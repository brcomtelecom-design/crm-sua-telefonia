import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateRawSync, crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { containsInternalBranding, isAlwaysExcluded, isProfileIncluded, normalizeRelative, profileConfig, VISUAL_ASSETS } from './package-rules.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let profile = 'public';
let outputArgument = '';
if (args.length === 1) outputArgument = args[0];
else if (args.length === 2) {
  profile = args[0];
  outputArgument = args[1];
} else {
  throw new Error('Uso: node scripts/package.mjs [public|source] <arquivo-de-saida.zip>');
}

const config = profileConfig(profile);
const output = path.resolve(outputArgument);
const manifestOutput = `${output}.manifest.json`;
const relativeOutput = path.relative(root, output);
if (relativeOutput && !relativeOutput.startsWith('..') && !path.isAbsolute(relativeOutput)) {
  throw new Error('O ZIP de saída deve ficar fora do diretório do projeto.');
}
if (fs.existsSync(output) || fs.existsSync(manifestOutput)) {
  throw new Error('Arquivo de saída ou manifesto já existe; nada será sobrescrito.');
}

const files = [];
function walk(directory, relative = '') {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const normalized = normalizeRelative(relative ? path.join(relative, entry.name) : entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!isAlwaysExcluded(normalized)) walk(absolute, normalized);
      continue;
    }
    if (!entry.isFile() || !isProfileIncluded(profile, normalized)) continue;
    files.push(normalized);
  }
}
walk(root);
files.sort((left, right) => left.localeCompare(right, 'pt-BR'));
if (!files.length) throw new Error('Nenhum arquivo incluído no pacote.');
if (profile === 'public' && files.some((file) => /CRM-WEB-TESTE-ISO1|(^|\/)TESTE-ISO([\/_.-]|$)/i.test(file))) {
  throw new Error('O perfil público não pode conter marcador interno TESTE/ISO no nome de arquivos.');
}
if (profile === 'public') {
  const textExtensions = new Set(['.md', '.json', '.mjs', '.js', '.html', '.css', '.txt', '.example']);
  for (const file of files) {
    const base = path.basename(file).toLowerCase();
    const extension = path.extname(base);
    if (!textExtensions.has(extension) && base !== '.gitignore') continue;
    if (containsInternalBranding(fs.readFileSync(path.join(root, file), 'utf8'))) {
      throw new Error(`O perfil público não pode conter marcador interno TESTE/ISO no arquivo ${file}.`);
    }
  }
}

const local = [];
const central = [];
let offset = 0;
for (const relative of files) {
  const name = Buffer.from(`${config.rootFolder}/${relative}`, 'utf8');
  const data = fs.readFileSync(path.join(root, relative));
  const compressed = deflateRawSync(data, { level: 9 });
  const checksum = crc32(data);
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt32LE(checksum >>> 0, 14);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(data.length, 22);
  localHeader.writeUInt16LE(name.length, 26);
  local.push(localHeader, name, compressed);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt32LE(checksum >>> 0, 16);
  centralHeader.writeUInt32LE(compressed.length, 20);
  centralHeader.writeUInt32LE(data.length, 24);
  centralHeader.writeUInt16LE(name.length, 28);
  centralHeader.writeUInt32LE(offset, 42);
  central.push(centralHeader, name);
  offset += localHeader.length + name.length + compressed.length;
}

const centralBuffer = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuffer.length, 12);
end.writeUInt32LE(offset, 16);
const archive = Buffer.concat([...local, centralBuffer, end]);
const archiveSha256 = createHash('sha256').update(archive).digest('hex');
const fileManifest = files.map((relative) => {
  const data = fs.readFileSync(path.join(root, relative));
  return {
    path: `${config.rootFolder}/${relative}`,
    sourcePath: relative,
    sha256: createHash('sha256').update(data).digest('hex'),
    bytes: data.length,
  };
});
const manifest = {
  schemaVersion: 1,
  profile,
  package: config.packageName,
  version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
  createdAt: new Date().toISOString(),
  description: config.description,
  rootFolder: config.rootFolder,
  archive: {
    file: path.basename(output),
    bytes: archive.length,
    sha256: archiveSha256,
  },
  visualAssets: VISUAL_ASSETS.map((asset) => `${config.rootFolder}/${asset}`),
  exclusions: {
    runtimeDirectories: ['node_modules', '.git', 'data', 'logs', 'auth', 'qr-auth', 'campaign-temp', 'coverage', 'backups', '.cache'],
    secretFiles: ['.env', '.env.* (exceto .env.example)', '*.sqlite*', '*.db*', '*.log', '*.pem', '*.key', '*.p12', '*.pfx'],
    publicProfileExcludes: ['tests/**', 'scripts/package.mjs', 'scripts/package-rules.mjs', 'scripts/verify-package.mjs', 'scripts/generate-lockfile.mjs'],
  },
  files: fileManifest,
};

fs.writeFileSync(output, archive, { flag: 'wx' });
fs.writeFileSync(manifestOutput, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({
  ok: true,
  profile,
  output,
  manifest: manifestOutput,
  bytes: archive.length,
  files: files.length,
  sha256: archiveSha256,
}));
