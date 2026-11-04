import express from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { ApplicationService } from './service.js';
import { createApiRouter } from './http/routes.js';
import { accessLog, errorHandler, requestContext } from './http/middleware.js';
import { securityChecks, securityHeaders, type SecurityOptions } from './http/security.js';
import { silentLogger, type Logger } from './logger.js';

export interface AppDeps {
  db: DatabaseSync;
  logger?: Logger;
  now?: () => Date;
  /** Directory with the built SPA; omitted in API-only tests. */
  clientDist?: string;
  security?: Partial<SecurityOptions>;
}

/**
 * Composition root for the Express app. Dependencies are injected,
 * which is what makes the whole stack testable without network or disk.
 */
export function createApp({ db, logger = silentLogger, now, clientDist, security }: AppDeps) {
  const app = express();
  const service = new ApplicationService(db, now);

  app.disable('x-powered-by');
  app.use(requestContext(logger));
  app.use(securityHeaders);
  app.use(
    securityChecks({
      trustedOrigins: security?.trustedOrigins ?? [],
      trustedHosts: security?.trustedHosts ?? [],
      isDevelopment: security?.isDevelopment ?? true,
    }),
  );
  app.use(express.json({ limit: '256kb' }));

  const api = createApiRouter(service, db);
  // Access logging only for API traffic; static assets would be noise.
  app.use('/api', accessLog, api);
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
  });

  // Static serving is opt-in: only the composition root (index.ts) passes a
  // directory. Tests get a pure API app with no filesystem coupling.
  if (clientDist && existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile('index.html', { root: clientDist });
    });
  }

  app.use(errorHandler(logger));
  return app;
}
