import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inflateRawSync, crc32 } from 'node:zlib';
import { isProfileIncluded, normalizeRelative, profileConfig, VISUAL_ASSETS } from './package-rules.mjs';

const archiveArgument = process.argv[2] || '';
const archivePath = archiveArgument ? path.resolve(archiveArgument) : '';
const profile = process.argv[3] || '';
if (!archiveArgument || (profile && !['public', 'source'].includes(profile))) {
  throw new Error('Uso: node scripts/verify-package.mjs <arquivo.zip> [public|source]');
}
const bytes = fs.readFileSync(archivePath);
const archiveSha256 = createHash('sha256').update(bytes).digest('hex');
let end = -1;
for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index -= 1) {
  if (bytes.readUInt32LE(index) === 0x06054b50) { end = index; break; }
}
if (end < 0) throw new Error('ZIP inválido');
const count = bytes.readUInt16LE(end + 10);
const centralSize = bytes.readUInt32LE(end + 12);
const centralOffset = bytes.readUInt32LE(end + 16);
if (centralOffset + centralSize > bytes.length) throw new Error('Diretório central do ZIP inválido');
let cursor = centralOffset;
const entries = [];
for (let index = 0; index < count; index += 1) {
  if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Registro central do ZIP inválido');
  const flags = bytes.readUInt16LE(cursor + 8);
  const method = bytes.readUInt16LE(cursor + 10);
  const expectedCrc = bytes.readUInt32LE(cursor + 16);
  const compressedSize = bytes.readUInt32LE(cursor + 20);
  const uncompressedSize = bytes.readUInt32LE(cursor + 24);
  const nameLength = bytes.readUInt16LE(cursor + 28);
  const extraLength = bytes.readUInt16LE(cursor + 30);
  const commentLength = bytes.readUInt16LE(cursor + 32);
  const localOffset = bytes.readUInt32LE(cursor + 42);
  const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
  cursor += 46 + nameLength + extraLength + commentLength;
  if (flags & 1) throw new Error(`Entrada criptografada não suportada: ${name}`);
  if (![0, 8].includes(method)) throw new Error(`Método de compressão não suportado em ${name}`);
  if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`Registro local inválido em ${name}`);
  const dataOffset = localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
  if (dataOffset + compressedSize > bytes.length) throw new Error(`Entrada truncada: ${name}`);
  const raw = bytes.subarray(dataOffset, dataOffset + compressedSize);
  const data = method === 8 ? inflateRawSync(raw) : raw;
  if (data.length !== uncompressedSize) throw new Error(`Tamanho divergente em ${name}`);
  if ((crc32(data) >>> 0) !== expectedCrc) throw new Error(`CRC divergente em ${name}`);
  entries.push({ name, data, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length });
}

const names = new Set();
for (const entry of entries) {
  const name = entry.name;
  const parts = name.split('/');
  if (!name || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || parts.some((part) => part === '..' || part === '.')) {
    throw new Error(`Caminho de entrada inseguro: ${name}`);
  }
  if (names.has(name)) throw new Error(`Entrada duplicada: ${name}`);
  names.add(name);
}

const forbidden = entries.filter(({ name }) => {
  const lower = name.toLowerCase();
  const parts = lower.split('/');
  const base = parts.at(-1) || '';
  const runtimeDir = ['node_modules', '.git', 'data', 'logs', 'auth', 'qr-auth', 'campaign-temp', 'coverage', 'backups', '.cache']
    .some((directory) => parts.includes(directory));
  const secretFile = base === '.env'
    || (base.startsWith('.env.') && base !== '.env.example')
    || /\.(sqlite|sqlite-wal|sqlite-shm|db|db-wal|db-shm|log|pid|tmp|bak|pem|key|p12|pfx)$/i.test(base);
  return runtimeDir || secretFile;
});
if (forbidden.length) throw new Error(`Entradas proibidas: ${forbidden.map((entry) => entry.name).join(', ')}`);

let manifestVerified = false;
let visualAssets = [];
if (profile) {
  const config = profileConfig(profile);
  const wrongRoot = entries.filter((entry) => !entry.name.startsWith(`${config.rootFolder}/`));
  if (wrongRoot.length) throw new Error(`Prefixo de raiz inválido: ${wrongRoot.map((entry) => entry.name).join(', ')}`);
  const relativeEntries = entries.map((entry) => ({ ...entry, relative: normalizeRelative(entry.name.slice(config.rootFolder.length + 1)) }));
  const notAllowed = relativeEntries.filter((entry) => !isProfileIncluded(profile, entry.relative));
  if (notAllowed.length) throw new Error(`Entradas não permitidas no perfil ${profile}: ${notAllowed.map((entry) => entry.name).join(', ')}`);

  visualAssets = relativeEntries.filter((entry) => entry.relative.startsWith('public/assets/')).map((entry) => entry.relative).sort();
  const expectedAssets = [...VISUAL_ASSETS].sort();
  if (JSON.stringify(visualAssets) !== JSON.stringify(expectedAssets)) {
    throw new Error(`Assets visuais divergentes: ${visualAssets.join(', ')}`);
  }
  const required = [
    'package.json',
    'package-lock.json',
    'README.md',
    'LIMITACOES.md',
    'NOTICE.md',
    '.env.example',
    'src/index.mjs',
    'public/index.html',
    'scripts/backup.mjs',
  ];
  if (profile === 'source') required.push('tests/package.test.mjs', 'scripts/package.mjs', 'scripts/package-rules.mjs', 'scripts/verify-package.mjs');
  const missing = required.filter((requiredPath) => !relativeEntries.some((entry) => entry.relative === requiredPath));
  if (missing.length) throw new Error(`Arquivos obrigatórios ausentes no perfil ${profile}: ${missing.join(', ')}`);

  const manifestPath = `${archivePath}.manifest.json`;
  if (!fs.existsSync(manifestPath)) throw new Error(`Manifesto sidecar ausente: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.profile !== profile || manifest.package !== config.packageName || manifest.rootFolder !== config.rootFolder) {
    throw new Error('Identidade do manifesto sidecar divergente do perfil.');
  }
  if (manifest.archive?.sha256 !== archiveSha256 || manifest.archive?.bytes !== bytes.length) {
    throw new Error('Hash ou tamanho do ZIP divergente do manifesto sidecar.');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== entries.length) throw new Error('Contagem de arquivos do manifesto divergente.');
  const entryMap = new Map(entries.map((entry) => [entry.name, entry]));
  for (const file of manifest.files) {
    const entry = entryMap.get(file.path);
    if (!entry) throw new Error(`Arquivo do manifesto ausente no ZIP: ${file.path}`);
    if (file.sha256 !== entry.sha256 || file.bytes !== entry.bytes) throw new Error(`Hash ou tamanho divergente em ${file.path}`);
  }
  manifestVerified = true;
}

console.log(JSON.stringify({
  ok: true,
  profile: profile || null,
  entries: entries.length,
  bytes: bytes.length,
  sha256: archiveSha256,
  forbidden: 0,
  visualAssets,
  manifestVerified,
}));
