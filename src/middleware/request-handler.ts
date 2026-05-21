import { Context } from 'hono';
import { randomUUID } from 'crypto';
import { acquireAccount, decrementActive, markAccountInactive, Account } from '../accounts.js';
import { validateApiKey, recordApiKeyUsage, ApiKey } from '../api-keys.js';
import { config } from '../config.js';
import { appendLog, RequestLogRecord } from '../db.js';
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
  const log: RequestLogRecord = {
    id: randomUUID(),
    account_id: data.account_id,
    session_id: null,
    api_key_id: data.api_key_id,
    endpoint: data.endpoint,
    model: data.model,
    prompt_tokens: data.usage?.promptTokens ?? null,
    completion_tokens: data.usage?.completionTokens ?? null,
    reasoning_tokens: data.usage?.reasoningTokens ?? null,
    duration_ms: data.duration_ms,
    status: data.status,
    error: data.error ?? null,
    created_at: new Date().toLocaleString('sv-SE'),
  };

  appendLog(log);
}

export function handleAccountError(account: Account, errorMsg: string) {
  if (errorMsg.includes('401') || errorMsg.includes('403') || errorMsg.includes('451')) {
    markAccountInactive(account.id);
  }
}
