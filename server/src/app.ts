import express, { type NextFunction, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApplicationRepository } from './repository.js';
import { buildOverview } from './analytics.js';
import {
  createApplicationSchema,
  createEventSchema,
  listQuerySchema,
  updateApplicationSchema,
} from './validation.js';
import { seedDatabase } from './seed.js';

export function createApp(db: DatabaseSync) {
  const app = express();
  const repo = new ApplicationRepository(db);

  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  const api = express.Router();

  api.get('/health', (_req, res) => {
    res.json({ status: 'ok', applications: repo.count() });
  });

  api.get('/applications', (req, res) => {
    const query = listQuerySchema.parse(req.query);
    res.json(repo.list(query));
  });

  api.post('/applications', (req, res) => {
    const input = createApplicationSchema.parse(req.body);
    res.status(201).json(repo.create(input));
  });

  api.get('/applications/:id', (req, res) => {
    const app = repo.getById(req.params.id);
    if (!app) {
      res.status(404).json({ error: 'Application not found' });
      return;
    }
    res.json(app);
  });

  api.patch('/applications/:id', (req, res) => {
    const input = updateApplicationSchema.parse(req.body);
    const updated = repo.update(req.params.id, input);
    if (!updated) {
      res.status(404).json({ error: 'Application not found' });
      return;
    }
    res.json(updated);
  });

  api.delete('/applications/:id', (req, res) => {
    const deleted = repo.delete(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Application not found' });
      return;
    }
    res.status(204).end();
  });

  api.post('/applications/:id/events', (req, res) => {
    const input = createEventSchema.parse(req.body);
    const event = repo.createUserEvent(req.params.id, input);
    if (!event) {
      res.status(404).json({ error: 'Application not found' });
      return;
    }
    res.status(201).json(event);
  });

  api.get('/analytics/overview', (_req, res) => {
    res.json(buildOverview(db));
  });

  api.post('/demo/reset', (_req, res) => {
    db.exec('DELETE FROM events; DELETE FROM applications;');
    seedDatabase(repo);
    res.json({ status: 'reseeded', applications: repo.count() });
  });

  app.use('/api', api);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Serve the built client in production (single-container deployment).
  const clientDist = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../client/dist',
  );
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({
        error: 'Validation failed',
        details: err.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
      });
      return;
    }
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: 'Invalid JSON body' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
