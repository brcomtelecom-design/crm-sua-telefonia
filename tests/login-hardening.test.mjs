import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir, baseConfig, startApp, stopApp, login } from './helpers.mjs';

test('login limita tentativas inválidas e informa Retry-After', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));
  const body = JSON.stringify({ email: 'inexistente@example.test', password: 'Senha-Incorreta-123!' });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`${app.baseUrl}/api/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    assert.equal(response.status, 401);
  }
  const blocked = await fetch(`${app.baseUrl}/api/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  });
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error.code, 'LOGIN_RATE_LIMITED');
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
});

test('login em desenvolvimento aceita a origem exata do servidor e rejeita origem externa', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));
  const accepted = await fetch(`${app.baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: app.baseUrl },
    body: JSON.stringify({ email: 'admin@example.test', password: 'Synthetic-Only-Password-42!' }),
  });
  assert.equal(accepted.status, 200);
  const rejected = await fetch(`${app.baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://externo.example.test' },
    body: JSON.stringify({ email: 'admin@example.test', password: 'Synthetic-Only-Password-42!' }),
  });
  assert.equal(rejected.status, 403);
  assert.equal((await rejected.json()).error.code, 'ORIGIN_REJECTED');
});
