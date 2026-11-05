import { describe, it, expect } from 'vitest';
import { makeTestApp } from './helpers.js';
import { parseImport } from '../src/csv.js';
import { ValidationError } from '../src/errors.js';

/**
 * Seeded adversarial fuzzing (ADR-0013).
 *
 * The earlier audit rounds fixed specific holes; this suite turns the
 * underlying invariant into a CONTINUOUS test: no hostile input — random
 * JSON, malformed CSV, absurd query strings, weaponized path ids — may
 * ever produce a 5xx or a non-structured error. A future change that
 * reintroduces an unmapped throw fails here, on every push, with the seed
 * and iteration needed to reproduce it.
 *
 * Deterministic: a fixed mulberry32 seed makes every run identical, so a
 * failure is reproducible and CI is never flaky. Rate limits are disabled
 * and the quota raised so requests actually reach the parsers/handlers
 * instead of being absorbed by the limiter.
 */

const SEED = 0x0ffe2;

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CHAR_POOL =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' +
  ' \t\n\r\x00\x01\x1f\x7f' +
  '"\'\\,;=<>()[]{}|&$#@!%^*+-/`~' +
  '中文日本語한국어العربيةעברית' +
  '😀🚀💀️‍' +
  '́̈ͅ' +
  'SELECTDROP TABLE-- OR 1=1' +
  '=HYPERLINK+CMD@SUM';

function randString(rng: () => number, maxLen: number): string {
  const len = Math.floor(rng() * (maxLen + 1));
  let out = '';
  for (let i = 0; i < len; i++) out += CHAR_POOL[Math.floor(rng() * CHAR_POOL.length)];
  return out;
}

/** Remove unpaired surrogates so encodeURIComponent never throws URIError. */
function stripLoneSurrogates(s: string): string {
  return s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '');
}

function randValue(rng: () => number, depth: number): unknown {
  const t = Math.floor(rng() * 9);
  switch (t) {
    case 0:
    case 1:
      return randString(rng, 120);
    case 2:
      return Math.floor(rng() * 4e9) - 2e9;
    case 3:
      return rng() * 1e308 * (rng() < 0.5 ? -1 : 1);
    case 4:
      return null;
    case 5:
      return rng() < 0.5;
    case 6:
      return depth > 0
        ? Array.from({ length: Math.floor(rng() * 4) }, () => randValue(rng, depth - 1))
        : [];
    case 7:
      return depth > 0 ? { nested: randValue(rng, depth - 1), '': randString(rng, 20) } : {};
    default:
      return randString(rng, 300);
  }
}

/** Fresh app with limiters off and a high quota so fuzz reaches handlers. */
function fuzzApp() {
  return makeTestApp({
    rateLimit: { max: 0 },
    readRateLimit: { max: 0 },
    limits: { maxApplicationsPerUser: 1_000_000 },
  });
}

/** The core invariant: never a 5xx, and every 4xx is a structured error. */
function assertNoServerError(status: number, body: unknown, ctx: string): void {
  expect(status, `${ctx} → unexpected ${status}`).toBeLessThan(500);
  if (status >= 400) {
    expect(typeof (body as { code?: unknown })?.code, `${ctx} → 4xx without a code`).toBe('string');
  }
}

