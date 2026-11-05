import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, transaction } from '../src/db.js';

/**
 * Contention regressions for the exact failure modes reported against
 * node:sqlite in the wild (nodejs/node#57597, nanobpm/nano-bpm#1287):
 * default busy_timeout=0 → instant "database is locked", and WAL
 * deferred read→write upgrades that ignore busy_timeout entirely.
 *
 * node:sqlite is synchronous, so contention is simulated with two
 * connections in one process: the blocked call really sleeps in the
 * SQLite busy handler, which is what the timing assertions observe.
 */
function withTempDb(fn: (file: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'offerflow-lock-'));
  try {
    fn(path.join(dir, 'lock.db'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const insert = (db: ReturnType<typeof createDb>, id: string) =>
  db
    .prepare(
      `INSERT INTO applications (id, company, position, created_at, updated_at)
       VALUES (?, 'Lock Co', 'FE', 'now', 'now')`,
    )
    .run(id);

describe('busy_timeout', () => {
  it('defaults to 5000ms (node:sqlite itself defaults to 0)', () => {
    const db = createDb(':memory:');
    const row = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
    expect(row.timeout).toBe(5000);
    db.close();
  });

  it('applies a custom value and rejects invalid ones', () => {
    const db = createDb(':memory:', { busyTimeoutMs: 1234 });
    const row = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
    expect(row.timeout).toBe(1234);
    db.close();
    expect(() => createDb(':memory:', { busyTimeoutMs: -1 })).toThrow(/busyTimeoutMs/);
    expect(() => createDb(':memory:', { busyTimeoutMs: 1.5 })).toThrow(/busyTimeoutMs/);
  });

  it('a blocked writer waits for the timeout, then succeeds once the lock frees', () => {
    withTempDb((file) => {
      const a = createDb(file);
      const b = createDb(file, { busyTimeoutMs: 200 });
      a.exec('BEGIN IMMEDIATE'); // connection A holds the write lock
      insert(a, 'a1');

      const start = Date.now();
      expect(() => b.exec('BEGIN IMMEDIATE')).toThrow(/locked|busy/i);
      // With node:sqlite's default timeout of 0 this would fail in ~0ms.
      expect(Date.now() - start).toBeGreaterThanOrEqual(150);

      a.exec('ROLLBACK');
      expect(() => b.exec('BEGIN IMMEDIATE')).not.toThrow();
      b.exec('ROLLBACK');
      a.close();
      b.close();
    });
  });
});

describe('BEGIN IMMEDIATE transactions', () => {
  it('transaction() holds the write lock from BEGIN, before any write', () => {
    withTempDb((file) => {
      const a = createDb(file);
      const b = createDb(file, { busyTimeoutMs: 100 });
      transaction(a, () => {
        // No write has happened yet. With BEGIN DEFERRED, another writer
        // could still start — with IMMEDIATE the lock is already taken.
        expect(() => b.exec('BEGIN IMMEDIATE')).toThrow(/locked|busy/i);
        insert(a, 'a1');
      });
      // After commit the lock is free again.
      transaction(b, () => insert(b, 'b1'));
      const n = a.prepare('SELECT COUNT(*) AS n FROM applications').get() as { n: number };
      expect(n.n).toBe(2);
      a.close();
      b.close();
    });
  });

  it('documents the WAL hazard we avoid: deferred read→write upgrade fails instantly', () => {
    withTempDb((file) => {
      const reader = createDb(file, { busyTimeoutMs: 5000 });
      const writer = createDb(file);

      reader.exec('BEGIN'); // DEFERRED — the pattern we deliberately do NOT use
      reader.prepare('SELECT COUNT(*) AS n FROM applications').get(); // snapshot taken
      insert(writer, 'w1'); // another connection commits a write

      const start = Date.now();
      // Upgrading the stale snapshot to a write cannot be fixed by waiting:
      // SQLite returns BUSY immediately, ignoring the 5s busy_timeout.
      expect(() => insert(reader, 'r1')).toThrow(/locked|busy/i);
      expect(Date.now() - start).toBeLessThan(1000);
      reader.exec('ROLLBACK');
      reader.close();
      writer.close();
    });
  });
});
