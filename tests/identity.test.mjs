import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir, baseConfig, startApp, stopApp, login } from './helpers.mjs';

test('consulta anônima de sessão responde sem erro de autenticação', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));

  const response = await fetch(`${app.baseUrl}/api/session`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { user: null });
});

test('rota inicial entrega a interface e os assets visuais autorizados', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));

  const page = await fetch(`${app.baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') || '', /^text\/html/);
  assert.match(await page.text(), /id="login-form"/);

  const logo = await fetch(`${app.baseUrl}/assets/logo-st-original.png`);
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get('content-type'), 'image/png');
});

test('login protege sessão, aplica cookie HttpOnly e sessão deriva o tenant', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));
  const session = await login(app);
  assert.match(session.cookie, /^crm_session=/);
  const me = await fetch(`${app.baseUrl}/api/session`, { headers: { Cookie: session.cookie } });
  assert.equal(me.status, 200);
  const body = await me.json();
  assert.equal(body.user.email, 'admin@example.test');
  assert.ok(body.user.tenantId);
  assert.ok(body.csrfToken);
});

test('mutação sem CSRF é rejeitada', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));
  const session = await login(app);
  const response = await fetch(`${app.baseUrl}/api/installations`, {
    method: 'POST', headers: { Cookie: session.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'PC' }),
  });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error.code, 'CSRF_FAILED');
});

test('logout revoga a sessão persistida', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));
  const session = await login(app);
  const logout = await fetch(`${app.baseUrl}/api/session`, {
    method: 'DELETE', headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrf },
  });
  assert.equal(logout.status, 200);
  const me = await fetch(`${app.baseUrl}/api/session`, { headers: { Cookie: session.cookie } });
  assert.equal(me.status, 401);
});
