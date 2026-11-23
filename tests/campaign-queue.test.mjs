import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir, baseConfig, startApp, stopApp, login } from './helpers.mjs';
import { newId, nowIso } from '../src/db.mjs';
import { encryptString, sha256 } from '../src/security.mjs';

test('fila de campanha é global, limitada e não cria worker por campanha', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));
  const owner = await login(app);
  const account = app.db.prepare(`SELECT * FROM accounts WHERE tenant_id=? LIMIT 1`).get(owner.body.user.tenantId);
  if (!account) {
    app.db.prepare(`INSERT INTO accounts(id,tenant_id,kind,name,status,created_at,updated_at) VALUES(?,?,'waba','synthetic','active',?,?)`)
      .run(newId(), owner.body.user.tenantId, nowIso(), nowIso());
  }
  const tenantId = owner.body.user.tenantId;
  const activeAccount = app.db.prepare(`SELECT * FROM accounts WHERE tenant_id=? LIMIT 1`).get(tenantId);
  const campaignId = newId();
  app.db.prepare(`INSERT INTO campaigns(id,tenant_id,name,executor,status,audience_count,template_name,parameters_json,idempotency_key,digest,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(campaignId, tenantId, 'Fila', 'web', 'queued', 2, 'template', '{}', 'queue-key-0001', sha256('queue'), nowIso(), nowIso());
  for (let index = 1; index <= 2; index += 1) {
    const payload = JSON.stringify({ phone: `55119999999${index}`, name: 'Cliente', optIn: { at: '2026-01-01', source: 'test', evidence: 'test' } });
    app.db.prepare(`INSERT INTO campaign_recipients(id,tenant_id,campaign_id,row_number,phone_encrypted,phone_digest,payload_encrypted,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'pending',?,?)`)
      .run(newId(), tenantId, campaignId, index, encryptString(`55119999999${index}`, app.config.appEncryptionKey, `campaign:${campaignId}:phone`), sha256(`55119999999${index}`), encryptString(payload, app.config.appEncryptionKey, `campaign:${campaignId}:payload`), nowIso(), nowIso());
  }
  let active = 0;
  let peak = 0;
  const original = app.queue.sendRecipient;
  app.queue.sendRecipient = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return { status: 'sent', providerMessageId: `synthetic-${Date.now()}` };
  };
  await app.queue.tick();
  await app.queue.tick();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(peak <= app.config.campMaxInFlight);
  assert.equal(app.db.prepare(`SELECT COUNT(*) AS n FROM campaign_recipients WHERE status='sent'`).get().n, 2);
  assert.equal(app.db.prepare(`SELECT COUNT(*) AS n FROM campaign_receipts`).get().n, 2);
  app.queue.sendRecipient = original;
});

test('status de entrega recebido antes do retorno do envio não é regravado como sent', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));
  const owner = await login(app);
  const tenantId = owner.body.user.tenantId;
  const campaignId = newId();
  const recipientId = newId();
  const now = nowIso();
  app.db.prepare(`INSERT INTO campaigns(id,tenant_id,name,executor,status,audience_count,template_name,parameters_json,idempotency_key,digest,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(campaignId, tenantId, 'Entrega', 'web', 'queued', 1, 'template', '[]', 'delivery-race-0001', sha256('delivery-race'), now, now);
  const payload = JSON.stringify({ phone: '5511999999999', name: 'Cliente', optIn: { at: '2026-01-01', source: 'test', evidence: 'test' } });
  app.db.prepare(`INSERT INTO campaign_recipients(id,tenant_id,campaign_id,row_number,phone_encrypted,phone_digest,payload_encrypted,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'pending',?,?)`)
    .run(recipientId, tenantId, campaignId, 2, encryptString('5511999999999', app.config.appEncryptionKey, `campaign:${campaignId}:phone`), sha256('5511999999999'), encryptString(payload, app.config.appEncryptionKey, `campaign:${campaignId}:payload`), now, now);
  app.queue.sendRecipient = async () => {
    app.db.prepare(`UPDATE campaign_recipients SET status='delivered', provider_message_id='wamid.delivered' WHERE id=?`).run(recipientId);
    return { status: 'sent', providerMessageId: 'wamid.sent' };
  };

  await app.queue.tick();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const recipient = app.db.prepare('SELECT status, provider_message_id FROM campaign_recipients WHERE id=?').get(recipientId);
  assert.equal(recipient.status, 'delivered');
  assert.equal(recipient.provider_message_id, 'wamid.delivered');
  const receipt = app.db.prepare('SELECT status, provider_message_id FROM campaign_receipts WHERE recipient_id=?').get(recipientId);
  assert.equal(receipt.status, 'delivered');
  assert.equal(receipt.provider_message_id, 'wamid.delivered');
});
