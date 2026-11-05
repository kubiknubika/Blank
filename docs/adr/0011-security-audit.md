# 0011 — Security audit: findings and hardening

Date: 2026-11-05
Status: Accepted

## Scope

Full-codebase audit after round 7: authentication and sessions, tenant
isolation, injection surfaces (SQL, XSS, CSV, header, path), CSRF, rate
limiting, dependency advisories, secrets handling, Docker runtime, and
live attack probes against the running build. Method: read every
security-relevant module, then attack the live API (SQLi payloads,
prototype pollution, traversal, forged cookies, XSS planting) and check
what the browser actually receives.

## Findings fixed in this round

### F1 — HIGH: stored XSS via `javascript:`/`data:` posting URLs

`z.string().url()` validates syntax, not scheme: it accepts
`javascript:alert(document.domain)` and `data:text/html,<script>…`.
The value was rendered into `<a href={app.url}>` in the detail drawer.
Attack path: a malicious CSV "job list" import plants a script URL;
one click on "Open job posting" executes attacker JS in the app's
origin with the victim's session (HttpOnly does not help — the script
_is_ the victim). Confirmed live: the API accepted the payload.

Fix, three layers:

1. **Contract**: `httpUrlSchema` = `z.url({ protocol: /^https?$/ })` in
   both create and update schemas — covers the API, the form and CSV
   import at once. `javascript:`, `data:`, `vbscript:`, `file:` → 400.
2. **Rendering**: the drawer independently checks the protocol before
   making an anchor; non-http(s) values render as inert text. This
   protects rows written _before_ the schema fix.
3. **Regression tests** at every entry point: schema (create+update),
   HTTP POST/PATCH, atomic CSV import (bad URL rejects the whole file),
   and drawer rendering of legacy malicious rows.

### F2 — MEDIUM: scrypt cost below current baseline

N=2^14 (16384) was the 2017-era interactive-login baseline; the OWASP
Password Storage Cheat Sheet now specifies N=2^17 (131072), r=8, p=1.
Measured here: ~43ms → ~355ms per hash — an 8× offline-cracking cost
increase for a login latency users never notice. The hash format
already carries its parameters, so **existing hashes keep verifying**;
new registrations and password changes use the raised cost. `maxmem`
raised to 256 MiB to fit 128·N·r.

Also hardened `verifyPassword` to **fail closed on tampered rows**: an
empty `hashHex` previously derived a zero-length key that compared
equal to anything; absurd cost parameters threw instead of returning
false. Key length, salt length, and parameter bounds are now validated
before any derivation.

### F3 — MEDIUM (dev-only): vulnerable test toolchain

`npm audit` flagged tinypool ≤2.1.1 (critical, prototype-pollution →
RCE in worker options) and @vitest/mocker (path traversal / mock
injection) inside vitest 3.x, plus a minimatch DoS. None of it ships
(the Docker image installs `--omit=dev`, and CI gates on
`npm audit --omit=dev --audit-level=high`), but a compromised test
runner executes with developer credentials and CI secrets. Upgraded
vitest 3.2.7 → 5.1.0 in both workspaces; all 285 tests pass unchanged.
`npm audit` (including dev): **0 vulnerabilities**.

## Verified sound (no change needed)

- **SQL**: every value is a bound parameter. The two dynamic-SQL sites
  build column lists from a frozen `FIELD_TO_COLUMN` map, never from
  input; LIKE metacharacters are escaped with a declared ESCAPE.
  Live probes (`' OR 1=1 --`, `'; DROP TABLE…`) returned 0 rows / 400;
  tables intact.
- **Isolation**: `user_id = ?` is the first, non-optional clause of
  every query; foreign ids read as 404 (no existence oracle). Export,
  import, reminders, analytics, archive all route through the same
  `UserScope`.
- **Sessions**: 32 random bytes, only SHA-256 at rest; HttpOnly +
  SameSite=Lax + Secure-on-HTTPS cookie; absolute 7-day TTL; logout
  deletes server-side; expired rows swept opportunistically; unknown
  emails burn a dummy scrypt hash (no enumeration timing oracle).
- **CSRF**: mutations must be JSON (forces preflight, never granted) +
  Origin check + SameSite=Lax; Host allowlist available for DNS-rebind
  defense (off in dynamic-hostname previews by design, on in prod via
  `TRUSTED_HOSTS`).
- **XSS elsewhere**: React escaping everywhere; the markdown renderer
  builds elements (no `dangerouslySetInnerHTML`) and defuses non-http
  links; CSV export quote-prefixes formula cells (reversibly).
- **Traversal**: `/assets/../../server/data/offerflow.db` and encoded
  variants serve the SPA fallback, never files outside `client/dist`.
- **Prototype pollution**: `__proto__`/`constructor` keys in JSON
  bodies are dropped by zod parsing; nothing merges raw input.
- **Abuse**: per-IP mutation limiter (120/min) before body parsing,
  tighter credential budget (20/min), bounded bucket map, body cap
  256 KiB, import cap 1000 rows, request-id charset/length clamp,
  metrics labels from a closed set (no cardinality spray).
- **Errors**: unknown errors log a stack server-side and return a
  generic 500 — no internals leaked.
- **Secrets**: no credentials in the repo or history surface; `.env*`
  ignored (examples only); DB files ignored; Docker runs as `USER
node` with a dedicated volume.

## Residual risks (accepted, documented)

- **No CSP / frame-ancestors**: the Arena preview embeds the app in an
  iframe; a strict CSP would break it. In a real deployment add
  `Content-Security-Policy: default-src 'self'; …` and frame-ancestors.
- **`/api/metrics` is unauthenticated**: exposes aggregate counters
  only (no user data). Set `METRICS_ENABLED=false` or firewall it when
  exposing the app publicly.
- **In-memory rate limiting** resets on restart and is per-process;
  the documented multi-instance upgrade path is a shared store.
- **Demo account is shared and public by design** — its data is
  resettable by anyone; never put real data in it.
- **Email enumeration via register** (409 on duplicate) is standard
  UX; login itself is timing-equalized.

## Consequences

- The only exploitable finding (F1) is closed at contract, render, and
  import layers with regression tests; legacy malicious rows render
  inert.
- Password storage meets the current OWASP baseline without
  invalidating existing hashes.
- The full dependency tree, dev included, is advisory-clean.
- Test count: 285 unit (207 server + 78 client) + 16 E2E.
