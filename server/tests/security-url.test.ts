import { describe, it, expect } from 'vitest';
import { createApplicationSchema, updateApplicationSchema } from '@offerflow/shared/schemas';
import { makeTestApp } from './helpers.js';

/**
 * SECURITY REGRESSION (audit 2026-11-05): z.string().url() accepts
 * javascript: and data: schemes. Rendered into <a href> that is stored
 * XSS — plantable via the API or a malicious CSV import. The contract
 * now allows http(s) only; these tests pin it at every entry point.
 */

const XSS_URLS = [
  'javascript:alert(document.domain)',
  'JaVaScRiPt:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
];

describe('url schema: http(s) allowlist', () => {
  for (const url of XSS_URLS) {
    it(`create rejects ${url.slice(0, 30)}`, () => {
      const res = createApplicationSchema.safeParse({ company: 'A', position: 'B', url });
      expect(res.success).toBe(false);
    });
    it(`update rejects ${url.slice(0, 30)}`, () => {
      expect(updateApplicationSchema.safeParse({ url }).success).toBe(false);
    });
  }

  it('still accepts http and https URLs', () => {
    for (const url of ['https://jobs.example.com/a?b=1', 'http://example.com']) {
      expect(createApplicationSchema.safeParse({ company: 'A', position: 'B', url }).success).toBe(
        true,
      );
    }
  });

  it('empty string still normalizes to null', () => {
    const res = createApplicationSchema.parse({ company: 'A', position: 'B', url: '' });
    expect(res.url).toBeNull();
  });
});

describe('url allowlist: HTTP entry points', () => {
  it('POST /applications rejects a javascript: URL with 400', async () => {
    const ctx = makeTestApp();
    const res = await ctx.agent
      .post('/api/applications')
      .send({ company: 'X', position: 'Y', url: 'javascript:alert(1)' });
    expect(res.status).toBe(400);
    expect(res.body.details.some((d: { path: string }) => d.path === 'url')).toBe(true);
  });

  it('PATCH rejects a data: URL with 400', async () => {
    const ctx = makeTestApp();
    const created = await ctx.agent.post('/api/applications').send({ company: 'X', position: 'Y' });
    const res = await ctx.agent
      .patch(`/api/applications/${created.body.id}`)
      .send({ url: 'data:text/html,<script>alert(1)</script>' });
    expect(res.status).toBe(400);
  });

  it('CSV import rejects a javascript: URL atomically', async () => {
    const ctx = makeTestApp();
    const res = await ctx.agent.post('/api/import/csv').send({
      csv: 'company,position,url\nGood,FE,https://ok.example\nEvil,FE,javascript:alert(1)\n',
    });
    expect(res.status).toBe(400);
    expect(res.body.details.some((d: { path: string }) => d.path === 'row 3: url')).toBe(true);
    // Atomic: the good row was NOT written either.
    expect((await ctx.agent.get('/api/applications')).body).toHaveLength(0);
  });

  it('CSV import accepts http(s) URLs and round-trips them', async () => {
    const ctx = makeTestApp();
    const res = await ctx.agent.post('/api/import/csv').send({
      csv: 'company,position,url\nGood,FE,https://ok.example/job\n',
    });
    expect(res.status).toBe(201);
    const list = await ctx.agent.get('/api/applications');
    expect(list.body[0].url).toBe('https://ok.example/job');
  });
});
