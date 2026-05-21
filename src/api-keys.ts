import { loadConfig, saveConfig, ApiKeyRecord } from './db.js';
import { randomUUID } from 'crypto';

export interface ApiKey {
  id: string;
  key: string;
  name: string | null;
  is_active: number;
  created_at: string;
  last_used_at: string | null;
  request_count: number;
}

export function createApiKey(name?: string, customKey?: string): ApiKey {
  const id = randomUUID();
  const key = customKey || 'sk-' + randomUUID().replace(/-/g, '');
  const created_at = new Date().toISOString();

  const configData = loadConfig();
  if (!configData.api_keys) configData.api_keys = [];

  const newKey: ApiKeyRecord = {
    id,
    key,
    name: name ?? null,
    is_active: 1,
    created_at,
    last_used_at: null,
    request_count: 0,
  };

  configData.api_keys.push(newKey);
  saveConfig(configData);

  return newKey;
}

export function listApiKeys(): ApiKey[] {
  const configData = loadConfig();
  return configData.api_keys || [];
}

export function getApiKeyById(id: string): ApiKey | undefined {
  const configData = loadConfig();
  return configData.api_keys?.find(k => k.id === id);
}

export function validateApiKey(key: string): ApiKey | undefined {
  const configData = loadConfig();
  return configData.api_keys?.find(k => k.key === key && k.is_active === 1);
}

export function updateApiKey(id: string, data: { name?: string; is_active?: number }) {
  const configData = loadConfig();
  if (!configData.api_keys) return;

  const apiKey = configData.api_keys.find(k => k.id === id);
  if (!apiKey) return;

  if (data.name !== undefined) apiKey.name = data.name;
  if (data.is_active !== undefined) apiKey.is_active = data.is_active;

  saveConfig(configData);
}

export function deleteApiKey(id: string) {
  const configData = loadConfig();
  if (!configData.api_keys) return;

  configData.api_keys = configData.api_keys.filter(k => k.id !== id);
  saveConfig(configData);
}

export function recordApiKeyUsage(id: string) {
  const configData = loadConfig();
  if (!configData.api_keys) return;

  const apiKey = configData.api_keys.find(k => k.id === id);
  if (!apiKey) return;

  apiKey.last_used_at = new Date().toISOString();
  apiKey.request_count += 1;
  saveConfig(configData);
}
