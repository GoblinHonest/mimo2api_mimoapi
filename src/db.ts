import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const LOGS_DIR = path.join(__dirname, '..', 'logs');

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(LOGS_DIR, { recursive: true });

export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
export const ACCOUNT_PATH = path.join(DATA_DIR, 'account.json');
export const LOGS_PATH = LOGS_DIR;

export interface ConfigData {
  port?: number;
  adminKey?: string;
  maxReplayMessages?: number;
  maxQueryChars?: number;
  contextResetThreshold?: number;
  maxConcurrentPerAccount?: number;
  thinkMode?: 'passthrough' | 'strip' | 'separate';
  sessionTtlDays?: number;
  sessionIsolation?: 'manual' | 'auto' | 'per-request';
  api_keys?: ApiKeyRecord[];
  sessions?: SessionRecord[];
}

export interface ApiKeyRecord {
  id: string;
  key: string;
  name: string | null;
  is_active: number;
  created_at: string;
  last_used_at: string | null;
  request_count: number;
}

export interface SessionRecord {
  id: string;
  account_id: string;
  client_session_id: string;
  conversation_id: string;
  last_message_fingerprint: string;
  cumulative_prompt_tokens: number;
  is_expired: number;
  created_at: string;
  last_used_at: string;
}

export interface AccountRecord {
  id: string;
  alias: string | null;
  service_token: string;
  user_id: string;
  ph_token: string;
  api_key: string;
  is_active: number;
  active_requests: number;
  request_count: number;
  created_at: string;
}

export interface AccountData {
  accounts: AccountRecord[];
}

export interface RequestLogRecord {
  id: string;
  account_id: string;
  session_id: string | null;
  api_key_id: string | null;
  endpoint: string;
  model: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  reasoning_tokens: number | null;
  duration_ms: number;
  status: string;
  error: string | null;
  created_at: string;
}

function readJsonFile<T>(filePath: string, defaultValue: T): T {
  if (!existsSync(filePath)) {
    writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), 'utf-8');
    return defaultValue;
  }
  try {
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return defaultValue;
  }
}

function writeJsonFile<T>(filePath: string, data: T): void {
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export function loadConfig(): ConfigData {
  return readJsonFile<ConfigData>(CONFIG_PATH, {
    api_keys: [],
    sessions: []
  });
}

export function saveConfig(data: ConfigData): void {
  writeJsonFile(CONFIG_PATH, data);
}

export function loadAccountData(): AccountData {
  return readJsonFile<AccountData>(ACCOUNT_PATH, { accounts: [] });
}

export function saveAccountData(data: AccountData): void {
  writeJsonFile(ACCOUNT_PATH, data);
}

export function getLogFilePath(date?: string): string {
  const d = date || new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return path.join(LOGS_PATH, `${d}.json`);
}

export function loadLogs(date?: string): RequestLogRecord[] {
  const filePath = getLogFilePath(date);
  return readJsonFile<RequestLogRecord[]>(filePath, []);
}

export function appendLog(log: RequestLogRecord): void {
  const filePath = getLogFilePath();
  const logs = loadLogs();
  logs.push(log);
  writeJsonFile(filePath, logs);
}

export function initDb() {
  loadConfig();
  loadAccountData();
  console.log('[DB] JSON storage initialized');

  const accountData = loadAccountData();
  for (const account of accountData.accounts) {
    account.active_requests = 0;
  }
  saveAccountData(accountData);
  console.log('[DB] Reset all accounts active_requests to 0');
}
