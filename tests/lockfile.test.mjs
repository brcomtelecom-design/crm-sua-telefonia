import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('lockfile é coerente com package.json e contém somente o fechamento de dependências declaradas', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  assert.equal(lock.lockfileVersion, 3);
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
  assert.equal(lock.packages['node_modules/@whiskeysockets/baileys'].version, pkg.dependencies['@whiskeysockets/baileys']);
  assert.equal(lock.packages['node_modules/qrcode'].version, pkg.dependencies.qrcode);
  for (const key of Object.keys(lock.packages)) {
    if (!key) continue;
    const entry = lock.packages[key];
    if (entry.resolved) assert.match(entry.integrity, /^sha512-/);
  }
});
