import { getLogFilePath } from './logger.js';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initDb } from './db.js';
import { registerOpenAI } from './adapters/openai.js';
import { registerAnthropic } from './adapters/anthropic.js';
import { registerAdmin } from './admin/routes.js';
import { config, loadConfig } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = new Hono();

initDb();
loadConfig();

app.use('/*', cors());

// Web UI
app.get('/', (c) => {
  const html = readFileSync(join(__dirname, 'web', 'index.html'), 'utf-8');
  return c.html(html);
});

app.get('/style.css', (c) => {
  const css = readFileSync(join(__dirname, 'web', 'style.css'), 'utf-8');
  c.header('Content-Type', 'text/css');
  return c.body(css);
});

app.get('/chart.js', (c) => {
  const js = readFileSync(join(__dirname, 'web', 'chart.js'), 'utf-8');
  c.header('Content-Type', 'application/javascript');
  return c.body(js);
});

// Health
app.get('/health', (c) => c.json({ status: 'ok', ts: Date.now() }));

// Routes
registerOpenAI(app);
registerAnthropic(app);
registerAdmin(app);

serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`MiMo Proxy running on http://localhost:${config.port}`);
  console.log(`Admin UI: http://localhost:${config.port}/`);
  console.log(`THINK_MODE: ${config.thinkMode}`);
  console.log(`Log file: ${getLogFilePath()}`);
});

export default app;
