import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir, baseConfig, startApp, stopApp } from './helpers.mjs';

test('desafio WABA valida modo e verify token', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));
  const valid = await fetch(`${app.baseUrl}/api/meta/webhook?hub.mode=subscribe&hub.verify_token=synthetic-verify-token&hub.challenge=12345`);
  assert.equal(valid.status, 200);
  assert.equal(await valid.text(), '12345');
  const invalid = await fetch(`${app.baseUrl}/api/meta/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345`);
  assert.equal(invalid.status, 403);
});
