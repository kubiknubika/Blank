import { describe, it, expect } from 'vitest';
import { makeTestApp, addTestUser } from './helpers.js';
import { createApplicationSchema } from '@offerflow/shared/schemas';
import type { Application } from '@offerflow/shared';

/**
 * CSV round-trip property (ADR-0015): for ANY valid board, export → import
 * into a fresh account is lossless. The fuzzer (ADR-0013) proves hostile
 * input never crashes the codec; this proves the CORRECTNESS invariant —
 * every field survives the trip, including the adversarial-but-valid
 * content the escaping exists for: commas, quotes, embedded newlines,
 * formula prefixes, unicode, and archived rows.
 *
 * Deterministic mulberry32 seed -> reproducible. The only field that does
 * not round-trip byte-for-byte is archivedAt: import re-archives at import
 * time, so the property asserts the archived STATE (null vs non-null),
 * which is the semantically meaningful part.
 */

const SEED = 0xc0ffee;

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

const TRICKY = [
  'plain text',
  'A,B "C"',
  "'=SUM(1,2)",
  '+CMD|calc',
  '-negative',
  '@import',
  'line one\nline two\r\nline three',
  'Berlin, DE · 北京',
  'quote\'and"double',
  '\ttab-leading',
  '😀🚀 emoji',
  '',
];
const STATUSES = ['wishlist', 'applied', 'screening', 'interview', 'offer', 'rejected'];
const SOURCES = ['linkedin', 'referral', 'job_board', 'company_site', 'recruiter', 'other'];
const PRIORITIES = ['low', 'medium', 'high'];
const MODES = ['remote', 'hybrid', 'onsite'];
const CURRENCIES = ['EUR', 'USD', 'GBP', 'JPY', 'CHF'];
const DATES = ['2026-01-15', '2026-06-30', '2026-11-05', '2026-12-31', null];

/** Fields that must round-trip byte-for-byte (archivedAt handled separately). */
const EXACT_FIELDS = [
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
] as const;

describe('property: CSV export → import is lossless for any valid board', () => {
  it('50 random rows (incl. archived) round-trip field-for-field into a fresh account', () => {
    const rng = mulberry32(SEED);
    const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];
    const maybe = <T>(v: T): T | null => (rng() < 0.35 ? null : v);

    const ctx = makeTestApp({
      rateLimit: { max: 0 },
      readRateLimit: { max: 0 },
      limits: { maxApplicationsPerUser: 1_000_000 },
    });
    const alice = ctx.scope;
    const bob = addTestUser(ctx).scope; // fresh, empty account

    const N = 50;
    for (let i = 0; i < N; i++) {
      const salaryMin = maybe(Math.floor(rng() * 100000));
      const salaryMax =
        salaryMin === null
          ? maybe(Math.floor(rng() * 150000))
          : salaryMin + Math.floor(rng() * 50000);
      const input = createApplicationSchema.parse({
        company: `Co-${i}-${pick(TRICKY) || 'x'}`, // unique by index; tricky chars exercise escaping
        position: pick(TRICKY) || 'Engineer',
        status: pick(STATUSES),
        source: pick(SOURCES),
        priority: pick(PRIORITIES),
        location: maybe(pick(TRICKY)),
        workMode: pick(MODES),
        salaryMin,
        salaryMax,
        currency: pick(CURRENCIES),
        url: maybe(`https://example.com/jobs/${i}`),
        notes: maybe(pick(TRICKY)),
        appliedAt: pick(DATES),
        followUpAt: pick(DATES),
      });
      const created = alice.create(input);
      if (rng() < 0.3) alice.archive(created.id);
    }

    // The trip under test: export Alice's whole board, import into empty Bob.
    const csv = alice.exportCsv();
    const { imported } = bob.importCsv(csv);
    expect(imported).toBe(N);

    const allRows = (scope: typeof alice): Application[] => [
      ...scope.listPage({ archived: 'false', limit: 500 }).items,
      ...scope.listPage({ archived: 'true', limit: 500 }).items,
    ];
    const aRows = allRows(alice);
    const bRows = allRows(bob);
    expect(bRows.length).toBe(aRows.length);

    const byCompany = new Map(bRows.map((r) => [r.company, r]));
    for (const a of aRows) {
      const b = byCompany.get(a.company);
      expect(b, `row "${a.company}" missing after import`).toBeDefined();
      const bb = b as unknown as Record<string, unknown>;
      const aa = a as unknown as Record<string, unknown>;
      for (const field of EXACT_FIELDS) {
        expect(bb[field], `"${a.company}".${field} changed in round-trip`).toEqual(aa[field]);
      }
      // Archived STATE is preserved (the timestamp itself is re-stamped on import).
      expect(bb.archivedAt !== null, `"${a.company}" archived state changed`).toBe(
        aa.archivedAt !== null,
      );
    }

    // Bob's board is independent: re-exporting him reproduces the same data.
    const csv2 = bob.exportCsv();
    const carol = addTestUser(ctx).scope;
    expect(carol.importCsv(csv2).imported).toBe(N);
    expect(allRows(carol).length).toBe(N);
  });
});
