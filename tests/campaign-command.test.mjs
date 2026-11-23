import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir, baseConfig, startApp, stopApp, login } from './helpers.mjs';

test('tipos de comandos locais são allowlisted e persistem ID + digest', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));
  const owner = await login(app);
  const installation = (await (await fetch(`${app.baseUrl}/api/installations`, {
    method: 'POST', headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Local' }),
  })).json()).installation;
  for (const type of ['query_audience', 'create_campaign', 'start_campaign', 'pause_campaign', 'cancel_campaign']) {
    const payload = type === 'query_audience' ? { filters: { limit: 50 } } : { campaignId: 'campaign-contract-0001' };
    const response = await fetch(`${app.baseUrl}/api/agent-commands`, {
      method: 'POST', headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ installationId: installation.id, type, payload }),
    });
    assert.equal(response.status, 202, type);
    const command = (await response.json()).command;
    assert.ok(command.id);
    assert.match(command.digest, /^[a-f0-9]{64}$/);
    assert.equal(command.executor, 'local');
  }
  const invalid = await fetch(`${app.baseUrl}/api/agent-commands`, {
    method: 'POST', headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ installationId: installation.id, type: 'drop_database', payload: {} }),
  });
  assert.equal(invalid.status, 400);
});
