import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const referenceZip = process.argv[2];
if (!referenceZip) throw new Error('Informe o ZIP de referência com package-lock.json');
const bytes = fs.readFileSync(referenceZip);
let end = -1;
for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index -= 1) {
  if (bytes.readUInt32LE(index) === 0x06054b50) { end = index; break; }
}
if (end < 0) throw new Error('ZIP inválido');
const count = bytes.readUInt16LE(end + 10);
let cursor = bytes.readUInt32LE(end + 16);
let lockText = null;
for (let index = 0; index < count; index += 1) {
  const method = bytes.readUInt16LE(cursor + 10);
  const compressedSize = bytes.readUInt32LE(cursor + 20);
  const uncompressedSize = bytes.readUInt32LE(cursor + 24);
  const nameLength = bytes.readUInt16LE(cursor + 28);
  const extraLength = bytes.readUInt16LE(cursor + 30);
  const commentLength = bytes.readUInt16LE(cursor + 32);
  const offset = bytes.readUInt32LE(cursor + 42);
  const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
  cursor += 46 + nameLength + extraLength + commentLength;
  if (name !== 'package-lock.json') continue;
  const dataOffset = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
  const raw = bytes.subarray(dataOffset, dataOffset + compressedSize);
  const output = method === 8 ? inflateRawSync(raw) : raw;
  if (output.length !== uncompressedSize) throw new Error('package-lock.json truncado');
  lockText = output.toString('utf8');
}
if (!lockText) throw new Error('package-lock.json não encontrado no ZIP');
const reference = JSON.parse(lockText);
const wanted = ['node_modules/@whiskeysockets/baileys', 'node_modules/qrcode'];
const root = {
  name: 'sua-telefonia-crm-web-node',
  version: '0.1.0',
  license: 'UNLICENSED',
  dependencies: {
    '@whiskeysockets/baileys': '7.0.0-rc14',
    qrcode: '1.5.4',
  },
  engines: { node: '>=22.16.0' },
};
const packages = { '': root };
for (const key of wanted) {
  const entry = reference.packages[key];
  if (!entry?.resolved || !entry?.integrity) throw new Error(`Metadados incompletos para ${key}`);
  packages[key] = entry;
}
function collectClosure(key, target) {
  const entry = reference.packages[key];
  if (!entry) throw new Error(`Dependência ausente no lockfile de referência: ${key}`);
  for (const dependency of Object.keys(entry.dependencies || {})) {
    const candidate = `node_modules/${dependency}`;
    if (reference.packages[candidate]) {
      packages[candidate] = reference.packages[candidate];
      collectClosure(candidate, target);
    }
  }
  for (const dependency of Object.keys(entry.optionalDependencies || {})) {
    const candidate = `node_modules/${dependency}`;
    if (reference.packages[candidate]) {
      packages[candidate] = reference.packages[candidate];
      collectClosure(candidate, target);
    }
  }
}
for (const key of wanted) collectClosure(key, packages);
const lock = {
  name: root.name,
  version: root.version,
  lockfileVersion: 3,
  requires: true,
  packages,
};
const target = path.resolve('package-lock.json');
fs.writeFileSync(target, JSON.stringify(lock, null, 2) + '\n');
console.log(JSON.stringify({ target, packages: Object.keys(packages).length, sha256: createHash('sha256').update(fs.readFileSync(target)).digest('hex') }));
