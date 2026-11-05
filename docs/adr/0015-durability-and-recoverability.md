# 0015 — Durability and recoverability: prove the operational promises

Date: 2026-11-05
Status: Accepted

## Context

The app makes several operational claims in its own comments and docs:

- `createDb`: `synchronous=NORMAL` in WAL mode is "durable against app
  crashes."
- `backup.mjs`: "a backup you never restored is a hope, not a backup."
- The CSV codec escapes formula injection _reversibly_, so export→import
  is lossless.

Until now these were assertions backed by reasoning and point tests. This
round turns each into a **proven, continuously-checked property**, and
ships the missing tool that makes the backup claim actionable.

## Decision 1 — a guarded restore script (the other half of backup)

`server/scripts/restore.mjs` (`npm run restore -- <snapshot.db> [--db
target] [--force]`) completes the backup/restore loop. Its safety model:

1. **Verify before touching anything.** The snapshot is opened read-only,
   `integrity_check`ed, and schema-checked (`applications` +
   `schema_migrations` must exist). A corrupt or foreign file is rejected
   without the target being modified.
2. **Refuse to clobber by default.** An existing target requires `--force`.
3. **Reversible.** With `--force`, the current target is first saved to a
   timestamped `*.pre-restore-*.db` safety snapshot via `VACUUM INTO`, so a
   wrong restore can itself be undone. If the safety copy cannot be taken
   (e.g. the server is still running and holds the lock), the restore
   aborts without changes.
4. **Atomic replace.** The snapshot is copied to a temp file in the same
   directory and `rename(2)`d over the target; stale `-wal`/`-shm` sidecars
   from the old database are removed. (Design note: `node:sqlite`'s
   `close()` does **not** delete WAL sidecars, so a stopped server can
   leave them behind — the restore must clear them or the old WAL would
   shadow the restored file.)
5. **Verify after.** The restored target is independently
   `integrity_check`ed and its row count compared to the snapshot.

The server must be stopped first; the `--force` gate and the safety-copy
failure path make that requirement explicit rather than implicit.

## Decision 2 — crash-recovery test (prove the WAL claim)

`server/tests/crash-recovery.test.ts` spawns a child that mirrors
`createDb`'s durability pragmas (`WAL`, `synchronous=NORMAL`,
`busy_timeout`, `foreign_keys`) and writes autocommitted rows, printing
each commit. The parent **`SIGKILL`s it mid-stream** — no clean close, no
checkpoint — then reopens the database exactly as the server would on
restart and asserts:

- `integrity_check` is `ok`;
- **every acknowledged commit (1..50) survived**, plus the pre-crash
  baseline row;
- the app accepts new writes on the recovered database.

This is process death, not power loss: the OS page cache survives
`SIGKILL`, which is precisely the failure mode `NORMAL` guarantees. The
test confirms an uncheckpointed WAL is left behind and correctly replayed.
It runs against raw `node:sqlite` (not the built server) so it works in
CI's test phase, which runs before the build.

## Decision 3 — the restore drill (prove the backup claim)

`server/tests/restore.test.ts` runs the **real** `backup.mjs` and
`restore.mjs` as subprocesses and drills the full loop: snapshot a live
DB → mutate it → restore → land on the exact point-in-time data, with a
working app that accepts new writes. It also pins every guard: refuse
without `--force`, the reversible safety copy captures the pre-restore
state, corrupt and foreign snapshots are rejected without touching the
target, a fresh target needs no `--force`, and snapshot==target is refused.

## Decision 4 — CSV round-trip property (prove the codec claim)

`server/tests/csv-property.test.ts` generates random **valid** boards
(seeded) whose fields deliberately include the adversarial-but-legal
content the escaping exists for — commas, quotes, embedded newlines,
formula prefixes (`= + - @`), unicode, and archived rows — then exports
account A and imports into a fresh account B, asserting every field
round-trips byte-for-byte. The one exception is `archivedAt`: import
re-archives at import time, so the property asserts the archived _state_
(null vs non-null), which is the semantically meaningful part. A second
export→import hop (B→C) confirms stability.

This is the **correctness** complement to the round-13 fuzzer, which proves
_robustness_ (hostile input never 5xx). Together they bracket the codec:
it neither crashes on garbage nor loses valid data.

## Consequences

- The three operational claims are now executable properties re-checked on
  every push, each with a reproduction recipe on failure.
- Backup is actionable: there is a guarded, reversible restore path with a
  drill that proves it works, not just a snapshot writer.
- No new dependencies; the scripts use `node:sqlite` + `node:fs`, the tests
  reuse the seeded-PRNG and subprocess patterns already in the suite.

## Deferred

A Docker-image build/smoke job in CI would catch Dockerfile drift, but the
sandbox has no Docker daemon to verify it locally, and shipping an
unverified CI job risks a red pipeline. The `docker` dependabot ecosystem
(round 9) already tracks base-image updates; a verified build job is a
future step once it can be tested before merge.
