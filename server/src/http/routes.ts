import { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import {
  createApplicationSchema,
  createEventSchema,
  listApplicationsQuerySchema,
  updateApplicationSchema,
} from '@offerflow/shared/schemas';
import { buildOverview } from '../analytics.js';
import { seedDatabase } from '../seed.js';
import type { ApplicationService } from '../service.js';
import { parseIfMatch, versionEtag } from './concurrency.js';

/**
 * Thin HTTP layer: parse → delegate → serialize. No business logic,
 * no SQL, no error payloads (middleware owns those).
 */
export function createApiRouter(service: ApplicationService, db: DatabaseSync): Router {
  const api = Router();

  api.get('/health', (_req, res) => {
    res.json({ status: 'ok', applications: service.count() });
  });

  api.get('/applications', (req, res) => {
    const query = listApplicationsQuerySchema.parse(req.query);
    const { items, total } = service.listPage(query);
    // Plain-array body stays backward compatible; the total travels in a
    // header so clients can paginate without a second request.
    res.setHeader('X-Total-Count', String(total));
    res.json(items);
  });

  api.post('/applications', (req, res) => {
    const input = createApplicationSchema.parse(req.body);
    res.status(201).json(service.create(input));
  });

  api.get('/applications/:id', (req, res) => {
    const app = service.get(req.params.id);
    res.setHeader('ETag', versionEtag(app.version));
    res.json(app);
  });

  api.patch('/applications/:id', (req, res) => {
    const input = updateApplicationSchema.parse(req.body);
    const expectedVersion = parseIfMatch(req.headers['if-match']);
    const app = service.update(req.params.id, input, expectedVersion);
    res.setHeader('ETag', versionEtag(app.version));
    res.json(app);
  });

  api.delete('/applications/:id', (req, res) => {
    service.delete(req.params.id);
    res.status(204).end();
  });

  api.post('/applications/:id/events', (req, res) => {
    const input = createEventSchema.parse(req.body);
    res.status(201).json(service.addEvent(req.params.id, input));
  });

  api.get('/analytics/overview', (_req, res) => {
    res.json(buildOverview(db));
  });

  api.post('/demo/reset', (_req, res) => {
    const applications = service.resetDemo(seedDatabase);
    res.json({ status: 'reseeded', applications });
  });

  return api;
}
