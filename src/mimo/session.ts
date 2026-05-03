import { db } from '../db.js';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { calculateMessageFingerprint } from './session-marker.js';
import { isHistoryContaminated } from './serialize.js';

export interface Session {
  id: string;
  account_id: string;
  client_session_id: string;
  conversation_id: string;
  cumulative_prompt_tokens: number;
  last_message_fingerprint: string;
  is_expired: number;
  created_at: string;
  last_used_at: string;
}

/**
 * 获取或创建会话（基于消息历史连续性）
 * 
 * 逻辑：
 * 1. 计算当前消息的指纹
 * 2. 查找是否有 session 的 last_message_fingerprint 是当前消息的前缀
 * 3. 如果找到，说明当前消息包含了上次的历史 → 复用会话
 * 4. 如果没找到 → 创建新会话
 * 
 * @param accountId - 账号ID
 * @param clientSessionId - 客户端会话ID（用于创建新会话）
 * @param messages - 当前请求的消息列表
 */
export async function getOrCreateSession(
  accountId: string,
  clientSessionId: string,
  messages: any[]
): Promise<{ conversationId: string; session: Session }> {
  const currentFingerprint = calculateMessageFingerprint(messages);

  console.log('[SESSION] getOrCreateSession:', {
    accountId: accountId.slice(0, 8) + '...',
    clientSessionId: clientSessionId.slice(0, 20) + '...',
    messageCount: messages.length,
    fingerprint: currentFingerprint.slice(0, 16) + '...'
  });

  // 查找所有活跃的会话，检查消息连续性
  const activeSessions = db.prepare(
    'SELECT * FROM sessions WHERE account_id = ? AND is_expired = 0 ORDER BY last_used_at DESC LIMIT 10'
  ).all(accountId) as Session[];

  console.log(`[SESSION] Found ${activeSessions.length} active sessions for this account`);
  
  for (const session of activeSessions) {
    console.log(`[SESSION] Checking session ${session.id.slice(0, 8)}..., fingerprint: ${session.last_message_fingerprint.slice(0, 16)}...`);

    // 检查当前消息是否包含上次的消息（通过比较指纹）
    // 如果当前消息更长，且包含了之前的内容，说明是连续的
    if (isMessageContinuation(messages, session.last_message_fingerprint)) {
      // 检测历史是否被污染（只在复用会话时检查）
      if (isHistoryContaminated(messages)) {
        console.log('[SESSION] ⚠️ History contamination detected in continuation, forcing new session...');
        break; // 跳出循环，创建新会话
      }

      // Token 超限检查
      if (session.cumulative_prompt_tokens > config.contextResetThreshold && config.contextResetThreshold > 0) {
        console.log('[SESSION] Token limit exceeded, creating new session...');
        break; // 跳出循环，创建新会话
      }

      // 复用现有会话，更新指纹
      db.prepare(
        `UPDATE sessions SET 
           last_message_fingerprint = ?,
           last_used_at = datetime('now')
         WHERE id = ?`
      ).run(currentFingerprint, session.id);
      
      console.log('[SESSION] ✓ Reusing session (message continuation detected):', {
        id: session.id.slice(0, 8) + '...',
        conversationId: session.conversation_id.slice(0, 16) + '...',
        tokens: session.cumulative_prompt_tokens,
        previousMsgCount: extractMessageCount(session.last_message_fingerprint),
        currentMsgCount: messages.length
      });
      
      // 重新获取更新后的 session
      const updatedSession = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id) as Session;
      return { conversationId: updatedSession.conversation_id, session: updatedSession };
    }
  }

  // 没有找到连续的会话 → 创建新会话
  console.log('[SESSION] No continuation found, creating new session...');
  try {
    return createNewSession(accountId, clientSessionId, currentFingerprint);
  } catch (error) {
    console.error('[SESSION] ❌ Error creating new session:', error);
    throw error;
  }
}

/**
 * 检查消息是否是连续的
 * 策略：检查当前消息的前 N 条是否与上次的指纹匹配
 */