describe('fuzz: JSON bodies never produce a 5xx', () => {
  it('100 random/malformed bodies → only 2xx/4xx, structured errors', async () => {
    const rng = mulberry32(SEED);
    const ctx = fuzzApp();
    const statuses = new Set<number>();
    for (let i = 0; i < 100; i++) {
      const mode = Math.floor(rng() * 4);
      let res;
      if (mode === 0) {
        // Well-formed-ish application with random field values.
        res = await ctx.agent.post('/api/applications').send({
          company: randValue(rng, 2),
          position: randValue(rng, 2),
          status: randValue(rng, 1),
          notes: randValue(rng, 2),
          salaryMin: randValue(rng, 1),
          url: randValue(rng, 1),
        });
      } else if (mode === 1) {
        // Random object / array / primitive. superagent.send() only accepts
        // objects/strings, so serialize primitives to raw JSON ourselves.
        const v = randValue(rng, 3);
        if (typeof v === 'object' && v !== null) {
          res = await ctx.agent.post('/api/applications').send(v);
        } else {
          res = await ctx.agent
            .post('/api/applications')
            .set('Content-Type', 'application/json')
            .send(JSON.stringify(v));
        }
      } else if (mode === 2) {
        // Raw malformed JSON (non-standard tokens, truncation, deep nesting).
        const raws = [
          '{"company":"X","position":"Y","salaryMin":NaN}',
          '{"company":"X","position":"Y","salaryMin":1e999}',
          '{"company":"X","position":"Y",}',
          '{"company":"X"',
          '['.repeat(2000) + ']'.repeat(2000),
          '{"company":"X","position":"Y","x":' + '{"a":'.repeat(500) + '1' + '}'.repeat(500) + '}',
          '{"__proto__":{"polluted":true},"company":"X","position":"Y"}',
          '{"company":"X","position":"Y","company":"Z"}',
        ];
        res = await ctx.agent
          .post('/api/applications')
          .set('Content-Type', 'application/json')
          .send(raws[Math.floor(rng() * raws.length)]);
      } else {
        // Oversized body → 413, never 500.
        res = await ctx.agent
          .post('/api/applications')
          .send({ company: 'X', position: 'Y', notes: randString(rng, 200).repeat(2000) });
      }
      assertNoServerError(res.status, res.body, `JSON seed=${SEED} iter=${i} mode=${mode}`);
      statuses.add(res.status);
    }
    // Prove the fuzzer reached both happy and error paths, not just one.
    expect(statuses.has(201), 'fuzz never created a row').toBe(true);
    expect(
      [...statuses].some((s) => s >= 400),
      'fuzz never hit an error path',
    ).toBe(true);
  });
});

