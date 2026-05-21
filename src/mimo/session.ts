import { loadConfig, saveConfig, SessionRecord } from '../db.js';
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

  const configData = loadConfig();
  if (!configData.sessions) configData.sessions = [];

  const activeSessions = configData.sessions
    .filter(s => s.account_id === accountId && s.is_expired === 0)
    .sort((a, b) => b.last_used_at.localeCompare(a.last_used_at))
    .slice(0, 10);

  console.log(`[SESSION] Found ${activeSessions.length} active sessions for this account`);

  for (const session of activeSessions) {
    console.log(`[SESSION] Checking session ${session.id.slice(0, 8)}..., fingerprint: ${session.last_message_fingerprint.slice(0, 16)}...`);

    if (isMessageContinuation(messages, session.last_message_fingerprint)) {
      if (isHistoryContaminated(messages)) {
        console.log('[SESSION] ⚠️ History contamination detected in continuation, forcing new session...');
        break;
      }

      if (session.cumulative_prompt_tokens > config.contextResetThreshold && config.contextResetThreshold > 0) {
        console.log('[SESSION] Token limit exceeded, creating new session...');
        break;
      }

      session.last_message_fingerprint = currentFingerprint;
      session.last_used_at = new Date().toISOString();
      saveConfig(configData);

      console.log('[SESSION] ✓ Reusing session (message continuation detected):', {
        id: session.id.slice(0, 8) + '...',
        conversationId: session.conversation_id.slice(0, 16) + '...',
        tokens: session.cumulative_prompt_tokens,
        previousMsgCount: extractMessageCount(session.last_message_fingerprint),
        currentMsgCount: messages.length
      });

      return { conversationId: session.conversation_id, session };
    }
  }

  console.log('[SESSION] No continuation found, creating new session...');
  try {
    return createNewSession(accountId, clientSessionId, currentFingerprint);
  } catch (error) {
    console.error('[SESSION] ❌ Error creating new session:', error);
    throw error;
  }
}

function isMessageContinuation(currentMessages: any[], lastFingerprint: string): boolean {
  if (!lastFingerprint) return false;

  const nonSystemMessages = currentMessages.filter(m => m.role !== 'system');
  if (nonSystemMessages.length < 2) return false;

  for (let i = nonSystemMessages.length; i >= 1; i--) {
    const slice = nonSystemMessages.slice(0, i);
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

function extractMessageCount(fingerprint: string): string {
  return 'N/A';
}

function createNewSession(accountId: string, clientSessionId: string, messageFingerprint: string): { conversationId: string; session: Session } {
  console.log('[SESSION] createNewSession called:', {
    accountId: accountId.slice(0, 8) + '...',
    clientSessionId: clientSessionId.slice(0, 20) + '...',
    fingerprint: messageFingerprint.slice(0, 16) + '...'
  });

  try {
    const configData = loadConfig();
    if (!configData.sessions) configData.sessions = [];

    const id = randomUUID();
    const conversationId = randomUUID().replace(/-/g, '');

    console.log('[SESSION] Deleting old sessions with same client_session_id...');
    const beforeCount = configData.sessions.length;
    configData.sessions = configData.sessions.filter(
      s => !(s.account_id === accountId && s.client_session_id === clientSessionId && s.is_expired === 0)
    );
    console.log('[SESSION] Deleted', beforeCount - configData.sessions.length, 'old sessions');

    console.log('[SESSION] Inserting new session...');
    const newSession: SessionRecord = {
      id,
      account_id: accountId,
      client_session_id: clientSessionId,
      conversation_id: conversationId,
      last_message_fingerprint: messageFingerprint,
      cumulative_prompt_tokens: 0,
      is_expired: 0,
      created_at: new Date().toISOString(),
      last_used_at: new Date().toISOString(),
    };

    configData.sessions.push(newSession);
    saveConfig(configData);

    console.log('[SESSION] ✓ New session created:', {
      id: id.slice(0, 8) + '...',
      conversationId: conversationId.slice(0, 16) + '...',
      fingerprint: messageFingerprint.slice(0, 16) + '...'
    });

    return { conversationId, session: newSession };
  } catch (error) {
    console.error('[SESSION] ❌ Error in createNewSession:', error);
    throw error;
  }
}

export function updateSessionTokens(sessionId: string, promptTokens: number) {
  console.log('[SESSION] updateSessionTokens:', {
    sessionId: sessionId.slice(0, 8) + '...',
    promptTokens
  });

  const configData = loadConfig();
  if (!configData.sessions) return;

  const session = configData.sessions.find(s => s.id === sessionId);
  if (session) {
    session.cumulative_prompt_tokens += promptTokens;
    session.last_used_at = new Date().toISOString();
    saveConfig(configData);
  }
}

export function expireSession(sessionId: string) {
  const configData = loadConfig();
  if (!configData.sessions) return;

  const session = configData.sessions.find(s => s.id === sessionId);
  if (session) {
    session.is_expired = 1;
    saveConfig(configData);
  }
}

export function listSessions(): Session[] {
  const configData = loadConfig();
  return (configData.sessions || [])
    .filter(s => s.is_expired === 0)
    .sort((a, b) => b.last_used_at.localeCompare(a.last_used_at));
}

export function deleteSession(id: string) {
  const configData = loadConfig();
  if (!configData.sessions) return;

  configData.sessions = configData.sessions.filter(s => s.id !== id);
  saveConfig(configData);
}
