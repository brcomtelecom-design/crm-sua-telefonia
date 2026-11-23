import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateRawSync, crc32 } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { containsInternalBranding } from '../scripts/package-rules.mjs';

function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(content);
    const compressed = deflateRawSync(data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum >>> 0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(checksum >>> 0, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

test('manifesto de empacotamento exclui segredos e persistência', () => {
  const archive = zip({
    'package.json': '{}',
    '.env': 'ADMIN_PASSWORD=secret',
    'data/crm.sqlite': 'binary',
    'node_modules/pkg/index.js': 'dependency',
    'logs/app.log': 'log',
  });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-package-check-'));
  const script = path.resolve('scripts/verify-package.mjs');
  const target = path.join(temp, 'check.zip');
  fs.writeFileSync(target, archive);
  const result = spawnSync(process.execPath, [script, target], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr + result.stdout, /Entradas proibidas/);
});

test('detecção de branding interno distingue marcadores de trabalho', () => {
  assert.equal(containsInternalBranding('CRM-WEB-TESTE-ISO1'), true);
  assert.equal(containsInternalBranding('marca TESTE/ISO'), true);
  assert.equal(containsInternalBranding('TESTE ISOLADO'), false);
  assert.equal(containsInternalBranding('SUA_TELEFONIA_CRM_WEB_NODE'), false);
});

test('perfis público e fonte empacotam com manifesto, exclusões e sem sobrescrita', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-package-profiles-'));
  const packageScript = path.resolve('scripts/package.mjs');
  const verifyScript = path.resolve('scripts/verify-package.mjs');
  for (const profile of ['public', 'source']) {
    const target = path.join(temp, `${profile}.zip`);
    const packaged = spawnSync(process.execPath, [packageScript, profile, target], { encoding: 'utf8' });
    assert.equal(packaged.status, 0, packaged.stderr || packaged.stdout);
    assert.equal(fs.existsSync(target), true);
    assert.equal(fs.existsSync(`${target}.manifest.json`), true);

    const verified = spawnSync(process.execPath, [verifyScript, target, profile], { encoding: 'utf8' });
    assert.equal(verified.status, 0, verified.stderr || verified.stdout);
    const verification = JSON.parse(verified.stdout);
    assert.equal(verification.ok, true);
    assert.equal(verification.profile, profile);
    assert.equal(verification.manifestVerified, true);
    assert.equal(verification.forbidden, 0);

    const manifest = JSON.parse(fs.readFileSync(`${target}.manifest.json`, 'utf8'));
    const sourcePaths = manifest.files.map((file) => file.sourcePath);
    assert.equal(manifest.profile, profile);
    assert.equal(manifest.files.length, verification.entries);
    assert.equal(sourcePaths.includes('.env'), false);
    assert.equal(sourcePaths.includes('public/assets/logo-st-original.png'), true);
    assert.equal(sourcePaths.includes('public/assets/avatar-default.svg'), true);
    assert.equal(sourcePaths.includes('public/assets/favicon.svg'), true);
    assert.equal(sourcePaths.some((file) => file.startsWith('public/assets/') && ![
      'public/assets/logo-st-original.png',
      'public/assets/avatar-default.svg',
      'public/assets/favicon.svg',
    ].includes(file)), false);
    if (profile === 'public') {
      assert.equal(sourcePaths.some((file) => file.startsWith('tests/')), false);
      assert.equal(sourcePaths.includes('scripts/package.mjs'), false);
      assert.equal(sourcePaths.includes('scripts/verify-package.mjs'), false);
      assert.equal(sourcePaths.includes('scripts/package-rules.mjs'), false);
    } else {
      assert.equal(sourcePaths.some((file) => file.startsWith('tests/')), true);
      assert.equal(sourcePaths.includes('scripts/package.mjs'), true);
      assert.equal(sourcePaths.includes('scripts/verify-package.mjs'), true);
      assert.equal(sourcePaths.includes('scripts/package-rules.mjs'), true);
    }

    const repeated = spawnSync(process.execPath, [packageScript, profile, target], { encoding: 'utf8' });
    assert.equal(repeated.status, 1);
    assert.match(repeated.stderr + repeated.stdout, /já existe|nada será sobrescrito/);
  }
});
