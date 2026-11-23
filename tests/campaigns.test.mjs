import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, crc32 } from 'node:zlib';
import { makeTempDir, baseConfig, startApp, stopApp, login } from './helpers.mjs';
import { newId, nowIso } from '../src/db.mjs';

function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(content);
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc >>> 0, 16);
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

function xlsx(rows) {
  const sheetRows = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((cell, columnIndex) => `<c r="${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}" t="inlineStr"><is><t>${cell}</t></is></c>`).join('')}</row>`).join('');
  return zip({
    '[Content_Types].xml': '<Types/>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`,
  });
}

test('upload XLSX cria campanha durável sem cadastrar contatos e mantém payload de destinatário privado', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));
  const owner = await login(app);
  const accountId = newId();
  const now = nowIso();
  app.db.prepare(`INSERT INTO accounts(id,tenant_id,kind,name,status,created_at,updated_at) VALUES(?,?,'waba','WABA sintética','active',?,?)`)
    .run(accountId, owner.body.user.tenantId, now, now);
  const file = xlsx([
    ['telefone', 'nome', 'cpf', 'opt_in_at', 'opt_in_source', 'opt_in_evidence'],
    ['5511999999999', 'Cliente sintético', '52998224725', '2026-01-01', 'sintetico', 'evidencia-1'],
  ]);
  const upload = await fetch(`${app.baseUrl}/api/campaigns/upload?filename=audiencia.xlsx`, {
    method: 'POST', headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf, 'Content-Type': 'application/octet-stream' }, body: file,
  });
  assert.equal(upload.status, 201);
  const uploaded = (await upload.json()).upload;
  assert.equal(uploaded.rowCount, 1);
  const created = await fetch(`${app.baseUrl}/api/campaigns`, {
    method: 'POST', headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId: uploaded.id, accountId, name: 'Campanha sintética', templateName: 'promocao_aprovada', executor: 'web', idempotencyKey: 'campaign-synthetic-0001' }),
  });
  assert.equal(created.status, 201);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM campaign_recipients').get().n, 1);
  assert.equal(app.db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='contacts'`).get().n, 0);
  const stored = app.db.prepare('SELECT phone_encrypted, payload_encrypted FROM campaign_recipients').get();
  assert.doesNotMatch(stored.phone_encrypted, /5511999999999/);
  assert.doesNotMatch(stored.payload_encrypted, /Cliente sintético/);
});

test('comando de campanha local não exige conversation_id e rejeita SQL livre', async (t) => {
  const temp = makeTempDir();
  const app = await startApp(baseConfig(temp));
  t.after(() => stopApp(app));
  const owner = await login(app);
  const installation = (await (await fetch(`${app.baseUrl}/api/installations`, {
    method: 'POST', headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Local' }),
  })).json()).installation;
  const response = await fetch(`${app.baseUrl}/api/agent-commands`, {
    method: 'POST', headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ installationId: installation.id, type: 'create_campaign', payload: { campaignId: 'campaign-local-0001', name: 'Grande', templateName: 'promocao' } }),
  });
  assert.equal(response.status, 202);
  const command = (await response.json()).command;
  assert.equal(command.payload.conversation_id, undefined);
  const rejected = await fetch(`${app.baseUrl}/api/agent-commands`, {
    method: 'POST', headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ installationId: installation.id, type: 'query_audience', payload: { sql: 'select * from leads' } }),
  });
  assert.equal(rejected.status, 400);
});
