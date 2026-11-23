import { decryptString, sha256 } from './security.mjs';
import { newId, nowIso } from './db.mjs';
import { HttpError } from './http.mjs';

export class CampaignQueue {
  constructor({ db, encryptionKey, maxInFlight = 2, sendRecipient }) {
    this.db = db;
    this.encryptionKey = encryptionKey;
    this.maxInFlight = Math.max(1, Math.min(20, maxInFlight));
    this.sendRecipient = sendRecipient;
    this.inFlight = 0;
    this.timer = null;
    this.stopped = false;
    this.onError = () => {};
  }

  recoverInterrupted() {
    const interrupted = this.db.prepare(`SELECT id, tenant_id, campaign_id, provider_message_id FROM campaign_recipients WHERE status='sending'`).all();
    if (!interrupted.length) return 0;
    const now = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const recipient of interrupted) {
        this.db.prepare(`UPDATE campaign_recipients SET status='uncertain', error_code='PROCESS_RESTARTED', updated_at=? WHERE id=? AND status='sending'`)
          .run(now, recipient.id);
        this.db.prepare(`
          INSERT INTO campaign_receipts(id,tenant_id,campaign_id,recipient_id,provider_message_id,status,error_code,received_at)
          VALUES(?,?,?,?,?,?,?,?)
        `).run(newId(), recipient.tenant_id, recipient.campaign_id, recipient.id, recipient.provider_message_id || null, 'uncertain', 'PROCESS_RESTARTED', now);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.onError(error);
      throw error;
    }
    return interrupted.length;
  }

  start() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), 500);
    this.timer.unref?.();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.stopped || this.inFlight >= this.maxInFlight) return;
    const candidates = this.db.prepare(`
      SELECT r.*, c.tenant_id AS tenant_id, c.account_id AS account_id, c.name AS campaign_name, c.template_name AS template_name,
        c.parameters_json AS parameters_json
      FROM campaign_recipients r JOIN campaigns c ON c.id=r.campaign_id
      WHERE r.status='pending' AND c.status IN ('queued','running') AND c.executor='web'
      ORDER BY r.created_at, r.id LIMIT ?
    `).all(this.maxInFlight - this.inFlight);
    for (const recipient of candidates) {
      if (this.inFlight >= this.maxInFlight) break;
      const claimed = this.db.prepare(`UPDATE campaign_recipients SET status='sending', attempt_count=attempt_count+1, updated_at=? WHERE id=? AND status='pending'`)
        .run(nowIso(), recipient.id);
      if (!claimed.changes) continue;
      this.db.prepare(`UPDATE campaigns SET status='running', updated_at=? WHERE id=? AND status IN ('queued','draft')`).run(nowIso(), recipient.campaign_id);
      this.inFlight += 1;
      void this.process(recipient).finally(() => { this.inFlight -= 1; });
    }
  }

  async process(recipient) {
    let payload;
    try {
      payload = JSON.parse(decryptString(recipient.payload_encrypted, this.encryptionKey, `campaign:${recipient.campaign_id}:payload`));
      if (!payload.optIn) {
        this.finish(recipient, 'failed', null, 'CONSENT_REQUIRED');
        return;
      }
      const result = await this.sendRecipient({
        recipientId: recipient.id,
        tenantId: recipient.tenant_id,
        campaignId: recipient.campaign_id,
        payload,
        templateName: recipient.template_name,
        parameters: JSON.parse(recipient.parameters_json || '{}'),
      });
      this.finish(recipient, result.status || 'sent', result.providerMessageId || null, result.errorCode || null);
    } catch (error) {
      const uncertain = ['META_UNCERTAIN', 'TIMEOUT', 'ECONNRESET', 'ECONNABORTED'].includes(error.code);
      this.finish(recipient, uncertain ? 'uncertain' : 'failed', null, error.code || 'SEND_FAILED');
      this.onError(error);
    }
  }

  finish(recipient, status, providerMessageId, errorCode) {
    const now = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare('SELECT status, provider_message_id FROM campaign_recipients WHERE id=?').get(recipient.id);
      const effectiveStatus = ['delivered', 'read'].includes(current?.status) ? current.status : status;
      const effectiveProviderMessageId = current?.provider_message_id || providerMessageId || null;
      this.db.prepare('UPDATE campaign_recipients SET status=?, provider_message_id=?, error_code=?, updated_at=? WHERE id=?')
        .run(effectiveStatus, effectiveProviderMessageId, errorCode || null, now, recipient.id);
      this.db.prepare(`
        INSERT INTO campaign_receipts(id,tenant_id,campaign_id,recipient_id,provider_message_id,status,error_code,received_at)
        VALUES(?,?,?,?,?,?,?,?)
      `).run(newId(), recipient.tenant_id, recipient.campaign_id, recipient.id, effectiveProviderMessageId, effectiveStatus, errorCode || null, now);
      const pending = this.db.prepare(`SELECT COUNT(*) AS n FROM campaign_recipients WHERE campaign_id=? AND status IN ('pending','sending')`).get(recipient.campaign_id).n;
      if (!pending) this.db.prepare(`UPDATE campaigns SET status='completed', updated_at=? WHERE id=? AND status NOT IN ('cancelled','paused')`).run(now, recipient.campaign_id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.onError(error);
    }
  }
}
