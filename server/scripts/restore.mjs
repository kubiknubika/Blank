#!/usr/bin/env node
/**
 * Restore a SQLite snapshot produced by backup.mjs (VACUUM INTO).
 *
 * The backup script's own comment says it best: "a backup you never
 * restored is a hope, not a backup." This is the other half of that
 * promise — a guarded, verified, reversible restore.
 *
 * Safety model:
 *  - The snapshot is integrity-checked and schema-checked BEFORE the
 *    target is touched. A corrupt or foreign file never clobbers data.
 *  - An existing target is refused unless --force is passed.
 *  - With --force, the current target is first saved to a timestamped
 *    safety snapshot (VACUUM INTO), so a wrong restore is reversible.
 *  - The replacement is atomic: copy to a temp file in the same
 *    directory, then rename(2) over the target. Stale WAL/SHM sidecars
 *    from the old database are removed (the snapshot is a clean single
 *    file). STOP THE SERVER FIRST — restoring under a live writer is
 *    unsupported and the --force gate exists to make that explicit.
 *
 * Usage:
 *   npm run restore -- server/backups/offerflow-<ts>.db
 *   npm run restore -- snap.db --db /data/offerflow.db --force
 *
 * Exit codes: 0 ok, 1 failure (message on stderr).
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, copyFileSync, renameSync, unlinkSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const args = { snapshot: null, db: null, force: false, help: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') args.db = argv[++i];
    else if (argv[i] === '--force') args.force = true;
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else rest.push(argv[i]);
  }
  args.snapshot = rest[0] ?? null;
  return args;
}

function verifySnapshot(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const check = db.prepare('PRAGMA integrity_check').get();
    if (check.integrity_check !== 'ok') {
      throw new Error(`snapshot failed integrity_check: ${JSON.stringify(check)}`);
    }
    const tables = new Set(
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all()
        .map((r) => r.name),
    );
    for (const required of ['applications', 'schema_migrations']) {
      if (!tables.has(required)) throw new Error(`snapshot is missing the '${required}' table`);
    }
    return db.prepare('SELECT COUNT(*) AS c FROM applications').get().c;
  } finally {
    db.close();
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: npm run restore -- <snapshot.db> [--db target.db] [--force]');
    return 0;
  }
  if (!args.snapshot) {
    console.error('restore: missing snapshot argument (see --help)');
    return 1;
  }

  const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const snapshot = path.resolve(args.snapshot);
  const target = path.resolve(
    args.db ?? process.env.DB_PATH ?? path.join(serverRoot, 'data/offerflow.db'),
  );

  if (!existsSync(snapshot)) {
    console.error(`restore: snapshot not found: ${snapshot}`);
    return 1;
  }
  if (snapshot === target) {
    console.error('restore: snapshot and target are the same file');
    return 1;
  }

  // 1. Verify the snapshot before touching anything.
  let rows;
  try {
    rows = verifySnapshot(snapshot);
  } catch (err) {
    console.error(`restore: ${err.message}`);
    return 1;
  }

  // 2. Guard the existing target; with --force, save a reversible safety copy.
  if (existsSync(target)) {
    if (!args.force) {
      console.error(
        `restore: target exists: ${target}\n` +
          '  Stop the server, then re-run with --force to replace it ' +
          '(a safety snapshot of the current data is saved first).',
      );
      return 1;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const safety = `${target}.pre-restore-${stamp}.db`;
    const live = new DatabaseSync(target, { readOnly: true });
    try {
      live.prepare('VACUUM INTO ?').run(safety);
    } catch (err) {
      console.error(
        `restore: could not save a safety snapshot of the current target (${err.message}). ` +
          'Is the server still running? Stop it first. Aborting without changes.',
      );
      return 1;
    } finally {
      live.close();
    }
    console.log(`restore: saved current target to safety snapshot ${safety}`);
  }

  // 3. Atomic replace: temp file in the same directory, then rename over
  //    the target. Remove stale sidecars that belong to the OLD database.
  for (const suffix of ['-wal', '-shm']) {
    try {
      unlinkSync(target + suffix);
    } catch {
      /* none present */
    }
  }
  const tmp = `${target}.restore-tmp`;
  try {
    copyFileSync(snapshot, tmp);
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    console.error(`restore: failed to replace target: ${err.message}`);
    return 1;
  }

  // 4. Verify the restored database independently.
  let restoredRows;
  try {
    restoredRows = verifySnapshot(target);
  } catch (err) {
    console.error(`restore: restored target failed verification: ${err.message}`);
    return 1;
  }
  console.log(
    `restore: ${target} restored from ${path.basename(snapshot)} ` +
      `(${statSync(target).size} bytes, ${restoredRows} applications, integrity ok)`,
  );
  if (restoredRows !== rows) {
    console.error('restore: warning — row count changed during restore (concurrent writer?)');
    return 1;
  }
  return 0;
}

process.exit(main());
