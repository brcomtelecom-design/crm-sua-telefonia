export const PROFILE_CONFIG = Object.freeze({
  public: Object.freeze({
    packageName: 'SUA_TELEFONIA_CRM_WEB_NODE',
    rootFolder: 'SUA_TELEFONIA_CRM_WEB_NODE',
    description: 'Pacote público de implantação, sem testes nem ferramentas internas de empacotamento.',
  }),
  source: Object.freeze({
    packageName: 'SUA_TELEFONIA_CRM_WEB_NODE_SOURCE',
    rootFolder: 'SUA_TELEFONIA_CRM_WEB_NODE_SOURCE',
    description: 'Pacote de fonte, incluindo testes sintéticos e ferramentas de empacotamento.',
  }),
});

export const VISUAL_ASSETS = Object.freeze([
  'public/assets/logo-st-original.png',
  'public/assets/avatar-default.svg',
  'public/assets/favicon.svg',
]);

export const ALWAYS_EXCLUDED_DIRS = Object.freeze([
  'node_modules', '.git', 'data', 'logs', 'auth', 'qr-auth', 'campaign-temp',
  'coverage', 'backups', '.cache',
]);

const PUBLIC_EXACT_FILES = new Set([
  '.env.example',
  '.gitignore',
  'README.md',
  'LIMITACOES.md',
  'MANIFESTO.json',
  'NOTICE.md',
  'package.json',
  'package-lock.json',
  'scripts/backup.mjs',
]);

export function containsInternalBranding(value) {
  return /CRM-WEB-TESTE-ISO1|TESTE[\s/_-]+ISO\b/i.test(String(value || ''));
}

export function normalizeRelative(relative) {
  return String(relative || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function segments(relative) {
  return normalizeRelative(relative).split('/').filter(Boolean);
}

export function isAlwaysExcluded(relative) {
  const normalized = normalizeRelative(relative);
  const parts = segments(normalized);
  const base = (parts.at(-1) || '').toLowerCase();
  if (parts.some((part) => ALWAYS_EXCLUDED_DIRS.includes(part.toLowerCase()))) return true;
  if (base === '.env') return true;
  if (base.startsWith('.env.') && base !== '.env.example') return true;
  if (/\.(sqlite|sqlite-wal|sqlite-shm|db|db-wal|db-shm|log|pid|tmp|bak)$/i.test(base)) return true;
  if (/\.(pem|key|p12|pfx)$/i.test(base)) return true;
  if (base === '.ds_store' || base === 'thumbs.db') return true;
  if (normalized.startsWith('public/assets/') && !VISUAL_ASSETS.includes(normalized)) return true;
  return false;
}

export function isProfileIncluded(profile, relative) {
  const normalized = normalizeRelative(relative);
  if (!normalized || isAlwaysExcluded(normalized)) return false;
  if (profile === 'source') return true;
  if (profile !== 'public') throw new Error(`Perfil de empacotamento desconhecido: ${profile}`);
  if (PUBLIC_EXACT_FILES.has(normalized)) return true;
  if (normalized.startsWith('src/') || normalized.startsWith('public/')) return true;
  return false;
}

export function profileConfig(profile) {
  const config = PROFILE_CONFIG[profile];
  if (!config) throw new Error(`Perfil de empacotamento desconhecido: ${profile}`);
  return config;
}
