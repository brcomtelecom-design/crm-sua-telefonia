import http from 'node:http';
import fs, { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, newId, nowIso } from './db.mjs';
import { loadConfig } from './config.mjs';
import {
  bootstrapAdmin, login, logout, authenticateSession, requireSession, requireAdmin, requireCsrf, cleanupSessions,
  createTenantWithUser,
} from './identity.mjs';
import {
  listAccounts, createInstallation, listInstallations, authenticateInstallation, touchInstallation,
  createWabaAccount, createQrAccount, qrStatus, setWabaAccountStatus, setQrState,
} from './accounts.mjs';
import { listConversations, listMessages, createOutgoingIntent, updateOutgoingMessage } from './attendance.mjs';
import {
  verifyMetaSignature, verifyChallenge, parseWebhookEvents, persistWebhookBatch, resolveWebhookAccount,
  sendWabaText,
} from './waba.mjs';
import {
  storeCampaignUpload, parseCampaignUpload, createCampaign, listCampaigns, campaignReceipts, createCampaignCommand,
  changeCampaignStatus, cleanupExpiredUploads,
} from './campaigns.mjs';
import { CampaignQueue } from './campaign-queue.mjs';
import { listCommands, claimCommand, acknowledgeCommand, receiveEvent, requeueExpiredCommands } from './bridge.mjs';
import { QrSupervisor } from './qr-supervisor.mjs';
import { LoginThrottle } from './login-throttle.mjs';
import { decryptString } from './security.mjs';
import {
  HttpError, readBody, readJson, sendJson, sendText, parseCookies, cookie, clearCookie, parseLimit,
  originAllowed,
} from './http.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, '..', 'public');
const SESSION_COOKIE = 'crm_session';
const MAX_JSON_BODY = 1024 * 1024;
const MAX_UPLOAD_BODY = 2 * 1024 * 1024;

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
}

function sessionFromRequest(req, db) {
  const cookies = parseCookies(req.headers.cookie);
  return authenticateSession(db, cookies[SESSION_COOKIE]);
}

function csrfFor(req, db) {
  const session = sessionFromRequest(req, db);
  return session?.csrf_token || null;
}

function assertSameOrigin(req, config) {
  const origin = String(req.headers.origin || '');
  if (!origin) return;
  const configured = [config.websiteOrigin, config.baseUrl].filter(Boolean);
  if (originAllowed(req, configured)) return;
  if (!config.production) {
    try {
      const parsed = new URL(origin);
      if (parsed.host === String(req.headers.host || '') && ['http:', 'https:'].includes(parsed.protocol)) return;
    } catch {}
  }
  throw new HttpError(403, 'ORIGIN_REJECTED', 'Origem não autorizada');
}

function routeMatch(pathname, pattern) {
  if (pathname === pattern) return [];
  if (!pathname.startsWith(`${pattern}/`)) return null;
  const rest = pathname.slice(pattern.length + 1);
  return rest.split('/').map((part) => decodeURIComponent(part));
}

function jsonError(res, error, requestIdValue) {
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : 'INTERNAL_ERROR';
  const message = error instanceof HttpError ? error.message : 'Erro interno';
  if (status >= 500) console.error(JSON.stringify({ level: 'error', requestId: requestIdValue, code, message: error.message }));
  sendJson(res, status, { error: { code, message, requestId: requestIdValue } });
}

function safeStaticPath(pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const resolved = path.resolve(PUBLIC_DIR, relative);
  if (!resolved.startsWith(path.resolve(PUBLIC_DIR) + path.sep)) return null;
  return resolved;
}

