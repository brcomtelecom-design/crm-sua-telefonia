import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir, baseConfig, startApp, stopApp, login } from './helpers.mjs';
import { newId, nowIso } from '../src/db.mjs';

test('destinatário interrompido em sending é recuperado como uncertain sem reenvio', async (t) => {
  const temp = makeTempDir();
  const config = baseConfig(temp);
  const first = await startApp(config);
  const owner = await login(first);
  const tenantId = owner.body.user.tenantId;
  const campaignId = newId();
  const recipientId = newId();
  const now = nowIso();
  first.db.prepare(`INSERT INTO campaigns(id,tenant_id,name,executor,status,audience_count,template_name,parameters_json,idempotency_key,digest,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(campaignId, tenantId, 'Interrompida', 'web', 'paused', 1, 'modelo', '[]', 'recovery-campaign-0001', 'synthetic-digest', now, now);
  first.db.prepare(`INSERT INTO campaign_recipients(id,tenant_id,campaign_id,row_number,phone_encrypted,phone_digest,payload_encrypted,status,attempt_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(recipientId, tenantId, campaignId, 2, 'encrypted', 'digest', 'encrypted', 'sending', 1, now, now);
  await stopApp(first);

  const second = await startApp(config);
  t.after(() => stopApp(second));
  const recipient = second.db.prepare('SELECT status, error_code FROM campaign_recipients WHERE id=?').get(recipientId);
  assert.equal(recipient.status, 'uncertain');
  assert.equal(recipient.error_code, 'PROCESS_RESTARTED');
  const receipts = second.db.prepare('SELECT status, error_code FROM campaign_receipts WHERE recipient_id=?').all(recipientId);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].status, 'uncertain');
  assert.equal(receipts[0].error_code, 'PROCESS_RESTARTED');
});
