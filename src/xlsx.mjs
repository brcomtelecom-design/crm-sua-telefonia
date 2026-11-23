import { inflateRawSync } from 'node:zlib';

const MAX_COMPRESSED_BYTES = 2 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 150;
const MAX_ROWS = 5000;
const MAX_COLUMNS = 80;
const MAX_CELL_LENGTH = 2000;

function xmlDecode(value) {
  return String(value || '')
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&(quot|apos|lt|gt|amp);/g, (_, entity) => ({
      quot: '"', apos: "'", lt: '<', gt: '>', amp: '&',
    }[entity] || _));
}

function inlineText(xml) {
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((match) => xmlDecode(match[1])).join('');
}

function columnNumber(reference) {
  const chars = String(reference || '').match(/^[A-Z]+/i)?.[0]?.toUpperCase() || '';
  let number = 0;
  for (const char of chars) number = number * 26 + char.charCodeAt(0) - 64;
  return number - 1;
}

function unzipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer.subarray(0, 2).toString() !== 'PK') {
    throw new Error('Arquivo XLSX inválido');
  }
  if (buffer.length > MAX_COMPRESSED_BYTES) throw new Error('Arquivo XLSX excede 2 MB comprimidos');
  let end = -1;
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65557); index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) { end = index; break; }
  }
  if (end < 0) throw new Error('Arquivo XLSX truncado ou corrompido');
  const count = buffer.readUInt16LE(end + 10);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  if (count > MAX_ENTRIES || directoryOffset >= buffer.length) throw new Error('XLSX possui entradas demais');
  const entries = new Map();
  let cursor = directoryOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Diretório XLSX inválido');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const offset = buffer.readUInt32LE(cursor + 42);
    if (cursor + 46 + nameLength + extraLength + commentLength > buffer.length) throw new Error('Entrada XLSX incompleta');
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name.startsWith('/') || name.includes('..') || (flags & 1) || uncompressedSize > 8 * 1024 * 1024 || compressedSize > 2 * 1024 * 1024) {
      throw new Error('XLSX criptografado ou suspeito');
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) throw new Error('Conteúdo descompactado do XLSX excede 20 MB');
    if (!['xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml'].includes(name)) continue;
    if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) throw new Error('Registro ZIP local inválido');
    const dataOffset = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    if (dataOffset + compressedSize > buffer.length) throw new Error('Entrada XLSX truncada');
    const raw = buffer.subarray(dataOffset, dataOffset + compressedSize);
    const output = method === 8
      ? inflateRawSync(raw, { maxOutputLength: 8 * 1024 * 1024 })
      : method === 0 ? raw : null;
    if (!output || output.length !== uncompressedSize) throw new Error('Compressão XLSX inválida');
    entries.set(name, output.toString('utf8'));
  }
  return entries;
}

export function readXlsx(buffer, { maxRows = MAX_ROWS } = {}) {
  const entries = unzipEntries(buffer);
  const sheet = entries.get('xl/worksheets/sheet1.xml');
  if (!sheet) throw new Error('Primeira planilha não encontrada');
  const shared = [...(entries.get('xl/sharedStrings.xml') || '').matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)]
    .map((match) => inlineText(match[1]));
  const rows = [];
  let cellCount = 0;
  for (const match of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (rows.length > maxRows) {
      const error = new Error(`Máximo de ${maxRows} destinatários por arquivo`);
      error.code = 'RECIPIENT_LIMIT_EXCEEDED';
      throw error;
    }
    const values = [];
    let lastColumn = -1;
    for (const cell of match[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cell[1];
      const inner = cell[2] || '';
      const reference = attributes.match(/\br="([A-Z]+)\d+"/i)?.[1];
      const column = reference ? columnNumber(reference) : lastColumn + 1;
      if (column < 0 || column >= MAX_COLUMNS) continue;
      lastColumn = column;
      const type = attributes.match(/\bt="([^"]+)"/)?.[1] || '';
      const raw = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1] || '';
      const value = type === 's' ? shared[Number(raw)] || '' : type === 'inlineStr' ? inlineText(inner) : type === 'b' ? (raw === '1' ? 'SIM' : 'NÃO') : xmlDecode(raw);
      values[column] = String(value).slice(0, MAX_CELL_LENGTH);
      cellCount += 1;
      if (cellCount > 200000) throw new Error('XLSX excede o limite de 200.000 células');
    }
    if (values.some((value) => String(value || '').trim())) rows.push(values);
  }
  const headers = (rows.shift() || []).map((value) => String(value || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9_]+/g, '_'));
  const alias = (row, ...names) => {
    for (const name of names) {
      const index = headers.indexOf(name);
      if (index >= 0 && String(row[index] || '').trim()) return String(row[index]).trim();
    }
    return '';
  };
  const normalized = rows.map((row, index) => ({
    rowNumber: index + 2,
    name: alias(row, 'name', 'nome', 'razao_social', 'empresa'),
    phone: alias(row, 'phone', 'telefone', 'celular', 'whatsapp', 'numero'),
    cpf: alias(row, 'cpf'),
    email: alias(row, 'email', 'e_mail'),
    optInAt: alias(row, 'opt_in_at', 'consentimento_em'),
    optInSource: alias(row, 'opt_in_source', 'origem_consentimento'),
    optInEvidence: alias(row, 'opt_in_evidence', 'evidencia_consentimento'),
    custom: Object.fromEntries(headers.map((header, column) => [header, String(row[column] || '').trim()]).filter(([, value]) => value)),
  }));
  return { headers, rows: normalized, rowCount: normalized.length, cellCount };
}
