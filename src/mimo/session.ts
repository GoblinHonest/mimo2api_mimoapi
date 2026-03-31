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
  const existing = db.prepare(
    'SELECT * FROM sessions WHERE account_id = ? AND client_session_id = ? AND is_expired = 0'
  ).get(accountId, clientSessionId) as Session | undefined;

  if (existing) {
    if (existing.cumulative_prompt_tokens > config.contextResetThreshold) {
      db.prepare('UPDATE sessions SET is_expired = 1 WHERE id = ?').run(existing.id);
    } else {
      const currentHash = hashMessages(messages);
      const reuseHistory = currentHash === existing.last_messages_hash;
      db.prepare("UPDATE sessions SET last_used_at = datetime('now') WHERE id = ?").run(existing.id);
      return { conversationId: existing.conversation_id, reuseHistory, session: existing };
    }
  }

  const id = uuidv4();
  const conversationId = uuidv4().replace(/-/g, '');
  const historyHash = hashMessages(messages);
  db.prepare(
    `INSERT INTO sessions
     (id, account_id, client_session_id, conversation_id, last_messages_hash, last_msg_count, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(id, accountId, clientSessionId, conversationId, historyHash, messages.length);

  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session;
  return { conversationId, reuseHistory: false, session };
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
