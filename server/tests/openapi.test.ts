import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createApiRouter } from '../src/http/routes.js';
import { ApplicationService } from '../src/service.js';
import {
  createApplicationSchema,
  createEventSchema,
  updateApplicationSchema,
} from '@offerflow/shared/schemas';
import type { z } from 'zod';

// The document is deeply nested JSON; index it loosely but explicitly.
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- JSON traversal in assertions

/**
 * Contract drift protection. The OpenAPI document is only worth anything
 * if it matches reality, so these tests pin it against BOTH sides:
 *  - the Express router (every real route is documented, no phantoms),
 *  - live API responses (every documented field actually exists).
 */
describe('OpenAPI contract', () => {
  let app: Express;
  let doc: Json;

  beforeAll(async () => {
    const db = createDb(':memory:');
    app = createApp({ db });
    const res = await request(app).get('/api/openapi.json');
    expect(res.status).toBe(200);
    doc = res.body;
  });

  it('serves a 3.1 document with info and components', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('OfferFlow API');
    expect(doc.components.schemas.Application).toBeTruthy();
  });

  it('documents every route registered on the API router — and nothing phantom', () => {
    const db = createDb(':memory:');
    const router = createApiRouter(new ApplicationService(db), db);
    const realRoutes = new Set<string>();
    for (const layer of (
      router as unknown as {
        stack: { route?: { path: string; methods: Record<string, boolean> } }[];
      }
    ).stack) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) {
        // Express ':id' → OpenAPI '{id}'
        realRoutes.add(`${method} /api${layer.route.path.replace(/:([^/]+)/g, '{$1}')}`);
      }
    }
    const documented = new Set<string>();
    for (const [path, operations] of Object.entries<Record<string, unknown>>(doc.paths)) {
      for (const method of Object.keys(operations)) {
        documented.add(`${method} ${path}`);
      }
    }
    for (const route of realRoutes) {
      expect(documented.has(route), `route ${route} is missing from openapi.json`).toBe(true);
    }
    // Operational endpoints live outside the router but must be documented too.
    for (const ops of ['get /api/ready', 'get /api/metrics', 'get /api/openapi.json']) {
      expect(documented.has(ops)).toBe(true);
    }
    // No documented path without a real handler.
    for (const entry of documented) {
      const known =
        realRoutes.has(entry) ||
        ['get /api/ready', 'get /api/metrics', 'get /api/openapi.json'].includes(entry);
      expect(known, `openapi.json documents phantom route ${entry}`).toBe(true);
    }
  });

  it('request-body schemas expose exactly the zod input fields', () => {
    // zod 4: .refine() keeps the ZodObject (checks attach to it), so the
    // shape is reachable directly — no ZodEffects unwrapping needed.
    const shapeOf = (schema: z.ZodType) =>
      Object.keys(
        (schema as unknown as { _zod: { def: { shape: object } } })._zod.def.shape,
      ).sort();
    expect(Object.keys(doc.components.schemas.CreateApplicationInput.properties).sort()).toEqual(
      shapeOf(createApplicationSchema),
    );
    expect(Object.keys(doc.components.schemas.UpdateApplicationInput.properties).sort()).toEqual(
      shapeOf(updateApplicationSchema),
    );
    expect(Object.keys(doc.components.schemas.CreateEventInput.properties).sort()).toEqual(
      shapeOf(createEventSchema),
    );
    // Only company+position are required on create; PATCH is all-optional.
    expect(doc.components.schemas.CreateApplicationInput.required.sort()).toEqual([
      'company',
      'position',
    ]);
    expect(doc.components.schemas.UpdateApplicationInput.required).toBeUndefined();
  });

  it('Application model matches live create/read responses field-for-field', async () => {
    const created = await request(app)
      .post('/api/applications')
      .send({ company: 'Contract Co', position: 'Engineer' });
    expect(created.status).toBe(201);
    const modelKeys = Object.keys(doc.components.schemas.Application.properties).sort();
    const withEventsKeys = [...modelKeys, 'events'].sort();
    // create returns the row plus its initial event — the contract says so.
    expect(Object.keys(created.body).sort()).toEqual(withEventsKeys);
    expect(created.body.events).toHaveLength(1);

    const fetched = await request(app).get(`/api/applications/${created.body.id}`);
    expect(Object.keys(fetched.body).sort()).toEqual(withEventsKeys);
    expect(doc.components.schemas.Application.required.sort()).toEqual(modelKeys);

    // PATCH also answers with the full ApplicationWithEvents shape.
    const patched = await request(app)
      .patch(`/api/applications/${created.body.id}`)
      .send({ notes: 'x' });
    expect(Object.keys(patched.body).sort()).toEqual(withEventsKeys);
    const patchModel =
      doc.paths['/api/applications/{id}'].patch.responses['200'].content['application/json'].schema;
    expect(patchModel.$ref).toBe('#/components/schemas/ApplicationWithEvents');
  });

  it('AppEvent model matches a live event response', async () => {
    const created = await request(app)
      .post('/api/applications')
      .send({ company: 'Events Co', position: 'Engineer' });
    const event = await request(app)
      .post(`/api/applications/${created.body.id}/events`)
      .send({ type: 'note', message: 'called recruiter' });
    expect(event.status).toBe(201);
    expect(Object.keys(event.body).sort()).toEqual(
      Object.keys(doc.components.schemas.AppEvent.properties).sort(),
    );
  });

  it('AnalyticsOverview model matches the live dashboard payload shape', async () => {
    const res = await request(app).get('/api/analytics/overview');
    const model = doc.components.schemas.AnalyticsOverview;
    expect(Object.keys(res.body).sort()).toEqual(Object.keys(model.properties).sort());
    expect(Object.keys(res.body.totals).sort()).toEqual(
      Object.keys(model.properties.totals.properties).sort(),
    );
  });

  it('ApiError model covers a live 429 and a live validation error', async () => {
    const limited = createApp({ db: createDb(':memory:'), rateLimit: { max: 0 } });
    const bad = await request(limited).post('/api/applications').send({ company: '' });
    expect(bad.status).toBe(400);
    const errorKeys = Object.keys(doc.components.schemas.ApiError.properties);
    for (const key of Object.keys(bad.body)) {
      expect(errorKeys).toContain(key);
    }
    expect(doc.components.schemas.ApiError.properties.code.enum).toContain('RATE_LIMITED');
    expect(doc.components.schemas.ApiError.properties.code.enum).toContain('PRECONDITION_FAILED');
  });

  it('documents ETag/If-Match, Retry-After and X-Total-Count headers', () => {
    const patch = doc.paths['/api/applications/{id}'].patch;
    const hasIfMatch = patch.parameters.some(
      (p: { name: string; in: string }) => p.name === 'If-Match' && p.in === 'header',
    );
    expect(hasIfMatch).toBe(true);
    expect(patch.responses['200'].headers.ETag).toBeTruthy();
    expect(patch.responses['412']).toBeTruthy();
    expect(patch.responses['429'].headers['Retry-After']).toBeTruthy();
    expect(
      doc.paths['/api/applications'].get.responses['200'].headers['X-Total-Count'],
    ).toBeTruthy();
  });
});
