# 0013 — Adversarial robustness: continuous fuzzing and connection hygiene

Date: 2026-11-05
Status: Accepted

## Scope

Third hardening pass, after [ADR-0011](0011-security-audit.md) (injection)
and [ADR-0012](0012-second-pass-hardening.md) (resource ceilings). Those
rounds fixed specific holes; this one asks two further questions:

1. **Is the "no hostile input ever yields a 5xx" property actually true
   across the whole input surface — and will it stay true?** Point fixes
   regress. The answer is a permanent, seeded fuzz suite that re-verifies
   the invariant on every push.
2. **What happens below the application layer?** Connection lifecycles,
   slow-header floods, and the rate limiter's own memory under a spray of
   fresh source addresses are DoS surfaces the request-handler audit
   never touched.

## Findings fixed in this round

### F1 — MEDIUM: the rate limiter's IP cap was soft

`MAX_TRACKED_IPS = 10_000` existed, but exceeding it only triggered a
sweep of **expired** buckets. A spray of _fresh_ IPs inside one window
(IPv6 makes source addresses effectively unlimited) leaves every bucket
live, so the sweep frees nothing: the map grows without bound, and — worse
— the over-cap condition made the O(n) sweep run on **every subsequent
request**, turning the limiter itself into a CPU amplifier.

Fix: a **hard cap with FIFO eviction**. When a genuinely new key arrives
and the map is full, the oldest-inserted bucket is deleted to make room
(`Map` preserves insertion order). Memory is now bounded at
`MAX_TRACKED_IPS` entries unconditionally, and the sweep is purely
time-based again (once per window). An evicted IP receives a fresh budget
— the standard bounded-memory tradeoff, strictly better than OOM. Pinned
by a direct-middleware test that sprays `MAX_TRACKED_IPS + 50` distinct
IPs and asserts the earliest were evicted while the newest stay blocked.

### F2 — MEDIUM: no explicit connection timeouts (slowloris)

Node's defaults hold a socket open for 60 s of header trickling and 300 s
for a full request. A slow-header flood pins file descriptors and worker
attention cheaply. Fix: `server.headersTimeout = 10 s`,
`server.requestTimeout = 30 s`, both configurable
(`HTTP_HEADERS_TIMEOUT_MS`, `HTTP_REQUEST_TIMEOUT_MS`). The config schema
cross-validates `headers < request` and fails fast on a misconfigured
pair instead of silently letting the request timeout shadow the header
bound. 30 s is generous for the 256 KiB body ceiling on any real link.

### F3 — LOW: shutdown lingered on idle keep-alive connections

`server.close()` stops _new_ connections but waits for idle keep-alive
ones to drain on their own (up to `keepAliveTimeout` each), and the
forced-exit path called `process.exit(1)` without severing sockets. Fix:
`server.closeIdleConnections()` immediately after `close()` (in-flight
requests on _active_ connections still finish), and
`server.closeAllConnections()` on the forced-timeout path so the process
can actually exit instead of lingering on a stuck client.

## The headline: a permanent adversarial fuzz suite

`server/tests/fuzz.test.ts` drives **332 hostile requests per run** through
the real Express stack (Supertest, in-memory SQLite), with limiters off
and the quota raised so inputs reach the parsers and handlers rather than
being absorbed by the limiter:

- **JSON bodies (100):** random field values (unicode, control chars,
  huge floats, nested objects), random objects/arrays/primitives, raw
  malformed JSON (`NaN`, `1e999`, trailing commas, truncation, 2000-level
  nesting, `__proto__`, duplicate keys), and oversized payloads.
- **CSV imports (60):** random headers (duplicated/unknown/empty columns),
  random cells with embedded quotes/newlines/delimiters, stray quotes,
  BOM, CRLF/LF mixing, truncation, and the 1001-row cap. Each file is also
  fed to `parseImport` directly.
- **Query strings (100):** negative/huge/non-numeric limits and offsets,
  SQL fragments, null bytes, traversal, unicode, repeated keys.
- **Path ids (60):** weaponized ids across GET/PATCH/DELETE — traversal,
  SQL, unicode, control chars, overlong strings.
- **Registration (12):** random invalid emails (rejected by zod before
  any scrypt work, so the suite stays fast).

**The invariant, asserted on every response:** status < 500, and every
4xx carries a structured `code` (never a raw stack or HTML). The codec
additionally must throw _only_ `ValidationError`. Each category also
asserts it reached both success and error paths, so a fuzzer that
degenerates into "everything 429" cannot pass silently.

Deterministic by construction: a fixed `mulberry32` seed makes every run
identical — no CI flakiness — and any failure message carries the seed and
iteration needed to reproduce it. The suite adds ~2.5 s to `npm test` and
runs on both Node matrix legs. It found no new 5xx (the round-8/9 fixes
hold); its value is that a _future_ unmapped throw now fails CI on the
push that introduces it, with a reproduction recipe attached.

## Examined and judged safe (no change)

- **Deep JSON nesting:** V8 parses 100k levels without throwing, and
  body-parser normalizes any parse failure to a 400 — confirmed live.
- **Query bounds:** `limit` is `int().min(1).max(500)`, `offset ≥ 0`; a
  huge offset is bounded by the per-account quota (≤ 5000 rows to skip).
- **CSV parser:** a single O(n) pass, no nested unbounded loops;
  unterminated quotes reject the file.
- **Markdown rendering:** builds React elements; no `dangerouslySetInnerHTML`
  or `innerHTML` anywhere in application code.

## Evaluated and deferred: Trusted Types

`require-trusted-types-for 'script'` would block string-to-DOM sinks
outright. The built bundle, however, contains five `innerHTML` references
inside React DOM itself; enabling the directive without a Trusted Types
policy shim risks breaking rendering, and the marginal gain over the
existing `script-src 'self'` CSP (which already blocks injected inline
scripts) does not justify shipping a browser-breaking change that cannot
be verified outside CI. Revisit if the app ever adopts a TT policy or
moves to a renderer with no internal sinks.

## Verification

- New tests: 5 fuzz categories (332 requests), 2 rate-limiter hard-cap
  tests, 1 config cross-validation test. Full suite: 235 server + 78
  client unit tests, 16 E2E (CI).
- Live re-probe of the running build: connection timeouts applied,
  graceful shutdown drops idle connections, limiter behavior unchanged
  for normal traffic.
