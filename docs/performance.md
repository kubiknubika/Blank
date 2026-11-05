# Performance baseline

Measured with the built-in load benchmark (`npm run bench`), which spawns an
isolated production server, seeds a realistic dataset via CSV import, and
drives concurrent keep-alive HTTP load with a zero-dependency generator.
Rate limiters are disabled during the run so the numbers reflect the
application, not the limiter.

## How to run

```bash
npm run build
npm run bench
```

Tuning knobs (environment variables):

| Variable            | Default | Meaning                                |
| ------------------- | ------- | -------------------------------------- |
| `BENCH_CONCURRENCY` | `25`    | Simultaneous keep-alive connections    |
| `BENCH_DURATION_MS` | `4000`  | Measured duration per scenario         |
| `BENCH_DATASET`     | `400`   | Applications seeded before measuring   |
| `BENCH_PORT`        | `3210`  | Port for the isolated benchmark server |

The script writes `benchmark-results.json` (git-ignored) and exits non-zero
if any scenario produces a `5xx` or a connection error, so it doubles as a
load smoke test. It is a **manual/dev tool, not a CI gate** — shared CI
runners are too noisy for stable throughput numbers.

## Baseline (2026-11-05)

Environment: Node v22.22.3, linux/x64, **2 vCPU** (Intel Xeon @ 2.60 GHz,
shared sandbox), 400 applications, concurrency 25, 4 s per scenario.
These are sandbox numbers on two shared cores — treat them as a relative
regression baseline, not a hardware capacity claim.

| Scenario                       | req/s | p50 ms | p95 ms | p99 ms | max ms | 5xx |
| ------------------------------ | ----- | ------ | ------ | ------ | ------ | --- |
| `list` (100 rows)              | 838   | 27.0   | 45.0   | 63.2   | 370.7  | 0   |
| `detail` (row + events)        | 2561  | 8.6    | 16.1   | 21.2   | 102.2  | 0   |
| `analytics/overview`           | 389   | 60.6   | 78.3   | 120.3  | 153.0  | 0   |
| `reminders`                    | 916   | 25.4   | 38.2   | 54.8   | 339.4  | 0   |
| `export/csv` (400 rows)        | 336   | 68.6   | 103.6  | 206.5  | 931.8  | 0   |
| `mixed` (70% read / 30% write) | 976   | 23.4   | 40.5   | 52.5   | 261.8  | 0   |

**Peak server RSS: ~201 MB** under sustained load.

## Reading the numbers

- **`detail` is the fast path** (~2.5k req/s, p95 16 ms): a single indexed
  row lookup plus a bounded (≤ 200) event read. This is the drawer-open
  hot path and it is cheap.
- **`list` and `reminders`** are indexed scans with pagination; sub-50 ms
  p95 at 100 rows. The partial index on `follow_up_at` serves reminders.
- **`analytics` and `export` are the heavy paths** by design: analytics
  runs several aggregations over the user's rows, export serializes the
  whole table to CSV. Their lower throughput is exactly why round 9 put a
  read budget in front of them — they are the CPU/egress levers.
- **`mixed`** shows writes (PATCH) do not collapse read throughput; the
  WAL + `BEGIN IMMEDIATE` write path coexists with concurrent readers.
- **Zero 5xx across ~24k requests** — the robustness invariant from
  [ADR-0013](adr/0013-adversarial-robustness.md) holds under load, not just
  under fuzzing.

## What would move the needle

The single-process SQLite design is intentionally simple. If a deployment
outgrows it, the levers, in order: more CPU (the app is single-threaded
per request but Node overlaps I/O), a read replica or per-worker DB for
horizontal scale, and caching the analytics aggregate. None are needed at
portfolio scale; the benchmark exists to make that claim measurable.
