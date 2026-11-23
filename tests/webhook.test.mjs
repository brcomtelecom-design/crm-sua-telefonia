import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { makeTempDir, baseConfig, startApp, stopApp, login } from './helpers.mjs';
import { newId, nowIso } from '../src/db.mjs';

function signature(body, secret) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

test('webhook WABA valida HMAC no corpo original, deduplica e persiste antes do ACK', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));
  const owner = await login(app);
  const accountResponse = await fetch(`${app.baseUrl}/api/waba-accounts`, {
    method: 'POST',
    headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'WABA sintética', externalId: '1234567890', wabaId: '9876543210', accessToken: 'synthetic-access-token-12345', appSecret: 'synthetic-app-secret' }),
  });
  assert.equal(accountResponse.status, 201);
  const account = await accountResponse.json();
  const payload = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'entry-1', changes: [{ field: 'messages', value: { metadata: { phone_number_id: account.externalId }, messages: [{ id: 'wamid.SYNTHETIC', from: '5511999999999', timestamp: '1700000000', type: 'text', text: { body: 'Mensagem sintética' } }] } }] }],
  });
  const body = Buffer.from(payload);
  const response = await fetch(`${app.baseUrl}/api/meta/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature(body, 'synthetic-app-secret') }, body,
  });
  assert.equal(response.status, 200);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM webhook_receipts').get().n, 1);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
  const repeated = await fetch(`${app.baseUrl}/api/meta/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature(body, 'synthetic-app-secret') }, body,
  });
  assert.equal(repeated.status, 200);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM webhook_receipts').get().n, 1);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
});

test('webhook WABA recusa assinatura inválida e conta desconhecida', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));
  const payload = Buffer.from(JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: '9999999999' }, messages: [{ id: 'wamid.BAD', from: '5511900000000', text: { body: 'x' } }] } }] }] }));
  const unknown = await fetch(`${app.baseUrl}/api/meta/webhook`, {
    method: 'POST', headers: { 'X-Hub-Signature-256': signature(payload, 'synthetic-app-secret') }, body: payload,
  });
  assert.equal(unknown.status, 404);
  const owner = await login(app);
  const created = await (await fetch(`${app.baseUrl}/api/waba-accounts`, {
    method: 'POST', headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'WABA', externalId: '1234567890', wabaId: '9876543210', accessToken: 'synthetic-access-token-12345', appSecret: 'synthetic-app-secret' }),
  })).json();
  const validPayload = Buffer.from(JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: created.externalId }, messages: [{ id: 'wamid.BAD2', from: '5511900000000', text: { body: 'x' } }] } }] }] }));
  const invalid = await fetch(`${app.baseUrl}/api/meta/webhook`, {
    method: 'POST', headers: { 'X-Hub-Signature-256': 'sha256=invalid' }, body: validPayload,
  });
  assert.equal(invalid.status, 401);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM webhook_receipts').get().n, 0);
});

test('webhook rejeita payload assinado que mistura contas diferentes', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));
  const owner = await login(app);
  const account = (await (await fetch(`${app.baseUrl}/api/waba-accounts`, {
    method: 'POST',
    headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'WABA', externalId: '1234567890', wabaId: '9876543210', accessToken: 'synthetic-access-token-12345', appSecret: 'synthetic-app-secret' }),
  })).json());
  const payload = Buffer.from(JSON.stringify({
    entry: [
      { changes: [{ value: { metadata: { phone_number_id: account.externalId }, messages: [{ id: 'wamid.ACCOUNT.A', from: '5511900000000', text: { body: 'A' } }] } }] },
      { changes: [{ value: { metadata: { phone_number_id: '9999999999' }, messages: [{ id: 'wamid.ACCOUNT.B', from: '5511900000001', text: { body: 'B' } }] } }] },
    ],
  }));
  const response = await fetch(`${app.baseUrl}/api/meta/webhook`, {
    method: 'POST', headers: { 'X-Hub-Signature-256': signature(payload, 'synthetic-app-secret') }, body: payload,
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'WEBHOOK_ACCOUNT_MISMATCH');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM webhook_receipts').get().n, 0);
});

