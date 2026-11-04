# 6. Optimistic concurrency via row versions (ETag / If-Match)

- **Status**: accepted
- **Date**: 2026-11-04
- **Amends**: [ADR-0003](0003-migrations-and-transactions.md) (migration 3)

## Context

Client-side race guards (ADR-0005 §6) order responses within **one** tab.
They cannot see another tab, window or device: two forms opened on the
same application both submit full field sets, and the later save silently
destroys the earlier one — the classic _lost update_. `updated_at`
timestamps are not a guard (clock granularity, equal timestamps), and
`BEGIN IMMEDIATE` only serializes writes; it does not detect that the
second writer was looking at stale data.

## Decision

- **Row version**: `applications.version INTEGER NOT NULL DEFAULT 1`
  (migration 3, backfills existing rows). Every field update does
  `version = version + 1` inside the same transaction.
- **ETag**: `GET/PATCH /api/applications/:id` return a strong ETag derived
  from the version (`"3"`). Exact and free — no body hashing. The version
  also travels in the JSON body so list consumers have it without extra
  requests.
- **If-Match on PATCH** (optional):
  - `"N"` → compare-and-swap: `UPDATE ... WHERE id = ? AND version = N`.
    Zero changed rows → `412 PRECONDITION_FAILED` (new coded error),
    transaction rolls back, no phantom status event.
  - `*` → any existing row (the 404 check already covers existence).
  - Malformed values (`W/"1"`, lists, unquoted) → `400 VALIDATION_FAILED`.
    Silently ignoring a broken precondition would turn the guard into a
    no-op — the exact failure the guard exists to prevent.
  - Absent → last-write-wins, unchanged behavior.
- **Who sends it**: form edits always (the form tracks the version it was
  opened with); drag-and-drop moves and the drawer's status select do not
  — they are single-field _intent_ writes ("put it in Interview"), where
  last-write-wins is the correct semantics and the client-side per-card
  sequencing already prevents self-inflicted races.
- **412 UX**: the form shows a conflict banner with **Load latest** —
  it refetches the row, rebases the fields _and_ the base version, and the
  user re-applies their intent on top. No dead ends, no silent overwrites.

## Alternatives considered

- **Pessimistic locking / edit sessions**: needs lock TTLs, heartbeats and
  cleanup; massive complexity for a personal tracker.
- **`updated_at` comparison**: not reliable under equal timestamps and
  clock adjustments; an integer version is exact.
- **Mandatory If-Match**: would break curl/scripts and force synthetic
  versions on intent-style moves; optional keeps the API friendly while
  the UI opts into safety where it matters.
- **Field-level merge (CRDT-ish)**: overkill; the domain has one human
  editor per application in practice.

## Consequences

- Lost updates between tabs/devices are detected and recoverable, with a
  tested rollback path (412 leaves data and timeline untouched).
- The contract grew by one field (`version`) and one error code
  (`PRECONDITION_FAILED`) — both live in `@offerflow/shared`, so client
  and server compile against the same truth.
- Migration 3 is additive with a default; existing databases (including
  baselined legacy ones) upgrade in place.
- Tests: server ETag/If-Match matrix incl. malformed headers and phantom
  event checks; client conflict-flow tests (banner, rebase, resubmit with
  the fresh version).
