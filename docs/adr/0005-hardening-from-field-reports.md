# 5. Hardening from published field reports

- **Status**: accepted
- **Date**: 2026-11-04
- **Amends**: [ADR-0003](0003-migrations-and-transactions.md) (transaction mode)

## Context

Instead of only reviewing our own code, we surveyed public issue trackers
and advisories for the exact stack we use (`node:sqlite`, SQLite WAL,
Express 5, Vite dev server, React optimistic UI) and checked each reported
failure mode against OfferFlow. Five were applicable; one was not. This
ADR records the findings, the sources, and the fixes, so the reasoning is
auditable later.

## Findings and decisions

### 1. `node:sqlite` defaults `busy_timeout` to 0 → instant "database is locked"

- **Reports**: [nodejs/node#57597](https://github.com/nodejs/node/issues/57597)
  (random `SQLITE_BUSY` under concurrent writes; the driver exposes no
  timeout default), [nanobpm/nano-bpm#1287](https://github.com/nanobpm/nano-bpm/pull/1288)
  (4 workers × 150 writes: 222/600 failed before, 0 after the fix).
- **Applicability**: we had WAL + foreign_keys but no `busy_timeout`. A
  second process (backup script, second container, future worker) would
  fail instantly instead of waiting.
- **Fix**: `createDb` sets `PRAGMA busy_timeout` **first** — before the WAL
  switch, which itself contends for the lock (the nano-bpm report) —
  default 5000 ms, configurable via `DB_BUSY_TIMEOUT_MS`. Also
  `synchronous = NORMAL`, the recommended WAL pairing.

### 2. WAL deferred transactions ignore `busy_timeout` on read→write upgrade

- **Reports**: [WAL upgrade write-up](https://dev.to/ji_ai/sqlite-database-is-locked-ignored-my-30s-busytimeout-311-failures-dem)
  (30 s busy_timeout "ignored", 311 failures — the busy handler only runs
  when no transaction is open; a stale snapshot can never be upgraded by
  waiting), [loomux/server#480](https://github.com/loomux/server/pull/480)
  (8 concurrent read-then-write txs: 7 fail with deferred BEGIN, 0 with
  immediate).
- **Applicability**: direct hit — `service.update()` reads the row, then
  writes, inside `transaction()`, which used plain `BEGIN` (DEFERRED).
- **Fix**: `transaction()` and migrations use `BEGIN IMMEDIATE`; the write
  lock is taken at BEGIN where the busy handler actually applies.
  Regression tests reproduce both failure modes with two connections
  (`server/tests/db-contention.test.ts`), including a timing assertion
  that a blocked writer really waits.

### 3. `engines: ">=22"` promised a Node floor that cannot run the app

- **Reports**: [vib795/agent-memory#47](https://github.com/vib795/agent-memory/pull/47),
  [career-ops-hq/career-ops#4803](https://github.com/career-ops-hq/career-ops/pull/4803)
  — `node:sqlite` exists from 22.5 behind a flag and is unflagged only
  from **22.13**; on 22.12 the app dies with `ERR_UNKNOWN_BUILTIN_MODULE`.
  CI on floating `node-version: 22` resolves the newest 22.x, so the
  declared floor is never exercised.
- **Applicability**: we declared `>=22` and CI tested only `22`.
- **Fix**: `engines: ">=22.13.0"`, `.npmrc` with `engine-strict=true`,
  `.nvmrc`, and a CI matrix `['22.13.0', '22']` — the exact floor plus the
  current release line.

### 4. Vite `allowedHosts: true` + `host: 0.0.0.0` → DNS-rebinding source theft

- **Reports**: [Vite server options / GHSA-vg6x-rcgg-rjx6](https://vite.dev/config/server-options),
  [magicxiaobao/doc-edtitor-agent-prototype#8](https://github.com/magicxiaobao/doc-edtitor-agent-prototype/issues/8)
  (same combo; resolved with an env-driven allowlist that keeps container
  previews working).
- **Applicability**: our dev config had exactly this combo (set for the
  sandbox preview).
- **Fix**: `allowedHosts` is now an explicit list from `VITE_ALLOWED_HOSTS`
  (comma-separated; empty by default — localhost/IPs are always allowed by
  Vite). Container previews opt in with `.e2b.app`. Documented in
  `client/.env.example`.

### 5. Local-first APIs: loopback binding is not a CSRF boundary

- **Reports**: [misaka310/local-finance-dashboard#12](https://github.com/misaka310/local-finance-dashboard/issues/12)
  (a cross-site "simple" POST executed a state change on localhost),
  [burakdede/lorepack#635](https://github.com/burakdede/lorepack/pull/635)
  (Origin checks alone don't stop DNS-rebinding **reads** — a rebound GET
  is same-origin; Host must be validated too; 415 unless JSON).
- **Applicability**: our bodyless `POST /api/demo/reset` was executable by
  a cross-site form post; JSON routes were only accidentally protected by
  Zod rejecting the unparsed body.
- **Fix**: `securityChecks` middleware — (a) mutations with a body require
  `application/json` → 415 otherwise; (b) browser mutations need a
  same-origin `Origin` (host:port match), an explicitly trusted origin
  (`TRUSTED_ORIGINS`), or a loopback origin in development (the Vite proxy
  rewrites Host); (c) optional `TRUSTED_HOSTS` Host allowlist blocks
  rebinding reads where hostnames are static. Header-less clients
  (curl, tests) are unaffected. New coded errors: `FORBIDDEN` (403),
  `UNSUPPORTED_MEDIA_TYPE` (415). Plus `nosniff` / `no-referrer` headers.

### 6. React optimistic UI: out-of-order responses clobber newer state

- **Reports**: [trailheadapps/multiframework-recipes#82](https://github.com/trailheadapps/multiframework-recipes/issues/82)
  (stale refetch overwrites newer results; debounce can't cancel dispatched
  requests), [CupThread/CupThreadReactNativeSDK#75](https://github.com/CupThread/CupThreadReactNativeSDK/issues/75)
  (in-flight fetch clobbers optimistic local state),
  [remigiusz-antczak/deep-code-review#978](https://github.com/remigiusz-antczak/deep-code-review/issues/978)
  (superseded optimistic rollback destroys a newer confirmed write and
  shows a misleading toast; single-call tests miss it).
- **Applicability**: `App.tsx` had an unguarded `refresh()` and a
  last-writer-wins optimistic `moveApp` — all three races were present.
- **Fix**: state moved into `useApplications` with (a) a latest-only
  refresh sequence guard (data, errors and loading flag), (b) per-item
  mutation sequence — a superseded failure skips rollback **and** toast,
  (c) `overlayPendingStatuses` so an in-flight refetch cannot undo a
  pending optimistic move. Tests fire two overlapping operations and
  resolve them out of order, exactly as report #978 prescribes.

### Checked and NOT applicable: Express 5 bare-wildcard routes

- **Report**: [Express 5 migration guide](https://expressjs.com/en/guide/migrating-5.html#path-syntax)
  — `app.get('*')` / `'/*'` now throw "Missing parameter name".
- **Verdict**: our SPA fallback uses a RegExp literal
  (`/^(?!\/api).*/`), which Express 5 still supports. No change needed;
  `server/tests/spa-fallback.test.ts` pins the behavior (/, deep client
  routes, and `/api/*` 404s) so a future route-syntax "cleanup" is a
  conscious, tested decision.

## Consequences

- Write contention degrades to waiting, not failing; the failure mode that
  remains (timeout exceeded) is tested and observable.
- The dev server and the API both validate Host/Origin explicitly; the
  preview workflow keeps working via env opt-ins instead of disabling checks.
- The declared Node floor is real and continuously verified.
- Client state survives out-of-order networks; the race tests document the
  exact interleavings that used to break it.
- Cost: two new env knobs on the server, one on the client, ~30 new tests.