test('status WABA de campanha atualiza destinatário e preserva novo recibo', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));
  const owner = await login(app);
  const account = (await (await fetch(`${app.baseUrl}/api/waba-accounts`, {
    method: 'POST',
    headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'WABA', externalId: '1234567890', wabaId: '9876543210', accessToken: 'synthetic-access-token-12345', appSecret: 'synthetic-app-secret' }),
  })).json());
  const tenantId = owner.body.user.tenantId;
  const campaignId = newId();
  const recipientId = newId();
  const now = nowIso();
  app.db.prepare(`INSERT INTO campaigns(id,tenant_id,account_id,name,executor,status,audience_count,template_name,parameters_json,idempotency_key,digest,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(campaignId, tenantId, account.id, 'Campanha', 'web', 'running', 1, 'modelo', '[]', 'webhook-campaign-0001', 'synthetic-digest', now, now);
  app.db.prepare(`INSERT INTO campaign_recipients(id,tenant_id,campaign_id,row_number,phone_encrypted,phone_digest,payload_encrypted,status,provider_message_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(recipientId, tenantId, campaignId, 2, 'encrypted', 'digest', 'encrypted', 'sent', 'wamid.CAMPAIGN', now, now);

  const payload = Buffer.from(JSON.stringify({
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: account.externalId },
      statuses: [{ id: 'wamid.CAMPAIGN', status: 'delivered', recipient_id: '5511900000000', timestamp: '1700000000' }],
    } }] }],
  }));
  const response = await fetch(`${app.baseUrl}/api/meta/webhook`, {
    method: 'POST', headers: { 'X-Hub-Signature-256': signature(payload, 'synthetic-app-secret') }, body: payload,
  });
  assert.equal(response.status, 200);
  assert.equal(app.db.prepare('SELECT status FROM campaign_recipients WHERE id=?').get(recipientId).status, 'delivered');
  const receipts = app.db.prepare('SELECT status FROM campaign_receipts WHERE campaign_id=? AND recipient_id=? ORDER BY received_at DESC').all(campaignId, recipientId);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].status, 'delivered');
});

test('status WABA de uma conta não altera mensagem ou destinatário de outra conta', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));
  const owner = await login(app);
  const headers = { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf, 'Content-Type': 'application/json' };
  const accountA = (await (await fetch(`${app.baseUrl}/api/waba-accounts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'WABA A', externalId: '1111111111', wabaId: '1111111111', accessToken: 'synthetic-access-token-a-12345', appSecret: 'synthetic-app-secret-a' }),
  })).json());
  const accountB = (await (await fetch(`${app.baseUrl}/api/waba-accounts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'WABA B', externalId: '2222222222', wabaId: '2222222222', accessToken: 'synthetic-access-token-b-12345', appSecret: 'synthetic-app-secret-b' }),
  })).json());
  const tenantId = owner.body.user.tenantId;
  const conversationId = newId();
  const campaignId = newId();
  const recipientId = newId();
  const now = nowIso();
  app.db.prepare(`INSERT INTO conversations(id,tenant_id,account_id,remote_id,customer_name,last_message_at,created_at) VALUES(?,?,?,?,?,?,?)`)
    .run(conversationId, tenantId, accountB.id, '5511900000000', 'Cliente B', now, now);
  app.db.prepare(`INSERT INTO messages(id,tenant_id,conversation_id,account_id,direction,body,status,provider_message_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(newId(), tenantId, conversationId, accountB.id, 'out', 'Original B', 'sent', 'wamid.ACCOUNT.B', now);
  app.db.prepare(`INSERT INTO campaigns(id,tenant_id,account_id,name,executor,status,audience_count,template_name,parameters_json,idempotency_key,digest,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(campaignId, tenantId, accountB.id, 'Campanha B', 'web', 'running', 1, 'modelo', '[]', 'webhook-account-isolation-0001', 'synthetic-digest', now, now);
  app.db.prepare(`INSERT INTO campaign_recipients(id,tenant_id,campaign_id,row_number,phone_encrypted,phone_digest,payload_encrypted,status,provider_message_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(recipientId, tenantId, campaignId, 2, 'encrypted', 'digest', 'encrypted', 'sent', 'wamid.ACCOUNT.B', now, now);

  const payload = Buffer.from(JSON.stringify({
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: accountA.externalId },
      statuses: [{ id: 'wamid.ACCOUNT.B', status: 'delivered', recipient_id: '5511900000000', timestamp: '1700000000' }],
    } }] }],
  }));
  const response = await fetch(`${app.baseUrl}/api/meta/webhook`, {
    method: 'POST', headers: { 'X-Hub-Signature-256': signature(payload, 'synthetic-app-secret-a') }, body: payload,
  });
  assert.equal(response.status, 200);
  assert.equal(app.db.prepare('SELECT status FROM messages WHERE provider_message_id=?').get('wamid.ACCOUNT.B').status, 'sent');
  assert.equal(app.db.prepare('SELECT status FROM campaign_recipients WHERE id=?').get(recipientId).status, 'sent');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM campaign_receipts').get().n, 0);
});
