import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, crc32 } from 'node:zlib';

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

const { readXlsx } = await import('../src/xlsx.mjs');

test('leitor XLSX rejeira macros e arquivos não ZIP sem executar conteúdo', () => {
  assert.throws(() => readXlsx(Buffer.from('not-a-zip')), /XLSX inválido/);
  assert.throws(() => readXlsx(zip({ 'xl/workbook.xml': '<x/>' })), /Primeira planilha/);
});

test('leitor XLSX extrai primeira planilha e normaliza cabeçalhos', () => {
  const file = xlsx([['Telefone', 'Nome'], ['5511999999999', 'Cliente']]);
  const result = readXlsx(file);
  assert.equal(result.rowCount, 1);
  assert.equal(result.rows[0].phone, '5511999999999');
  assert.equal(result.rows[0].name, 'Cliente');
});

test('leitor XLSX decodifica entidades XML sem reinterpretar escapes duplos', () => {
  const file = xlsx([['Telefone', 'Nome'], ['5511999999999', 'Tom & Cia <VIP>']]);
  const result = readXlsx(file);
  assert.equal(result.rows[0].name, 'Tom & Cia <VIP>');
});
