#!/usr/bin/env node
/**
 * OfferFlow load benchmark (ADR-0014).
 *
 * Zero-dependency load generator: spawns an isolated production server
 * (temp DB, rate limiters OFF so we measure the app, not the limiter),
 * seeds a realistic dataset via CSV import, then drives concurrent
 * keep-alive HTTP load against six scenarios and reports throughput,
 * latency percentiles and peak server RSS.
 *
 * Usage:  npm run build && npm run bench
 * Tuning: BENCH_PORT, BENCH_CONCURRENCY, BENCH_DURATION_MS, BENCH_DATASET
 *
 * This is a manual/dev tool, NOT a CI gate — shared CI runners are too
 * noisy for stable numbers. It exits non-zero if any scenario sees a 5xx
 * or a connection error, so it doubles as a load smoke test.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENTRY = path.join(ROOT, 'server/dist/index.js');
const PORT = Number(process.env.BENCH_PORT ?? 3210);
const HOST = '127.0.0.1';
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 25);
const DURATION_MS = Number(process.env.BENCH_DURATION_MS ?? 4000);
const DATASET = Number(process.env.BENCH_DATASET ?? 400);

if (!fs.existsSync(SERVER_ENTRY)) {
  console.error('server/dist/index.js not found — run `npm run build` first.');
  process.exit(1);
}

const dbPath = path.join(
  os.tmpdir(),
  `offerflow-bench-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
);

/** One-shot request used for setup (register / import / list). */
function request(method, urlPath, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const r = http.request({ host: HOST, port: PORT, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(timeoutMs = 20000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      const res = await request('GET', '/api/ready');
      if (res.status === 200) return;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error('server did not become ready in time');
}

/** Peak RSS of the server child, sampled from /proc (Linux). */
function makeRssSampler(pid) {
  let peak = 0;
  const read = () => {
    try {
      const m = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/);
      if (m) peak = Math.max(peak, parseInt(m[1], 10) / 1024);
    } catch {
      /* /proc unavailable */
    }
  };
  read();
  const timer = setInterval(read, 150);
  return { stop: () => (clearInterval(timer), read(), peak) };
}

/**
 * Drive `concurrency` keep-alive workers against makeReq() until the
 * deadline; record per-request latency and status. Responses are drained,
 * not buffered — we measure the server, not the client's JSON parsing.
 */
function runScenario(name, makeReq, cookie) {
  return new Promise((resolve) => {
    const agent = new http.Agent({
      keepAlive: true,
      maxSockets: CONCURRENCY,
      keepAliveMsecs: 1000,
    });
    const lat = [];
    let errors = 0;
    let non2xx = 0;
    let total = 0;
    let stopped = 0;
    const start = performance.now();
    const deadline = start + DURATION_MS;

    function finish() {
      agent.destroy();
      const elapsed = (performance.now() - start) / 1000;
      lat.sort((a, b) => a - b);
      const pct = (p) =>
        lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : 0;
      resolve({
        name,
        total,
        rps: total / elapsed,
        p50: pct(0.5),
        p95: pct(0.95),
        p99: pct(0.99),
        max: lat.length ? lat[lat.length - 1] : 0,
        errors,
        non2xx,
      });
    }

    function worker() {
      if (performance.now() >= deadline) {
        stopped++;
        if (stopped === CONCURRENCY) finish();
        return;
      }
      const { method, path: urlPath, body } = makeReq();
      const data = body === undefined ? null : JSON.stringify(body);
      const headers = { Cookie: cookie };
      if (data) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(data);
      }
      const t0 = process.hrtime.bigint();
      const r = http.request(
        { host: HOST, port: PORT, method, path: urlPath, agent, headers },
        (res) => {
          res.resume();
          res.on('end', () => {
            lat.push(Number(process.hrtime.bigint() - t0) / 1e6);
            total++;
            if (res.statusCode >= 500) errors++;
            else if (res.statusCode >= 400) non2xx++;
            worker();
          });
        },
      );
      r.on('error', () => {
        errors++;
        total++;
        worker();
      });
      if (data) r.write(data);
      r.end();
    }

    for (let i = 0; i < CONCURRENCY; i++) worker();
  });
}

function buildCsv(n) {
  const statuses = ['wishlist', 'applied', 'interview', 'offer', 'rejected'];
  const sources = ['linkedin', 'referral', 'job_board', 'company_site', 'recruiter', 'other'];
  const modes = ['remote', 'hybrid', 'onsite'];
  const header =
    'company,position,status,source,priority,location,workMode,salaryMin,salaryMax,currency,url,notes,appliedAt,followUpAt';
  const lines = [header];
  for (let i = 0; i < n; i++) {
    const status = statuses[i % statuses.length];
    const followUp = i % 4 === 0 ? '2026-12-01' : '';
    const applied = status === 'wishlist' ? '' : '2026-10-01';
    lines.push(
      [
        `Company ${i}`,
        `Engineer ${i}`,
        status,
        sources[i % sources.length],
        ['low', 'medium', 'high'][i % 3],
        'Berlin',
        modes[i % modes.length],
        50000 + (i % 50) * 1000,
        70000 + (i % 50) * 1000,
        'EUR',
        `https://example.com/jobs/${i}`,
        `Notes for application ${i} — benchmark dataset.`,
        applied,
        followUp,
      ].join(','),
    );
  }
  return lines.join('\n');
}

async function main() {
  console.log(
    `OfferFlow benchmark — node ${process.version}, ${os.platform()}/${os.arch()}, ${os.cpus().length} CPUs`,
  );
  console.log(
    `concurrency=${CONCURRENCY} duration=${DURATION_MS}ms dataset=${DATASET} port=${PORT}\n`,
  );

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST,
      DB_PATH: dbPath,
      SEED_ON_EMPTY: 'false',
      RATE_LIMIT_MAX: '0',
      READ_RATE_LIMIT_MAX: '0',
      CREDENTIAL_RATE_LIMIT_MAX: '0',
      LOG_LEVEL: 'silent',
      NODE_ENV: 'production',
      TRUST_PROXY_HOPS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverErr = '';
  child.stderr.on('data', (d) => (serverErr += d.toString()));
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) console.error(`server exited early (${code}):\n${serverErr}`);
  });

  const rss = makeRssSampler(child.pid);
  let cookie;
  let ids = [];
  try {
    await waitReady();

    const reg = await request('POST', '/api/auth/register', {
      body: {
        email: 'bench@example.com',
        password: 'benchmark-password-123',
        displayName: 'Bench',
      },
    });
    if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${reg.body}`);
    cookie = reg.headers['set-cookie'][0].split(';')[0];

    const imp = await request('POST', '/api/import/csv', {
      body: { csv: buildCsv(DATASET) },
      cookie,
    });
    if (imp.status !== 201) throw new Error(`import failed: ${imp.status} ${imp.body}`);

    const list = await request('GET', '/api/applications?limit=500', { cookie });
    ids = JSON.parse(list.body).map((a) => a.id);
    if (ids.length === 0) throw new Error('dataset is empty after import');

    // Warm up the JIT and connection pool before measuring.
    await runScenario(
      'warmup',
      () => ({ method: 'GET', path: '/api/applications?limit=100' }),
      cookie,
    );

    const randId = () => ids[Math.floor(Math.random() * ids.length)];
    const scenarios = [
      ['list', () => ({ method: 'GET', path: '/api/applications?limit=100' })],
      ['detail', () => ({ method: 'GET', path: `/api/applications/${randId()}` })],
      ['analytics', () => ({ method: 'GET', path: '/api/analytics/overview' })],
      ['reminders', () => ({ method: 'GET', path: '/api/reminders' })],
      ['export', () => ({ method: 'GET', path: '/api/export/csv' })],
      [
        'mixed (70r/30w)',
        () =>
          Math.random() < 0.7
            ? { method: 'GET', path: '/api/applications?limit=100' }
            : {
                method: 'PATCH',
                path: `/api/applications/${randId()}`,
                body: { notes: 'bench write' },
              },
      ],
    ];

    const results = [];
    for (const [name, makeReq] of scenarios) {
      results.push(await runScenario(name, makeReq, cookie));
    }

    const peakRss = rss.stop();
    const f = (x) => x.toFixed(1);
    console.log(
      '| Scenario | Requests | req/s | p50 ms | p95 ms | p99 ms | max ms | 5xx | non-2xx |',
    );
    console.log('|---|---|---|---|---|---|---|---|---|');
    for (const r of results) {
      console.log(
        `| ${r.name} | ${r.total} | ${f(r.rps)} | ${f(r.p50)} | ${f(r.p95)} | ${f(r.p99)} | ${f(r.max)} | ${r.errors} | ${r.non2xx} |`,
      );
    }
    console.log(`\nPeak server RSS: ${peakRss ? f(peakRss) + ' MB' : 'n/a (/proc unavailable)'}`);
    console.log(
      `Dataset: ${DATASET} applications · concurrency ${CONCURRENCY} · ${DURATION_MS}ms per scenario`,
    );

    const out = {
      timestamp: new Date().toISOString(),
      node: process.version,
      platform: `${os.platform()}/${os.arch()}`,
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model ?? 'unknown',
      concurrency: CONCURRENCY,
      durationMs: DURATION_MS,
      dataset: DATASET,
      peakRssMb: peakRss || null,
      results,
    };
    fs.writeFileSync(path.join(ROOT, 'benchmark-results.json'), JSON.stringify(out, null, 2));
    console.log('\nWrote benchmark-results.json');

    const failed = results.some((r) => r.errors > 0);
    if (failed) {
      console.error('\nFAIL: at least one scenario produced 5xx / connection errors.');
      process.exitCode = 1;
    } else {
      console.log('\nPASS: no 5xx or connection errors under load.');
    }
  } finally {
    rss.stop();
    child.kill('SIGTERM');
    await sleep(300);
    if (child.exitCode === null) child.kill('SIGKILL');
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbPath + suffix);
      } catch {
        /* already gone */
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
