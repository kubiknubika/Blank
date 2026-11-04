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
import type { ApplicationService, UserScope } from '../service.js';
import { ForbiddenError } from '../errors.js';
import { parseIfMatch, versionEtag } from './concurrency.js';
import { requireUser } from './auth.js';

/**
 * Thin HTTP layer: parse → delegate → serialize. No business logic,
 * no SQL, no error payloads (middleware owns those).
 *
 * Every data route sits behind requireUser and operates on
 * service.forUser(req.user.id) — ownership is bound at the boundary,
 * so no handler can accidentally serve another user's rows.
 */
export function createApiRouter(service: ApplicationService, db: DatabaseSync): Router {
  const api = Router();

  api.get('/health', (_req, res) => {
    res.json({ status: 'ok', applications: service.count() });
  });

  // Data routes require a session; ops/health above stays public, and
  // unknown paths still fall through to a plain 404 (not 401) so the
  // API's shape isn't gated on auth.
  api.use(['/applications', '/analytics', '/demo', '/reminders'], requireUser);
  const scopeOf = (req: { user?: { id: string } }): UserScope => service.forUser(req.user!.id);

  api.get('/applications', (req, res) => {
    const query = listApplicationsQuerySchema.parse(req.query);
    const { items, total } = scopeOf(req).listPage(query);
    // Plain-array body stays backward compatible; the total travels in a
    // header so clients can paginate without a second request.
    res.setHeader('X-Total-Count', String(total));
    res.json(items);
  });

  api.post('/applications', (req, res) => {
    const input = createApplicationSchema.parse(req.body);
    res.status(201).json(scopeOf(req).create(input));
  });

  api.get('/applications/:id', (req, res) => {
    const app = scopeOf(req).get(req.params.id);
    res.setHeader('ETag', versionEtag(app.version));
    res.json(app);
  });

  api.patch('/applications/:id', (req, res) => {
    const input = updateApplicationSchema.parse(req.body);
    const expectedVersion = parseIfMatch(req.headers['if-match']);
    const app = scopeOf(req).update(req.params.id, input, expectedVersion);
    res.setHeader('ETag', versionEtag(app.version));
    res.json(app);
  });

  api.delete('/applications/:id', (req, res) => {
    scopeOf(req).delete(req.params.id);
    res.status(204).end();
  });

  api.post('/applications/:id/events', (req, res) => {
    const input = createEventSchema.parse(req.body);
    res.status(201).json(scopeOf(req).addEvent(req.params.id, input));
  });

  api.get('/analytics/overview', (req, res) => {
    res.json(buildOverview(db, req.user!.id));
  });

  api.get('/reminders', (req, res) => {
    // Flat list, soonest first; the client buckets into
    // overdue / today / upcoming so "today" follows the USER's timezone,
    // not the server's.
    res.json(scopeOf(req).listReminders());
  });

  api.post('/demo/reset', (req, res) => {
    // Only the shared demo account may reseed. A real account's data is
    // never one CSRF away from being replaced by a demo dataset.
    if (!req.user!.isDemo) {
      throw new ForbiddenError('Demo reset is only available in the demo account');
    }
    const applications = scopeOf(req).resetDemo(seedDatabase);
    res.json({ status: 'reseeded', applications });
  });

  return api;
}
