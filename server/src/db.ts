import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Forward-only migrations. Each entry runs exactly once, inside a
 * transaction, and is recorded in schema_migrations. To change the schema,
 * append a new migration — never edit an applied one.
 */
const MIGRATIONS: { id: number; name: string; up: string }[] = [
  {
    id: 1,
    name: 'initial-schema',
    up: `
      CREATE TABLE applications (
        id TEXT PRIMARY KEY,
        company TEXT NOT NULL,
        position TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'wishlist',
        source TEXT NOT NULL DEFAULT 'other',
        priority TEXT NOT NULL DEFAULT 'medium',
        location TEXT,
        work_mode TEXT NOT NULL DEFAULT 'remote',
        salary_min INTEGER,
        salary_max INTEGER,
        currency TEXT NOT NULL DEFAULT 'EUR',
        url TEXT,
        notes TEXT,
        applied_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (status IN ('wishlist','applied','screening','interview','offer','rejected')),
        CHECK (work_mode IN ('remote','hybrid','onsite')),
        CHECK (salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max)
      );
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_applications_status ON applications(status);
      CREATE INDEX idx_events_application ON events(application_id);
    `,
  },
  {
    id: 2,
    name: 'events-created-at-index',
    up: `CREATE INDEX idx_events_created_at ON events(created_at DESC);`,
  },
];

export function createDb(path: string): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );`);
  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as unknown as { id: number }[]).map(
      (r) => r.id,
    ),
  );

  // Baseline: a database created before the migration system existed already
  // has the initial schema. Record migration 1 as applied instead of failing
  // on CREATE TABLE. (Real-world pattern for adopting migrations on live DBs.)
  if (applied.size === 0) {
    const legacy = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'applications'`)
      .get();
    if (legacy) {
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        1,
        'initial-schema (baselined)',
        new Date().toISOString(),
      );
      applied.add(1);
    }
  }
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    db.exec('BEGIN');
    try {
      db.exec(migration.up);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        migration.id,
        migration.name,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${migration.id} (${migration.name}) failed: ${String(err)}`);
    }
  }
}

const txDepth = new WeakMap<DatabaseSync, number>();

/**
 * Run fn inside a transaction; rolls back on any throw.
 * Re-entrant: nested calls use SAVEPOINTs, so a failure deep in a call
 * stack (e.g. seed → create) rolls back only its own work, and the
 * outermost call decides the final commit.
 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  const depth = txDepth.get(db) ?? 0;
  const savepoint = `sp_${depth}`;
  db.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
  txDepth.set(db, depth + 1);
  try {
    const result = fn();
    db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
    return result;
  } catch (err) {
    if (depth === 0) {
      db.exec('ROLLBACK');
    } else {
      db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
    }
    throw err;
  } finally {
    txDepth.set(db, depth);
  }
}
