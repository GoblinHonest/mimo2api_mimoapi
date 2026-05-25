import { db } from './db.js';
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
  db.prepare(
    `INSERT INTO accounts (id, alias, service_token, user_id, ph_token, api_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(id, data.alias ?? null, data.service_token, data.user_id, data.ph_token, api_key);
  return { id, api_key };
}

export function listAccounts(): Account[] {
  return db.prepare('SELECT * FROM accounts ORDER BY created_at DESC').all() as Account[];
}

export function getAccountById(id: string): Account | undefined {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Account | undefined;
}

export function getAccountByApiKey(apiKey: string): Account | undefined {
  return db.prepare('SELECT * FROM accounts WHERE api_key = ? AND is_active = 1').get(apiKey) as Account | undefined;
}

export function getLeastBusyAccount(): Account | undefined {
  return db.prepare(
    'SELECT * FROM accounts WHERE is_active = 1 ORDER BY active_requests ASC LIMIT 1'
  ).get() as Account | undefined;
}

export function acquireAccount(maxConcurrent: number): Account | undefined {
  const txn = db.transaction(() => {
    const account = db.prepare(
      'SELECT * FROM accounts WHERE is_active = 1 AND active_requests < ? ORDER BY active_requests ASC, request_count ASC LIMIT 1'
    ).get(maxConcurrent) as Account | undefined;
    if (!account) return undefined;
    db.prepare('UPDATE accounts SET active_requests = active_requests + 1, request_count = request_count + 1 WHERE id = ?').run(account.id);
    return { ...account, active_requests: account.active_requests + 1, request_count: account.request_count + 1 };
  });
  return txn();
}

export function incrementActive(id: string) {
  db.prepare('UPDATE accounts SET active_requests = active_requests + 1 WHERE id = ?').run(id);
}

export function decrementActive(id: string) {
  db.prepare('UPDATE accounts SET active_requests = MAX(0, active_requests - 1) WHERE id = ?').run(id);
}

export function updateAccount(id: string, data: { alias?: string; is_active?: number }) {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (data.alias !== undefined) { fields.push('alias = ?'); values.push(data.alias); }
  if (data.is_active !== undefined) { fields.push('is_active = ?'); values.push(data.is_active); }
  if (!fields.length) return;
  values.push(id);
  db.prepare(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteAccount(id: string) {
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
}

export function markAccountInactive(id: string) {
  db.prepare('UPDATE accounts SET is_active = 0 WHERE id = ?').run(id);
}

export function parseCurl(curl: string): { service_token: string; user_id: string; ph_token: string } | null {
  const m1 = curl.match(/(?:-b|--cookie)\s+'([^']+)'/) ?? curl.match(/(?:-b|--cookie)\s+"([^"]+)"/) ;
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
