import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from '../src/db.js';
import { ApplicationService } from '../src/service.js';
import { DEMO_USER_ID } from '../src/auth.js';
import { createApplicationSchema } from '@offerflow/shared/schemas';

const BACKUP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/backup.mjs');
const RESTORE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../scripts/restore.mjs',
);

/**
 * The restore drill (ADR-0015): a backup is only real if it restores.
 * These tests run the REAL backup and restore scripts as subprocesses
 * and prove the full loop — snapshot a live DB, mutate it, restore the
 * snapshot, and land exactly on the point-in-time data with a working
 * app — plus every guard that keeps a restore from destroying data.
 */
describe('restore script (guarded, verified, reversible)', () => {
  let dir: string;
  let dbPath: string;

  const seed = (companies: string[]) => {
    const db = createDb(dbPath);
    const service = new ApplicationService(db).forUser(DEMO_USER_ID);
    for (const company of companies) {
      service.create(createApplicationSchema.parse({ company, position: 'SRE' }));
    }
    db.close();
  };
  const companiesIn = (file: string): string[] => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return db
        .prepare('SELECT company FROM applications ORDER BY company')
        .all()
        .map((r) => (r as { company: string }).company);
    } finally {
      db.close();
    }
  };
  const runBackup = (args: string[]) =>
    execFileSync(process.execPath, [BACKUP, ...args], { encoding: 'utf8' });
  const runRestore = (args: string[]) =>
    execFileSync(process.execPath, [RESTORE, ...args], { encoding: 'utf8' });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'offerflow-restore-'));
    dbPath = path.join(dir, 'offerflow.db');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('backup → mutate → restore lands exactly on the point-in-time data', () => {
    seed(['Alpha Co', 'Beta LLC']);
    const snap = path.join(dir, 'snap.db');
    runBackup([snap, '--db', dbPath]);

    // Life goes on after the snapshot: a third row arrives.
    const live = createDb(dbPath);
    new ApplicationService(live)
      .forUser(DEMO_USER_ID)
      .create(createApplicationSchema.parse({ company: 'Gamma GmbH', position: 'Eng' }));
    live.close();
    expect(companiesIn(dbPath)).toEqual(['Alpha Co', 'Beta LLC', 'Gamma GmbH']);

    // Restore the snapshot over the live target.
    const out = runRestore([snap, '--db', dbPath, '--force']);
    expect(out).toContain('integrity ok');
    expect(out).toContain('2 applications');
    expect(companiesIn(dbPath)).toEqual(['Alpha Co', 'Beta LLC']); // Gamma is gone

    // The restored database is a fully working app, not just valid bytes.
    const reopened = createDb(dbPath);
    try {
      expect(reopened.prepare('PRAGMA integrity_check').get()).toMatchObject({
        integrity_check: 'ok',
      });
      const scope = new ApplicationService(reopened).forUser(DEMO_USER_ID);
      expect(scope.listPage({}).total).toBe(2);
      // And it accepts new writes after recovery.
      scope.create(createApplicationSchema.parse({ company: 'Post Restore', position: 'Eng' }));
      expect(scope.listPage({}).total).toBe(3);
    } finally {
      reopened.close();
    }
  });

  it('saves a reversible safety snapshot of the current target before replacing', () => {
    seed(['One', 'Two', 'Three']);
    const snap = path.join(dir, 'snap.db');
    // Snapshot when there was only one row.
    const early = createDb(dbPath);
    early.prepare('DELETE FROM applications WHERE company != ?').run('One');
    early.close();
    runBackup([snap, '--db', dbPath]);
    // Restore back to three rows, then restore the one-row snapshot.
    const live = createDb(dbPath);
    const svc = new ApplicationService(live).forUser(DEMO_USER_ID);
    svc.create(createApplicationSchema.parse({ company: 'Two', position: 'x' }));
    svc.create(createApplicationSchema.parse({ company: 'Three', position: 'x' }));
    live.close();

    runRestore([snap, '--db', dbPath, '--force']);
    expect(companiesIn(dbPath)).toEqual(['One']);

    // The pre-restore safety snapshot captured the three-row state.
    const safety = readdirSync(dir).filter((f) => f.includes('.pre-restore-'));
    expect(safety).toHaveLength(1);
    expect(companiesIn(path.join(dir, safety[0])).sort()).toEqual(['One', 'Three', 'Two']);
  });

  it('refuses to replace an existing target without --force', () => {
    seed(['Keep Me']);
    const snap = path.join(dir, 'snap.db');
    runBackup([snap, '--db', dbPath]);
    expect(() => runRestore([snap, '--db', dbPath])).toThrow(/target exists/);
    expect(companiesIn(dbPath)).toEqual(['Keep Me']); // untouched
  });

  it('restores into a fresh (nonexistent) target without --force', () => {
    seed(['Source Row']);
    const snap = path.join(dir, 'snap.db');
    runBackup([snap, '--db', dbPath]);
    const fresh = path.join(dir, 'fresh.db');
    const out = runRestore([snap, '--db', fresh]);
    expect(out).toContain('1 applications');
    expect(companiesIn(fresh)).toEqual(['Source Row']);
  });

  it('rejects a corrupt snapshot without touching the target', () => {
    seed(['Precious']);
    const corrupt = path.join(dir, 'corrupt.db');
    writeFileSync(corrupt, Buffer.from('this is definitely not a sqlite database'));
    expect(() => runRestore([corrupt, '--db', dbPath, '--force'])).toThrow();
    expect(companiesIn(dbPath)).toEqual(['Precious']); // untouched
  });

  it('rejects a valid SQLite file that is not an OfferFlow snapshot', () => {
    seed(['Precious']);
    const foreign = path.join(dir, 'foreign.db');
    const other = new DatabaseSync(foreign);
    other.exec('CREATE TABLE unrelated (x INTEGER)');
    other.close();
    expect(() => runRestore([foreign, '--db', dbPath, '--force'])).toThrow(
      /missing the 'applications'/,
    );
    expect(companiesIn(dbPath)).toEqual(['Precious']);
  });

  it('refuses when snapshot and target are the same file', () => {
    seed(['Self']);
    expect(() => runRestore([dbPath, '--db', dbPath, '--force'])).toThrow(/same file/);
    expect(companiesIn(dbPath)).toEqual(['Self']);
  });
});
