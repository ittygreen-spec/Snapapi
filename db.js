const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'snapapi.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key TEXT UNIQUE NOT NULL,
    quota INTEGER NOT NULL DEFAULT 100,
    used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    target_url TEXT,
    ip TEXT,
    status INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tokens (
    id TEXT PRIMARY KEY,
    plan TEXT NOT NULL DEFAULT 'free',
    quota INTEGER NOT NULL DEFAULT 100,
    used INTEGER NOT NULL DEFAULT 0,
    email TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Create default tokens if none exist
const count = db.prepare('SELECT COUNT(*) as c FROM tokens').get();
if (count.c === 0) {
  const { v4: uuidv4 } = require('uuid');
  const adminkey = 'snap_' + uuidv4().replace(/-/g, '').substring(0, 16);
  db.prepare('INSERT INTO tokens (id, plan, quota, used, email) VALUES (?, ?, ?, ?, ?)').run(uuidv4(), 'admin', 10000, 0, 'admin@snapapi.dev');
  console.log('✨ Created admin token:', adminkey);

  // Demo token using "demo" as the key
  db.prepare('INSERT INTO tokens (id, plan, quota, used, email) VALUES (?, ?, ?, ?, ?)').run('demo', 'free', 500, 0, 'demo@snapapi.dev');
  console.log('✨ Demo token: demo');

  // If DEMO_API_KEY env var is set, ensure it exists as a token
if (process.env.DEMO_API_KEY) {
  const demoKey = process.env.DEMO_API_KEY;
  const existing = db.prepare('SELECT * FROM tokens WHERE id = ?').get(demoKey);
  if (!existing) {
    db.prepare('INSERT INTO tokens (id, plan, quota, used, email) VALUES (?, ?, ?, ?, ?)').run(demoKey, 'free', 500, 0, 'demo@snapapi.dev');
    console.log('✨ Seeded DEMO_API_KEY:', demoKey);
  }
}

module.exports = db;