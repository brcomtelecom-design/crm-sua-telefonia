import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir, baseConfig, startApp, stopApp, login } from './helpers.mjs';
import { sessionHeaders, xlsx } from './fixtures.mjs';

async function createActiveWaba(app, owner) {
  const response = await fetch(`${app.baseUrl}/api/waba-accounts`, {
    method: 'POST',
    headers: sessionHeaders(owner, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      name: 'WABA de campanha',
      externalId: '1234567890',
      wabaId: '9876543210',
      accessToken: 'synthetic-access-token-12345',
      appSecret: 'synthetic-app-secret',
    }),
  });
  assert.equal(response.status, 201);
  const account = await response.json();
  const active = await fetch(`${app.baseUrl}/api/waba-accounts/${account.id}`, {
    method: 'PATCH',
    headers: sessionHeaders(owner, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ status: 'active' }),
  });
  assert.equal(active.status, 200);
  return account;
}

async function uploadAudience(app, owner, rows = [
  ['telefone', 'nome', 'opt_in_at', 'opt_in_source', 'opt_in_evidence'],
  ['5511999999999', 'Cliente sintético', '2026-01-01', 'sintetico', 'evidencia-1'],
]) {
  const response = await fetch(`${app.baseUrl}/api/campaigns/upload?filename=audiencia.xlsx`, {
    method: 'POST',
    headers: sessionHeaders(owner, { 'Content-Type': 'application/octet-stream' }),
    body: xlsx(rows),
  });
  assert.equal(response.status, 201);
  return (await response.json()).upload;
}

test('campanha Web exige conta explícita e respeita o teto configurável de destinatários', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp, { campMaxRecipients: 1 }));
  t.after(() => stopApp(app));
  const owner = await login(app);
  const account = await createActiveWaba(app, owner);
  const uploadResponse = await fetch(`${app.baseUrl}/api/campaigns/upload?filename=audiencia.xlsx`, {
    method: 'POST',
    headers: sessionHeaders(owner, { 'Content-Type': 'application/octet-stream' }),
    body: xlsx([
      ['telefone', 'nome'],
      ['5511999999999', 'Cliente 1'],
      ['5511888888888', 'Cliente 2'],
    ]),
  });
  assert.equal(uploadResponse.status, 422);
  assert.equal((await uploadResponse.json()).error.code, 'RECIPIENT_LIMIT_EXCEEDED');
});

test('campanha com executor inválido é rejeitada', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));
  const owner = await login(app);
  const upload = await uploadAudience(app, owner);
  const response = await fetch(`${app.baseUrl}/api/campaigns`, {
    method: 'POST',
    headers: sessionHeaders(owner, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      uploadId: upload.id,
      accountId: 'conta-inexistente',
      name: 'Campanha inválida',
      templateName: 'promocao_aprovada',
      executor: 'automatico',
      idempotencyKey: 'campaign-executor-invalido-0001',
    }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'INVALID_EXECUTOR');
});

test('campanha Web sem conta explícita é rejeitada', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));
  const owner = await login(app);
  const upload = await uploadAudience(app, owner);
  const response = await fetch(`${app.baseUrl}/api/campaigns`, {
    method: 'POST',
    headers: sessionHeaders(owner, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      uploadId: upload.id,
      name: 'Campanha sem conta',
      templateName: 'promocao_aprovada',
      executor: 'web',
      idempotencyKey: 'campaign-sem-conta-0001',
    }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'ACCOUNT_REQUIRED');
});

