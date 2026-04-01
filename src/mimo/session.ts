import { db } from '../db.js';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { config } from '../config.js';

export interface Session {
  id: string;
  account_id: string;
  client_session_id: string;
  conversation_id: string;
  last_messages_hash: string | null;
  last_msg_count: number;
  cumulative_prompt_tokens: number;
  is_expired: number;
  created_at: string;
  last_used_at: string;
}

function hashMessages(messages: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex');
}

export async function getOrCreateSession(
  accountId: string,
  clientSessionId: string,
  messages: unknown[]
): Promise<{ conversationId: string; reuseHistory: boolean; session: Session }> {
  console.log('[SESSION] getOrCreateSession:', {
    accountId: accountId.slice(0, 8) + '...',
    clientSessionId: clientSessionId.slice(0, 16) + '...',
    messageCount: Array.isArray(messages) ? messages.length : 0
  });
  
  const existing = db.prepare(
    'SELECT * FROM sessions WHERE account_id = ? AND client_session_id = ? AND is_expired = 0'
  ).get(accountId, clientSessionId) as Session | undefined;

  if (existing) {
    console.log('[SESSION] Found existing session:', {
      id: existing.id.slice(0, 8) + '...',
      tokens: existing.cumulative_prompt_tokens,
      threshold: config.contextResetThreshold
    });
    
    if (existing.cumulative_prompt_tokens > config.contextResetThreshold) {
      console.log('[SESSION] Token limit exceeded, resetting session...');
      // Token 超限，需要重置会话
      // 使用事务确保原子性
      const transaction = db.transaction(() => {
        // 1. 过期所有相同 client_session_id 的会话（防止并发问题）
        db.prepare(
          'UPDATE sessions SET is_expired = 1 WHERE account_id = ? AND client_session_id = ? AND is_expired = 0'
        ).run(accountId, clientSessionId);
        
        // 2. 创建新会话，使用 INSERT OR IGNORE 防止并发冲突
        const id = uuidv4();
        const conversationId = uuidv4().replace(/-/g, '');
        const historyHash = hashMessages(messages);
        
        const result = db.prepare(
          `INSERT OR IGNORE INTO sessions
           (id, account_id, client_session_id, conversation_id, last_messages_hash, last_msg_count, created_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
        ).run(id, accountId, clientSessionId, conversationId, historyHash, messages.length);
        
        if (result.changes > 0) {
          return { id, conversationId, historyHash, isNew: true };
        } else {
          // 并发冲突，重新查询
          console.log('[SESSION] ⚠️ Concurrent reset detected, re-querying...');
          const existingSession = db.prepare(
            'SELECT * FROM sessions WHERE account_id = ? AND client_session_id = ? AND is_expired = 0'
          ).get(accountId, clientSessionId) as Session | undefined;
          
          if (existingSession) {
            return { id: existingSession.id, conversationId: existingSession.conversation_id, historyHash: existingSession.last_messages_hash, isNew: false };
          } else {
            throw new Error('Session reset race condition: record disappeared');
          }
        }
      });
      
      const result = transaction();
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(result.id) as Session;
      
      if (result.isNew) {
        console.log('[SESSION] ✓ New session created after reset:', result.id.slice(0, 8) + '...');
      } else {
        console.log('[SESSION] ✓ Session reset by concurrent request, reusing:', result.id.slice(0, 8) + '...');
      }
      
      return { conversationId: result.conversationId, reuseHistory: false, session };
    } else {
      const currentHash = hashMessages(messages);
      const reuseHistory = currentHash === existing.last_messages_hash;
      db.prepare("UPDATE sessions SET last_used_at = datetime('now') WHERE id = ?").run(existing.id);
      console.log('[SESSION] ✓ Reusing session:', {
        reuseHistory,
        hashMatch: reuseHistory
      });
      return { conversationId: existing.conversation_id, reuseHistory, session: existing };
    }
  }

  console.log('[SESSION] No existing session, creating new...');
  // 没有现有会话，创建新的
  // 使用事务 + INSERT OR IGNORE 防止并发冲突
  const transaction = db.transaction(() => {
    // 先过期所有可能存在的旧会话（防止并发创建）
    db.prepare(
      'UPDATE sessions SET is_expired = 1 WHERE account_id = ? AND client_session_id = ? AND is_expired = 0'
    ).run(accountId, clientSessionId);
    
    const id = uuidv4();
    const conversationId = uuidv4().replace(/-/g, '');
    const historyHash = hashMessages(messages);
    
    // 使用 INSERT OR IGNORE 防止并发插入冲突
    const result = db.prepare(
      `INSERT OR IGNORE INTO sessions
       (id, account_id, client_session_id, conversation_id, last_messages_hash, last_msg_count, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    ).run(id, accountId, clientSessionId, conversationId, historyHash, messages.length);
    
    // 如果插入成功（changes > 0），返回新创建的 ID
    // 如果插入失败（并发冲突），重新查询已存在的记录
    if (result.changes > 0) {
      return { id, conversationId, isNew: true };
    } else {
      // 并发冲突，另一个请求已经创建了记录，重新查询
      console.log('[SESSION] ⚠️ Concurrent insert detected, re-querying...');
      const existingSession = db.prepare(
        'SELECT * FROM sessions WHERE account_id = ? AND client_session_id = ? AND is_expired = 0'
      ).get(accountId, clientSessionId) as Session | undefined;
      
      if (existingSession) {
        return { id: existingSession.id, conversationId: existingSession.conversation_id, isNew: false };
      } else {
        // 极端情况：记录被立即过期了，抛出错误
        throw new Error('Session creation race condition: record disappeared');
      }
    }
  });
  
  const result = transaction();
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(result.id) as Session;
  
  if (result.isNew) {
    console.log('[SESSION] ✓ New session created:', result.id.slice(0, 8) + '...');
  } else {
    console.log('[SESSION] ✓ Session created by concurrent request, reusing:', result.id.slice(0, 8) + '...');
  }
  
  return { conversationId: result.conversationId, reuseHistory: false, session };
}

export function updateSessionTokens(
  sessionId: string,
  promptTokens: number,
  messagesHash: string,
  msgCount: number
) {
  db.prepare(
    `UPDATE sessions SET
       cumulative_prompt_tokens = cumulative_prompt_tokens + ?,
       last_messages_hash = ?,
       last_msg_count = ?,
       last_used_at = datetime('now')
     WHERE id = ?`
  ).run(promptTokens, messagesHash, msgCount, sessionId);
}

export function expireSession(sessionId: string) {
  db.prepare('UPDATE sessions SET is_expired = 1 WHERE id = ?').run(sessionId);
}

export function listSessions(): Session[] {
  return db.prepare(
    'SELECT * FROM sessions WHERE is_expired = 0 ORDER BY last_used_at DESC'
  ).all() as Session[];
}

export function deleteSession(id: string) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}
