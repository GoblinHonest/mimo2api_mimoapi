import { loadAccountData, saveAccountData, AccountRecord } from './db.js';
import { randomUUID } from 'crypto';

export interface Account {
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

export function createAccount(data: {
  alias?: string;
  service_token: string;
  user_id: string;
  ph_token: string;
}) {
  const id = randomUUID();
  const api_key = 'sk-' + randomUUID().replace(/-/g, '');

  const accountData = loadAccountData();
  const newAccount: AccountRecord = {
    id,
    alias: data.alias ?? null,
    service_token: data.service_token,
    user_id: data.user_id,
    ph_token: data.ph_token,
    api_key,
    is_active: 1,
    active_requests: 0,
    request_count: 0,
    created_at: new Date().toISOString(),
  };

  accountData.accounts.push(newAccount);
  saveAccountData(accountData);

  return { id, api_key };
}

export function listAccounts(): Account[] {
  const accountData = loadAccountData();
  return accountData.accounts.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function getAccountById(id: string): Account | undefined {
  const accountData = loadAccountData();
  return accountData.accounts.find(a => a.id === id);
}

export function getAccountByApiKey(apiKey: string): Account | undefined {
  const accountData = loadAccountData();
  return accountData.accounts.find(a => a.api_key === apiKey && a.is_active === 1);
}

export function getLeastBusyAccount(): Account | undefined {
  const accountData = loadAccountData();
  return accountData.accounts
    .filter(a => a.is_active === 1)
    .sort((a, b) => a.active_requests - b.active_requests)[0];
}

export function acquireAccount(maxConcurrent: number): Account | undefined {
  const accountData = loadAccountData();

  const account = accountData.accounts
    .filter(a => a.is_active === 1 && a.active_requests < maxConcurrent)
    .sort((a, b) => a.active_requests - b.active_requests || a.request_count - b.request_count)[0];

  if (!account) return undefined;

  account.active_requests += 1;
  account.request_count += 1;
  saveAccountData(accountData);

  return { ...account };
}

export function incrementActive(id: string) {
  const accountData = loadAccountData();
  const account = accountData.accounts.find(a => a.id === id);
  if (account) {
    account.active_requests += 1;
    saveAccountData(accountData);
  }
}

export function decrementActive(id: string) {
  const accountData = loadAccountData();
  const account = accountData.accounts.find(a => a.id === id);
  if (account) {
    account.active_requests = Math.max(0, account.active_requests - 1);
    saveAccountData(accountData);
  }
}

export function updateAccount(id: string, data: { alias?: string; is_active?: number }) {
  const accountData = loadAccountData();
  const account = accountData.accounts.find(a => a.id === id);
  if (!account) return;

  if (data.alias !== undefined) account.alias = data.alias;
  if (data.is_active !== undefined) account.is_active = data.is_active;

  saveAccountData(accountData);
}

export function deleteAccount(id: string) {
  const accountData = loadAccountData();
  accountData.accounts = accountData.accounts.filter(a => a.id !== id);
  saveAccountData(accountData);
}

export function markAccountInactive(id: string) {
  const accountData = loadAccountData();
  const account = accountData.accounts.find(a => a.id === id);
  if (account) {
    account.is_active = 0;
    saveAccountData(accountData);
  }
}

export function parseCurl(curl: string): { service_token: string; user_id: string; ph_token: string } | null {
  const m1 = curl.match(/(?:-b|--cookie)\s+'([^']+)'/) ?? curl.match(/(?:-b|--cookie)\s+"([^"]+)"/);
  const m2 = curl.match(/-H\s+[Cc]ookie:\s*([^\r\n]+)/);
  const cookies = m1?.[1] ?? m2?.[1];
  if (!cookies) return null;

  const st = cookies.match(/serviceToken=["']?([^"';\s]+)["']?/);
  const uid = cookies.match(/userId=["']?(\d+)["']?/);
  const ph = cookies.match(/xiaomichatbot_ph=["']?([^"';\s]+)["']?/);
  if (!st) return null;

  return {
    service_token: st[1],
    user_id: uid?.[1] ?? '',
    ph_token: ph?.[1] ?? '',
  };
}
