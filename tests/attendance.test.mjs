import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir, baseConfig, startApp, stopApp, login } from './helpers.mjs';
import { newId, nowIso } from '../src/db.mjs';

test('resposta de atendimento mantém idempotência e impede reutilização com outro corpo', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));
  const owner = await login(app);
  const tenantId = owner.body.user.tenantId;
  const accountId = newId();
  const conversationId = newId();
  const now = nowIso();
  app.db.prepare(`INSERT INTO accounts(id,tenant_id,kind,name,status,created_at,updated_at) VALUES(?,?,'qr','QR','connected',?,?)`).run(accountId, tenantId, now, now);
  app.db.prepare(`INSERT INTO conversations(id,tenant_id,account_id,remote_id,customer_name,last_message_at,created_at) VALUES(?,?,?,?,?,?,?)`).run(conversationId, tenantId, accountId, '5511999999999', 'Cliente', now, now);
  const headers = { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf, 'Content-Type': 'application/json' };
  const first = await fetch(`${app.baseUrl}/api/conversations/${conversationId}/messages`, { method: 'POST', headers, body: JSON.stringify({ body: 'Olá', idempotencyKey: 'message-key-0001' }) });
  assert.equal(first.status, 202);
  const firstBody = await first.json();
  assert.equal(firstBody.status, 'pending');
  const repeated = await fetch(`${app.baseUrl}/api/conversations/${conversationId}/messages`, { method: 'POST', headers, body: JSON.stringify({ body: 'Olá', idempotencyKey: 'message-key-0001' }) });
  assert.equal(repeated.status, 202);
  assert.equal((await repeated.json()).messageId, firstBody.messageId);
  const conflict = await fetch(`${app.baseUrl}/api/conversations/${conversationId}/messages`, { method: 'POST', headers, body: JSON.stringify({ body: 'Outro', idempotencyKey: 'message-key-0001' }) });
  assert.equal(conflict.status, 409);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
});

test('resposta para conversa inexistente retorna 404 sem erro interno', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));
  const owner = await login(app);
  const response = await fetch(`${app.baseUrl}/api/conversations/conversa-inexistente-0001/messages`, {
    method: 'POST',
    headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'Olá', idempotencyKey: 'message-conversa-inexistente-0001' }),
  });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'NOT_FOUND');
});
