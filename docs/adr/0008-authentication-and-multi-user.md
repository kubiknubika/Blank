# 0008 — Authentication and multi-user isolation

Date: 2026-11-04
Status: Accepted

## Context

Until now OfferFlow was a single-user tracker: every visitor saw and mutated
the same rows, and `POST /api/demo/reset` could wipe the board for everyone.
The next step is real accounts with hard data isolation, while keeping the
zero-friction demo path that makes the project reviewable.

Constraints carried over from earlier rounds: no new runtime dependencies
(the whole stack is Express + node:sqlite + zod), engineering depth over
feature breadth, and the existing CSRF defenses (Origin allowlist + JSON
Content-Type enforcement, ADR-0005) must keep working.

## Decision

### Sessions, not JWTs

Server-side sessions in SQLite (`sessions` table), referenced by an opaque
cookie. For a single-node app this beats JWTs on every axis that matters
here: instant revocation (logout deletes the row), no token-refresh
machinery, no algorithm-confusion footguns, and the session list is
inspectable with plain SQL.

- Cookie `offerflow_session`: 32 random bytes, base64url. `HttpOnly`
  (JavaScript — including XSS payloads — cannot read it), `SameSite=Lax`
  (cross-site POSTs never carry it), `Path=/`, 7-day absolute expiry.
  `Secure` is derived from `req.secure`, i.e. set whenever the request
  arrived over HTTPS (trust-proxy aware via `TRUST_PROXY_HOPS`). Deriving
  it from the request instead of `NODE_ENV` keeps plain-HTTP CI E2E and
  local curl fully functional.
- **Only the SHA-256 of the token is stored.** A database leak yields no
  usable session tokens — the same reasoning as password hashing. Lookup
  is a primary-key hit; no salt is needed because the input is already
  256 bits of entropy.
- Expiry is absolute (7 days), not sliding: simpler to reason about, and
  re-login is cheap. Expired rows are swept opportunistically whenever a
  new session is issued — no timers, no cron.

### Passwords: scrypt from node:crypto

`scrypt(N=16384, r=8, p=1, keylen=64)` with a 16-byte random salt per user.
The stored format `scrypt$N$r$p$saltHex$hashHex` travels with its
parameters so cost can be raised later without a flag day. Verification
uses `timingSafeEqual`. Unknown-email logins still burn one scrypt
computation against a dummy hash, so "no such user" and "wrong password"
are indistinguishable in both response body and timing.

Registration policy follows NIST-ish guidance: 8–128 characters, no
composition rules. Emails are normalized (trim + lowercase) and unique
(`409 CONFLICT` on duplicates).

### The shared demo account

Migration 4 creates a fixed `demo` user with `password_hash = NULL` — it
is unreachable through `/api/auth/login` (a NULL hash always fails) and
reachable only via `POST /api/auth/demo`. All pre-auth rows are backfilled
to it, so existing deployments keep their data visible in demo mode.

- Demo data is explicitly shared and public; the UI says so.
- `POST /api/demo/reset` now requires a session **and** `isDemo` — a real
  account's data can never be replaced by the seed, and the reset only
  touches the demo user's rows.
- New registered accounts start empty.

### Ownership bound at the boundary

`applications.user_id` is nullable in SQLite (ALTER TABLE ADD COLUMN with
REFERENCES requires a NULL default under `foreign_keys=ON`) but the
repository binds it on **every** insert and filters **every** read. The
service exposes no unscoped data API at all: `service.forUser(userId)`
returns a facade whose methods close over the owner id, and the HTTP layer
constructs it from the session — forgetting to scope is a compile error,
not a data leak. A test pins that no row is ever ownerless.

Cross-user access answers **404, not 403**: the API never confirms that
another user's row exists. Analytics (all five aggregate groups plus the
activity feed) are scoped the same way.

### Middleware order and rate limits

`securityChecks` (Host/Origin/Content-Type) → ops endpoints (public) →
general mutation limiter → JSON parsing → session resolution →
`/api/auth` router (public, own limiter) → `requireUser` on data routes.

- Security checks stay FIRST so CSRF probes get 403/415 regardless of
  auth state — the round-2 regression tests keep their meaning.
- Credential endpoints (`register`, `login`, `demo`) get a separate,
  tighter per-IP budget (`CREDENTIAL_RATE_LIMIT_MAX`, default 20/min) —
  an online guessing brake on top of scrypt's offline cost.
- `/api/health`, `/api/ready`, `/api/metrics`, `/api/openapi.json` stay
  public: probes and scrapers are not users.

### Client shell

`App` resolves `GET /api/auth/me` once, then renders either `AuthScreen`
(sign in / create account / try demo) or the `Tracker`. The tracker — and
its data hooks — only mount while authenticated, so no request races the
login, and switching accounts remounts it (`key={user.id}`) so no stale
data crosses users. A 401 from any data call fires a DOM event that drops
the shell back to the sign-in screen. No auth library, no router, no
client-side token storage: the cookie is the session.

## Consequences

- - Hard multi-user isolation, tested at HTTP, service, and SQL levels
    (including the 404-not-403 non-enumeration property).
- - Instant revocation; a stolen DB dump exposes neither passwords nor
    usable sessions.
- - Demo path preserved with zero friction, now blast-radius-contained.
- - OpenAPI documents the auth surface with a `cookieAuth` scheme; the
    drift tests walk both routers.
- − Sessions add one PK lookup per authenticated request (negligible next
  to scrypt on login, which is deliberately ~50–100 ms).
- − Absolute expiry means an active user must re-login weekly. Acceptable
  for a tracker; sliding sessions can be added later without a migration.
- − The demo account is shared by design: concurrent demo visitors see
  each other's edits. That is the point of a public demo, and the UI
  labels it.

## Alternatives considered

- **JWT access + refresh tokens**: revocation requires a denylist — i.e.
  server-side state anyway, plus rotation complexity. Rejected.
- **Per-visitor demo sandboxes**: nicer isolation, but unbounded row
  growth from anonymous traffic and a cleanup job to run. The shared,
  resettable demo is the honest trade for a portfolio deployment.
- **NOT NULL user_id via table rebuild**: SQLite's 12-step rebuild with
  `foreign_keys=ON` turns `DROP TABLE` into an implicit DELETE that
  cascades events, and the pragma cannot toggle inside a transaction.
  Nullable column + repository enforcement + a pinning test is safer.
- **argon2/bcrypt packages**: better-known names, but node:crypto's scrypt
  is a memory-hard KDF that meets the bar without a native dependency.
