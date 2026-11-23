import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptString, decryptString, hashPassword, verifyPassword, parseEncryptionKey } from '../src/security.mjs';

const key = 'a'.repeat(64);

test('criptografia AES-GCM usa nonce único e authenticated context', () => {
  const first = encryptString('segredo', key, 'ctx');
  const second = encryptString('segredo', key, 'ctx');
  assert.notEqual(first, second);
  assert.equal(decryptString(first, key, 'ctx'), 'segredo');
  assert.throws(() => decryptString(first, key, 'outro-contexto'));
});

test('hash de senha usa salt e comparação constante', async () => {
  const first = await hashPassword('senha-sintética');
  const second = await hashPassword('senha-sintética');
  assert.notEqual(first.hash, second.hash);
  assert.equal(await verifyPassword('senha-sintética', first.salt, first.hash), true);
  assert.equal(await verifyPassword('outra', first.salt, first.hash), false);
  assert.equal(parseEncryptionKey(key).length, 32);
  assert.throws(() => parseEncryptionKey('abc'));
});
