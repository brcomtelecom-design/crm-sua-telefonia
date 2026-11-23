import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { encryptString, decryptString, sha256, payloadDigest } from './security.mjs';
import { newId, nowIso } from './db.mjs';
import { readXlsx } from './xlsx.mjs';
import { HttpError } from './http.mjs';

const TEMP_TTL_MS = 60 * 60 * 1000;

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('55') && digits.length === 13 && digits[4] === '9') return digits.slice(0, 4) + digits.slice(5);
  return digits;
}

function isValidCpf(value) {
  const cpf = String(value || '').replace(/\D/g, '');
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  let sum = 0;
  for (let index = 0; index < 9; index += 1) sum += Number(cpf[index]) * (10 - index);
  let digit = (sum * 10) % 11;
  if (digit === 10) digit = 0;
  if (digit !== Number(cpf[9])) return false;
  sum = 0;
  for (let index = 0; index < 10; index += 1) sum += Number(cpf[index]) * (11 - index);
  digit = (sum * 10) % 11;
  if (digit === 10) digit = 0;
  return digit === Number(cpf[10]);
}

function normalizeTemplateParameters(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_PARAMETERS', 'Os parâmetros do modelo devem ser uma lista');
  }
  if (value.length > 20) {
    throw new HttpError(400, 'INVALID_PARAMETERS', 'O modelo aceita no máximo 20 parâmetros');
  }
  return value.map((parameter, index) => {
    if (!['string', 'number', 'boolean'].includes(typeof parameter)) {
      throw new HttpError(400, 'INVALID_PARAMETERS', `Parâmetro ${index + 1} inválido`);
    }
    const text = String(parameter);
    if (!text || text.length > 1000) {
      throw new HttpError(400, 'INVALID_PARAMETERS', `Parâmetro ${index + 1} deve ter entre 1 e 1.000 caracteres`);
    }
    return text;
  });
}