export async function createApplication(overrides = {}) {
  const config = overrides.nodeEnv
    ? { ...overrides }
    : { ...loadConfig(process.env), ...overrides };
  config.production = config.nodeEnv === 'production';
  const db = overrides.db || openDatabase(config.dbPath);
  await bootstrapAdmin(db, { email: config.adminEmail, password: config.adminPassword });
  const qr = overrides.qr || new QrSupervisor({ enabled: config.qrEnabled, authDir: config.qrAuthDir, baseUrl: config.baseUrl });
  const fetchImpl = overrides.fetchImpl || globalThis.fetch;
  const loginThrottle = overrides.loginThrottle || new LoginThrottle();
  const queue = overrides.queue || new CampaignQueue({
    db,
    encryptionKey: config.appEncryptionKey,
    maxInFlight: config.campMaxInFlight,
    sendRecipient: async ({ recipientId, tenantId, campaignId, payload, templateName, parameters }) => {
      const campaign = db.prepare('SELECT * FROM campaigns WHERE id=? AND tenant_id=?').get(campaignId, tenantId);
      const account = campaign
        ? db.prepare(`SELECT * FROM accounts WHERE id=? AND tenant_id=? AND kind='waba' AND status='active'`).get(campaign.account_id, tenantId)
        : null;
      if (!campaign || !account) throw Object.assign(new Error('Conta WABA não configurada para a campanha.'), { code: 'ACCOUNT_UNAVAILABLE' });
      const result = await sendWabaText({
        db,
        tenantId,
        message: { remote_id: payload.phone, body: payload.name || '' },
        account,
        encryptionKey: config.appEncryptionKey,
        fetchImpl,
        templateName,
        parameters,
      });
      return { status: 'sent', providerMessageId: result.providerMessageId };
    },
  });
  if (!overrides.queue) {
    queue.recoverInterrupted();
    queue.start();
  }
  const cleanupTimer = setInterval(() => {
    cleanupSessions(db);
    cleanupExpiredUploads(db, config.tempCampaignDir);
    loginThrottle.cleanup();
  }, 15 * 60 * 1000);
  cleanupTimer.unref?.();
  cleanupExpiredUploads(db, config.tempCampaignDir);

  const server = http.createServer(async (req, res) => {
    securityHeaders(res);
    const requestIdValue = newId();
    res.setHeader('X-Request-Id', requestIdValue);
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;
      const method = req.method || 'GET';

      if (pathname === '/api/health' && method === 'GET') {
        sendJson(res, 200, { ok: true, service: 'sua-telefonia-crm-web-node', time: nowIso() });
        return;
      }

      if (pathname === '/api/meta/webhook' && method === 'GET') {
        const challenge = verifyChallenge(url.searchParams, config.metaVerifyToken);
        if (!challenge) throw new HttpError(403, 'WEBHOOK_CHALLENGE_REJECTED', 'Desafio de webhook inválido');
        sendText(res, 200, challenge);
        return;
      }

      if (pathname === '/api/meta/webhook' && method === 'POST') {
        const rawBody = await readBody(req, MAX_JSON_BODY);
        let parsed;
        try { parsed = JSON.parse(rawBody.toString('utf8')); } catch { throw new HttpError(400, 'INVALID_WEBHOOK', 'JSON inválido'); }
        const phoneId = parsed?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id || '';
        const account = resolveWebhookAccount(db, phoneId);
        const appSecret = account.app_secret_encrypted
          ? decryptString(account.app_secret_encrypted, config.appEncryptionKey, `waba:${account.id}:secret`)
          : config.metaAppSecret;
        const secrets = { accessToken: '', appSecret };
        if (!verifyMetaSignature(rawBody, req.headers['x-hub-signature-256'], secrets.appSecret)) {
          throw new HttpError(401, 'INVALID_SIGNATURE', 'Assinatura do webhook inválida');
        }
        const events = parseWebhookEvents(rawBody);
        if (events.some((event) => event.phoneId !== account.external_id)) {
          throw new HttpError(400, 'WEBHOOK_ACCOUNT_MISMATCH', 'O webhook contém eventos de outra conta');
        }
        persistWebhookBatch(db, account.tenant_id, account, rawBody, events, config.appEncryptionKey);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname.startsWith('/api/agent/v1/')) {
        const authorization = String(req.headers.authorization || '');
        const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
        const installation = authenticateInstallation(db, token);
        if (!installation) throw new HttpError(401, 'UNAUTHENTICATED', 'Instalação inválida ou revogada');
        requeueExpiredCommands(db, installation);
        touchInstallation(db, installation.id);
        if (method === 'GET' && pathname === '/api/agent/v1/commands') {
          const limit = parseLimit(url.searchParams.get('limit'), 50, 100);
          const after = String(url.searchParams.get('after') || '');
          sendJson(res, 200, { items: listCommands(db, installation, { after, limit }) });
          return;
        }
        const commandParts = routeMatch(pathname, '/api/agent/v1/commands');
        if (commandParts?.length === 2 && method === 'POST' && commandParts[1] === 'claim') {
          const body = await readJson(req);
          sendJson(res, 200, claimCommand(db, installation, commandParts[0], body));
          return;
        }
        if (commandParts?.length === 2 && method === 'POST' && commandParts[1] === 'ack') {
          const body = await readJson(req);
          sendJson(res, 200, acknowledgeCommand(db, installation, commandParts[0], body));
          return;
        }
        if (pathname === '/api/agent/v1/events' && method === 'POST') {
          const body = await readJson(req);
          sendJson(res, 200, receiveEvent(db, installation, body));
          return;
        }
        throw new HttpError(404, 'NOT_FOUND', 'Rota de agente não encontrada');
      }

      if (pathname === '/api/session' && method === 'POST') {
        assertSameOrigin(req, config);
        const body = await readJson(req);
        const throttleKey = loginThrottle.keyFor(req.socket.remoteAddress, body.email);
        try {
          loginThrottle.assertAllowed(throttleKey);
        } catch (error) {
          const retryAfterSeconds = Number(error?.details?.retryAfterSeconds || 0);
          if (retryAfterSeconds > 0) res.setHeader('Retry-After', String(retryAfterSeconds));
          throw error;
        }
        let result;
        try {
          result = await login(db, body.email, body.password);
        } catch (error) {
          if (error instanceof HttpError && error.status === 401) loginThrottle.recordFailure(throttleKey);
          throw error;
        }
        loginThrottle.recordSuccess(throttleKey);
        const secure = config.production;
        res.setHeader('Set-Cookie', cookie(SESSION_COOKIE, result.token, {
          httpOnly: true, secure, sameSite: 'Strict', maxAge: 12 * 60 * 60,
        }));
        sendJson(res, 200, { user: result.user, csrfToken: result.session.csrfToken });
        return;
      }
      if (pathname === '/api/session' && method === 'GET') {
        const sessionToken = parseCookies(req.headers.cookie)[SESSION_COOKIE];
        const session = sessionFromRequest(req, db);
        if (!session) {
          if (!sessionToken) {
            sendJson(res, 200, { user: null });
            return;
          }
          throw new HttpError(401, 'UNAUTHENTICATED', 'Sessão ausente ou expirada');
        }
        sendJson(res, 200, {
          user: { id: session.user_id, tenantId: session.tenant_id, email: session.email, role: session.role },
          csrfToken: session.csrf_token,
        });
        return;
      }
      if (pathname === '/api/session' && method === 'DELETE') {
        const session = requireSession(sessionFromRequest(req, db));
        requireCsrf(session, req.headers['x-csrf-token']);
        assertSameOrigin(req, config);
        logout(db, parseCookies(req.headers.cookie)[SESSION_COOKIE]);
        res.setHeader('Set-Cookie', clearCookie(SESSION_COOKIE, { secure: config.production, sameSite: 'Strict' }));
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname.startsWith('/api/')) {
        const session = requireSession(sessionFromRequest(req, db));
        if (!['GET', 'HEAD'].includes(method)) {
          requireCsrf(session, req.headers['x-csrf-token']);
          assertSameOrigin(req, config);
        }

        if (pathname === '/api/accounts' && method === 'GET') {
          sendJson(res, 200, { items: listAccounts(db, session.tenant_id) });
          return;
        }
        if (pathname === '/api/installations' && method === 'GET') {
          sendJson(res, 200, { items: listInstallations(db, session.tenant_id) });
          return;
        }
        if (pathname === '/api/installations' && method === 'POST') {
          requireAdmin(session);
          const body = await readJson(req);
          const name = String(body.name || '').trim();
          if (!name || name.length > 120) throw new HttpError(400, 'VALIDATION_ERROR', 'Nome da instalação inválido');
          const result = createInstallation(db, session.tenant_id, name);
          sendJson(res, 201, { installation: result, warning: 'Copie o token agora; ele não será exibido novamente.' });
          return;
        }
        if (pathname === '/api/admin/tenants' && method === 'POST') {
          requireAdmin(session);
          const body = await readJson(req);
          const user = await createTenantWithUser(db, body);
          sendJson(res, 201, { user });
          return;
        }
        if (pathname === '/api/waba-accounts' && method === 'POST') {
          requireAdmin(session);
          const body = await readJson(req);
          sendJson(res, 201, createWabaAccount(db, session.tenant_id, config.appEncryptionKey, body));
          return;
        }
        const wabaParts = routeMatch(pathname, '/api/waba-accounts');
        if (wabaParts?.length === 1 && method === 'PATCH') {
          requireAdmin(session);
          const body = await readJson(req);
          sendJson(res, 200, setWabaAccountStatus(db, session.tenant_id, wabaParts[0], String(body.status || '')));
          return;
        }
        if (pathname === '/api/qr-accounts' && method === 'POST') {
          requireAdmin(session);
          const body = await readJson(req);
          sendJson(res, 201, createQrAccount(db, session.tenant_id, body));
          return;
        }
        const qrParts = routeMatch(pathname, '/api/qr-accounts');
        if (qrParts?.length === 1 && method === 'GET') {
          const status = qrStatus(db, session.tenant_id, qrParts[0]);
          if (!status) throw new HttpError(404, 'NOT_FOUND', 'Conta QR não encontrada');
          sendJson(res, 200, status);
          return;
        }
        if (qrParts?.length === 2 && method === 'POST' && qrParts[1] === 'connect') {
          requireAdmin(session);
          if (!config.qrEnabled) throw new HttpError(503, 'QR_DISABLED', 'QR Web está desabilitado até o setup explícito do motor.');
          const status = qrStatus(db, session.tenant_id, qrParts[0]);
          if (!status) throw new HttpError(404, 'NOT_FOUND', 'Conta QR não encontrada');
          const result = await qr.request({ action: 'connect', accountId: qrParts[0] });
          setQrState(db, qrParts[0], { phase: result.status || 'connecting' });
          sendJson(res, 200, { ...status, ...result });
          return;
        }
        if (qrParts?.length === 2 && method === 'GET' && qrParts[1] === 'qr') {
          requireAdmin(session);
          if (!config.qrEnabled) throw new HttpError(503, 'QR_DISABLED', 'QR Web está desabilitado até o setup explícito do motor.');
          const status = qrStatus(db, session.tenant_id, qrParts[0]);
          if (!status) throw new HttpError(404, 'NOT_FOUND', 'Conta QR não encontrada');
          const result = await qr.request({ action: 'qr', accountId: qrParts[0] });
          setQrState(db, qrParts[0], { phase: result.status || 'awaiting_qr' });
          sendJson(res, 200, { ...status, ...result }, { 'Cache-Control': 'no-store' });
          return;
        }
        if (pathname === '/api/conversations' && method === 'GET') {
          const limit = parseLimit(url.searchParams.get('limit'), 50, 100);
          sendJson(res, 200, { items: listConversations(db, session.tenant_id, { after: url.searchParams.get('after'), limit }) });
          return;
        }
        const messagesParts = routeMatch(pathname, '/api/conversations');
        if (messagesParts?.length === 2 && method === 'GET' && messagesParts[1] === 'messages') {
          const limit = parseLimit(url.searchParams.get('limit'), 50, 100);
          sendJson(res, 200, { items: listMessages(db, session.tenant_id, messagesParts[0], { before: url.searchParams.get('before'), limit }) });
          return;
        }
        if (messagesParts?.length === 2 && method === 'POST' && messagesParts[1] === 'messages') {
          const body = await readJson(req);
          const intent = createOutgoingIntent(db, session.tenant_id, messagesParts[0], body);
          if (intent.repeated) {
            const message = intent.message;
            const terminal = ['sent', 'failed', 'uncertain'].includes(message.status);
            sendJson(res, terminal ? 200 : 202, {
              messageId: message.id,
              status: message.status,
              providerMessageId: message.provider_message_id,
              repeated: true,
            });
            return;
          }
          const conversation = db.prepare('SELECT * FROM conversations WHERE id=? AND tenant_id=?').get(messagesParts[0], session.tenant_id);
          if (!conversation) throw new HttpError(404, 'NOT_FOUND', 'Conversa não encontrada');
          const account = db.prepare('SELECT * FROM accounts WHERE id=? AND tenant_id=?').get(conversation.account_id, session.tenant_id);
          if (account?.kind === 'waba' && account.status === 'active') {
            try {
              const result = await sendWabaText({
                db, tenantId: session.tenant_id, message: { remote_id: conversation.remote_id, body: intent.message.body },
                account, encryptionKey: config.appEncryptionKey, fetchImpl,
              });
              const updated = updateOutgoingMessage(db, session.tenant_id, intent.message.id, { status: 'sent', providerMessageId: result.providerMessageId });
              sendJson(res, 200, { messageId: updated.id, status: updated.status, providerMessageId: updated.provider_message_id, repeated: false });
              return;
            } catch (error) {
              const uncertain = ['META_UNCERTAIN', 'TIMEOUT', 'ECONNRESET', 'ECONNABORTED'].includes(error.code);
              const updated = updateOutgoingMessage(db, session.tenant_id, intent.message.id, {
                status: uncertain ? 'uncertain' : 'failed',
                providerMessageId: null,
              });
              throw new HttpError(
                502,
                uncertain ? 'DELIVERY_UNCERTAIN' : 'DELIVERY_FAILED',
                uncertain
                  ? 'O envio não foi confirmado; verifique o WhatsApp antes de repetir.'
                  : 'O canal rejeitou o envio; revise a mensagem e as credenciais.',
                { messageId: updated.id },
              );
            }
          }
          sendJson(res, 202, { messageId: intent.message.id, status: 'pending', channel: account?.kind || 'unavailable' });
          return;
        }
        if (pathname === '/api/campaigns/upload' && method === 'POST') {
          const body = await readBody(req, MAX_UPLOAD_BODY);
          const upload = storeCampaignUpload(db, session.tenant_id, config.tempCampaignDir, body, url.searchParams.get('filename') || 'audiencia.xlsx');
          const parsed = parseCampaignUpload(db, session.tenant_id, upload.id, config.appEncryptionKey, config.campMaxRecipients);
          sendJson(res, 201, {
            upload: {
              id: parsed.uploadId, originalName: parsed.originalName, sha256: parsed.sha256, sizeBytes: parsed.sizeBytes,
              rowCount: parsed.rowCount, cellCount: parsed.cellCount, headers: parsed.headers, expiresAt: parsed.expiresAt,
            },
          });
          return;
        }
        if (pathname === '/api/campaigns' && method === 'GET') {
          sendJson(res, 200, { items: listCampaigns(db, session.tenant_id) });
          return;
        }
        if (pathname === '/api/campaigns' && method === 'POST') {
          const body = await readJson(req);
          const campaign = createCampaign(db, session.tenant_id, config.appEncryptionKey, body, { maxRecipients: config.campMaxRecipients });
          sendJson(res, 201, { campaign });
          return;
        }
        const campaignParts = routeMatch(pathname, '/api/campaigns');
        if (campaignParts?.length === 1 && method === 'GET') {
          const receipts = campaignReceipts(db, session.tenant_id, campaignParts[0]);
          sendJson(res, 200, { items: receipts });
          return;
        }
        if (campaignParts?.length === 2 && method === 'POST' && ['start', 'pause', 'cancel'].includes(campaignParts[1])) {
          const status = campaignParts[1] === 'start' ? 'queued' : campaignParts[1] === 'pause' ? 'paused' : 'cancelled';
          sendJson(res, 200, { campaign: changeCampaignStatus(db, session.tenant_id, campaignParts[0], status) });
          return;
        }
        if (pathname === '/api/agent-commands' && method === 'POST') {
          const body = await readJson(req);
          const command = createCampaignCommand(db, session.tenant_id, body.installationId, body.type, body.payload);
          sendJson(res, 202, { command });
          return;
        }
        throw new HttpError(404, 'NOT_FOUND', 'Rota não encontrada');
      }

      if (method === 'GET' || method === 'HEAD') {
        const filePath = safeStaticPath(pathname);
        if (filePath && existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const extension = path.extname(filePath).toLowerCase();
          const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
          res.writeHead(200, { 'Content-Type': types[extension] || 'application/octet-stream', 'Cache-Control': extension === '.html' ? 'no-store' : 'public, max-age=3600' });
          if (method === 'HEAD') res.end();
          else fs.createReadStream(filePath).pipe(res);
          return;
        }
      }
      throw new HttpError(404, 'NOT_FOUND', 'Página não encontrada');
    } catch (error) {
      jsonError(res, error, requestIdValue);
    }
  });

  async function close() {
    clearInterval(cleanupTimer);
    if (!overrides.queue) queue.stop();
    if (!overrides.qr) await qr.stop();
    if (!overrides.db) db.close();
    await new Promise((resolve) => server.close(resolve));
  }

  return { server, db, config, queue, qr, close };
}
