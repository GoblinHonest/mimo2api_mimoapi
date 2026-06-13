import { Hono } from 'hono';
import { config, saveSetting } from '../config.js';
import {
  listAccounts, createAccount, getAccountById,
  updateAccount, deleteAccount, parseCurl,
  getAccountByApiKey
} from '../accounts.js';
import {
  listApiKeys, createApiKey, getApiKeyById,
  updateApiKey, deleteApiKey
} from '../api-keys.js';
import { listSessions, deleteSession } from '../mimo/session.js';
import { loadConfig, saveConfig, loadLogs, loadAccountData, RequestLogRecord, LOGS_PATH } from '../db.js';
import { callMimo } from '../mimo/client.js';
import { randomUUID } from 'crypto';
import { readdirSync, existsSync } from 'fs';
import path from 'path';
import { getAllLogs, getLogsByDateRange, getLogsByAccountId, getLogsByApiKeyId, calculateLogStats } from '../shared/log-utils.js';

async function adminAuth(c: Parameters<Parameters<Hono['use']>[1]>[0], next: () => Promise<void>): Promise<void | Response> {
  const key = c.req.header('X-Admin-Key') ?? c.req.query('admin_key');
  if (key !== config.adminKey) {
    return c.json({ error: 'Forbidden' }, 403) as unknown as Response;
  }
  await next();
}