test('início, pausa, retomada e cancelamento preservam estados e recibos', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));
  const owner = await login(app);
  const account = await createActiveWaba(app, owner);
  const upload = await uploadAudience(app, owner);
  const createResponse = await fetch(`${app.baseUrl}/api/campaigns`, {
    method: 'POST',
    headers: sessionHeaders(owner, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      uploadId: upload.id,
      accountId: account.id,
      name: 'Campanha com controles',
      templateName: 'promocao_aprovada',
      parameters: ['Cliente'],
      executor: 'web',
      idempotencyKey: 'campaign-controles-0001',
    }),
  });
  assert.equal(createResponse.status, 201);
  const campaign = (await createResponse.json()).campaign;
  assert.equal(campaign.status, 'draft');

  const deactivate = await fetch(`${app.baseUrl}/api/waba-accounts/${account.id}`, {
    method: 'PATCH',
    headers: sessionHeaders(owner, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ status: 'inactive' }),
  });
  assert.equal(deactivate.status, 200);
  const blockedStart = await fetch(`${app.baseUrl}/api/campaigns/${campaign.id}/start`, {
    method: 'POST', headers: sessionHeaders(owner),
  });
  assert.equal(blockedStart.status, 409);
  assert.equal((await blockedStart.json()).error.code, 'CHANNEL_UNAVAILABLE');

  await fetch(`${app.baseUrl}/api/waba-accounts/${account.id}`, {
    method: 'PATCH',
    headers: sessionHeaders(owner, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ status: 'active' }),
  });
  const start = await fetch(`${app.baseUrl}/api/campaigns/${campaign.id}/start`, {
    method: 'POST', headers: sessionHeaders(owner),
  });
  assert.equal(start.status, 200);
  assert.equal((await start.json()).campaign.status, 'queued');

  const pause = await fetch(`${app.baseUrl}/api/campaigns/${campaign.id}/pause`, {
    method: 'POST', headers: sessionHeaders(owner),
  });
  assert.equal(pause.status, 200);
  assert.equal((await pause.json()).campaign.status, 'paused');

  const resume = await fetch(`${app.baseUrl}/api/campaigns/${campaign.id}/start`, {
    method: 'POST', headers: sessionHeaders(owner),
  });
  assert.equal(resume.status, 200);
  assert.equal((await resume.json()).campaign.status, 'queued');

  const recipient = app.db.prepare('SELECT id FROM campaign_recipients WHERE campaign_id=?').get(campaign.id);
  app.db.prepare(`INSERT INTO campaign_receipts(id,tenant_id,campaign_id,recipient_id,provider_message_id,status,error_code,received_at) VALUES(?,?,?,?,?,?,?,?)`)
    .run('receipt-synthetic-0001', owner.body.user.tenantId, campaign.id, recipient.id, 'wamid.synthetic', 'sent', null, new Date().toISOString());

  const cancel = await fetch(`${app.baseUrl}/api/campaigns/${campaign.id}/cancel`, {
    method: 'POST', headers: sessionHeaders(owner),
  });
  assert.equal(cancel.status, 200);
  assert.equal((await cancel.json()).campaign.status, 'cancelled');
  assert.equal(app.db.prepare(`SELECT status FROM campaign_recipients WHERE campaign_id=? AND id=?`).get(campaign.id, recipient.id).status, 'cancelled');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM campaign_receipts WHERE campaign_id=?').get(campaign.id).n, 1);

  const repeatedCancel = await fetch(`${app.baseUrl}/api/campaigns/${campaign.id}/cancel`, {
    method: 'POST', headers: sessionHeaders(owner),
  });
  assert.equal(repeatedCancel.status, 200);
  assert.equal((await repeatedCancel.json()).campaign.repeated, true);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM campaign_receipts WHERE campaign_id=?').get(campaign.id).n, 1);
});

test('retomada sem destinatários pendentes encerra a campanha sem reenvio', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));
  app.queue.stop();
  const owner = await login(app);
  const account = await createActiveWaba(app, owner);
  const upload = await uploadAudience(app, owner);
  const createResponse = await fetch(`${app.baseUrl}/api/campaigns`, {
    method: 'POST',
    headers: sessionHeaders(owner, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      uploadId: upload.id,
      accountId: account.id,
      name: 'Campanha já processada',
      templateName: 'promocao_aprovada',
      executor: 'web',
      idempotencyKey: 'campaign-resume-concluida-0001',
    }),
  });
  assert.equal(createResponse.status, 201);
  const campaign = (await createResponse.json()).campaign;
  const recipient = app.db.prepare('SELECT id FROM campaign_recipients WHERE campaign_id=?').get(campaign.id);
  app.db.prepare(`UPDATE campaign_recipients SET status='sent', provider_message_id='wamid.synthetic' WHERE id=?`).run(recipient.id);

  const pause = await fetch(`${app.baseUrl}/api/campaigns/${campaign.id}/pause`, {
    method: 'POST', headers: sessionHeaders(owner),
  });
  assert.equal(pause.status, 200);
  const resume = await fetch(`${app.baseUrl}/api/campaigns/${campaign.id}/start`, {
    method: 'POST', headers: sessionHeaders(owner),
  });
  assert.equal(resume.status, 200);
  assert.equal((await resume.json()).campaign.status, 'completed');
  assert.equal(app.db.prepare(`SELECT COUNT(*) AS n FROM campaign_receipts WHERE campaign_id=?`).get(campaign.id).n, 0);
});