export function storeCampaignUpload(db, tenantId, tempDir, fileBuffer, originalName) {
  const maxCompressed = 2 * 1024 * 1024;
  const maxUncompressed = 20 * 1024 * 1024;
  const maxRows = 5000;
  if (!Buffer.isBuffer(fileBuffer) || !fileBuffer.length) throw new HttpError(400, 'EMPTY_UPLOAD', 'Arquivo XLSX vazio');
  if (fileBuffer.length > maxCompressed) throw new HttpError(413, 'UPLOAD_TOO_LARGE', 'XLSX excede 2 MB comprimidos');
  fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
  const id = newId();
  const safeName = path.basename(String(originalName || 'audiencia.xlsx')).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
  const filePath = path.join(tempDir, `${id}.${safeName.endsWith('.xlsx') ? safeName : `${safeName}.xlsx`}`);
  fs.writeFileSync(filePath, fileBuffer, { mode: 0o600, flag: 'wx' });
  const sha = createHash('sha256').update(fileBuffer).digest('hex');
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + TEMP_TTL_MS).toISOString();
  db.prepare(`
    INSERT INTO campaign_uploads(id,tenant_id,file_path,original_name,sha256,size_bytes,row_count,cell_count,status,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, tenantId, filePath, safeName, sha, fileBuffer.length, 0, 0, 'uploaded', createdAt, expiresAt);
  return { id, filePath, originalName: safeName, sha256: sha, sizeBytes: fileBuffer.length, expiresAt };
}

export function parseCampaignUpload(db, tenantId, uploadId, encryptionKey, maxRecipients = 5000) {
  const recipientLimit = Number(maxRecipients);
  if (!Number.isSafeInteger(recipientLimit) || recipientLimit < 1 || recipientLimit > 5000) {
    throw new HttpError(500, 'INVALID_CONFIGURATION', 'Limite de destinatários inválido');
  }
  const upload = db.prepare('SELECT * FROM campaign_uploads WHERE id=? AND tenant_id=?').get(uploadId, tenantId);
  if (!upload) throw new HttpError(404, 'NOT_FOUND', 'Upload não encontrado');
  if (upload.status === 'rejected') throw new HttpError(422, 'UPLOAD_REJECTED', 'Upload já rejeitado');
  const bytes = fs.readFileSync(upload.file_path);
  if (sha256(bytes) !== upload.sha256) throw new HttpError(409, 'UPLOAD_CHANGED', 'O arquivo temporário foi alterado');
  let parsed;
  try {
    parsed = readXlsx(bytes, { maxRows: recipientLimit });
  } catch (error) {
    db.prepare(`UPDATE campaign_uploads SET status='rejected' WHERE id=? AND tenant_id=?`).run(uploadId, tenantId);
    if (error.code === 'RECIPIENT_LIMIT_EXCEEDED') {
      throw new HttpError(422, 'RECIPIENT_LIMIT_EXCEEDED', `O arquivo excede o limite de ${recipientLimit} destinatários`);
    }
    throw new HttpError(422, 'INVALID_XLSX', String(error.message || 'XLSX inválido'));
  }
  if (parsed.rowCount > recipientLimit) {
    db.prepare(`UPDATE campaign_uploads SET status='rejected' WHERE id=? AND tenant_id=?`).run(uploadId, tenantId);
    throw new HttpError(422, 'RECIPIENT_LIMIT_EXCEEDED', `O arquivo excede o limite de ${recipientLimit} destinatários`);
  }
  const invalidPhones = parsed.rows.filter((row) => normalizePhone(row.phone).length < 10 || normalizePhone(row.phone).length > 15);
  if (invalidPhones.length) {
    db.prepare(`UPDATE campaign_uploads SET status='rejected' WHERE id=? AND tenant_id=?`).run(uploadId, tenantId);
    throw new HttpError(422, 'INVALID_RECIPIENTS', `${invalidPhones.length} linha(s) com telefone inválido`);
  }
  const seen = new Set();
  for (const row of parsed.rows) {
    const phone = normalizePhone(row.phone);
    if (seen.has(phone)) {
      db.prepare(`UPDATE campaign_uploads SET status='rejected' WHERE id=? AND tenant_id=?`).run(uploadId, tenantId);
      throw new HttpError(422, 'DUPLICATE_RECIPIENTS', 'O XLSX contém telefones duplicados');
    }
    seen.add(phone);
    if (row.cpf && !isValidCpf(row.cpf)) {
      db.prepare(`UPDATE campaign_uploads SET status='rejected' WHERE id=? AND tenant_id=?`).run(uploadId, tenantId);
      throw new HttpError(422, 'INVALID_CPF', `CPF inválido na linha ${row.rowNumber}`);
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`UPDATE campaign_uploads SET status='parsed', row_count=?, cell_count=? WHERE id=? AND tenant_id=?`)
      .run(parsed.rowCount, parsed.cellCount, uploadId, tenantId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return {
    uploadId,
    originalName: upload.original_name,
    sha256: upload.sha256,
    sizeBytes: upload.size_bytes,
    rowCount: parsed.rowCount,
    cellCount: parsed.cellCount,
    headers: parsed.headers,
    expiresAt: upload.expires_at,
    encryptionKey,
  };
}

export function createCampaign(db, tenantId, encryptionKey, input, options = {}) {
  const maxRecipients = Number(options.maxRecipients ?? 5000);
  if (!Number.isSafeInteger(maxRecipients) || maxRecipients < 1 || maxRecipients > 5000) {
    throw new HttpError(500, 'INVALID_CONFIGURATION', 'Limite de destinatários inválido');
  }
  const upload = db.prepare('SELECT * FROM campaign_uploads WHERE id=? AND tenant_id=?').get(input.uploadId, tenantId);
  if (!upload) throw new HttpError(404, 'NOT_FOUND', 'Upload não encontrado');
  if (upload.status !== 'parsed') throw new HttpError(409, 'UPLOAD_NOT_READY', 'Upload ainda não foi processado');
  if (upload.expires_at <= nowIso()) throw new HttpError(410, 'UPLOAD_EXPIRED', 'Upload temporário expirou');
  const name = String(input.name || '').trim();
  const templateName = String(input.templateName || '').trim();
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  const parameters = normalizeTemplateParameters(input.parameters);
  if (!name || name.length > 120) throw new HttpError(400, 'VALIDATION_ERROR', 'Nome da campanha inválido');
  if (!/^[a-zA-Z0-9_.-]{2,120}$/.test(templateName)) throw new HttpError(400, 'VALIDATION_ERROR', 'Nome do modelo inválido');
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(idempotencyKey)) throw new HttpError(400, 'VALIDATION_ERROR', 'Chave idempotente inválida');
  const executor = String(input.executor || '').trim();
  if (!['web', 'local'].includes(executor)) throw new HttpError(400, 'INVALID_EXECUTOR', 'Executor deve ser web ou local');
  const installationId = executor === 'local' ? String(input.installationId || '') : null;
  const accountId = executor === 'web' ? String(input.accountId || '').trim() : null;
  if (executor === 'local' && !installationId) throw new HttpError(400, 'VALIDATION_ERROR', 'Instalação local obrigatória');
  if (executor === 'web' && !accountId) throw new HttpError(400, 'ACCOUNT_REQUIRED', 'Selecione a conta WABA da campanha');
  if (executor === 'local') {
    const installation = db.prepare('SELECT id FROM installations WHERE id=? AND tenant_id=? AND active=1').get(installationId, tenantId);
    if (!installation) throw new HttpError(404, 'NOT_FOUND', 'Instalação local não encontrada');
  }
  if (executor === 'web') {
    const account = db.prepare(`SELECT id FROM accounts WHERE id=? AND tenant_id=? AND kind='waba' AND status='active'`).get(accountId, tenantId);
    if (!account) throw new HttpError(409, 'ACCOUNT_UNAVAILABLE', 'A conta WABA selecionada não está ativa');
  }
  const digest = payloadDigest({ name, templateName, parameters, executor, uploadId: upload.id, accountId, installationId });
  const existing = db.prepare('SELECT * FROM campaigns WHERE tenant_id=? AND idempotency_key=?').get(tenantId, idempotencyKey);
  if (existing) {
    if (existing.digest !== digest) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'A chave idempotente já foi usada com outro conteúdo');
    return { ...existing, repeated: true };
  }
  const parsed = readXlsx(fs.readFileSync(upload.file_path), { maxRows: maxRecipients });
  if (parsed.rowCount > maxRecipients) {
    throw new HttpError(422, 'RECIPIENT_LIMIT_EXCEEDED', `A campanha excede o limite de ${maxRecipients} destinatários`);
  }
  const id = newId();
  const now = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO campaigns(id,tenant_id,account_id,installation_id,upload_id,name,executor,status,audience_count,template_name,parameters_json,idempotency_key,digest,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(id, tenantId, accountId, installationId, upload.id, name, executor, executor === 'local' ? 'pending_agent' : 'draft', parsed.rowCount, templateName, JSON.stringify(parameters), idempotencyKey, digest, now, now);
    for (const row of parsed.rows) {
      const phone = normalizePhone(row.phone);
      const payload = {
        name: row.name,
        phone,
        cpf: row.cpf || null,
        email: row.email || null,
        optIn: row.optInAt && row.optInSource && row.optInEvidence ? {
          at: row.optInAt,
          source: row.optInSource,
          evidence: row.optInEvidence,
        } : null,
        custom: row.custom,
      };
      db.prepare(`
        INSERT INTO campaign_recipients(id,tenant_id,campaign_id,row_number,phone_encrypted,phone_digest,payload_encrypted,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)
      `).run(
        newId(), tenantId, id, row.rowNumber,
        encryptString(phone, encryptionKey, `campaign:${id}:phone`),
        sha256(phone),
        encryptString(JSON.stringify(payload), encryptionKey, `campaign:${id}:payload`),
        'pending', now, now,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return db.prepare('SELECT * FROM campaigns WHERE id=?').get(id);
}

export function changeCampaignStatus(db, tenantId, campaignId, status) {
  const allowed = new Set(['queued', 'paused', 'cancelled']);
  if (!allowed.has(status)) throw new HttpError(400, 'INVALID_STATUS', 'Status de campanha inválido');
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id=? AND tenant_id=?').get(campaignId, tenantId);
  if (!campaign) throw new HttpError(404, 'NOT_FOUND', 'Campanha não encontrada');
  if (campaign.executor === 'local') throw new HttpError(409, 'LOCAL_EXECUTOR', 'Use os comandos do agente local para controlar esta campanha');
  if (campaign.status === status) return { ...campaign, repeated: true };
  if (campaign.status === 'completed' || campaign.status === 'cancelled') {
    throw new HttpError(409, 'CAMPAIGN_CLOSED', 'A campanha já foi encerrada');
  }
  let nextStatus = status;
  if (status === 'queued') {
    const remaining = db.prepare(`SELECT COUNT(*) AS n FROM campaign_recipients WHERE campaign_id=? AND tenant_id=? AND status IN ('pending','sending')`)
      .get(campaignId, tenantId).n;
    if (remaining === 0) {
      nextStatus = 'completed';
    } else {
      const account = db.prepare(`SELECT id FROM accounts WHERE id=? AND tenant_id=? AND kind='waba' AND status='active'`)
        .get(campaign.account_id, tenantId);
      if (!account) throw new HttpError(409, 'CHANNEL_UNAVAILABLE', 'A conta WABA da campanha não está ativa');
    }
  }
  const now = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE campaigns SET status=?, updated_at=? WHERE id=? AND tenant_id=?').run(nextStatus, now, campaignId, tenantId);
    if (status === 'cancelled') {
      db.prepare(`UPDATE campaign_recipients SET status='cancelled', updated_at=? WHERE campaign_id=? AND tenant_id=? AND status='pending'`).run(now, campaignId, tenantId);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return db.prepare('SELECT * FROM campaigns WHERE id=?').get(campaignId);
}

export function listCampaigns(db, tenantId) {
  return db.prepare(`
    SELECT c.id, c.name, c.executor, c.status, c.audience_count AS audienceCount, c.template_name AS templateName,
      c.account_id AS accountId, c.installation_id AS installationId, c.created_at AS createdAt, c.updated_at AS updatedAt,
      SUM(CASE WHEN r.status='sent' OR r.status='delivered' OR r.status='read' THEN 1 ELSE 0 END) sent,
      SUM(CASE WHEN r.status='failed' OR r.status='uncertain' THEN 1 ELSE 0 END) attention,
      SUM(CASE WHEN r.status='pending' OR r.status='sending' THEN 1 ELSE 0 END) pending
    FROM campaigns c LEFT JOIN campaign_recipients r ON r.campaign_id=c.id
    WHERE c.tenant_id=? GROUP BY c.id ORDER BY c.created_at DESC LIMIT 200
  `).all(tenantId).map((row) => ({
    ...row,
    sent: Number(row.sent || 0),
    attention: Number(row.attention || 0),
    pending: Number(row.pending || 0),
  }));
}

function pathInsideDirectory(filePath, directory) {
  const root = path.resolve(directory);
  const target = path.resolve(filePath);
  return target.startsWith(`${root}${path.sep}`);
}

export function cleanupExpiredUploads(db, tempDir) {
  const expired = db.prepare(`SELECT id, file_path FROM campaign_uploads WHERE expires_at<=? AND status!='expired'`).all(nowIso());
  let removed = 0;
  for (const upload of expired) {
    if (pathInsideDirectory(upload.file_path, tempDir)) {
      try { fs.rmSync(upload.file_path, { force: true }); } catch {}
    }
    db.prepare(`UPDATE campaign_uploads SET status='expired' WHERE id=?`).run(upload.id);
    removed += 1;
  }
  try {
    for (const entry of fs.readdirSync(tempDir)) {
      const file = path.join(tempDir, entry);
      const stat = fs.statSync(file);
      if (stat.isFile() && Date.now() - stat.mtimeMs > TEMP_TTL_MS) {
        fs.rmSync(file, { force: true });
        removed += 1;
      }
    }
  } catch {}
  return removed;
}

export function campaignReceipts(db, tenantId, campaignId) {
  const campaign = db.prepare('SELECT id FROM campaigns WHERE id=? AND tenant_id=?').get(campaignId, tenantId);
  if (!campaign) throw new HttpError(404, 'NOT_FOUND', 'Campanha não encontrada');
  return db.prepare(`
    SELECT id, recipient_id AS recipientId, provider_message_id AS providerMessageId, status, error_code AS errorCode, received_at AS receivedAt
    FROM campaign_receipts WHERE tenant_id=? AND campaign_id=? ORDER BY received_at DESC LIMIT 500
  `).all(tenantId, campaignId);
}

export function createCampaignCommand(db, tenantId, installationId, type, payload) {
  const validTypes = new Set(['query_audience', 'create_campaign', 'start_campaign', 'pause_campaign', 'cancel_campaign']);
  if (!validTypes.has(type)) throw new HttpError(400, 'INVALID_COMMAND', 'Tipo de comando inválido');
  const installation = db.prepare('SELECT id FROM installations WHERE id=? AND tenant_id=? AND active=1').get(installationId, tenantId);
  if (!installation) throw new HttpError(404, 'NOT_FOUND', 'Instalação local não encontrada');
  const validated = validateCommandPayload(type, payload);
  const digest = payloadDigest(validated);
  const id = newId();
  const now = nowIso();
  db.prepare(`
    INSERT INTO commands(id,tenant_id,installation_id,type,payload_json,digest,executor,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)
  `).run(id, tenantId, installationId, type, JSON.stringify(validated), digest, 'local', 'queued', now, now);
  return { id, type, digest, executor: 'local', status: 'queued', payload: validated, createdAt: now };
}

export function validateCommandPayload(type, payload) {
  const value = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  if (type === 'query_audience') {
    const filters = value.filters && typeof value.filters === 'object' && !Array.isArray(value.filters) ? value.filters : {};
    const allowed = new Set(['status', 'city', 'state', 'postalCode', 'segment', 'consentOnly', 'limit']);
    for (const key of Object.keys(filters)) if (!allowed.has(key)) throw new HttpError(400, 'INVALID_PAYLOAD', `Filtro não permitido: ${key}`);
    if ('sql' in value || 'query' in value || 'sqlText' in value) throw new HttpError(400, 'INVALID_PAYLOAD', 'SQL livre não é permitido');
    const limit = Number(filters.limit ?? 100);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250) throw new HttpError(400, 'INVALID_PAYLOAD', 'limit deve estar entre 1 e 250');
    return { filters: { ...filters, limit } };
  }
  if (type === 'create_campaign') {
    if (!value.campaignId || !/^[A-Za-z0-9._:-]{8,120}$/.test(String(value.campaignId))) throw new HttpError(400, 'INVALID_PAYLOAD', 'campaignId inválido');
    const recipients = Array.isArray(value.recipients) ? value.recipients : [];
    if (recipients.length > 5000) throw new HttpError(400, 'INVALID_PAYLOAD', 'Máximo de 5.000 destinatários');
    return { campaignId: String(value.campaignId), name: String(value.name || '').slice(0, 120), templateName: String(value.templateName || '').slice(0, 120), recipients };
  }
  if (['start_campaign', 'pause_campaign', 'cancel_campaign'].includes(type)) {
    if (!value.campaignId || !/^[A-Za-z0-9._:-]{8,120}$/.test(String(value.campaignId))) throw new HttpError(400, 'INVALID_PAYLOAD', 'campaignId inválido');
    return { campaignId: String(value.campaignId) };
  }
  throw new HttpError(400, 'INVALID_COMMAND', 'Comando não suportado');
}
