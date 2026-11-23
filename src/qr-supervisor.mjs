import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export class QrSupervisor {
  constructor({ enabled, authDir, baseUrl, logger = console, workerPath, spawnImpl = spawn }) {
    this.enabled = enabled;
    this.authDir = path.resolve(authDir);
    this.baseUrl = baseUrl;
    this.logger = logger;
    this.workerPath = workerPath || path.join(HERE, 'qr-worker.mjs');
    this.spawnImpl = spawnImpl;
    this.ipcDir = path.join(this.authDir, '.ipc');
    this.tokenPath = path.join(this.ipcDir, 'access.key');
    this.socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\sua-crm-qr-${Buffer.from(this.authDir).toString('hex').slice(0, 24)}` : path.join(this.ipcDir, 'worker.sock');
    this.child = null;
    this.starting = null;
  }

  available() {
    return this.enabled;
  }

  async ensureStarted() {
    if (!this.enabled) {
      const error = new Error('QR Web está desabilitado. Configure QR_ENABLED=true e conclua o setup do motor.');
      error.code = 'QR_DISABLED';
      throw error;
    }
    if (this.starting) return this.starting;
    if (this.child) return;
    this.starting = (async () => {
      mkdirSync(this.ipcDir, { recursive: true, mode: 0o700 });
      chmodSync(this.ipcDir, 0o700);
      const token = randomBytes(32).toString('hex');
      writeFileSync(this.tokenPath, token, { mode: 0o600 });
      chmodSync(this.tokenPath, 0o600);
      const child = this.spawnImpl(process.execPath, [this.workerPath], {
        cwd: HERE,
        env: { ...process.env, CRM_QR_AUTH_DIR: this.authDir, CRM_QR_SOCKET: this.socketPath, CRM_QR_TOKEN: token, CRM_BASE_URL: this.baseUrl },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
      child.stdout.on('data', (chunk) => this.logger.info?.(`[qr] ${String(chunk).trim()}`));
      child.stderr.on('data', (chunk) => this.logger.error?.(`[qr] ${String(chunk).trim()}`));
      child.on('exit', (code) => {
        if (this.child === child) {
          this.child = null;
          rmSync(this.tokenPath, { force: true });
        }
        this.logger.warn?.(`[qr] Motor encerrou com código ${code}`);
      });
      await new Promise((resolve, reject) => {
        let stdout = '';
        const timer = setTimeout(() => {
          cleanup();
          reject(Object.assign(new Error('Motor QR não iniciou.'), { code: 'QR_START_TIMEOUT' }));
        }, 10000);
        const onData = (chunk) => {
          stdout += String(chunk);
          if (!stdout.includes('[qr] Motor QR privado iniciado.')) return;
          cleanup();
          resolve();
        };
        const onExit = () => {
          cleanup();
          reject(Object.assign(new Error('Motor QR encerrou durante o startup.'), { code: 'QR_START_FAILED' }));
        };
        const onError = (error) => {
          cleanup();
          reject(Object.assign(new Error('Motor QR não pôde ser iniciado.'), { code: 'QR_START_FAILED', cause: error }));
        };
        const cleanup = () => {
          clearTimeout(timer);
          child.stdout.off('data', onData);
          child.off('exit', onExit);
          child.off('error', onError);
        };
        child.stdout.on('data', onData);
        child.once('exit', onExit);
        child.once('error', onError);
      });
    })().catch((error) => {
      const child = this.child;
      this.child = null;
      if (child && !child.killed) {
        try { child.kill(); } catch {}
      }
      rmSync(this.tokenPath, { force: true });
      throw error;
    }).finally(() => { this.starting = null; });
    return this.starting;
  }

  async request(command, { timeout = 15000 } = {}) {
    await this.ensureStarted();
    const token = readFileSync(this.tokenPath, 'utf8');
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      socket.setEncoding('utf8');
      let output = '';
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => finish(Object.assign(new Error('Motor QR não respondeu.'), { code: 'QR_TIMEOUT' })), timeout);
      socket.on('error', (error) => finish(Object.assign(new Error('Motor QR indisponível.'), { code: 'QR_UNAVAILABLE', cause: error })));
      socket.on('connect', () => socket.write(JSON.stringify({ ...command, token }) + '\n'));
      socket.on('data', (chunk) => {
        output += chunk;
        if (Buffer.byteLength(output) > 300000) return finish(new Error('Resposta QR acima do limite.'));
        if (!output.includes('\n')) return;
        try {
          const parsed = JSON.parse(output.split('\n')[0]);
          if (!parsed.ok) return finish(Object.assign(new Error(parsed.error || 'Falha no motor QR.'), { code: parsed.code || 'QR_ERROR' }));
          finish(null, parsed.value);
        } catch {
          finish(new Error('Resposta QR inválida.'));
        }
      });
    });
  }

  async stop() {
    if (this.child) {
      try { await this.request({ action: 'shutdown' }, { timeout: 2000 }); } catch {}
      this.child.kill();
    }
  }
}

export function constantTimeTokenMatch(provided, expected) {
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}
