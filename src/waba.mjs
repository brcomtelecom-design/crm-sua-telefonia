import { createHmac, timingSafeEqual } from 'node:crypto';
import { encryptString, decryptString, sha256 } from './security.mjs';
import { newId, nowIso } from './db.mjs';
import { accountForPhoneId, accountSecrets } from './accounts.mjs';
import { persistInboundMessage } from './attendance.mjs';
import { HttpError } from './http.mjs';

function rawJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '{}';
  const items = [];
  for (const entry of value.entry || []) {
    for (const change of entry.changes || []) {
      const valuePart = change.value || {};
      const phoneId = String(valuePart.metadata?.phone_number_id || '').trim();
      for (const message of valuePart.messages || []) {
        items.push({
          phoneId,
          eventKey: `message:${message.id || sha256(JSON.stringify(message))}`,
          remoteId: String(message.from || '').trim(),
          providerMessageId: String(message.id || '').trim(),
          body: String(message.text?.body || '').trim(),
          customerName: String(message.profile?.name || '').trim() || null,
          timestamp: message.timestamp || null,
        });
      }
      for (const status of valuePart.statuses || []) {
        items.push({
          phoneId,
          eventKey: `status:${status.id || sha256(JSON.stringify(status))}:${status.status || ''}`,
          providerMessageId: String(status.id || '').trim(),
          status: String(status.status || '').trim(),
          recipientId: String(status.recipient_id || '').trim(),
          timestamp: status.timestamp || null,
        });
      }
    }
  }
  return JSON.stringify(items);
}

export function verifyMetaSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyChallenge(query, expectedToken) {
  if (query.get('hub.mode') !== 'subscribe') return null;
  if (String(query.get('hub.verify_token') || '') !== String(expectedToken || '')) return null;
  const challenge = query.get('hub.challenge');
  if (!challenge || challenge.length > 512) return null;
  return challenge;
}

export function parseWebhookEvents(rawBody) {
  let parsed;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new HttpError(400, 'INVALID_WEBHOOK', 'JSON do webhook inválido');
  }
  const events = JSON.parse(rawJson(parsed));
  if (!events.length) throw new HttpError(400, 'INVALID_WEBHOOK', 'Webhook sem evento reconhecível');
  return events;
}

export function persistWebhookBatch(db, tenantId, account, rawBody, events, encryptionKey) {
  const bodyHash = sha256(rawBody);
  const results = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const event of events) {
      const existing = db.prepare('SELECT id FROM webhook_receipts WHERE tenant_id=? AND account_id=? AND event_key=?')
        .get(tenantId, account.id, event.eventKey);
      if (existing) {
        results.push({ eventKey: event.eventKey, repeated: true });
        continue;
      }
      db.prepare(`
        INSERT INTO webhook_receipts(id,tenant_id,account_id,event_key,body_sha256,payload_encrypted,received_at)
        VALUES(?,?,?,?,?,?,?)
      `).run(
        newId(), tenantId, account.id, event.eventKey, bodyHash,
        encryptString(JSON.stringify(event), encryptionKey, `webhook:${account.id}:${event.eventKey}`), nowIso(),
      );
      if (event.providerMessageId && event.body) {
        persistInboundMessage(db, tenantId, account, event);
      } else if (event.providerMessageId && event.status) {
        const statusMap = { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' };
        const status = statusMap[event.status];
        if (status) {
          db.prepare('UPDATE messages SET status=? WHERE tenant_id=? AND account_id=? AND provider_message_id=?')
            .run(status, tenantId, account.id, event.providerMessageId);
          const recipient = db.prepare(`
            SELECT r.id, r.campaign_id FROM campaign_recipients r
            JOIN campaigns c ON c.id=r.campaign_id
            WHERE r.tenant_id=? AND c.tenant_id=? AND c.account_id=? AND r.provider_message_id=?
          `).get(tenantId, tenantId, account.id, event.providerMessageId);
          if (recipient) {
            db.prepare('UPDATE campaign_recipients SET status=?, updated_at=? WHERE id=? AND tenant_id=?')
              .run(status, nowIso(), recipient.id, tenantId);
            db.prepare(`
              INSERT INTO campaign_receipts(id,tenant_id,campaign_id,recipient_id,provider_message_id,status,error_code,received_at)
              VALUES(?,?,?,?,?,?,?,?)
            `).run(newId(), tenantId, recipient.campaign_id, recipient.id, event.providerMessageId, status, null, nowIso());
          }
        }
      }
      results.push({ eventKey: event.eventKey, repeated: false });
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return results;
}

export function resolveWebhookAccount(db, phoneId) {
  const account = accountForPhoneId(db, phoneId);
  if (!account) throw new HttpError(404, 'UNKNOWN_ACCOUNT', 'Conta WABA não cadastrada');
  return account;
}

export async function sendWabaText({ db, tenantId, message, account, encryptionKey, fetchImpl = globalThis.fetch, templateName, parameters }) {
  const { accessToken } = accountSecrets(db, account, encryptionKey);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    if (templateName && parameters !== undefined && parameters !== null && !Array.isArray(parameters)) {
      const error = new Error('Parâmetros de template inválidos');
      error.code = 'INVALID_PARAMETERS';
      throw error;
    }
    const payload = templateName
      ? {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: message.remote_id,
          type: 'template',
          template: {
            name: templateName,
            language: { code: 'pt_BR' },
            components: Array.isArray(parameters) && parameters.length
              ? [{ type: 'body', parameters: parameters.map((text) => ({ type: 'text', text: String(text).slice(0, 1000) })) }]
              : [],
          },
        }
      : { messaging_product: 'whatsapp', recipient_type: 'individual', to: message.remote_id, type: 'text', text: { body: message.body } };
    const response = await fetchImpl(`https://graph.facebook.com/v23.0/${encodeURIComponent(account.external_id)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.error?.message || 'Meta não confirmou o envio');
      error.code = response.status >= 500 ? 'META_UNCERTAIN' : 'META_REJECTED';
      throw error;
    }
    if (!result.messages?.[0]?.id) {
      const error = new Error('Meta não confirmou o identificador do envio');
      error.code = 'META_UNCERTAIN';
      throw error;
    }
    return { providerMessageId: result.messages[0].id };
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') error.code = 'TIMEOUT';
    else if (!error?.code) error.code = 'META_UNCERTAIN';
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
