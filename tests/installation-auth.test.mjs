import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir, baseConfig, startApp, stopApp, login } from './helpers.mjs';

test('token de instalação não pode consultar empresa arbitrária', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));
  const owner = await login(app);
  const installation = (await (await fetch(`${app.baseUrl}/api/installations`, {
    method: 'POST', headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Agente' }),
  })).json()).installation;
  const response = await fetch(`${app.baseUrl}/api/agent/v1/commands?limit=10`, { headers: { Authorization: `Bearer ${installation.token}` } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).items, []);
  const invalid = await fetch(`${app.baseUrl}/api/agent/v1/commands?limit=10`, { headers: { Authorization: 'Bearer invalid' } });
  assert.equal(invalid.status, 401);
});
