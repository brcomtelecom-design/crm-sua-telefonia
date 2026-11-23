import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','operator')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS installations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_installations_tenant ON installations(tenant_id, active);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  kind TEXT NOT NULL CHECK(kind IN ('waba','qr')),
  name TEXT NOT NULL,
  external_id TEXT,
  waba_id TEXT,
  access_token_encrypted TEXT,
  app_secret_encrypted TEXT,
  verify_token_hash TEXT,
  status TEXT NOT NULL DEFAULT 'inactive',
  desired INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_activity_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounts_tenant ON accounts(tenant_id, kind);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_external ON accounts(kind, external_id) WHERE external_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  remote_id TEXT NOT NULL,
  customer_name TEXT,
  last_message_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(account_id, remote_id)
);
CREATE INDEX IF NOT EXISTS idx_conversations_tenant ON conversations(tenant_id, last_message_at DESC, id);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  direction TEXT NOT NULL CHECK(direction IN ('in','out')),
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_message_id TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at DESC, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idempotency ON messages(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_provider ON messages(tenant_id, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS webhook_receipts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  event_key TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  payload_encrypted TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE(tenant_id, account_id, event_key)
);
CREATE TABLE IF NOT EXISTS campaign_uploads (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  file_path TEXT NOT NULL,
  original_name TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  row_count INTEGER NOT NULL,
  cell_count INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('uploaded','parsed','rejected','expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_campaign_uploads_tenant ON campaign_uploads(tenant_id, created_at DESC);
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  account_id TEXT REFERENCES accounts(id),
  installation_id TEXT REFERENCES installations(id),
  upload_id TEXT REFERENCES campaign_uploads(id),
  name TEXT NOT NULL,
  executor TEXT NOT NULL CHECK(executor IN ('web','local')),
  status TEXT NOT NULL CHECK(status IN ('draft','queued','running','paused','cancelled','completed','failed','pending_agent')),
  audience_count INTEGER NOT NULL DEFAULT 0,
  template_name TEXT NOT NULL,
  parameters_json TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_campaigns_tenant ON campaigns(tenant_id, created_at DESC);
CREATE TABLE IF NOT EXISTS campaign_recipients (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  row_number INTEGER NOT NULL,
  phone_encrypted TEXT NOT NULL,
  phone_digest TEXT NOT NULL,
  payload_encrypted TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','delivered','read','failed','cancelled','uncertain')),
  provider_message_id TEXT,
  error_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_queue ON campaign_recipients(status, campaign_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_recipients_row ON campaign_recipients(campaign_id, row_number);
CREATE TABLE IF NOT EXISTS campaign_receipts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  recipient_id TEXT NOT NULL REFERENCES campaign_recipients(id),
  provider_message_id TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_campaign_receipts_replay ON campaign_receipts(campaign_id, recipient_id, received_at);
CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  installation_id TEXT NOT NULL REFERENCES installations(id),
  type TEXT NOT NULL CHECK(type IN ('query_audience','create_campaign','start_campaign','pause_campaign','cancel_campaign')),
  payload_json TEXT NOT NULL,
  digest TEXT NOT NULL,
  executor TEXT NOT NULL DEFAULT 'local' CHECK(executor='local'),
  status TEXT NOT NULL CHECK(status IN ('queued','claimed','succeeded','failed','cancelled')),
  lease_id TEXT,
  fence INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT,
  result_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_commands_queue ON commands(installation_id, status, created_at, id);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  installation_id TEXT NOT NULL REFERENCES installations(id),
  event_key TEXT NOT NULL,
  digest TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE(installation_id, event_key)
);
CREATE TABLE IF NOT EXISTS qr_sessions (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  phase TEXT NOT NULL,
  qr_payload_encrypted TEXT,
  qr_expires_at TEXT,
  error_code TEXT,
  updated_at TEXT NOT NULL
);
`;

function addColumnIfMissing(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(SCHEMA);
  addColumnIfMissing(db, 'accounts', 'waba_id', 'TEXT');
  addColumnIfMissing(db, 'campaigns', 'account_id', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_campaigns_account ON campaigns(tenant_id, account_id, created_at DESC)');
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

export function newId() {
  return randomUUID();
}

export function nowIso() {
  return new Date().toISOString();
}
