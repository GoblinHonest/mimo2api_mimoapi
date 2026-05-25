import { db } from './db.js';

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
  mimoProxy: '',
};

export const config: typeof DEFAULTS = { ...DEFAULTS };

export function loadConfig() {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
  const map = new Map(rows.map(r => [r.key, r.value]));

  const numKeys: Array<keyof typeof DEFAULTS> = [
    'port', 'maxReplayMessages', 'maxQueryChars',
    'contextResetThreshold', 'maxConcurrentPerAccount', 'sessionTtlDays',
  ];
  for (const key of numKeys) {
    if (map.has(key)) {
      const v = Number(map.get(key));
      if (!isNaN(v)) (config as Record<string, unknown>)[key] = v;
    }
  }

  if (map.has('adminKey')) config.adminKey = map.get('adminKey')!;
  if (map.has('mimoProxy')) config.mimoProxy = map.get('mimoProxy')!.trim();
  if (map.has('thinkMode') && ['passthrough', 'strip', 'separate'].includes(map.get('thinkMode')!)) {
    config.thinkMode = map.get('thinkMode') as typeof config.thinkMode;
  }
  if (map.has('sessionIsolation') && ['manual', 'auto', 'per-request'].includes(map.get('sessionIsolation')!)) {
    config.sessionIsolation = map.get('sessionIsolation') as typeof config.sessionIsolation;
  }

  console.log('[CONFIG] Loaded from database:', Object.fromEntries(map));
}

export const DEBUG = !!(process.env.DEBUG ?? process.env.NODE_ENV !== 'production');
export function debugLog(...args: unknown[]) {
  if (DEBUG) console.log(...args);
}

export function saveSetting(key: string, value: string) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  // Also apply to in-memory config immediately
  if (key in config) {
    if (typeof (config as Record<string, unknown>)[key] === 'number') {
      const v = Number(value);
      if (!isNaN(v)) (config as Record<string, unknown>)[key] = v;
    } else {
      (config as Record<string, unknown>)[key] = value;
    }
  }
}
