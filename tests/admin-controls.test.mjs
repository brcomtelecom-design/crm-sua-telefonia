import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir, baseConfig, startApp, stopApp, login } from './helpers.mjs';
import { sessionHeaders } from './fixtures.mjs';
import { cleanupExpiredUploads, storeCampaignUpload } from '../src/campaigns.mjs';
import { newId, nowIso } from '../src/db.mjs';

async function createWaba(app, owner, overrides = {}) {
  const response = await fetch(`${app.baseUrl}/api/waba-accounts`, {
    method: 'POST',
    headers: sessionHeaders(owner, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      name: 'WABA sintética',
      externalId: '1234567890',
      wabaId: '9876543210',
      accessToken: 'synthetic-access-token-12345',
      appSecret: 'synthetic-app-secret',
      ...overrides,
    }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

test('administrador cria outra empresa e o novo usuário fica isolado dos recursos existentes', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));
  const owner = await login(app);
  const account = await createWaba(app, owner);

  const createdTenant = await fetch(`${app.baseUrl}/api/admin/tenants`, {
    method: 'POST',
    headers: sessionHeaders(owner, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      name: 'Empresa Secondária',
      email: 'admin-secondaria@example.test',
      password: 'Second-Tenant-Password-99!',
      role: 'admin',
    }),
  });
  assert.equal(createdTenant.status, 201);
  const created = (await createdTenant.json()).user;
  assert.equal(created.role, 'admin');
  assert.ok(created.tenantId);

  const other = await login(app, 'admin-secondaria@example.test', 'Second-Tenant-Password-99!');
  const accounts = await fetch(`${app.baseUrl}/api/accounts`, { headers: { Cookie: other.cookie } });
  assert.deepEqual((await accounts.json()).items, []);
  const forbidden = await fetch(`${app.baseUrl}/api/waba-accounts/${account.id}`, {
    method: 'PATCH',
    headers: sessionHeaders(other, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ status: 'active' }),
  });
  assert.equal(forbidden.status, 404);
});

test('cadastro WABA preserva wabaId e ativação é explícita e isolada por empresa', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));
  const owner = await login(app);
  const account = await createWaba(app, owner);
  assert.equal(account.wabaId, '9876543210');
  assert.equal(account.status, 'inactive');

  const list = await fetch(`${app.baseUrl}/api/accounts`, { headers: { Cookie: owner.cookie } });
  const listed = (await list.json()).items.find((item) => item.id === account.id);
  assert.equal(listed.wabaId, '9876543210');
  assert.equal(listed.status, 'inactive');
  assert.equal(listed.credentialsConfigured, undefined);

  const activated = await fetch(`${app.baseUrl}/api/waba-accounts/${account.id}`, {
    method: 'PATCH',
    headers: sessionHeaders(owner, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ status: 'active' }),
  });
  assert.equal(activated.status, 200);
  assert.equal((await activated.json()).status, 'active');
});

test('limpeza expira uploads e não apaga arquivo fora do diretório temporário', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));
  const owner = await login(app);
  const tempDir = path.join(temp, 'campaign-temp');
  const upload = storeCampaignUpload(app.db, owner.body.user.tenantId, tempDir, Buffer.from('synthetic'), 'audiencia.xlsx');
  assert.equal(fs.existsSync(upload.filePath), true);
  app.db.prepare('UPDATE campaign_uploads SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), upload.id);
  const removed = cleanupExpiredUploads(app.db, tempDir);
  assert.ok(removed >= 1);
  assert.equal(fs.existsSync(upload.filePath), false);
  assert.equal(app.db.prepare('SELECT status FROM campaign_uploads WHERE id=?').get(upload.id).status, 'expired');

  const outside = path.join(temp, 'nao-deve-ser-removido.txt');
  fs.writeFileSync(outside, 'preservar', 'utf8');
  const outsideId = newId();
  app.db.prepare(`INSERT INTO campaign_uploads(id,tenant_id,file_path,original_name,sha256,size_bytes,row_count,cell_count,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(outsideId, owner.body.user.tenantId, outside, 'fora.xlsx', 'synthetic', 8, 0, 0, 'uploaded', nowIso(), new Date(Date.now() - 1000).toISOString());
  cleanupExpiredUploads(app.db, tempDir);
  assert.equal(fs.existsSync(outside), true);
});
