import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = path.join(__dirname, '..', 'dbdata');
import { mkdirSync } from 'fs';
mkdirSync(DB_DIR, { recursive: true });
const DB_PATH = path.join(DB_DIR, 'mimo-proxy.db');
export const db = new Database(DB_PATH);

export function initDb() {
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      alias TEXT,
      service_token TEXT NOT NULL,
      user_id TEXT NOT NULL,
      ph_token TEXT NOT NULL,
      api_key TEXT NOT NULL UNIQUE,
      is_active INTEGER DEFAULT 1,
      active_requests INTEGER DEFAULT 0,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      client_session_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      last_message_fingerprint TEXT DEFAULT '',
      cumulative_prompt_tokens INTEGER DEFAULT 0,
      is_expired INTEGER DEFAULT 0,
      created_at TEXT,
      last_used_at TEXT,
      UNIQUE(account_id, client_session_id)
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      name TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      request_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS request_logs (
      id TEXT PRIMARY KEY,
      account_id TEXT,
      session_id TEXT,
      api_key_id TEXT,
      endpoint TEXT,
      model TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      reasoning_tokens INTEGER,
      duration_ms INTEGER,
      status TEXT,
      error TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // 迁移：添加 last_message_fingerprint 列（如果不存在）
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN last_message_fingerprint TEXT DEFAULT ''`);
    console.log('[DB] Added last_message_fingerprint column to sessions table');
  } catch (err: any) {
    if (!err.message.includes('duplicate column name')) {
      console.error('[DB] Migration error:', err);
    }
  }

  // 迁移：添加 api_key_id 列到 request_logs（如果不存在）
  try {
    db.exec(`ALTER TABLE request_logs ADD COLUMN api_key_id TEXT`);
    console.log('[DB] Added api_key_id column to request_logs table');
  } catch (err: any) {
    if (!err.message.includes('duplicate column name')) {
      console.error('[DB] Migration error:', err);
    }
  }

  // 清理旧的列（如果存在）
  const columns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  const hasOldColumns = columns.some(c => c.name === 'last_messages_hash' || c.name === 'last_msg_count');
  
  if (hasOldColumns) {
    console.log('[DB] Migrating sessions table to remove old columns...');
    db.exec(`
      CREATE TABLE sessions_new (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        client_session_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        last_message_fingerprint TEXT DEFAULT '',
        cumulative_prompt_tokens INTEGER DEFAULT 0,
        is_expired INTEGER DEFAULT 0,
        created_at TEXT,
        last_used_at TEXT,
        UNIQUE(account_id, client_session_id)
      );
      
      INSERT INTO sessions_new (id, account_id, client_session_id, conversation_id, cumulative_prompt_tokens, is_expired, created_at, last_used_at)
      SELECT id, account_id, client_session_id, conversation_id, cumulative_prompt_tokens, is_expired, created_at, last_used_at
      FROM sessions;
      
      DROP TABLE sessions;
      ALTER TABLE sessions_new RENAME TO sessions;
    `);
    console.log('[DB] Migration completed');
  }
}
