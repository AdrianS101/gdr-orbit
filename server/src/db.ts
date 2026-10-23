import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';

export const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

// Migrações em ordem; cada uma roda uma única vez.
const migrations: string[] = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE sessions (token TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
  CREATE TABLE brands (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
    profile TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE assets (
    id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, name TEXT NOT NULL, ext TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT 'upload', proxy INTEGER NOT NULL DEFAULT 0, waveform INTEGER NOT NULL DEFAULT 0,
    filmstrip TEXT, created_at TEXT NOT NULL,
    UNIQUE (brand_id, sha256)
  );
  CREATE TABLE transcripts (
    asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
    language TEXT NOT NULL, model TEXT NOT NULL, text TEXT NOT NULL, words TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', timeline TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE project_versions (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL, label TEXT, auto INTEGER NOT NULL DEFAULT 1, timeline TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX idx_versions_project ON project_versions(project_id, created_at);
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
    brand_id TEXT, project_id TEXT, asset_id TEXT,
    payload TEXT NOT NULL DEFAULT '{}', checkpoint TEXT, result TEXT, error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
  );
  CREATE INDEX idx_jobs_status ON jobs(status, created_at);
  CREATE TABLE exports (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    brand_id TEXT NOT NULL, job_id TEXT, file TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
    settings TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE post_drafts (
    id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL, export_id TEXT,
    network TEXT NOT NULL, objective TEXT, content TEXT NOT NULL, provider TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE social_accounts (
    id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    network TEXT NOT NULL, external_id TEXT NOT NULL, name TEXT NOT NULL, username TEXT, avatar TEXT,
    page_id TEXT, token TEXT, status TEXT NOT NULL DEFAULT 'connected', verified_at TEXT, error TEXT,
    created_at TEXT NOT NULL, UNIQUE (brand_id, network, external_id)
  );
  CREATE TABLE posts (
    id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    project_id TEXT, type TEXT NOT NULL, media TEXT NOT NULL, caption TEXT NOT NULL DEFAULT '',
    captions TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'draft',
    scheduled_at TEXT, timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_posts_sched ON posts(status, scheduled_at);
  CREATE TABLE post_targets (
    id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL, network TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    container_id TEXT, external_id TEXT, permalink TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    published_at TEXT, UNIQUE (post_id, account_id)
  );
  `,
  `
  ALTER TABLE assets ADD COLUMN source_ref TEXT;
  CREATE INDEX idx_assets_ref ON assets(brand_id, source_ref);
  CREATE TABLE drive_folders (
    id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    folder_id TEXT NOT NULL, name TEXT NOT NULL, auto_import INTEGER NOT NULL DEFAULT 0,
    last_check TEXT, new_count INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL,
    UNIQUE (brand_id, folder_id)
  );
  `,
  `
  CREATE TABLE media_items (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
    network TEXT NOT NULL, external_id TEXT NOT NULL, type TEXT, caption TEXT, permalink TEXT, thumb TEXT,
    posted_at TEXT, metrics TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL,
    UNIQUE (account_id, external_id)
  );
  CREATE INDEX idx_media_posted ON media_items(account_id, posted_at);
  CREATE TABLE insight_cache (key TEXT PRIMARY KEY, data TEXT NOT NULL, fetched_at TEXT NOT NULL);
  `,
  `
  CREATE TABLE contacts (
    id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
    network TEXT NOT NULL, external_id TEXT NOT NULL, username TEXT, name TEXT, avatar TEXT,
    tags TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'open', paused INTEGER NOT NULL DEFAULT 0,
    conversation_id TEXT, last_message_at TEXT, last_inbound_at TEXT, unread INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, UNIQUE (account_id, external_id)
  );
  CREATE INDEX idx_contacts_brand ON contacts(brand_id, last_message_at);
  CREATE TABLE messages (
    id TEXT PRIMARY KEY, contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    direction TEXT NOT NULL, kind TEXT NOT NULL, external_id TEXT, text TEXT NOT NULL DEFAULT '',
    context TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL, author TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX idx_messages_ext ON messages(contact_id, external_id) WHERE external_id IS NOT NULL;
  CREATE INDEX idx_messages_contact ON messages(contact_id, created_at);
  CREATE TABLE automations (
    id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE automation_runs (
    id TEXT PRIMARY KEY, automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
    trigger_id TEXT NOT NULL, contact_id TEXT, step TEXT NOT NULL, status TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL,
    UNIQUE (automation_id, trigger_id, step)
  );
  `,
  `
  CREATE TABLE ideas (
    id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    title TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'manual',
    status TEXT NOT NULL DEFAULT 'idea', script TEXT, project_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_ideas_brand ON ideas(brand_id, created_at);
  `,
  `
  CREATE TABLE automation_flows (
    id TEXT PRIMARY KEY, automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL, recipient_id TEXT NOT NULL, contact_id TEXT, comment_id TEXT NOT NULL,
    stage TEXT NOT NULL, checks INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE (automation_id, recipient_id)
  );
  CREATE INDEX idx_flows_recipient ON automation_flows(account_id, recipient_id);
  `,
  `ALTER TABLE posts ADD COLUMN cover TEXT;`,
  `
  ALTER TABLE media_items ADD COLUMN source TEXT NOT NULL DEFAULT 'api';
  ALTER TABLE media_items ADD COLUMN import_batch TEXT;
  CREATE TABLE metric_imports (
    id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE, account_id TEXT NOT NULL,
    file TEXT NOT NULL, rows INTEGER NOT NULL, created_at TEXT NOT NULL
  );
  `,
  `ALTER TABLE contacts ADD COLUMN profile_checked_at TEXT;`,
];

db.exec('CREATE TABLE IF NOT EXISTS _migrations (n INTEGER PRIMARY KEY)');
const done = new Set((db.prepare('SELECT n FROM _migrations').all() as { n: number }[]).map((r) => r.n));
migrations.forEach((sql, i) => {
  if (done.has(i)) return;
  db.exec('BEGIN');
  try {
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (n) VALUES (?)').run(i);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

export const now = () => new Date().toISOString();

export function getSetting<T>(key: string, fallback: T): T {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return r ? (JSON.parse(r.value) as T) : fallback;
}

export function setSetting(key: string, value: unknown) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

export function tx<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
