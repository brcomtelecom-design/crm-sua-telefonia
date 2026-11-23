import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir, baseConfig, startApp, stopApp, login } from './helpers.mjs';
import { sessionHeaders, xlsx } from './fixtures.mjs';
import { newId, nowIso } from '../src/db.mjs';

async function createActiveWaba(app, owner) {
  const response = await fetch(`${app.baseUrl}/api/waba-accounts`, {
    method: 'POST',
    headers: sessionHeaders(owner, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      name: 'WABA de envio',
      externalId: '1234567890',
      wabaId: '9876543210',
      accessToken: 'synthetic-access-token-12345',
      appSecret: 'synthetic-app-secret',
    }),
  });
  assert.equal(response.status, 201);
  const account = await response.json();
  await fetch(`${app.baseUrl}/api/waba-accounts/${account.id}`, {
    method: 'PATCH',
    headers: sessionHeaders(owner, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ status: 'active' }),
  });
  return account;
}

test('executor de campanha envia template com parâmetros para a conta explicitada', async (t) => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.template.synthetic' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp, { fetchImpl }));
  t.after(() => stopApp(app));
  const owner = await login(app);
  const account = await createActiveWaba(app, owner);
  const uploadResponse = await fetch(`${app.baseUrl}/api/campaigns/upload?filename=audiencia.xlsx`, {
    method: 'POST',
    headers: sessionHeaders(owner, { 'Content-Type': 'application/octet-stream' }),
    body: xlsx([
      ['telefone', 'nome', 'opt_in_at', 'opt_in_source', 'opt_in_evidence'],
      ['5511999999999', 'Cliente sintético', '2026-01-01', 'sintetico', 'evidencia-1'],
    ]),
  });
  assert.equal(uploadResponse.status, 201);
  const upload = (await uploadResponse.json()).upload;
  const campaignResponse = await fetch(`${app.baseUrl}/api/campaigns`, {
    method: 'POST',
    headers: sessionHeaders(owner, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      uploadId: upload.id,
      accountId: account.id,
      name: 'Campanha com template',
      templateName: 'promocao_aprovada',
      parameters: ['Olá', 'Cliente'],
      executor: 'web',
      idempotencyKey: 'campaign-template-0001',
    }),
  });
  assert.equal(campaignResponse.status, 201);
  const campaign = (await campaignResponse.json()).campaign;
  const recipient = app.db.prepare('SELECT * FROM campaign_recipients WHERE campaign_id=?').get(campaign.id);

  const result = await app.queue.sendRecipient({
    recipientId: recipient.id,
    tenantId: owner.body.user.tenantId,
    campaignId: campaign.id,
    payload: { phone: '5511999999999', name: 'Cliente sintético' },
    templateName: campaign.template_name,
    parameters: ['Olá', 'Cliente'],
  });
  assert.equal(result.providerMessageId, 'wamid.template.synthetic');
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/1234567890\/messages$/);
  const payload = JSON.parse(requests[0].init.body);
  assert.equal(payload.type, 'template');
  assert.equal(payload.template.name, 'promocao_aprovada');
  assert.equal(payload.template.language.code, 'pt_BR');
  assert.deepEqual(payload.template.components[0].parameters.map((item) => item.text), ['Olá', 'Cliente']);
});

test('repetição de idempotência no atendimento não executa um segundo envio WABA', async (t) => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({ messages: [{ id: `wamid.synthetic.${calls}` }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp, { fetchImpl }));
  t.after(() => stopApp(app));
  const owner = await login(app);
  const account = await createActiveWaba(app, owner);
  const tenantId = owner.body.user.tenantId;
  const conversationId = newId();
  const now = nowIso();
  app.db.prepare(`INSERT INTO conversations(id,tenant_id,account_id,remote_id,customer_name,last_message_at,created_at) VALUES(?,?,?,?,?,?,?)`)
    .run(conversationId, tenantId, account.id, '5511999999999', 'Cliente', now, now);
  const headers = sessionHeaders(owner, { 'Content-Type': 'application/json' });
  const body = JSON.stringify({ body: 'Olá', idempotencyKey: 'message-idempotent-0001' });

  const first = await fetch(`${app.baseUrl}/api/conversations/${conversationId}/messages`, { method: 'POST', headers, body });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.status, 'sent');
  assert.equal(calls, 1);

  const repeated = await fetch(`${app.baseUrl}/api/conversations/${conversationId}/messages`, { method: 'POST', headers, body });
  assert.equal(repeated.status, 200);
  const repeatedBody = await repeated.json();
  assert.equal(repeatedBody.messageId, firstBody.messageId);
  assert.equal(repeatedBody.status, 'sent');
  assert.equal(repeatedBody.repeated, true);
  assert.equal(calls, 1);
});

test('timeout de envio WABA permanece incerto e não é rotulado como falha determinística', async (t) => {
  const fetchImpl = async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    throw error;
  };
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp, { fetchImpl }));
  t.after(() => stopApp(app));
  const owner = await login(app);
  const account = await createActiveWaba(app, owner);
  const tenantId = owner.body.user.tenantId;
  const conversationId = newId();
  const now = nowIso();
  app.db.prepare(`INSERT INTO conversations(id,tenant_id,account_id,remote_id,customer_name,last_message_at,created_at) VALUES(?,?,?,?,?,?,?)`)
    .run(conversationId, tenantId, account.id, '5511999999999', 'Cliente', now, now);

  const response = await fetch(`${app.baseUrl}/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: sessionHeaders(owner, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ body: 'Olá', idempotencyKey: 'message-timeout-0001' }),
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'DELIVERY_UNCERTAIN');
  assert.equal(app.db.prepare('SELECT status FROM messages WHERE tenant_id=?').get(tenantId).status, 'uncertain');
});
