import { loadConfig as loadJsonConfig, saveConfig, ConfigData } from './db.js';

const DEFAULTS = {
  port: 8080,
  adminKey: 'admin',
  maxReplayMessages: 20,
  maxQueryChars: 100000,
  contextResetThreshold: 150000,
  maxConcurrentPerAccount: 99999,
  thinkMode: 'separate' as 'passthrough' | 'strip' | 'separate',
  sessionTtlDays: 7,
  sessionIsolation: 'auto' as 'manual' | 'auto' | 'per-request',
};

export const config: typeof DEFAULTS = { ...DEFAULTS };

export function loadConfig() {
  const data = loadJsonConfig();

  const numKeys: Array<keyof typeof DEFAULTS> = [
    'port', 'maxReplayMessages', 'maxQueryChars',
    'contextResetThreshold', 'maxConcurrentPerAccount', 'sessionTtlDays',
  ];
  for (const key of numKeys) {
    if (data[key] !== undefined) {
      const v = Number(data[key]);
      if (!isNaN(v)) (config as Record<string, unknown>)[key] = v;
    }
  }

  if (data.adminKey) config.adminKey = data.adminKey;
  if (data.thinkMode && ['passthrough', 'strip', 'separate'].includes(data.thinkMode)) {
    config.thinkMode = data.thinkMode;
  }
  if (data.sessionIsolation && ['manual', 'auto', 'per-request'].includes(data.sessionIsolation)) {
    config.sessionIsolation = data.sessionIsolation;
  }

  console.log('[CONFIG] Loaded from JSON:', {
    port: config.port,
    adminKey: config.adminKey,
    maxReplayMessages: config.maxReplayMessages,
    maxQueryChars: config.maxQueryChars,
    contextResetThreshold: config.contextResetThreshold,
    maxConcurrentPerAccount: config.maxConcurrentPerAccount,
    thinkMode: config.thinkMode,
    sessionTtlDays: config.sessionTtlDays,
    sessionIsolation: config.sessionIsolation,
  });
}

export function saveSetting(key: string, value: string) {
  const data = loadJsonConfig();
  (data as Record<string, unknown>)[key] = value;
  saveConfig(data);
}
