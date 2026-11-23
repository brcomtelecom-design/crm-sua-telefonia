import { newId, nowIso } from './db.mjs';
import { HttpError } from './http.mjs';

export function listConversations(db, tenantId, { after, limit }) {
  const rows = after
    ? db.prepare(`
        SELECT id, account_id AS accountId, remote_id AS remoteId, customer_name AS customerName, last_message_at AS lastMessageAt
        FROM conversations WHERE tenant_id=? AND last_message_at<? ORDER BY last_message_at DESC, id DESC LIMIT ?
      `).all(tenantId, after, limit)
    : db.prepare(`
        SELECT id, account_id AS accountId, remote_id AS remoteId, customer_name AS customerName, last_message_at AS lastMessageAt
        FROM conversations WHERE tenant_id=? ORDER BY last_message_at DESC, id DESC LIMIT ?
      `).all(tenantId, limit);
  return rows;
}

export function listMessages(db, tenantId, conversationId, { before, limit }) {
  const conversation = db.prepare('SELECT id FROM conversations WHERE id=? AND tenant_id=?').get(conversationId, tenantId);
  if (!conversation) throw new HttpError(404, 'NOT_FOUND', 'Conversa não encontrada');
  return before
    ? db.prepare(`
        SELECT id, direction, body, status, provider_message_id AS providerMessageId, created_at AS createdAt
        FROM messages WHERE tenant_id=? AND conversation_id=? AND created_at<? ORDER BY created_at DESC, id DESC LIMIT ?
      `).all(tenantId, conversationId, before, limit)
    : db.prepare(`
        SELECT id, direction, body, status, provider_message_id AS providerMessageId, created_at AS createdAt
        FROM messages WHERE tenant_id=? AND conversation_id=? ORDER BY created_at DESC, id DESC LIMIT ?
      `).all(tenantId, conversationId, limit);
}

export function createOutgoingIntent(db, tenantId, conversationId, input) {
  const conversation = db.prepare('SELECT * FROM conversations WHERE id=? AND tenant_id=?').get(conversationId, tenantId);
  if (!conversation) throw new HttpError(404, 'NOT_FOUND', 'Conversa não encontrada');
  const body = String(input.body || '').trim();
  if (!body || body.length > 4096) throw new HttpError(400, 'VALIDATION_ERROR', 'Mensagem deve ter entre 1 e 4096 caracteres');
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(idempotencyKey)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Chave idempotente inválida');
  }
  const existing = db.prepare('SELECT * FROM messages WHERE tenant_id=? AND idempotency_key=?').get(tenantId, idempotencyKey);
  if (existing) {
    if (existing.conversation_id !== conversationId || existing.body !== body) {
      throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'A chave idempotente já foi usada com outro conteúdo');
    }
    return { message: existing, repeated: true };
  }
  const id = newId();
  const createdAt = nowIso();
  db.prepare(`
    INSERT INTO messages(id,tenant_id,conversation_id,account_id,direction,body,status,idempotency_key,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)
  `).run(id, tenantId, conversationId, conversation.account_id, 'out', body, 'pending', idempotencyKey, createdAt);
  return { message: db.prepare('SELECT * FROM messages WHERE id=?').get(id), repeated: false };
}

export function updateOutgoingMessage(db, tenantId, messageId, { status, providerMessageId, errorCode }) {
  const message = db.prepare('SELECT * FROM messages WHERE id=? AND tenant_id=?').get(messageId, tenantId);
  if (!message) throw new HttpError(404, 'NOT_FOUND', 'Mensagem não encontrada');
  db.prepare('UPDATE messages SET status=?, provider_message_id=?, created_at=created_at WHERE id=? AND tenant_id=?')
    .run(status, providerMessageId || null, messageId, tenantId);
  return db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
}

export function persistInboundMessage(db, tenantId, account, input) {
  const remoteId = String(input.remoteId || '').trim();
  const providerMessageId = String(input.providerMessageId || '').trim();
  const body = String(input.body || '').trim();
  if (!remoteId || !providerMessageId || !body) throw new HttpError(400, 'INVALID_WEBHOOK', 'Evento de mensagem incompleto');
  const existing = db.prepare('SELECT * FROM messages WHERE tenant_id=? AND provider_message_id=?').get(tenantId, providerMessageId);
  if (existing) return { message: existing, repeated: true };
  const now = nowIso();
  let conversation = db.prepare('SELECT * FROM conversations WHERE tenant_id=? AND account_id=? AND remote_id=?')
    .get(tenantId, account.id, remoteId);
  if (!conversation) {
    const id = newId();
    db.prepare(`
      INSERT INTO conversations(id,tenant_id,account_id,remote_id,customer_name,last_message_at,created_at)
      VALUES(?,?,?,?,?,?,?)
    `).run(id, tenantId, account.id, remoteId, input.customerName || null, now, now);
    conversation = db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
  } else if (input.customerName) {
    db.prepare('UPDATE conversations SET customer_name=COALESCE(customer_name,?) WHERE id=?').run(input.customerName, conversation.id);
  }
  const id = newId();
  db.prepare(`
    INSERT INTO messages(id,tenant_id,conversation_id,account_id,direction,body,status,provider_message_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)
  `).run(id, tenantId, conversation.id, account.id, 'in', body, 'received', providerMessageId, now);
  db.prepare('UPDATE conversations SET last_message_at=? WHERE id=?').run(now, conversation.id);
  return { message: db.prepare('SELECT * FROM messages WHERE id=?').get(id), repeated: false };
}
