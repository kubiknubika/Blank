# 0014 — Measurable performance and property-based isolation

Date: 2026-11-05
Status: Accepted

## Context

Rounds 8–13 made the app _correct_ and _robust_ under hostile input. Two
questions remained open, and both are about evidence rather than features:

1. **Is the isolation guarantee true under arbitrary operation orderings,
   not just the named scenarios?** A fixed test suite proves the cases it
   enumerates; an ordering-dependent leak (e.g. a scope captured before a
   user switch) can slip between them.
2. **What does the app actually cost to run?** "It's fast" is not an
   engineering claim. Without a reproducible baseline there is no way to
   detect a performance regression or to reason about capacity.

This round answers both with permanent, dependency-free tooling.

## Decision 1 — property-based owner isolation

`server/tests/isolation-property.test.ts` runs **300 randomized operations
across four authenticated users** on one app, driven by a fixed
`mulberry32` seed (reproducible, never flaky). Each iteration picks a random
actor and a random operation — `get`, `patch`, `delete`, `event`,
`archive`, `restore`, `list`, `search`, `analytics`, `reminders`, `export`
— and a target biased toward the actor's own rows but frequently probing
foreign ones.

The invariants, asserted on every step:

- **No foreign data, ever.** Every list/search/analytics/reminders/export
  payload is scanned for the other users' distinctive company markers
  (`OWN<u>#`); a single occurrence fails the test with the seed, iteration,
  actor and operation that leaked.
- **Foreign ids read as 404, never 403 or 200.** Existence is not leaked,
  and a deleted row is 404 for everyone including its former owner.
- **Own live rows succeed** with the operation's expected status, and the
  test tracks delete/archive/restore state so expectations stay correct.
- **Final board consistency.** After all operations, each user's active
  board equals _exactly_ their own surviving, non-archived rows — no leak
  (extra rows) and no loss (missing rows).

The suite also asserts it exercised both sides of the boundary (>20
foreign probes, >20 own successes), so a degenerate run that never crosses
the boundary cannot pass silently. It complements the deterministic
`isolation.test.ts` (named scenarios) and the round-13 fuzzer (robustness):
this one targets the _security_ invariant under interleaving.

## Decision 2 — a reproducible load benchmark

`scripts/benchmark.mjs` (`npm run bench`) is a **zero-dependency** load
generator. It spawns an isolated production server (temp DB, rate limiters
off so it measures the app, not the limiter), registers a user, seeds a
realistic dataset through the real CSV-import path, warms up, then drives
`BENCH_CONCURRENCY` keep-alive connections against six scenarios for
`BENCH_DURATION_MS` each:

`list`, `detail`, `analytics/overview`, `reminders`, `export/csv`, and
`mixed` (70% reads / 30% PATCH writes).

It reports throughput, p50/p95/p99/max latency, 5xx and non-2xx counts, and
**peak server RSS** sampled from `/proc/<pid>/status`. Results are written
to a git-ignored `benchmark-results.json`; the script exits non-zero on any
5xx or connection error, doubling as a load smoke test. It is deliberately
**not a CI gate** — shared runners are too noisy for stable numbers — but a
manual regression tool and the source of the documented baseline.

The baseline and its interpretation live in
[`docs/performance.md`](../performance.md). Headline on a 2-vCPU shared
sandbox, 400 rows, concurrency 25: `detail` ~2.5k req/s (p95 16 ms), `list`
~840 req/s, `mixed` ~980 req/s, peak RSS ~201 MB, **zero 5xx across ~24k
requests**. The heavy paths (`analytics`, `export`) are slower by design —
which is precisely why round 9 placed a read budget in front of them.

## Consequences

- Isolation is now verified under random interleavings on every push, with
  a reproduction recipe on failure; the deterministic suite still documents
  the named scenarios.
- Performance is a measurable, reproducible property with a committed
  baseline and a one-command tool to re-measure it. A future change that
  regresses throughput or introduces a load-time 5xx is detectable.
- No new runtime or dev dependencies: the generator uses `node:http`, the
  property test reuses the existing seeded-PRNG approach. The lean-client
  and zero-runtime-dependency constraints are preserved.
- The benchmark's absolute numbers are sandbox-relative; the value is the
  reproducible method and the regression signal, not a capacity claim.
