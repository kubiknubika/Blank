import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import { createDb } from '../src/db.js';
import { createApp } from '../src/app.js';

/**
 * Express 5 changed string-route syntax: bare '*' / '/*' now throw
 * "Missing parameter name" (path-to-regexp v8). Our SPA fallback uses a
 * RegExp literal, which Express 5 still supports — these tests pin that
 * behavior so a future "cleanup" to '/*splat'-style routes is a conscious,
 * tested change rather than a production 500.
 */
describe('SPA fallback (Express 5 route syntax regression)', () => {
  let dir: string;
  let app: Express;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'offerflow-spa-'));
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>OfferFlow SPA</title>');
    app = createApp({ db: createDb(':memory:'), clientDist: dir });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves index.html at /', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('OfferFlow SPA');
  });

  it('serves index.html for deep client-side routes', async () => {
    const res = await request(app).get('/board/some/deep/route');
    expect(res.status).toBe(200);
    expect(res.text).toContain('OfferFlow SPA');
  });

  it('does NOT swallow unknown API routes into the SPA', async () => {
    const res = await request(app).get('/api/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});
