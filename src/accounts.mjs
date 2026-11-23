import { encryptString, decryptString, sha256 } from './security.mjs';
import { newId, nowIso } from './db.mjs';
import { HttpError } from './http.mjs';

export function listAccounts(db, tenantId) {
  return db.prepare(`
    SELECT id, kind, name, external_id AS externalId, waba_id AS wabaId, status, desired, last_error AS lastError,
      last_activity_at AS lastActivityAt, created_at AS createdAt
    FROM accounts WHERE tenant_id=? ORDER BY kind, name
  `).all(tenantId).map((row) => ({ ...row, desired: Boolean(row.desired) }));
}

export function createInstallation(db, tenantId, name) {
  const token = `${newId()}.${newId()}`;
  const id = newId();
  db.prepare('INSERT INTO installations(id,tenant_id,name,token_hash,active,created_at) VALUES(?,?,?,?,1,?)')
    .run(id, tenantId, name, sha256(token), nowIso());
  return { id, name, token };
}

export function listInstallations(db, tenantId) {
  return db.prepare(`
    SELECT id, name, active, last_seen_at AS lastSeenAt, created_at AS createdAt
    FROM installations WHERE tenant_id=? ORDER BY created_at DESC
  `).all(tenantId).map((row) => ({ ...row, active: Boolean(row.active), tokenConfigured: true }));
}

export function authenticateInstallation(db, token) {
  if (!token) return null;
  return db.prepare(`
    SELECT id, tenant_id AS tenantId, name, active, last_seen_at AS lastSeenAt
    FROM installations WHERE token_hash=? AND active=1
  `).get(sha256(token)) || null;
}

export function touchInstallation(db, installationId) {
  db.prepare('UPDATE installations SET last_seen_at=? WHERE id=?').run(nowIso(), installationId);
}

export function createWabaAccount(db, tenantId, encryptionKey, input) {
  const name = String(input.name || '').trim();
  const externalId = String(input.externalId || '').trim();
  const wabaId = String(input.wabaId || '').trim();
  const accessToken = String(input.accessToken || '').trim();
  const appSecret = String(input.appSecret || '').trim();
  if (!name || name.length > 120) throw new HttpError(400, 'VALIDATION_ERROR', 'Nome da conta inválido');
  if (!/^[0-9]{5,32}$/.test(externalId)) throw new HttpError(400, 'VALIDATION_ERROR', 'Phone Number ID da Meta inválido');
  if (!/^[0-9]{5,32}$/.test(wabaId)) throw new HttpError(400, 'VALIDATION_ERROR', 'WABA ID da Meta inválido');
  if (accessToken.length < 20 || /\s/.test(accessToken)) throw new HttpError(400, 'VALIDATION_ERROR', 'Access token da Meta inválido');
  if (appSecret.length < 12 || /\s/.test(appSecret)) throw new HttpError(400, 'VALIDATION_ERROR', 'App secret da Meta inválido');
  const id = newId();
  const now = nowIso();
  db.prepare(`
    INSERT INTO accounts(id,tenant_id,kind,name,external_id,waba_id,access_token_encrypted,app_secret_encrypted,verify_token_hash,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, tenantId, 'waba', name, externalId, wabaId,
    encryptString(accessToken, encryptionKey, `waba:${id}:token`),
    encryptString(appSecret, encryptionKey, `waba:${id}:secret`),
    null, 'inactive', now, now,
  );
  return { id, name, kind: 'waba', externalId, wabaId, status: 'inactive', credentialsConfigured: true };
}

export function setWabaAccountStatus(db, tenantId, accountId, status) {
  if (!['active', 'inactive'].includes(status)) throw new HttpError(400, 'VALIDATION_ERROR', 'Status WABA inválido');
  const account = db.prepare(`SELECT id FROM accounts WHERE id=? AND tenant_id=? AND kind='waba'`).get(accountId, tenantId);
  if (!account) throw new HttpError(404, 'NOT_FOUND', 'Conta WABA não encontrada');
  db.prepare('UPDATE accounts SET status=?, updated_at=? WHERE id=? AND tenant_id=?').run(status, nowIso(), accountId, tenantId);
  return { id: accountId, status };
}

export function accountForPhoneId(db, phoneId) {
  return db.prepare(`SELECT * FROM accounts WHERE kind='waba' AND external_id=? AND status!='deleted'`).get(String(phoneId)) || null;
}

export function accountSecrets(db, account, encryptionKey) {
  if (!account?.access_token_encrypted || !account?.app_secret_encrypted) {
    throw new HttpError(503, 'ACCOUNT_NOT_CONFIGURED', 'Credenciais da conta WABA não configuradas');
  }
  return {
    accessToken: decryptString(account.access_token_encrypted, encryptionKey, `waba:${account.id}:token`),
    appSecret: decryptString(account.app_secret_encrypted, encryptionKey, `waba:${account.id}:secret`),
  };
}

export function createQrAccount(db, tenantId, input) {
  const name = String(input.name || '').trim();
  if (!name || name.length > 120) throw new HttpError(400, 'VALIDATION_ERROR', 'Nome da conta QR inválido');
  const id = newId();
  const now = nowIso();
  db.prepare(`INSERT INTO accounts(id,tenant_id,kind,name,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
    .run(id, tenantId, 'qr', name, 'disconnected', now, now);
  db.prepare('INSERT INTO qr_sessions(account_id,tenant_id,phase,updated_at) VALUES(?,?,?,?)')
    .run(id, tenantId, 'disconnected', now);
  return { id, name, kind: 'qr', status: 'disconnected' };
}

export function setQrState(db, accountId, { phase, qrPayload, qrExpiresAt, errorCode }) {
  const now = nowIso();
  const fields = ['phase=?', 'updated_at=?'];
  const values = [phase, now];
  if (qrPayload !== undefined) {
    fields.push('qr_payload_encrypted=?');
    values.push(qrPayload);
  }
  if (qrExpiresAt !== undefined) {
    fields.push('qr_expires_at=?');
    values.push(qrExpiresAt);
  }
  if (errorCode !== undefined) {
    fields.push('error_code=?');
    values.push(errorCode);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`UPDATE qr_sessions SET ${fields.join(',')} WHERE account_id=?`).run(...values, accountId);
    db.prepare('UPDATE accounts SET status=?, last_error=?, updated_at=? WHERE id=?').run(phase, errorCode || null, now, accountId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function qrStatus(db, tenantId, accountId) {
  return db.prepare(`
    SELECT a.id, a.name, a.status, a.last_error AS lastError, a.last_activity_at AS lastActivityAt,
      q.phase, q.qr_expires_at AS qrExpiresAt, q.error_code AS qrError
    FROM accounts a LEFT JOIN qr_sessions q ON q.account_id=a.id
    WHERE a.id=? AND a.tenant_id=? AND a.kind='qr'
  `).get(accountId, tenantId) || null;
}