export function registerAdmin(app: Hono) {
  const admin = new Hono();
  admin.use('/*', adminAuth);

  // --- Accounts ---
  admin.get('/accounts', (c) => {
    const page = Math.max(1, Number(c.req.query('page') ?? 1));
    const limit = Math.min(Math.max(1, Number(c.req.query('limit') ?? 10)), 100);
    const offset = (page - 1) * limit;

    const allAccounts = listAccounts();
    const total = allAccounts.length;

    const allLogs = getAllLogs();
    const logsByAccount = new Map<string, RequestLogRecord[]>();
    for (const log of allLogs) {
      if (!logsByAccount.has(log.account_id)) logsByAccount.set(log.account_id, []);
      logsByAccount.get(log.account_id)!.push(log);
    }

    const accounts = allAccounts.slice(offset, offset + limit).map(a => {
      const logs = logsByAccount.get(a.id) || [];
      const stats = calculateLogStats(logs);
      return {
        ...a,
        total_requests: stats.total_requests,
        total_prompt_tokens: stats.total_prompt_tokens,
        total_completion_tokens: stats.total_completion_tokens,
      };
    });

    return c.json({ accounts, total, page, limit });
  });

  admin.post('/accounts', async (c) => {
    const body = await c.req.json();
    let data: { service_token: string; user_id: string; ph_token: string; alias?: string } | null = null;

    if (body.curl) {
      const parsed = parseCurl(body.curl);
      if (!parsed) return c.json({ error: 'Failed to parse cURL command' }, 400);
      data = { ...parsed, alias: body.alias };
    } else if (body.service_token) {
      data = {
        service_token: body.service_token,
        user_id: body.user_id ?? '',
        ph_token: body.ph_token ?? '',
        alias: body.alias,
      };
    } else {
      return c.json({ error: 'Provide curl or service_token' }, 400);
    }

    const result = createAccount(data);
    return c.json({ ...result, message: 'Account created' }, 201);
  });

  admin.patch('/accounts/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const account = getAccountById(id);
    if (!account) return c.json({ error: 'Not found' }, 404);
    updateAccount(id, { alias: body.alias, is_active: body.is_active });
    return c.json({ message: 'Updated' });
  });

  admin.delete('/accounts/:id', (c) => {
    const id = c.req.param('id');
    const account = getAccountById(id);
    if (!account) return c.json({ error: 'Not found' }, 404);
    deleteAccount(id);
    return c.json({ message: 'Deleted' });
  });

  admin.post('/accounts/test', async (c) => {
    const body = await c.req.json();
    const account = body.api_key
      ? getAccountByApiKey(body.api_key)
      : getAccountById(body.id);
    if (!account) return c.json({ error: 'Account not found' }, 404);

    try {
      const convId = randomUUID().replace(/-/g, '');
      let reply = '';
      for await (const chunk of callMimo(account, convId, 'hi', false)) {
        if (chunk.type === 'text') reply += chunk.content ?? '';
      }
      return c.json({ success: true, response: reply.slice(0, 200) });
    } catch (e) {
      return c.json({ success: false, error: String(e) });
    }
  });

  // --- Sessions ---
  admin.get('/sessions', (c) => {
    return c.json(listSessions());
  });

  admin.delete('/sessions/:id', (c) => {
    deleteSession(c.req.param('id'));
    return c.json({ message: 'Deleted' });
  });

  admin.delete('/sessions', (c) => {
    const configData = loadConfig();
    configData.sessions = [];
    saveConfig(configData);
    return c.json({ message: 'All sessions deleted' });
  });

  // --- Logs ---
  admin.get('/logs', (c) => {
    const accountId = c.req.query('account_id');
    const status = c.req.query('status');
    const page = Number(c.req.query('page') ?? 1);
    const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);
    const offset = (page - 1) * limit;

    let allLogs = getAllLogs();

    if (accountId) allLogs = allLogs.filter(l => l.account_id === accountId);
    if (status) allLogs = allLogs.filter(l => l.status === status);

    allLogs.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const total = allLogs.length;
    const logs = allLogs.slice(offset, offset + limit);

    return c.json({ logs, total, page, limit });
  });

  // --- Stats ---
  admin.get('/stats', (c) => {
    const page = Math.max(1, Number(c.req.query('page') ?? 1));
    const limit = Math.min(Math.max(1, Number(c.req.query('limit') ?? 10)), 100);
    const offset = (page - 1) * limit;

    const allAccounts = listAccounts();
    const totalAccounts = allAccounts.length;

    const allLogs = getAllLogs();
    const logsByAccount = new Map<string, RequestLogRecord[]>();
    for (const log of allLogs) {
      if (!logsByAccount.has(log.account_id)) logsByAccount.set(log.account_id, []);
      logsByAccount.get(log.account_id)!.push(log);
    }

    const accounts = allAccounts.slice(offset, offset + limit).map(a => {
      const logs = logsByAccount.get(a.id) || [];
      const stats = calculateLogStats(logs);
      return {
        id: a.id,
        alias: a.alias,
        api_key: a.api_key,
        is_active: a.is_active,
        active_requests: a.active_requests,
        total_prompt_tokens: stats.total_prompt_tokens,
        total_completion_tokens: stats.total_completion_tokens,
        total_requests: stats.total_requests,
      };
    });

    const overallStats = calculateLogStats(allLogs);

    return c.json({
      accounts, maxConcurrent: config.maxConcurrentPerAccount,
      totalAccounts, page, limit,
      totalPromptTokens: overallStats.total_prompt_tokens,
      totalCompletionTokens: overallStats.total_completion_tokens,
    });
  });

  admin.get('/stats/api-keys', (c) => {
    const page = Math.max(1, Number(c.req.query('page') ?? 1));
    const limit = Math.min(Math.max(1, Number(c.req.query('limit') ?? 10)), 100);
    const offset = (page - 1) * limit;

    const configData = loadConfig();
    const allApiKeys = configData.api_keys || [];
    const total = allApiKeys.length;

    const allLogs = getAllLogs();
    const logsByKey = new Map<string, RequestLogRecord[]>();
    for (const log of allLogs) {
      if (log.api_key_id) {
        if (!logsByKey.has(log.api_key_id)) logsByKey.set(log.api_key_id, []);
        logsByKey.get(log.api_key_id)!.push(log);
      }
    }

    const apiKeys = allApiKeys.slice(offset, offset + limit).map(k => {
      const logs = logsByKey.get(k.id) || [];
      const stats = calculateLogStats(logs);
      return {
        ...k,
        total_requests: stats.total_requests,
        total_prompt_tokens: stats.total_prompt_tokens,
        total_completion_tokens: stats.total_completion_tokens,
      };
    });

    return c.json({ apiKeys, total, page, limit });
  });

  admin.get('/stats/overview', (c) => {
    const allLogs = getAllLogs();
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10).replace(/-/g, '');

    const todayLogs = allLogs.filter(l => l.created_at.replace(/[-:T ]/g, '').slice(0, 8) === today);
    const yesterdayLogs = allLogs.filter(l => l.created_at.replace(/[-:T ]/g, '').slice(0, 8) === yesterday);

    const todayStats = {
      requests: todayLogs.length,
      tokens: todayLogs.reduce((sum, l) => sum + (l.prompt_tokens || 0) + (l.completion_tokens || 0) + (l.reasoning_tokens || 0), 0),
      success_count: todayLogs.filter(l => l.status === 'success').length,
      avg_latency: todayLogs.filter(l => l.status === 'success').length > 0
        ? todayLogs.filter(l => l.status === 'success').reduce((sum, l) => sum + l.duration_ms, 0) / todayLogs.filter(l => l.status === 'success').length
        : 0,
    };

    const yesterdayStats = {
      requests: yesterdayLogs.length,
      tokens: yesterdayLogs.reduce((sum, l) => sum + (l.prompt_tokens || 0) + (l.completion_tokens || 0) + (l.reasoning_tokens || 0), 0),
    };

    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
    const recentLogs = allLogs.filter(l => {
      const date = l.created_at.replace(/[-:T ]/g, '').slice(0, 8);
      return date >= thirtyDaysAgo;
    });

    const dailyMap = new Map<string, { input_tokens: number; output_tokens: number; requests: number }>();
    for (const log of recentLogs) {
      const date = log.created_at.slice(0, 10);
      if (!dailyMap.has(date)) dailyMap.set(date, { input_tokens: 0, output_tokens: 0, requests: 0 });
      const day = dailyMap.get(date)!;
      day.input_tokens += log.prompt_tokens || 0;
      day.output_tokens += log.completion_tokens || 0;
      day.requests += 1;
    }
    const dailyTrend = Array.from(dailyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, stats]) => ({ date, ...stats }));

    const endpointMap = new Map<string, { requests: number; tokens: number }>();
    for (const log of allLogs) {
      if (!endpointMap.has(log.endpoint)) endpointMap.set(log.endpoint, { requests: 0, tokens: 0 });
      const ep = endpointMap.get(log.endpoint)!;
      ep.requests += 1;
      ep.tokens += (log.prompt_tokens || 0) + (log.completion_tokens || 0);
    }
    const endpointDist = Array.from(endpointMap.entries()).map(([endpoint, stats]) => ({ endpoint, ...stats }));

    const modelMap = new Map<string, { requests: number; tokens: number }>();
    for (const log of allLogs) {
      if (log.model) {
        if (!modelMap.has(log.model)) modelMap.set(log.model, { requests: 0, tokens: 0 });
        const m = modelMap.get(log.model)!;
        m.requests += 1;
        m.tokens += (log.prompt_tokens || 0) + (log.completion_tokens || 0);
      }
    }
    const modelDist = Array.from(modelMap.entries())
      .map(([model, stats]) => ({ model, ...stats }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 5);

    const allAccounts = listAccounts();
    const accountMap = new Map<string, string>();
    for (const a of allAccounts) accountMap.set(a.id, a.alias || a.user_id);

    const accountRankMap = new Map<string, { tokens: number; requests: number }>();
    for (const log of allLogs) {
      if (!accountRankMap.has(log.account_id)) accountRankMap.set(log.account_id, { tokens: 0, requests: 0 });
      const ar = accountRankMap.get(log.account_id)!;
      ar.tokens += (log.prompt_tokens || 0) + (log.completion_tokens || 0);
      ar.requests += 1;
    }
    const accountRanking = Array.from(accountRankMap.entries())
      .map(([id, stats]) => ({ name: accountMap.get(id) || id, ...stats }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 10);

    const configData = loadConfig();
    const apiKeyMap = new Map<string, string>();
    for (const k of configData.api_keys || []) apiKeyMap.set(k.id, k.name || k.key);

    const apiKeyRankMap = new Map<string, { tokens: number; requests: number }>();
    for (const log of allLogs) {
      if (log.api_key_id) {
        if (!apiKeyRankMap.has(log.api_key_id)) apiKeyRankMap.set(log.api_key_id, { tokens: 0, requests: 0 });
        const ak = apiKeyRankMap.get(log.api_key_id)!;
        ak.tokens += (log.prompt_tokens || 0) + (log.completion_tokens || 0);
        ak.requests += 1;
      }
    }
    const apiKeyRanking = Array.from(apiKeyRankMap.entries())
      .map(([id, stats]) => ({ name: apiKeyMap.get(id) || id, ...stats }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 10);

    const hourlyMap = new Map<number, number>();
    for (let h = 0; h < 24; h++) hourlyMap.set(h, 0);
    for (const log of todayLogs) {
      const hour = parseInt(log.created_at.slice(11, 13) || '0');
      hourlyMap.set(hour, (hourlyMap.get(hour) || 0) + 1);
    }
    const hourlyDist = Array.from(hourlyMap.entries()).map(([hour, requests]) => ({ hour, requests }));

    return c.json({
      today: {
        requests: todayStats.requests,
        tokens: todayStats.tokens,
        successRate: todayStats.requests > 0 ? Math.round((todayStats.success_count / todayStats.requests) * 1000) / 10 : 100,
        avgLatency: Math.round(todayStats.avg_latency),
      },
      yesterday: { requests: yesterdayStats.requests, tokens: yesterdayStats.tokens },
      dailyTrend,
      endpointDist,
      modelDist,
      accountRanking,
      apiKeyRanking,
      hourlyDist,
    });
  });

  // --- API Keys ---
  admin.get('/api-keys', (c) => {
    return c.json({ keys: listApiKeys() });
  });

  admin.post('/api-keys', async (c) => {
    const body = await c.req.json();
    const apiKey = createApiKey(body.name, body.key);
    return c.json(apiKey, 201);
  });

  admin.patch('/api-keys/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const apiKey = getApiKeyById(id);
    if (!apiKey) return c.json({ error: 'Not found' }, 404);
    updateApiKey(id, { name: body.name, is_active: body.is_active });
    return c.json({ message: 'Updated' });
  });

  admin.delete('/api-keys/:id', (c) => {
    const id = c.req.param('id');
    const apiKey = getApiKeyById(id);
    if (!apiKey) return c.json({ error: 'Not found' }, 404);
    deleteApiKey(id);
    return c.json({ message: 'Deleted' });
  });

  admin.get('/api-keys/:id/stats', (c) => {
    const id = c.req.param('id');
    const apiKey = getApiKeyById(id);
    if (!apiKey) return c.json({ error: 'Not found' }, 404);

    const keyLogs = getLogsByApiKeyId(id);
    const stats = calculateLogStats(keyLogs);

    return c.json({ ...apiKey, stats });
  });

  // --- Config ---
  admin.get('/config', (c) => {
    return c.json({
      port: config.port,
      maxReplayMessages: config.maxReplayMessages,
      maxQueryChars: config.maxQueryChars,
      contextResetThreshold: config.contextResetThreshold,
      maxConcurrentPerAccount: config.maxConcurrentPerAccount,
      thinkMode: config.thinkMode,
      sessionTtlDays: config.sessionTtlDays,
      sessionIsolation: config.sessionIsolation,
    });
  });

  admin.patch('/config', async (c) => {
    const body = await c.req.json();
    const numericKeys = ['maxReplayMessages', 'maxQueryChars', 'contextResetThreshold', 'maxConcurrentPerAccount', 'sessionTtlDays'];
    for (const key of numericKeys) {
      if (body[key] !== undefined) {
        const v = Number(body[key]);
        if (v > 0) {
          (config as Record<string, unknown>)[key] = v;
          saveSetting(key, String(v));
        }
      }
    }
    if (body.thinkMode && ['passthrough', 'strip', 'separate'].includes(body.thinkMode)) {
      (config as Record<string, unknown>).thinkMode = body.thinkMode;
      saveSetting('thinkMode', body.thinkMode);
    }
    if (body.sessionIsolation && ['manual', 'auto', 'per-request'].includes(body.sessionIsolation)) {
      (config as Record<string, unknown>).sessionIsolation = body.sessionIsolation;
      saveSetting('sessionIsolation', body.sessionIsolation);
    }
    return c.json({ message: 'Config updated' });
  });

  admin.patch('/admin-key', async (c) => {
    const body = await c.req.json();
    if (!body.newKey || typeof body.newKey !== 'string' || body.newKey.trim().length === 0) {
      return c.json({ error: 'New key is required' }, 400);
    }
    const newKey = body.newKey.trim();
    (config as Record<string, unknown>).adminKey = newKey;
    saveSetting('adminKey', newKey);
    return c.json({ message: 'Admin key updated' });
  });

  app.route('/admin', admin);
}
