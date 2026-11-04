import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import type { LifecycleState } from '../src/observability/readiness.js';

describe('observability: readiness, metrics, cache policy', () => {
  let app: Express;
  let db: ReturnType<typeof createDb>;

  beforeEach(() => {
    db = createDb(':memory:');
    app = createApp({ db });
  });

  it('/api/ready is 200 while serving and flips to 503 draining during shutdown', async () => {
    const ok = await request(app).get('/api/ready');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ status: 'ready' });

    (app.locals.lifecycle as LifecycleState).draining = true;
    const draining = await request(app).get('/api/ready');
    expect(draining.status).toBe(503);
    expect(draining.body).toEqual({ status: 'draining' });

    // Liveness stays green while draining: the process is healthy,
    // it just should not receive NEW traffic.
    expect((await request(app).get('/api/health')).status).toBe(200);
  });

  it('/api/ready is 503 unavailable when the database handle is gone', async () => {
    db.close();
    const res = await request(app).get('/api/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'unavailable' });
  });

  it('/api/metrics serves Prometheus text format with request counters', async () => {
    await request(app).get('/api/applications');
    await request(app).get('/api/applications');
    const res = await request(app).get('/api/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('# TYPE http_requests_total counter');
    expect(res.text).toContain(
      'http_requests_total{method="GET",route="/api/applications",status="200"} 2',
    );
    expect(res.text).toContain('# TYPE http_request_duration_seconds histogram');
    expect(res.text).toContain('http_request_duration_seconds_bucket');
    expect(res.text).toContain('process_uptime_seconds');
    expect(res.text).toContain('offerflow_applications 0');
  });

  it('metric route labels are patterns, not URLs — ids never leak into cardinality', async () => {
    const created = await request(app)
      .post('/api/applications')
      .send({ company: 'Acme', position: 'FE' });
    await request(app).get(`/api/applications/${created.body.id}`);
    await request(app).get('/api/applications/00000000-0000-4000-8000-000000000000');
    const res = await request(app).get('/api/metrics');
    expect(res.text).toContain('route="/api/applications/:id"');
    expect(res.text).not.toContain(created.body.id);
    // One series per (method, route) — not one per URL.
    const countLines = res.text
      .split('\n')
      .filter((l) =>
        l.startsWith(
          'http_request_duration_seconds_count{method="GET",route="/api/applications/:id"',
        ),
      );
    expect(countLines).toHaveLength(1);
    expect(countLines[0].trim().endsWith(' 2')).toBe(true);
  });

  it('unmatched API routes collapse into a single /api/unmatched series', async () => {
    await request(app).get('/api/definitely-not-a-route');
    await request(app).get('/api/another-missing-route');
    const res = await request(app).get('/api/metrics');
    expect(res.text).toContain('route="/api/unmatched"');
    expect(res.text).not.toContain('definitely-not-a-route');
  });

  it('metrics can be disabled by configuration', async () => {
    const off = createApp({ db: createDb(':memory:'), metricsEnabled: false });
    const res = await request(off).get('/api/metrics');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('API responses are Cache-Control: no-store', async () => {
    const res = await request(app).get('/api/applications');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
