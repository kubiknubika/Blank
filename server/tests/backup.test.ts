import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from '../src/db.js';
import { ApplicationService } from '../src/service.js';
import { createApplicationSchema } from '@offerflow/shared/schemas';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/backup.mjs');

/**
 * The backup script is an operational promise: the snapshot must be a
 * consistent, restorable database taken WHILE the source is in use.
 * These tests run the real script as a subprocess against a real WAL-mode
 * file, then open the snapshot and verify contents + integrity.
 */
describe('backup script (VACUUM INTO)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'offerflow-backup-'));
    dbPath = path.join(dir, 'source.db');
    const db = createDb(dbPath);
    const service = new ApplicationService(db);
    service.create(createApplicationSchema.parse({ company: 'Backup Co', position: 'SRE' }));
    service.create(createApplicationSchema.parse({ company: 'Snapshot AG', position: 'DBA' }));
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const runBackup = (args: string[]) =>
    execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

  it('produces a consistent snapshot of a WAL-mode database', () => {
    const target = path.join(dir, 'snap.db');
    const out = runBackup([target, '--db', dbPath]);
    expect(out).toContain('integrity ok');
    expect(out).toContain('2 applications');

    const copy = new DatabaseSync(target, { readOnly: true });
    try {
      expect(copy.prepare('PRAGMA integrity_check').get()).toMatchObject({ integrity_check: 'ok' });
      const companies = copy
        .prepare('SELECT company FROM applications ORDER BY company')
        .all()
        .map((r) => (r as { company: string }).company);
      expect(companies).toEqual(['Backup Co', 'Snapshot AG']);
      // Schema migrations must travel with the data.
      const migrations = copy.prepare('SELECT COUNT(*) c FROM schema_migrations').get() as {
        c: number;
      };
      expect(migrations.c).toBeGreaterThanOrEqual(3);
    } finally {
      copy.close();
    }
    // No WAL sidecars for the snapshot: VACUUM INTO writes a clean single file.
    expect(existsSync(`${target}-wal`)).toBe(false);
  });

  it('captures writes made while the source connection stays open', () => {
    const live = createDb(dbPath);
    try {
      const service = new ApplicationService(live);
      const target = path.join(dir, 'live-snap.db');
      runBackup([target, '--db', dbPath]);
      service.create(createApplicationSchema.parse({ company: 'Mid Backup Inc', position: 'Eng' }));
      const copy = new DatabaseSync(target, { readOnly: true });
      try {
        // Snapshot is a point-in-time cut: exactly the 2 rows that existed.
        const c = copy.prepare('SELECT COUNT(*) c FROM applications').get() as { c: number };
        expect(c.c).toBe(2);
      } finally {
        copy.close();
      }
      expect(live.prepare('SELECT COUNT(*) c FROM applications').get()).toMatchObject({ c: 3 });
    } finally {
      live.close();
    }
  });

  it('refuses to overwrite an existing target', () => {
    const target = path.join(dir, 'twice.db');
    runBackup([target, '--db', dbPath]);
    expect(() => runBackup([target, '--db', dbPath])).toThrow(/refusing to overwrite/);
  });

  it('fails cleanly when the source database does not exist', () => {
    expect(() => runBackup([path.join(dir, 'x.db'), '--db', path.join(dir, 'missing.db')])).toThrow(
      /source database not found/,
    );
  });

  it('defaults into --out-dir with a timestamped name', () => {
    const outDir = path.join(dir, 'snaps');
    const out = runBackup(['--db', dbPath, '--out-dir', outDir]);
    expect(out).toMatch(/offerflow-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.db/);
  });
});
