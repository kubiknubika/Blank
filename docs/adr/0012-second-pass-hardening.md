# 0012 — Second-pass security audit: resource ceilings and supply chain

Date: 2026-11-05
Status: Accepted

## Scope

A deliberately stricter second pass after [ADR-0011](0011-security-audit.md).
Round 8 asked "can an attacker break in or inject?"; round 9 asks "can an
authenticated (or anonymous) caller exhaust the server, amplify responses,
or poison the build pipeline?". Method: re-read every request-path module
looking for unbounded growth and unmapped error paths, probe the live build,
then review CI/CD and the cookie/header surface. All findings below were
fixed and pinned with regression tests in the same change.

## Findings fixed in this round

### F1 — MEDIUM: oversized bodies returned 500 and logged stack traces

Confirmed live: a 300 KB JSON body (limit: 256 KiB) produced
`500 INTERNAL` — body-parser's typed `http-errors` fell through to the
generic handler, which also logs a stack trace per request. Any client
could flood the error log with one cheap request each.

Fix: `errorHandler` now maps `err.type` before the generic branch —
`entity.too.large` → **413 `PAYLOAD_TOO_LARGE`**, `encoding.unsupported`
→ 415, `request.aborted`/`request.size.invalid` → 400. Expected client
errors no longer touch `logger.error`. New error code in the shared
contract; OpenAPI documents 413 on the JSON mutation paths.

### F2 — MEDIUM: unbounded session table

Every login/demo click inserted a session row living for 7 days; expired
rows were only swept opportunistically. The credential limiter (20/min/IP)
bounds the rate, not the total — a distributed caller grows the table
forever. Fix: **`MAX_SESSIONS_PER_USER = 50`**; `createSession` evicts the
oldest beyond the cap in the same call (`DELETE … NOT IN (SELECT … ORDER
BY created_at DESC, rowid DESC LIMIT 50)`). The table is now bounded by
users × 50 rows. 50 (not 10) because the demo account is shared by many
concurrent visitors; evicting a stranger's oldest demo session is an
acceptable trade for a hard ceiling.

### F3 — MEDIUM: unbounded event history = storage DoS + response amplification

`GET /applications/:id` returns the full event log, and nothing capped it:
120 mutations/min × 2 KB messages ≈ 345 MB/day of DB growth, and one cheap
GET would eventually pull hundreds of MB back out. Fix:
**`MAX_EVENTS_PER_APPLICATION = 200`** — `insertEvent` prunes the oldest
beyond the cap (rowid tie-break for same-millisecond inserts) and
`listEvents` reads with `LIMIT`. Every read path (get/create/update all
return full events) is bounded by construction.

Semantics change, stated explicitly: the timeline is now a **bounded
recent-history window**, not a complete audit trail. For a job tracker
that is the right product behavior; a compliance-grade audit log would
belong in append-only external storage, not in the row the UI renders.

### F4 — MEDIUM: unbounded applications per user; CSV import amplifies ×1000

The mutation limiter caps requests, not rows: one import writes up to
1000 applications, so 120 requests/min could create ~120k rows/min.
Fix: **`MAX_APPLICATIONS_PER_USER = 5000`** (active + archived) enforced
inside the create transaction and as an atomic pre-check in `importCsv`
(`countForUser + rows.length` before the loop) → **422 `QUOTA_EXCEEDED`**.
A rejected import writes nothing. Limits are injectable
(`ServiceLimits`, `AppDeps.limits`) so tests run with tiny caps instead
of inserting 5000 rows.

### F5 — MEDIUM: reads were unlimited

"Reads are never limited" was a documented round-7 decision; with
analytics (five aggregations per call) and CSV export (full table scan +
serialization) it is a CPU/egress lever. Fix: a separate generous read
budget — **`READ_RATE_LIMIT_MAX = 600/min`** per IP, same fixed-window
limiter, enforced before body parsing. Operational probes
(`/api/health`, `/api/ready`, `/api/metrics`, `/api/openapi.json`) are
exempt: the ops router responds before the limiter and `/health` is
skipped explicitly. 600/min is far above interactive use and above the
E2E suite's read volume; `0` disables. The rate-limit test suite was
rewritten to pin the new contract (reads carry their own budget, probes
carry none).

### F6 — MEDIUM: CI supply chain

Three gaps: actions pinned to **mutable tags** (`@v4` — a compromised
action repo can repoint the tag, cf. the tj-actions incident), the
`GITHUB_TOKEN` inheriting default (possibly write) permissions, and
checkout leaving credentials in `.git/config` for any later step to read.
Fix: full-SHA pins with version comments (checkout v4.2.2, setup-node
v4.4.0, upload-artifact v4.6.2 — dependabot's `github-actions` ecosystem
updates SHA pins natively), workflow-level `permissions: contents: read`,
`persist-credentials: false` on both checkouts, and a `docker` dependabot
ecosystem for base-image updates.

### F7 — LOW: `verifyPassword` still had throwing parameter sets

