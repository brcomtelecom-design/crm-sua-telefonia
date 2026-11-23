import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir, baseConfig, startApp, stopApp, login } from './helpers.mjs';

test('cadastro protegido de conta WABA não devolve token nem app secret', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));
  const owner = await login(app);
  const response = await fetch(`${app.baseUrl}/api/waba-accounts`, {
    method: 'POST',
    headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'WABA', externalId: '1234567890', wabaId: '9876543210', accessToken: 'synthetic-access-token-12345', appSecret: 'synthetic-app-secret' }),
  });
  assert.equal(response.status, 201);
  const text = await response.text();
  assert.doesNotMatch(text, /synthetic-access-token/);
  assert.doesNotMatch(text, /synthetic-app-secret/);
  assert.doesNotMatch(text, /synthetic-verify-token/);
  const list = await fetch(`${app.baseUrl}/api/accounts`, { headers: { Cookie: owner.cookie } });
  const listText = await list.text();
  assert.doesNotMatch(listText, /synthetic-access-token/);
  assert.doesNotMatch(listText, /synthetic-app-secret/);
});
