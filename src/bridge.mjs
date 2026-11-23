import { newId, nowIso } from './db.mjs';
import { payloadDigest } from './security.mjs';
import { HttpError } from './http.mjs';

const LEASE_MS = 60 * 1000;

export function requeueExpiredCommands(db, installation) {
  const now = nowIso();
  const result = db.prepare(`
    UPDATE commands SET status='queued', lease_id=NULL, lease_expires_at=NULL, updated_at=?
    WHERE installation_id=? AND status='claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?
  `).run(now, installation.id, now);
  return result.changes;
}

export function listCommands(db, installation, { after, limit }) {
  return db.prepare(`
    SELECT id, type, payload_json AS payloadJson, digest, executor, status, lease_id AS leaseId,
      fence, lease_expires_at AS leaseExpiresAt, created_at AS createdAt
    FROM commands
    WHERE installation_id=? AND status='queued' AND id>?
    ORDER BY id LIMIT ?
  `).all(installation.id, after || '', limit).map((row) => ({ ...row, payload: JSON.parse(row.payloadJson), payloadJson: undefined }));
}

export function claimCommand(db, installation, commandId, { leaseId, fence }) {
  if (!leaseId || !/^[A-Za-z0-9._:-]{8,120}$/.test(leaseId)) throw new HttpError(400, 'INVALID_LEASE', 'leaseId inválido');
  if (!Number.isSafeInteger(fence) || fence < 0) throw new HttpError(400, 'INVALID_FENCE', 'fence inválido');
  const now = nowIso();
  const expiresAt = new Date(Date.now() + LEASE_MS).toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const command = db.prepare(`SELECT * FROM commands WHERE id=? AND installation_id=?`).get(commandId, installation.id);
    if (!command) throw new HttpError(404, 'NOT_FOUND', 'Comando não encontrado');
    if (command.status !== 'queued') throw new HttpError(409, 'COMMAND_CLAIMED', 'Comando já foi reivindicado');
    if (command.fence !== fence) throw new HttpError(409, 'STALE_FENCE', 'Fence obsoleto');
    const updated = db.prepare(`
      UPDATE commands SET status='claimed', lease_id=?, fence=fence+1, lease_expires_at=?, updated_at=?
      WHERE id=? AND installation_id=? AND status='queued' AND fence=?
    `).run(leaseId, expiresAt, now, commandId, installation.id, fence);
    if (!updated.changes) throw new HttpError(409, 'COMMAND_CLAIMED', 'Comando já foi reivindicado');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const claimed = db.prepare('SELECT * FROM commands WHERE id=?').get(commandId);
  return { id: claimed.id, leaseId: claimed.lease_id, fence: claimed.fence, leaseExpiresAt: claimed.lease_expires_at, digest: claimed.digest };
}

export function acknowledgeCommand(db, installation, commandId, input) {
  const { leaseId, fence, result } = input;
  if (!leaseId || !Number.isSafeInteger(fence)) throw new HttpError(400, 'INVALID_ACK', 'leaseId e fence são obrigatórios');
  if (!result || !['succeeded', 'failed'].includes(result.status)) throw new HttpError(400, 'INVALID_ACK', 'result.status deve ser succeeded ou failed');
  const now = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    const command = db.prepare('SELECT * FROM commands WHERE id=? AND installation_id=?').get(commandId, installation.id);
    if (!command) throw new HttpError(404, 'NOT_FOUND', 'Comando não encontrado');
    if (command.status === 'succeeded' || command.status === 'failed') {
      if (command.lease_id !== leaseId || command.fence !== fence) throw new HttpError(409, 'STALE_ACK', 'ACK obsoleto');
      db.exec('COMMIT');
      return { id: command.id, status: command.status, repeated: true };
    }
    if (command.status !== 'claimed' || command.lease_id !== leaseId || command.fence !== fence) {
      throw new HttpError(409, 'STALE_ACK', 'Lease ou fence inválido');
    }
    if (command.lease_expires_at && command.lease_expires_at <= now) throw new HttpError(409, 'LEASE_EXPIRED', 'Lease expirado');
    db.prepare('UPDATE commands SET status=?, result_json=?, error_code=?, updated_at=? WHERE id=? AND installation_id=?')
      .run(result.status, JSON.stringify(result.payload || {}), result.errorCode || null, now, commandId, installation.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { id: commandId, status: result.status, repeated: false };
}

export function receiveEvent(db, installation, input) {
  const eventKey = String(input.eventKey || '').trim();
  const type = String(input.type || '').trim();
  const payload = input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload : null;
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(eventKey)) throw new HttpError(400, 'INVALID_EVENT', 'eventKey inválido');
  if (!/^[a-z][a-z0-9_.-]{2,80}$/.test(type)) throw new HttpError(400, 'INVALID_EVENT', 'type inválido');
  if (!payload) throw new HttpError(400, 'INVALID_EVENT', 'payload deve ser um objeto');
  const digest = payloadDigest(payload);
  const existing = db.prepare('SELECT * FROM events WHERE installation_id=? AND event_key=?').get(installation.id, eventKey);
  if (existing) {
    if (existing.digest !== digest) throw new HttpError(409, 'EVENT_CONFLICT', 'eventKey repetida com conteúdo diferente');
    return { id: existing.id, eventKey, repeated: true };
  }
  const id = newId();
  db.prepare(`
    INSERT INTO events(id,tenant_id,installation_id,event_key,digest,type,payload_json,received_at)
    VALUES(?,?,?,?,?,?,?,?)
  `).run(id, installation.tenantId, installation.id, eventKey, digest, type, JSON.stringify(payload), nowIso());
  return { id, eventKey, repeated: false };
}
