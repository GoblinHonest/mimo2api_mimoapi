import { Context } from 'hono';
import { randomUUID } from 'crypto';
import { acquireAccount, decrementActive, markAccountInactive, Account } from '../accounts.js';
import { validateApiKey, recordApiKeyUsage, ApiKey } from '../api-keys.js';
import { config } from '../config.js';
import { db } from '../db.js';
import { MimoUsage } from '../mimo/client.js';

export interface RequestContext {
  account: Account;
  apiKeyRecord: ApiKey;
  startTime: number;
}

export function extractApiKey(c: Context): string {
  const xApiKey = c.req.header('x-api-key');
  if (xApiKey) return xApiKey;
  const auth = c.req.header('Authorization') ?? '';
  return auth.replace(/^Bearer\s+/i, '').trim();
}

export function authenticateRequest(apiKey: string): ApiKey | null {
  if (!apiKey) return null;
  return validateApiKey(apiKey) ?? null;
}

export function acquireAccountForRequest(apiKeyRecord: ApiKey): { account: Account } | null {
  recordApiKeyUsage(apiKeyRecord.id);
  const account = acquireAccount(config.maxConcurrentPerAccount);
  if (!account) return null;
  return { account };
}

export function logApiRequest(data: {
  account_id: string;
  api_key_id: string | null;
  endpoint: 'openai' | 'anthropic';
  model: string;
  usage: MimoUsage | null;
  status: 'success' | 'error';
  error?: string;
  duration_ms: number;
}) {
  db.prepare(
    `INSERT INTO request_logs (id, account_id, session_id, api_key_id, endpoint, model, prompt_tokens, completion_tokens, reasoning_tokens, duration_ms, status, error, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(), data.account_id, data.api_key_id, data.endpoint, data.model,
    data.usage?.promptTokens ?? null, data.usage?.completionTokens ?? null,
    data.usage?.reasoningTokens ?? null, data.duration_ms,
    data.status, data.error ?? null, new Date().toLocaleString('sv-SE')
  );
}

export function handleAccountError(account: Account, errorMsg: string) {
  if (errorMsg.includes('401') || errorMsg.includes('403') || errorMsg.includes('451')) {
    markAccountInactive(account.id);
  }
}