describe('fuzz: CSV import never produces a 5xx or a non-ValidationError throw', () => {
  it('60 random CSVs → only 2xx/4xx; parseImport throws only ValidationError', async () => {
    const rng = mulberry32(SEED ^ 0xc5c);
    const ctx = fuzzApp();
    const statuses = new Set<number>();
    const columns = [
      'company',
      'position',
      'status',
      'source',
      'priority',
      'location',
      'workMode',
      'salaryMin',
      'salaryMax',
      'currency',
      'url',
      'notes',
      'appliedAt',
      'followUpAt',
      'archivedAt',
    ];
    for (let i = 0; i < 60; i++) {
      // Random header: subset, sometimes duplicated / unknown / empty.
      const headerLen = 1 + Math.floor(rng() * 6);
      const header: string[] = [];
      for (let h = 0; h < headerLen; h++) {
        const pick = rng();
        header.push(
          pick < 0.7
            ? columns[Math.floor(rng() * columns.length)]
            : pick < 0.85
              ? randString(rng, 12)
              : '',
        );
      }
      const rowCount = rng() < 0.1 ? 1001 : Math.floor(rng() * 12);
      const lines = [header.join(',')];
      for (let r = 0; r < rowCount; r++) {
        const cells: string[] = [];
        for (let c = 0; c < headerLen; c++) {
          let cell = randString(rng, 40);
          // Randomly quote / embed delimiters to stress the RFC 4180 parser.
          if (rng() < 0.3) cell = '"' + cell.replace(/"/g, '""') + '"';
          if (rng() < 0.1) cell += '"'; // stray quote → maybe unterminated
          cells.push(cell);
        }
        lines.push(cells.join(','));
      }
      let csv = lines.join(rng() < 0.5 ? '\n' : '\r\n');
      if (rng() < 0.2) csv = '' + csv; // BOM
      if (rng() < 0.1) csv = csv.slice(0, Math.floor(csv.length / 2)); // truncate

      const res = await ctx.agent.post('/api/import/csv').send({ csv });
      assertNoServerError(res.status, res.body, `CSV seed=${SEED} iter=${i}`);
      statuses.add(res.status);

      // The codec itself must only ever throw ValidationError.
      try {
        const rows = parseImport(csv);
        expect(Array.isArray(rows)).toBe(true);
      } catch (err) {
        expect(err, `CSV iter=${i} threw ${String(err)}`).toBeInstanceOf(ValidationError);
      }
    }
    expect(
      [...statuses].some((s) => s >= 400),
      'CSV fuzz never hit an error path',
    ).toBe(true);
  });
});

describe('fuzz: query strings never produce a 5xx', () => {
  it('100 random query strings → only 2xx/4xx', async () => {
    const rng = mulberry32(SEED ^ 0x9e37);
    const ctx = fuzzApp();
    const statuses = new Set<number>();
    const keys = [
      'limit',
      'offset',
      'status',
      'q',
      'archived',
      'source',
      'priority',
      'workMode',
      'bogus',
    ];
    const values = [
      '-1',
      '0',
      '999999999999',
      '1e309',
      'NaN',
      'abc',
      "'; DROP TABLE applications;--",
      '%00',
      '../..',
      'true',
      'null',
      'undefined',
      '[]',
      '{}',
      '中文',
      '😀',
      'a'.repeat(300),
    ];
    for (let i = 0; i < 100; i++) {
      const params = new URLSearchParams();
      const n = Math.floor(rng() * 5);
      for (let p = 0; p < n; p++) {
        const k = keys[Math.floor(rng() * keys.length)];
        const v = rng() < 0.5 ? values[Math.floor(rng() * values.length)] : randString(rng, 60);
        params.append(k, v);
      }
      const res = await ctx.agent.get(`/api/applications?${params.toString()}`);
      assertNoServerError(
        res.status,
        res.body,
        `QUERY seed=${SEED} iter=${i} qs=${params.toString()}`,
      );
      statuses.add(res.status);
    }
    expect(statuses.has(200), 'query fuzz never succeeded').toBe(true);
    expect(
      [...statuses].some((s) => s >= 400),
      'query fuzz never hit an error path',
    ).toBe(true);
  });
});

describe('fuzz: path ids never produce a 5xx', () => {
  it('60 weaponized ids across GET/PATCH/DELETE → only 2xx/4xx', async () => {
    const rng = mulberry32(SEED ^ 0x1d);
    const ctx = fuzzApp();
    const created = await ctx.agent.post('/api/applications').send({ company: 'X', position: 'Y' });
    const realId = created.body.id as string;
    const statuses = new Set<number>();
    for (let i = 0; i < 60; i++) {
      const id = rng() < 0.2 ? realId : randString(rng, 80) || '../../etc/passwd';
      const enc = encodeURIComponent(stripLoneSurrogates(id));
      const method = Math.floor(rng() * 3);
      let res;
      if (method === 0) res = await ctx.agent.get(`/api/applications/${enc}`);
      else if (method === 1)
        res = await ctx.agent
          .patch(`/api/applications/${enc}`)
          .send({ notes: randString(rng, 40) });
      else res = await ctx.agent.delete(`/api/applications/${enc}`);
      assertNoServerError(res.status, res.body, `PATH seed=${SEED} iter=${i} method=${method}`);
      statuses.add(res.status);
    }
    expect(
      [...statuses].some((s) => s >= 400),
      'path fuzz never hit an error path',
    ).toBe(true);
  });
});

describe('fuzz: registration validation never produces a 5xx', () => {
  it('random invalid emails are rejected fast (no hashing, no 5xx)', async () => {
    const rng = mulberry32(SEED ^ 0xa1);
    const ctx = fuzzApp();
    for (let i = 0; i < 12; i++) {
      const res = await ctx.agent.post('/api/auth/register').send({
        email: randString(rng, 60), // overwhelmingly invalid → zod 400 before scrypt
        password: randString(rng, 20),
      });
      assertNoServerError(res.status, res.body, `AUTH seed=${SEED} iter=${i}`);
      expect(res.status).toBeLessThan(500);
    }
  });
});
