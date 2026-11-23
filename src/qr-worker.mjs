import { createServer } from 'node:net';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const authRoot = path.resolve(process.env.CRM_QR_AUTH_DIR || '');
const socketPath = process.env.CRM_QR_SOCKET || '';
const token = process.env.CRM_QR_TOKEN || '';
const sessions = new Map();
let baileys;
let qrcode;
let stopping = false;

if (!authRoot || !socketPath || !token) {
  console.error('Configuração privada do motor QR ausente.');
  process.exit(2);
}

function safeToken(value) {
  const a = Buffer.from(String(value || ''));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function accountDirectory(accountId) {
  if (!/^[a-f0-9-]{16,80}$/i.test(String(accountId || ''))) throw new Error('Conta QR inválida.');
  const directory = path.resolve(authRoot, accountId);
  if (!directory.startsWith(path.resolve(authRoot) + path.sep)) throw new Error('Diretório de sessão QR inválido.');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

async function loadDependencies() {
  baileys ??= await import('@whiskeysockets/baileys');
  qrcode ??= await import('qrcode');
}

async function connect(accountId) {
  await loadDependencies();
  if (sessions.has(accountId)) {
    const existing = sessions.get(accountId);
    if (existing.status === 'new_pairing_required') {
      throw Object.assign(new Error('Esta conta exige um novo pareamento explícito.'), { code: 'NEW_PAIRING_REQUIRED' });
    }
    return { status: existing.status };
  }
  const makeSocket = baileys.default?.default || baileys.default || baileys.makeWASocket;
  const { state, saveCreds } = await baileys.useMultiFileAuthState(accountDirectory(accountId));
  const logger = { level: 'silent', child() { return this; }, trace() {}, debug() {}, info() {}, fatal() {}, warn() {}, error() {} };
  const sock = makeSocket({ auth: state, logger, browser: baileys.Browsers?.ubuntu('Chrome'), markOnlineOnConnect: false, syncFullHistory: false });
  const session = { sock, status: 'connecting', qr: null, qrAt: 0, saveCreds };
  sessions.set(accountId, session);
  sock.ev.on('creds.update', () => saveCreds().catch(() => {}));
  sock.ev.on('connection.update', (event) => {
    if (event.qr) {
      session.qr = event.qr;
      session.qrAt = Date.now();
      session.status = 'awaiting_qr';
    }
    if (event.connection === 'open') {
      session.status = 'connected';
      session.qr = null;
    }
    if (event.connection === 'close') {
      session.qr = null;
      const statusCode = Number(event.lastDisconnect?.error?.output?.statusCode || event.lastDisconnect?.error?.statusCode || 0);
      if ([401, 403, 440].includes(statusCode)) {
        session.status = 'new_pairing_required';
      } else {
        session.status = 'disconnected';
        sessions.delete(accountId);
      }
    }
  });
  return { status: session.status };
}

async function command(input) {
  const action = String(input.action || '');
  if (action === 'ping') return { protocol: 1, version: '0.1.0' };
  if (action === 'shutdown') {
    setTimeout(() => process.exit(0), 20);
    return { ok: true };
  }
  if (action === 'connect') return connect(String(input.accountId || ''));
  if (action === 'qr') {
    const session = sessions.get(String(input.accountId || ''));
    if (!session?.qr || Date.now() - session.qrAt > 60000) return { status: session?.status || 'disconnected', qr: null };
    await loadDependencies();
    const QRCode = qrcode.default || qrcode;
    return { status: session.status, qr: await QRCode.toDataURL(session.qr, { width: 280, margin: 2 }), expiresAt: new Date(session.qrAt + 60000).toISOString() };
  }
  if (action === 'disconnect') {
    const session = sessions.get(String(input.accountId || ''));
    if (session) {
      try { session.sock.end(new Error('Desconectado pelo CRM')); } catch {}
      sessions.delete(String(input.accountId || ''));
    }
    return { status: 'disconnected' };
  }
  if (action === 'reset') {
    const accountId = String(input.accountId || '');
    const session = sessions.get(accountId);
    if (session) {
      try { await session.sock.logout(); } catch {}
      sessions.delete(accountId);
    }
    rmSync(accountDirectory(accountId), { recursive: true, force: true });
    return { status: 'new_pairing_required' };
  }
  throw Object.assign(new Error('Operação QR inválida.'), { code: 'QR_INVALID_ACTION' });
}

const server = createServer((socket) => {
  let input = '';
  let handled = false;
  socket.setEncoding('utf8');
  socket.setTimeout(40000, () => socket.destroy());
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    if (handled) return;
    input += chunk;
    if (Buffer.byteLength(input) > 16000) return socket.destroy();
    if (!input.includes('\n')) return;
    handled = true;
    let parsed;
    try { parsed = JSON.parse(input.split('\n')[0]); } catch { return socket.end(JSON.stringify({ ok: false, error: 'Comando QR inválido.' }) + '\n'); }
    if (!safeToken(parsed.token)) return socket.end(JSON.stringify({ ok: false, error: 'Acesso QR inválido.' }) + '\n');
    Promise.resolve(command(parsed)).then(
      (value) => socket.end(JSON.stringify({ ok: true, value }) + '\n'),
      (error) => socket.end(JSON.stringify({ ok: false, error: String(error.message || 'Falha QR.').slice(0, 300), code: error.code || 'QR_ERROR' }) + '\n'),
    );
  });
});

server.on('error', (error) => {
  console.error(`[qr] Falha no canal privado: ${error.message}`);
  process.exit(1);
});
server.listen(socketPath, () => console.info('[qr] Motor QR privado iniciado.'));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { stopping = true; server.close(); process.exit(0); });
