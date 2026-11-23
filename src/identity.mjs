import { hashPassword, verifyPassword, randomToken, tokenHash, isValidEmail } from './security.mjs';
import { newId, nowIso } from './db.mjs';
import { HttpError } from './http.mjs';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
// Valores sintéticos não autenticam usuário algum; igualam o custo de scrypt para e-mails inexistentes.
const DUMMY_PASSWORD_SALT = 'crm-login-dummy-salt-v1';
const DUMMY_PASSWORD_HASH = 'prc-9kzahr4TjEdHhans3XNGNVQLtG83oIIZwqpMw8ZRhhftAEpE4CiPmNkavfujgIyWVwmiztUW_Fm-UX5oHA';

export async function bootstrapAdmin(db, { email, password }) {
  if (!isValidEmail(email)) throw new Error('ADMIN_EMAIL inválido');
  const existing = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (existing > 0) return;
  const tenantId = newId();
  const userId = newId();
  const createdAt = nowIso();
  const passwordData = await hashPassword(password);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)').run(tenantId, 'Sua Telefonia', createdAt);
    db.prepare('INSERT INTO users(id,tenant_id,email,password_hash,password_salt,role,active,created_at) VALUES(?,?,?,?,?,?,1,?)')
      .run(userId, tenantId, email, passwordData.hash, passwordData.salt, 'admin', createdAt);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export async function createTenantWithUser(db, { name, email, password, role = 'admin' }) {
  const tenantName = String(name || '').trim();
  if (!tenantName || tenantName.length > 120) throw new HttpError(400, 'VALIDATION_ERROR', 'Nome da empresa inválido');
  if (!isValidEmail(email)) throw new HttpError(400, 'VALIDATION_ERROR', 'E-mail inválido');
  if (String(password || '').length < 12) throw new HttpError(400, 'VALIDATION_ERROR', 'A senha deve ter pelo menos 12 caracteres');
  if (!['admin', 'operator'].includes(role)) throw new HttpError(400, 'VALIDATION_ERROR', 'Papel inválido');
  if (db.prepare('SELECT id FROM users WHERE email=?').get(String(email).toLowerCase())) {
    throw new HttpError(409, 'EMAIL_IN_USE', 'Este e-mail já está cadastrado');
  }
  const tenantId = newId();
  const userId = newId();
  const createdAt = nowIso();
  const passwordData = await hashPassword(password);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)').run(tenantId, tenantName, createdAt);
    db.prepare('INSERT INTO users(id,tenant_id,email,password_hash,password_salt,role,active,created_at) VALUES(?,?,?,?,?,?,1,?)')
      .run(userId, tenantId, String(email).toLowerCase(), passwordData.hash, passwordData.salt, role, createdAt);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { id: userId, tenantId, tenantName, email: String(email).toLowerCase(), role };
}

export async function login(db, email, password) {
  const normalized = String(email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(normalized);
  const passwordValid = await verifyPassword(
    password,
    user?.password_salt || DUMMY_PASSWORD_SALT,
    user?.password_hash || DUMMY_PASSWORD_HASH,
  );
  if (!user || !passwordValid) {
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'E-mail ou senha inválidos');
  }
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const session = {
    id: newId(),
    tokenHash: tokenHash(token),
    userId: user.id,
    tenantId: user.tenant_id,
    csrfToken,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    createdAt: nowIso(),
  };
  db.prepare('INSERT INTO sessions(id,token_hash,user_id,tenant_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(session.id, session.tokenHash, session.userId, session.tenantId, session.csrfToken, session.expiresAt, session.createdAt);
  return {
    token,
    session,
    user: { id: user.id, tenantId: user.tenant_id, email: user.email, role: user.role },
  };
}

export function logout(db, rawToken) {
  if (!rawToken) return;
  db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(rawToken));
}

export function authenticateSession(db, rawToken) {
  if (!rawToken) return null;
  const session = db.prepare(`
    SELECT s.*, u.email, u.role, u.active
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>? AND u.active=1
  `).get(tokenHash(rawToken), nowIso());
  return session || null;
}

export function requireSession(session) {
  if (!session) throw new HttpError(401, 'UNAUTHENTICATED', 'Sessão ausente ou expirada');
  return session;
}

export function requireAdmin(session) {
  requireSession(session);
  if (session.role !== 'admin') throw new HttpError(403, 'FORBIDDEN', 'Permissão administrativa necessária');
  return session;
}

export function requireCsrf(session, provided) {
  requireSession(session);
  if (!provided || String(provided) !== session.csrf_token) {
    throw new HttpError(403, 'CSRF_FAILED', 'Token CSRF inválido');
  }
}

export function cleanupSessions(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(nowIso());
}
