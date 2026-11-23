import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../src/config.mjs';

const base = {
  ADMIN_EMAIL: 'admin@example.test',
  ADMIN_PASSWORD: 'Synthetic-Only-Password-42!',
  APP_ENCRYPTION_KEY: 'a'.repeat(64),
};

test('configuração de produção recusa HTTP e URL com credenciais', () => {
  assert.throws(() => loadConfig({ ...base, NODE_ENV: 'production', BASE_URL: 'http://example.test', WEBSITE_ORIGIN: 'http://example.test' }), ConfigError);
  assert.throws(() => loadConfig({ ...base, NODE_ENV: 'production', BASE_URL: 'https://user:pass@example.test', WEBSITE_ORIGIN: 'https://example.test' }), ConfigError);
});

test('configuração recusa senha curta, segredo ausente e teto acima de 5.000', () => {
  assert.throws(() => loadConfig({ ...base, ADMIN_PASSWORD: 'curta' }), ConfigError);
  assert.throws(() => loadConfig({ ...base, APP_ENCRYPTION_KEY: '' }), ConfigError);
  assert.throws(() => loadConfig({ ...base, CAMP_MAX_RECIPIENTS: '5001' }), ConfigError);
});
