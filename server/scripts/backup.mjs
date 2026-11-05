#!/usr/bin/env node
/**
 * Online SQLite backup via VACUUM INTO.
 *
 * Why VACUUM INTO and not `cp offerflow.db`?
 *  - The live DB runs in WAL mode: the freshest committed rows may sit in
 *    offerflow.db-wal, so a plain file copy can capture a stale or torn state.
 *  - VACUUM INTO produces a compacted, transactionally consistent snapshot
 *    while the server keeps serving — no downtime, no lock beyond a brief
 *    shared read.
 *
 * Usage:
 *   npm run backup                          # → server/backups/offerflow-<ts>.db
 *   npm run backup -- /path/to/snapshot.db  # explicit target file
 *   npm run backup -- --db /data/offerflow.db --out-dir /mnt/backups
 *
 * Refuses to overwrite an existing file (SQLite enforces this too).
 * Exit codes: 0 ok, 1 failure (message on stderr).
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const args = { target: null, db: null, outDir: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') args.db = argv[++i];
    else if (argv[i] === '--out-dir') args.outDir = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else rest.push(argv[i]);
  }
  args.target = rest[0] ?? null;
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: npm run backup -- [target.db] [--db source.db] [--out-dir dir]');
    return 0;
  }

  const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dbPath = path.resolve(
    args.db ?? process.env.DB_PATH ?? path.join(serverRoot, 'data/offerflow.db'),
  );
  if (!existsSync(dbPath)) {
    console.error(`backup: source database not found: ${dbPath}`);
    return 1;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const outDir = path.resolve(args.outDir ?? path.join(serverRoot, 'backups'));
  const target = path.resolve(args.target ?? path.join(outDir, `offerflow-${stamp}.db`));
  if (existsSync(target)) {
    console.error(`backup: refusing to overwrite existing file: ${target}`);
    return 1;
  }
  mkdirSync(path.dirname(target), { recursive: true });

  // Read-only attach: the backup must never mutate the source.
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA quick_check').get();
    if (integrity.quick_check !== 'ok') {
      console.error(`backup: source failed quick_check: ${JSON.stringify(integrity)}`);
      return 1;
    }
    db.prepare('VACUUM INTO ?').run(target);
  } finally {
    db.close();
  }

  // Verify the snapshot independently — a backup you never restored is a hope, not a backup.
  const copy = new DatabaseSync(target, { readOnly: true });
  try {
    const check = copy.prepare('PRAGMA integrity_check').get();
    if (check.integrity_check !== 'ok') {
      console.error(`backup: snapshot failed integrity_check: ${JSON.stringify(check)}`);
      return 1;
    }
    const rows = copy.prepare('SELECT COUNT(*) AS c FROM applications').get().c;
    console.log(
      `backup: ${target} (${statSync(target).size} bytes, ${rows} applications, integrity ok)`,
    );
  } finally {
    copy.close();
  }
  return 0;
}

process.exit(main());
