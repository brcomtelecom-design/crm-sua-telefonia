import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir, baseConfig, startApp, stopApp, login } from './helpers.mjs';
import { newId, nowIso } from '../src/db.mjs';
import { hashPassword } from '../src/security.mjs';

async function addTenant(app) {
  const tenantId = newId();
  const userId = newId();
  const password = await hashPassword('Other-Tenant-Password-99!');
  app.db.prepare('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)').run(tenantId, 'Outra empresa', nowIso());
  app.db.prepare('INSERT INTO users(id,tenant_id,email,password_hash,password_salt,role,active,created_at) VALUES(?,?,?,?,?,?,1,?)')
    .run(userId, tenantId, 'other@example.test', password.hash, password.salt, 'operator', nowIso());
  return tenantId;
}

test('recursos de uma empresa não são acessíveis por outra empresa', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));
  const owner = await login(app);
  const account = await fetch(`${app.baseUrl}/api/qr-accounts`, {
    method: 'POST', headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Conta isolada' }),
  });
  const created = await account.json();
  assert.equal(account.status, 201);
  await addTenant(app);
  const other = await login(app, 'other@example.test', 'Other-Tenant-Password-99!');
  const access = await fetch(`${app.baseUrl}/api/qr-accounts/${created.id}`, { headers: { Cookie: other.cookie } });
  assert.equal(access.status, 404);
  const list = await fetch(`${app.baseUrl}/api/accounts`, { headers: { Cookie: other.cookie } });
  assert.deepEqual((await list.json()).items, []);
});
