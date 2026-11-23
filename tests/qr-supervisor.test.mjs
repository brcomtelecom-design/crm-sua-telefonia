import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { makeTempDir } from './helpers.mjs';
import { QrSupervisor } from '../src/qr-supervisor.mjs';

test('supervisor QR inicia um único motor e aguarda o sinal de prontidão do IPC', async () => {
  const temp = makeTempDir();
  let spawnCalls = 0;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const spawnImpl = () => {
    spawnCalls += 1;
    setImmediate(() => child.stdout.emit('data', '[qr] Motor QR privado iniciado.\n'));
    return child;
  };
  const supervisor = new QrSupervisor({
    enabled: true,
    authDir: temp,
    baseUrl: 'http://127.0.0.1:0',
    workerPath: 'worker-sintético.mjs',
    spawnImpl,
    logger: { info() {}, error() {}, warn() {} },
  });

  await supervisor.ensureStarted();
  await supervisor.ensureStarted();
  assert.equal(spawnCalls, 1);
  assert.equal(supervisor.child, child);
});