Round 8's fail-closed verifier bounded N, r, p individually, but
combinations could still exceed `maxmem` (N=2^20, r=32 → 4 GiB) and
non-power-of-two N is invalid for scrypt — both throw → 500. Non-hex
salt/hash strings were silently truncated by `Buffer.from(x, 'hex')`.
Fix: strict lowercase-hex validation, integer + power-of-two checks, an
explicit `128·N·r ≤ maxmem` bound, and a final `try/catch → false`. A
tampered hash row can now never produce anything but a failed login.

### F8 — LOW: no CSP, HSTS, or Permissions-Policy

Round 8 deferred CSP over iframe-preview concerns — but only
`frame-ancestors` affects framing. Fix: a real CSP **without**
`frame-ancestors` by default: `default-src 'self'; script-src 'self';
style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src
'self'; base-uri 'self'; form-action 'self'; object-src 'none'`. The
built bundle loads only self-hosted scripts (verified against
`dist/index.html`), so injected inline scripts/event handlers are blocked
even if an XSS vector ever slips past React and the URL schema; inline
style attributes are pervasive in the components, hence
`style-src 'unsafe-inline'` (styles cannot execute code). Deployments
that don't need embedding set **`CSP_FRAME_ANCESTORS='none'`**.
HSTS (`max-age=31536000; includeSubDomains`) is sent only when
`req.secure` — correct behind a TLS-terminating proxy with
`TRUST_PROXY_HOPS`, absent on plain HTTP. `Permissions-Policy` denies
camera/microphone/geolocation/payment.

### F9 — LOW: cookie tossing from sibling subdomains (HTTPS)

A plain-name session cookie can be set by any subdomain of the app's
host and shadow the real one. Fix: on HTTPS the cookie is
**`__Host-offerflow_session`** — browsers only accept the prefix with
`Secure` + `Path=/` + no `Domain`, locking it to the exact origin. The
secure reader accepts **only** the prefixed name, so a tossed plain
cookie is ignored even with a valid token. Plain HTTP keeps the plain
name (the prefix requires `Secure`; curl and CI E2E run over HTTP), so an
HTTP→HTTPS switch costs one re-login. Logout clears both names; the
`__Host-` clear always carries `Secure` or browsers reject it.

### F10 — LOW: import error amplification

1000 invalid rows × several zod issues each serialized into one huge 400
response (and log line) from a single cheap request. Fix: error details
capped at **50** plus a `…and N more issue(s)` summary entry. The client
already shows only the first three.

### F11 — LOW: codec and client edges

- `FORMULA_PREFIXES` gains `\n` (defense in depth — the API schema's
  `.trim()` already strips leading whitespace, but `toCsv` must defend
  for any caller).
- The client rejects import files > 256 KiB **before** `file.text()`
  reads them into memory; the server limit would bounce them anyway.
- Export revokes its object URL on a 1 s delay — synchronous revocation
  can cancel the download in some browsers.

### F12 — INFO: defensive UNIQUE mapping in register

The email pre-check makes a UNIQUE violation unreachable in the current
single-threaded design; the INSERT now maps SQLite errcode 2067 to 409
anyway, so a future concurrent write path degrades to a conflict, not a 500.

## Examined and judged safe (no change)

- **SQL injection**: every statement parameterized; ownership is the
  first WHERE clause by construction.
- **Prototype pollution**: zod strips unknown keys; no `Object.assign`
  of user input onto objects.
- **Path traversal**: static serving rooted at `client/dist`; SPA
  fallback serves one fixed file; `../` probes return the app shell.
- **CSRF**: JSON-only mutations + Origin allowlist + `SameSite=Lax`;
  bodyless demo/reset still passes the Origin check.
- **Session fixation**: every login/register/demo mints a fresh token.
- **Timing oracle**: unknown-email logins burn the dummy hash; the 409
  on duplicate registration already reveals existence, so register
  timing is moot.
- **Metrics**: aggregate counters only, no user data; route labels from
  a closed set (no cardinality injection).
- **Backups**: `VACUUM INTO` with operator-supplied path, refuses to
  overwrite; WAL-consistent by construction.
- **Docker**: non-root `USER node`, `.dockerignore` excludes data,
  backups, `.git` and coverage from the build context.

## Accepted risks (unchanged or re-affirmed)

- In-memory rate-limit buckets: per-process, reset on restart. A shared
  store is the multi-instance answer; single-process SQLite deployment
  doesn't need it yet.
- Shared demo account: anyone can reset it; the session cap now bounds
  its footprint as well.
- Unauthenticated `/api/metrics`: aggregate-only, operationally useful;
  put it behind the ingress ACL in sensitive deployments.
- HTTP cookie tossing remains possible on plain-HTTP deployments (no
  `Secure`, no `__Host-`); HTTPS deployments are covered by F9.

## Verification

- 18 new tests in `server/tests/security-hardening.test.ts` (413/415
  mapping with no error log, verifier throw-paths, session eviction,
  event pruning at rest, quota create/import atomicity, error-detail
  cap, LF formula guard, CSP/HSTS/Permissions-Policy, `__Host-` issuance
  / tossing resistance / dual clear) plus a rewritten rate-limit suite
  (read budget, probe exemption, read-window rollover, `max: 0`).
- Full suite: 227 server + 78 client unit tests, 16 E2E (CI).
- Live re-probe of the running build after the fixes.
