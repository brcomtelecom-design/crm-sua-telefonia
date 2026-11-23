import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir, baseConfig, startApp, stopApp, login } from './helpers.mjs';

test('QR Web permanece desabilitado por padrão e expõe gate explícito', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));
  const owner = await login(app);
  const account = (await (await fetch(`${app.baseUrl}/api/qr-accounts`, {
    method: 'POST', headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'QR local' }),
  })).json());
  const response = await fetch(`${app.baseUrl}/api/qr-accounts/${account.id}/connect`, {
    method: 'POST', headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf },
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, 'QR_DISABLED');
});
