import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function makeTempDir(prefix = 'crm-web-node-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function keyHex() {
  return createHash('sha256').update('synthetic-test-key').digest('hex');
}

export function baseConfig(tempDir, overrides = {}) {
  return {
    nodeEnv: 'test',
    production: false,
    host: '127.0.0.1',
    port: 0,
    baseUrl: 'http://127.0.0.1:0',
    websiteOrigin: 'http://127.0.0.1',
    dbPath: path.join(tempDir, 'crm.sqlite'),
    tempCampaignDir: path.join(tempDir, 'campaign-temp'),
    qrAuthDir: path.join(tempDir, 'qr-auth'),
    adminEmail: 'admin@example.test',
    adminPassword: 'Synthetic-Only-Password-42!',
    appEncryptionKey: keyHex(),
    metaAppId: '',
    metaAppSecret: 'synthetic-app-secret',
    metaVerifyToken: 'synthetic-verify-token',
    campMaxRecipients: 5000,
    campMaxInFlight: 2,
    qrEnabled: false,
    ...overrides,
  };
}

export async function startApp(overrides = {}) {
  const { createApplication } = await import('../src/server.mjs');
  const application = await createApplication(overrides);
  await new Promise((resolve) => application.server.listen(0, '127.0.0.1', resolve));
  const address = application.server.address();
  application.baseUrl = `http://127.0.0.1:${address.port}`;
  return application;
}

export async function stopApp(application) {
  if (!application) return;
  await application.close();
}

export async function login(application, email = 'admin@example.test', password = 'Synthetic-Only-Password-42!') {
  const response = await fetch(`${application.baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Login falhou: ${response.status} ${JSON.stringify(body)}`);
  return {
    body,
    cookie: response.headers.get('set-cookie').split(';')[0],
    csrf: body.csrfToken,
  };
}
