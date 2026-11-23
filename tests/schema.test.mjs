import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { makeTempDir } from './helpers.mjs';
import { openDatabase } from '../src/db.mjs';

test('openDatabase migra colunas novas em banco existente sem perder dados', () => {
  const temp = makeTempDir();
  const dbPath = path.join(temp, 'legacy.sqlite');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
      external_id TEXT, access_token_encrypted TEXT, app_secret_encrypted TEXT, verify_token_hash TEXT,
      status TEXT NOT NULL DEFAULT 'inactive', desired INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      last_activity_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE campaigns (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, installation_id TEXT, upload_id TEXT, name TEXT NOT NULL,
      executor TEXT NOT NULL, status TEXT NOT NULL, audience_count INTEGER NOT NULL DEFAULT 0,
      template_name TEXT NOT NULL, parameters_json TEXT NOT NULL DEFAULT '{}', idempotency_key TEXT NOT NULL,
      digest TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO accounts(id,tenant_id,kind,name,status,created_at,updated_at) VALUES('legacy-account','tenant','waba','Legada','inactive','now','now');
  `);
  legacy.close();

  const db = openDatabase(dbPath);
  try {
    const accountColumns = new Set(db.prepare('PRAGMA table_info(accounts)').all().map((row) => row.name));
    const campaignColumns = new Set(db.prepare('PRAGMA table_info(campaigns)').all().map((row) => row.name));
    assert.equal(accountColumns.has('waba_id'), true);
    assert.equal(campaignColumns.has('account_id'), true);
    assert.equal(db.prepare('SELECT name FROM accounts WHERE id=?').get('legacy-account').name, 'Legada');
  } finally {
    db.close();
  }
});

test('frontend JavaScript permanece sintaticamente válido', () => {
  const script = path.resolve('public/app.js');
  const result = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(script), true);
  assert.doesNotMatch(fs.readFileSync(script, 'utf8'), /^await\s/m, 'script clássico não pode usar await no nível superior');
});

test('HTML expõe um único landmark main e descrição da aplicação', () => {
  const html = fs.readFileSync(path.resolve('public/index.html'), 'utf8');
  assert.equal((html.match(/<main(?:\s|>)/g) || []).length, 1);
  assert.match(html, /<meta name="description" content="[^"]+">/);
});

test('layout mobile impede expansão horizontal da grade principal', () => {
  const css = fs.readFileSync(path.resolve('public/styles.css'), 'utf8');
  const start = css.indexOf('@media (max-width: 800px)');
  const end = css.indexOf('@media (max-width: 480px)');
  assert.ok(start >= 0 && end > start);
  const mobileCss = css.slice(start, end);
  assert.match(mobileCss, /\.app-shell\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(mobileCss, /\.sidebar nav\s*\{[^}]*overflow-x:\s*auto/);
});

test('interface de QR expõe criação, permissão administrativa e imagem acessível', () => {
  const script = fs.readFileSync(path.resolve('public/app.js'), 'utf8');
  const html = fs.readFileSync(path.resolve('public/index.html'), 'utf8');
  const css = fs.readFileSync(path.resolve('public/styles.css'), 'utf8');
  assert.match(script, /\$\('#qr-form'\)\.addEventListener\('submit'/);
  assert.match(script, /'#qr-form', '#tenant-form', '#waba-form', '#installation-form'/);
  assert.match(script, /image\.className = 'qr-image'/);
  assert.match(html, /id="qr-form"/);
  assert.match(html, /id="qr-name"/);
  assert.match(css, /\.qr-image\s*\{/);
});
