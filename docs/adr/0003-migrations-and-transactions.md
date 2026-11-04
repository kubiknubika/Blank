# 3. Forward-only migrations and transactional writes

Date: 2026-11-04 · Status: accepted

## Context

`CREATE TABLE IF NOT EXISTS` is not a migration system: it cannot evolve a
schema, and it silently accepts databases of unknown vintage. Multi-write
operations (application + event) were not atomic, so a crash between writes
could leave an application without its `created` event.

## Decision

- **Migrations**: an ordered, append-only list in `db.ts`, each applied once
  inside a transaction and recorded in `schema_migrations`. Applied
  migrations are never edited.
- **Baselining**: a database created before the migration system is detected
  (legacy `applications` table, empty `schema_migrations`) and migration 1 is
  recorded as applied instead of re-running it.
- **Transactions**: `transaction(db, fn)` wraps every multi-write service
  operation. It is re-entrant via SAVEPOINTs, so composed operations
  (demo reset → seed → create) participate in one outer transaction.
  Amended by [ADR-0005](0005-hardening-from-field-reports.md): transactions
  start with `BEGIN IMMEDIATE` (not DEFERRED) and every connection sets
  `busy_timeout`, because WAL read→write upgrades otherwise fail instantly
  under contention.
- **CHECK constraints** in the schema mirror the Zod rules as a last line of
  defense — the database refuses invalid states even if a future code path
  forgets to validate.

## Consequences

- Schema history is explicit and reproducible; a fresh DB and an upgraded DB
  converge to the same state.
- Partial writes are impossible: either the aggregate and its events commit
  together, or nothing does.
- SQLite's single-writer model keeps this simple; a move to Postgres would
  keep the same migration/transaction discipline with a different driver.
