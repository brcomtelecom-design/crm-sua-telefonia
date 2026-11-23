import path from 'node:path';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function required(env, key) {
  const value = String(env[key] ?? '').trim();
  if (!value) throw new ConfigError(`Variável obrigatória ausente: ${key}`);
  return value;
}

function integer(env, key, fallback, min, max) {
  const raw = env[key];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(`${key} deve ser um inteiro entre ${min} e ${max}`);
  }
  return value;
}

function boolean(env, key, fallback = false) {
  const raw = env[key];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new ConfigError(`${key} deve ser true ou false`);
}

export function loadConfig(env = process.env) {
  const nodeEnv = String(env.NODE_ENV || 'development').trim();
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new ConfigError('NODE_ENV deve ser development, test ou production');
  }

  const host = String(env.HOST || '127.0.0.1').trim();
  const port = integer(env, 'PORT', 3000, 1, 65535);
  const baseUrl = String(env.BASE_URL || '').trim().replace(/\/$/, '');
  const websiteOrigin = String(env.WEBSITE_ORIGIN || baseUrl).trim().replace(/\/$/, '');
  const dbPath = path.resolve(String(env.DB_PATH || './data/crm.sqlite').trim());
  const tempCampaignDir = path.resolve(String(env.TEMP_CAMPAIGN_DIR || './data/campaign-temp').trim());
  const qrAuthDir = path.resolve(String(env.QR_AUTH_DIR || './data/qr-auth').trim());

  const config = {
    nodeEnv,
    production: nodeEnv === 'production',
    host,
    port,
    baseUrl,
    websiteOrigin,
    dbPath,
    tempCampaignDir,
    qrAuthDir,
    adminEmail: String(env.ADMIN_EMAIL || '').trim().toLowerCase(),
    adminPassword: String(env.ADMIN_PASSWORD || ''),
    appEncryptionKey: String(env.APP_ENCRYPTION_KEY || '').trim(),
    metaAppId: String(env.META_APP_ID || '').trim(),
    metaAppSecret: String(env.META_APP_SECRET || '').trim(),
    metaVerifyToken: String(env.META_VERIFY_TOKEN || '').trim(),
    campMaxRecipients: integer(env, 'CAMP_MAX_RECIPIENTS', 5000, 1, 5000),
    campMaxInFlight: integer(env, 'CAMP_MAX_IN_FLIGHT', 2, 1, 20),
    qrEnabled: boolean(env, 'QR_ENABLED', false),
  };

  if (!config.adminEmail || !config.adminPassword) {
    throw new ConfigError('ADMIN_EMAIL e ADMIN_PASSWORD são obrigatórios');
  }
  if (config.adminPassword.length < 12) {
    throw new ConfigError('ADMIN_PASSWORD deve ter pelo menos 12 caracteres');
  }
  if (!config.appEncryptionKey) {
    throw new ConfigError('APP_ENCRYPTION_KEY é obrigatória');
  }
  if (config.production) {
    if (!baseUrl || !websiteOrigin) throw new ConfigError('BASE_URL e WEBSITE_ORIGIN são obrigatórios em production');
    for (const [name, value] of [['BASE_URL', baseUrl], ['WEBSITE_ORIGIN', websiteOrigin]]) {
      const parsed = new URL(value);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new ConfigError(`${name} deve ser uma URL HTTPS sem credenciais, query ou fragmento`);
      }
    }
  }
  if (config.qrEnabled && !config.baseUrl) {
    throw new ConfigError('BASE_URL é obrigatória quando QR_ENABLED=true');
  }
  return config;
}
