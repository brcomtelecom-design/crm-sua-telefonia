import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';

const dbPath = path.resolve(process.env.DB_PATH || './data/crm.sqlite');
const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(path.dirname(dbPath), 'backups'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = path.join(backupDir, `crm-${stamp}.sqlite`);
fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  await backup(db, target);
  const digest = createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  fs.writeFileSync(`${target}.sha256`, `${digest}  ${path.basename(target)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, target, sha256: digest }));
} finally {
  db.close();
}
