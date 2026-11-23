import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir, baseConfig, startApp, stopApp, login } from './helpers.mjs';

test('gateway agente v1 resolve tenant, faz claim atômico, exige fence e deduplica eventos', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));
  const owner = await login(app);
  const installationResponse = await fetch(`${app.baseUrl}/api/installations`, {
    method: 'POST', headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Agente sintético' }),
  });
  const installation = (await installationResponse.json()).installation;
  const commandResponse = await fetch(`${app.baseUrl}/api/agent-commands`, {
    method: 'POST', headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ installationId: installation.id, type: 'query_audience', payload: { filters: { city: 'Joinville', limit: 25 } } }),
  });
  assert.equal(commandResponse.status, 202);
  const command = (await commandResponse.json()).command;
  const auth = { Authorization: `Bearer ${installation.token}` };
  const list = await fetch(`${app.baseUrl}/api/agent/v1/commands?limit=10`, { headers: auth });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).items.length, 1);
  const firstClaim = await fetch(`${app.baseUrl}/api/agent/v1/commands/${command.id}/claim`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ leaseId: 'lease-synthetic-0001', fence: 0 }),
  });
  assert.equal(firstClaim.status, 200);
  const claimed = await firstClaim.json();
  assert.equal(claimed.fence, 1);
  const secondClaim = await fetch(`${app.baseUrl}/api/agent/v1/commands/${command.id}/claim`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ leaseId: 'lease-synthetic-0002', fence: 0 }),
  });
  assert.equal(secondClaim.status, 409);
  const staleAck = await fetch(`${app.baseUrl}/api/agent/v1/commands/${command.id}/ack`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ leaseId: 'lease-synthetic-0001', fence: 0, result: { status: 'succeeded' } }),
  });
  assert.equal(staleAck.status, 409);
  const ack = await fetch(`${app.baseUrl}/api/agent/v1/commands/${command.id}/ack`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ leaseId: 'lease-synthetic-0001', fence: 1, result: { status: 'succeeded', payload: { count: 3 } } }),
  });
  assert.equal(ack.status, 200);
  const eventBody = { eventKey: 'event-synthetic-0001', type: 'audience.completed', payload: { count: 3 } };
  const event = await fetch(`${app.baseUrl}/api/agent/v1/events`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(eventBody) });
  assert.equal(event.status, 200);
  assert.equal((await event.json()).repeated, false);
  const repeated = await fetch(`${app.baseUrl}/api/agent/v1/events`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(eventBody) });
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).repeated, true);
  const conflict = await fetch(`${app.baseUrl}/api/agent/v1/events`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...eventBody, payload: { count: 4 } }) });
  assert.equal(conflict.status, 409);
});

test('comando com lease vencido retorna à fila e ACK do lease antigo é rejeitado', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));
  const owner = await login(app);
  const installation = (await (await fetch(`${app.baseUrl}/api/installations`, {
    method: 'POST', headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Agente' }),
  })).json()).installation;
  const command = (await (await fetch(`${app.baseUrl}/api/agent-commands`, {
    method: 'POST', headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ installationId: installation.id, type: 'query_audience', payload: { filters: { limit: 10 } } }),
  })).json()).command;
  const auth = { Authorization: `Bearer ${installation.token}` };
  const firstClaim = await fetch(`${app.baseUrl}/api/agent/v1/commands/${command.id}/claim`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ leaseId: 'lease-old-0001', fence: 0 }),
  });
  assert.equal(firstClaim.status, 200);
  app.db.prepare('UPDATE commands SET lease_expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), command.id);

  const listed = await fetch(`${app.baseUrl}/api/agent/v1/commands?limit=10`, { headers: auth });
  assert.equal(listed.status, 200);
  const items = (await listed.json()).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'queued');
  assert.equal(items[0].fence, 1);

  const staleAck = await fetch(`${app.baseUrl}/api/agent/v1/commands/${command.id}/ack`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ leaseId: 'lease-old-0001', fence: 1, result: { status: 'succeeded' } }),
  });
  assert.equal(staleAck.status, 409);

  const newClaim = await fetch(`${app.baseUrl}/api/agent/v1/commands/${command.id}/claim`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ leaseId: 'lease-new-0002', fence: 1 }),
  });
  assert.equal(newClaim.status, 200);
  assert.equal((await newClaim.json()).fence, 2);
});
