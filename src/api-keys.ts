import { db } from './db.js';
import { v4 as uuidv4 } from 'uuid';

export interface ApiKey {
  id: string;
  key: string;
  name: string | null;
  is_active: number;
  created_at: string;
  last_used_at: string | null;
  request_count: number;
}

/**
 * 创建新的 API 密钥
 */
export function createApiKey(name?: string, customKey?: string): ApiKey {
  const id = uuidv4();
  const key = customKey || 'sk-' + uuidv4().replace(/-/g, '');
  const created_at = new Date().toISOString();

  db.prepare(
    `INSERT INTO api_keys (id, key, name, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(id, key, name ?? null, created_at);

  return {
    id,
    key,
    name: name ?? null,
    is_active: 1,
    created_at,
    last_used_at: null,
    request_count: 0,
  };
}

/**
 * 列出所有 API 密钥
 */
export function listApiKeys(): ApiKey[] {
  return db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as ApiKey[];
}

/**
 * 根据 ID 获取 API 密钥
 */
export function getApiKeyById(id: string): ApiKey | undefined {
  return db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as ApiKey | undefined;
}

/**
 * 验证 API 密钥是否有效
 * @returns 如果有效返回密钥记录，否则返回 undefined
 */
export function validateApiKey(key: string): ApiKey | undefined {
  return db.prepare('SELECT * FROM api_keys WHERE key = ? AND is_active = 1').get(key) as ApiKey | undefined;
}

/**
 * 更新 API 密钥
 */
export function updateApiKey(id: string, data: { name?: string; is_active?: number }) {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (data.name !== undefined) {
    fields.push('name = ?');
    values.push(data.name);
  }
  if (data.is_active !== undefined) {
    fields.push('is_active = ?');
    values.push(data.is_active);
  }

  if (!fields.length) return;

  values.push(id);
  db.prepare(`UPDATE api_keys SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

/**
 * 删除 API 密钥
 */
export function deleteApiKey(id: string) {
  db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
}

/**
 * 记录 API 密钥使用情况
 */
export function recordApiKeyUsage(id: string) {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE api_keys
     SET last_used_at = ?, request_count = request_count + 1
     WHERE id = ?`
  ).run(now, id);
}