function isMessageContinuation(currentMessages: any[], lastFingerprint: string): boolean {
  // 如果是首次请求（没有历史指纹），不是连续
  if (!lastFingerprint) return false;

  // 过滤掉 system 消息
  const nonSystemMessages = currentMessages.filter(m => m.role !== 'system');

  // 如果只有1条非 system 消息，无法判断连续性（可能是新对话）
  if (nonSystemMessages.length < 2) return false;

  // 尝试不同的切片长度，看是否能匹配上次的指纹
  // 从最长的开始往前查找（优先匹配完整历史）
  for (let i = nonSystemMessages.length; i >= 1; i--) {
    const slice = nonSystemMessages.slice(0, i);
    // 需要加回 system 消息来计算指纹（因为 calculateMessageFingerprint 会过滤）
    const sliceWithSystem = currentMessages.filter(m => m.role === 'system').concat(slice);
    const sliceFingerprint = calculateMessageFingerprint(sliceWithSystem);

    console.log(`[SESSION] Checking slice [0:${i}] (${i} non-system msgs), fingerprint: ${sliceFingerprint.slice(0, 16)}... vs ${lastFingerprint.slice(0, 16)}...`);

    if (sliceFingerprint === lastFingerprint) {
      console.log('[SESSION] ✓ Found continuation at message index:', i);
      return true;
    }
  }

  return false;
}

/**
 * 从指纹中提取消息数量（用于日志）
 */
function extractMessageCount(fingerprint: string): string {
  return 'N/A'; // 指纹中不包含消息数量，仅用于日志显示
}

/**
 * 创建新会话
 */
function createNewSession(accountId: string, clientSessionId: string, messageFingerprint: string): { conversationId: string; session: Session } {
  console.log('[SESSION] createNewSession called:', {
    accountId: accountId.slice(0, 8) + '...',
    clientSessionId: clientSessionId.slice(0, 20) + '...',
    fingerprint: messageFingerprint.slice(0, 16) + '...'
  });
  
  try {
    const transaction = db.transaction(() => {
      const id = randomUUID();
      const conversationId = randomUUID().replace(/-/g, '');
      
      console.log('[SESSION] Deleting old sessions with same client_session_id...');
      // 先删除旧的同名 session（如果存在）
      const deleteResult = db.prepare(
        `DELETE FROM sessions 
         WHERE account_id = ? AND client_session_id = ? AND is_expired = 0`
      ).run(accountId, clientSessionId);
      console.log('[SESSION] Deleted', deleteResult.changes, 'old sessions');
      
      console.log('[SESSION] Inserting new session...');
      // 创建新 session
      db.prepare(
        `INSERT INTO sessions
         (id, account_id, client_session_id, conversation_id, last_message_fingerprint, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      ).run(id, accountId, clientSessionId, conversationId, messageFingerprint);
      
      return { id, conversationId };
    });
    
    const result = transaction();
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(result.id) as Session;
    
    console.log('[SESSION] ✓ New session created:', {
      id: result.id.slice(0, 8) + '...',
      conversationId: result.conversationId.slice(0, 16) + '...',
      fingerprint: messageFingerprint.slice(0, 16) + '...'
    });
    
    return { conversationId: result.conversationId, session };
  } catch (error) {
    console.error('[SESSION] ❌ Error in createNewSession:', error);
    throw error;
  }
}

/**
 * 更新会话 token 统计
 */
export function updateSessionTokens(sessionId: string, promptTokens: number) {
  console.log('[SESSION] updateSessionTokens:', {
    sessionId: sessionId.slice(0, 8) + '...',
    promptTokens
  });
  
  const transaction = db.transaction(() => {
    db.prepare(
      `UPDATE sessions SET
         cumulative_prompt_tokens = cumulative_prompt_tokens + ?,
         last_used_at = datetime('now')
       WHERE id = ?`
    ).run(promptTokens, sessionId);
  });
  
  transaction();
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
