import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDb, migrate } from '../src/db.js';

describe('migrations', () => {
  it('records applied migrations and is idempotent', () => {
    const db = createDb(':memory:');
    const first = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };
    expect(first.n).toBeGreaterThanOrEqual(2);
    migrate(db); // running again must be a no-op
    const second = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };
    expect(second.n).toBe(first.n);
  });

  it('baselines a pre-migration database instead of crashing', () => {
    const db = new DatabaseSync(':memory:');
    // Simulate the legacy schema that existed before the migration system.
    db.exec(`CREATE TABLE applications (
      id TEXT PRIMARY KEY, company TEXT NOT NULL, position TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'wishlist', source TEXT NOT NULL DEFAULT 'other',
      priority TEXT NOT NULL DEFAULT 'medium', location TEXT,
      work_mode TEXT NOT NULL DEFAULT 'remote', salary_min INTEGER, salary_max INTEGER,
      currency TEXT NOT NULL DEFAULT 'EUR', url TEXT, notes TEXT, applied_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );`);
    db.exec(`CREATE TABLE events (
      id TEXT PRIMARY KEY, application_id TEXT NOT NULL, type TEXT NOT NULL,
      message TEXT NOT NULL, created_at TEXT NOT NULL
    );`);
    migrate(db);
    const rows = db
      .prepare('SELECT id, name FROM schema_migrations ORDER BY id')
      .all() as unknown as { id: number; name: string }[];
    expect(rows[0].id).toBe(1);
    expect(rows[0].name).toContain('baselined');
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it('persists data across reopen (WAL file database)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'offerflow-test-'));
    const file = path.join(dir, 'test.db');
    try {
      const db1 = createDb(file);
      db1
        .prepare(
          `INSERT INTO applications (id, company, position, created_at, updated_at)
           VALUES ('p1', 'Persist Co', 'FE', 'now', 'now')`,
        )
        .run();
      db1.close();

      const db2 = createDb(file);
      const row = db2.prepare('SELECT company FROM applications WHERE id = ?').get('p1') as {
        company: string;
      };
      expect(row.company).toBe('Persist Co');
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforces schema CHECK constraints as a last line of defense', () => {
    const db = createDb(':memory:');
    expect(() =>
      db
        .prepare(
          `INSERT INTO applications (id, company, position, status, created_at, updated_at)
           VALUES ('bad', 'X', 'X', 'not-a-status', 'now', 'now')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });
});
