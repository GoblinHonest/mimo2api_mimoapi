import { Hono } from 'hono';
import { config } from '../config.js';
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
import { db } from '../db.js';
import { callMimo } from '../mimo/client.js';
import { v4 as uuidv4 } from 'uuid';
function saveSetting(key: string, value: string) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

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

    const total = (db.prepare('SELECT COUNT(*) as cnt FROM accounts').get() as { cnt: number }).cnt;
    const accounts = db.prepare(`
      SELECT a.id, a.alias, a.user_id, a.service_token, a.ph_token, a.api_key,
             a.is_active, a.active_requests, a.created_at,
             COALESCE(COUNT(l.id), 0) as total_requests,
             COALESCE(SUM(l.prompt_tokens), 0) as total_prompt_tokens,
             COALESCE(SUM(l.completion_tokens), 0) as total_completion_tokens
      FROM accounts a
      LEFT JOIN request_logs l ON a.id = l.account_id
      GROUP BY a.id
      ORDER BY a.created_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);
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
      const convId = uuidv4().replace(/-/g, '');
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
    db.prepare('DELETE FROM sessions').run();
    return c.json({ message: 'All sessions deleted' });
  });

  // --- Logs ---
  admin.get('/logs', (c) => {
    const accountId = c.req.query('account_id');
    const status = c.req.query('status');
    const page = Number(c.req.query('page') ?? 1);
    const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);
    const offset = (page - 1) * limit;

    let sql = 'SELECT * FROM request_logs WHERE 1=1';
    const params: unknown[] = [];
    if (accountId) { sql += ' AND account_id = ?'; params.push(accountId); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const logs = db.prepare(sql).all(...params);
    const total = (db.prepare('SELECT COUNT(*) as cnt FROM request_logs').get() as { cnt: number }).cnt;
    return c.json({ logs, total, page, limit });
  });

  // --- Stats ---
  admin.get('/stats', (c) => {
    const page = Math.max(1, Number(c.req.query('page') ?? 1));
    const limit = Math.min(Math.max(1, Number(c.req.query('limit') ?? 10)), 100);
    const offset = (page - 1) * limit;

    const totalAccounts = (db.prepare('SELECT COUNT(*) as cnt FROM accounts').get() as { cnt: number }).cnt;
    const accounts = db.prepare(`
      SELECT a.id, a.alias, a.api_key, a.is_active, a.active_requests,
             COALESCE(SUM(l.prompt_tokens), 0) as total_prompt_tokens,
             COALESCE(SUM(l.completion_tokens), 0) as total_completion_tokens,
             COUNT(l.id) as total_requests
      FROM accounts a
      LEFT JOIN request_logs l ON a.id = l.account_id
      GROUP BY a.id
      LIMIT ? OFFSET ?
    `).all(limit, offset);

    // 全量汇总（不受分页影响）
    const totals = db.prepare(`
      SELECT COALESCE(SUM(l.prompt_tokens), 0) as total_prompt_tokens,
             COALESCE(SUM(l.completion_tokens), 0) as total_completion_tokens
      FROM request_logs l
    `).get() as { total_prompt_tokens: number; total_completion_tokens: number };

    return c.json({
      accounts, maxConcurrent: config.maxConcurrentPerAccount,
      totalAccounts, page, limit,
      totalPromptTokens: totals.total_prompt_tokens,
      totalCompletionTokens: totals.total_completion_tokens,
    });
  });

  admin.get('/stats/api-keys', (c) => {
    const page = Math.max(1, Number(c.req.query('page') ?? 1));
    const limit = Math.min(Math.max(1, Number(c.req.query('limit') ?? 10)), 100);
    const offset = (page - 1) * limit;

    const total = (db.prepare('SELECT COUNT(*) as cnt FROM api_keys').get() as { cnt: number }).cnt;
    const apiKeys = db.prepare(`
      SELECT k.id, k.key, k.name, k.is_active, k.request_count, k.last_used_at,
             COALESCE(COUNT(l.id), 0) as total_requests,
             COALESCE(SUM(l.prompt_tokens), 0) as total_prompt_tokens,
             COALESCE(SUM(l.completion_tokens), 0) as total_completion_tokens
      FROM api_keys k
      LEFT JOIN request_logs l ON k.id = l.api_key_id
      GROUP BY k.id
      ORDER BY k.created_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);
    return c.json({ apiKeys, total, page, limit });
  });

  admin.get('/stats/overview', (c) => {
    // 1. 今日概览
    const today = db.prepare(`
      SELECT COUNT(*) as requests,
             COALESCE(SUM(prompt_tokens + completion_tokens + reasoning_tokens), 0) as tokens,
             COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END), 0) as success_count,
             COALESCE(AVG(CASE WHEN status='success' THEN duration_ms END), 0) as avg_latency
      FROM request_logs WHERE date(created_at) = date('now')
    `).get() as any;

    const yesterday = db.prepare(`
      SELECT COUNT(*) as requests,
             COALESCE(SUM(prompt_tokens + completion_tokens + reasoning_tokens), 0) as tokens
      FROM request_logs WHERE date(created_at) = date('now', '-1 day')
    `).get() as any;

    // 2. 每日趋势（最近 30 天）
    const dailyTrend = db.prepare(`
      SELECT date(created_at) as date,
             COALESCE(SUM(prompt_tokens), 0) as input_tokens,
             COALESCE(SUM(completion_tokens), 0) as output_tokens,
             COUNT(*) as requests
      FROM request_logs
      WHERE created_at >= date('now', '-30 days')
      GROUP BY date(created_at)
      ORDER BY date ASC
    `).all();

    // 3. 端点分布
    const endpointDist = db.prepare(`
      SELECT endpoint,
             COUNT(*) as requests,
             COALESCE(SUM(prompt_tokens + completion_tokens), 0) as tokens
      FROM request_logs
      GROUP BY endpoint
    `).all();

    // 4. 模型分布（Top 5）
    const modelDist = db.prepare(`
      SELECT model,
             COUNT(*) as requests,
             COALESCE(SUM(prompt_tokens + completion_tokens), 0) as tokens
      FROM request_logs
      WHERE model IS NOT NULL AND model != ''
      GROUP BY model
      ORDER BY tokens DESC
      LIMIT 5
    `).all();

    // 5. 账号排行（Top 10）
    const accountRanking = db.prepare(`
      SELECT COALESCE(a.alias, a.user_id) as name,
             COALESCE(SUM(l.prompt_tokens + l.completion_tokens), 0) as tokens,
             COUNT(l.id) as requests
      FROM request_logs l
      LEFT JOIN accounts a ON l.account_id = a.id
      GROUP BY l.account_id
      ORDER BY tokens DESC
      LIMIT 10
    `).all();

    // 6. API Key 排行（Top 10）
    const apiKeyRanking = db.prepare(`
      SELECT COALESCE(k.name, k.key) as name,
             COALESCE(SUM(l.prompt_tokens + l.completion_tokens), 0) as tokens,
             COUNT(l.id) as requests
      FROM request_logs l
      LEFT JOIN api_keys k ON l.api_key_id = k.id
      WHERE l.api_key_id IS NOT NULL
      GROUP BY l.api_key_id
      ORDER BY tokens DESC
      LIMIT 10
    `).all();

    // 7. 每小时分布（今天）
    const hourlyDist = db.prepare(`
      SELECT CAST(strftime('%H', created_at) AS INTEGER) as hour,
             COUNT(*) as requests
      FROM request_logs
      WHERE date(created_at) = date('now')
      GROUP BY hour
      ORDER BY hour
    `).all();

    return c.json({
      today: {
        requests: today.requests,
        tokens: today.tokens,
        successRate: today.requests > 0 ? Math.round((today.success_count / today.requests) * 1000) / 10 : 100,
        avgLatency: Math.round(today.avg_latency),
      },
      yesterday: { requests: yesterday.requests, tokens: yesterday.tokens },
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

    const stats = db.prepare(`
      SELECT COUNT(*) as total_requests,
             COALESCE(SUM(prompt_tokens), 0) as total_prompt_tokens,
             COALESCE(SUM(completion_tokens), 0) as total_completion_tokens
      FROM request_logs
      WHERE api_key_id = ?
    `).get(id);

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
