import express, { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ApplicationService } from './service.js';
import { createApiRouter } from './http/routes.js';
import { accessLog, errorHandler, requestContext } from './http/middleware.js';
import { securityChecks, securityHeaders, type SecurityOptions } from './http/security.js';
import { rateLimit, type RateLimitOptions } from './http/rateLimit.js';
import { buildOpenApiDocument } from './http/openapi.js';
import { MetricsRegistry } from './observability/metrics.js';
import {
  checkReadiness,
  createLifecycleState,
  type LifecycleState,
} from './observability/readiness.js';
import { silentLogger, type Logger } from './logger.js';

export interface AppDeps {
  db: DatabaseSync;
  logger?: Logger;
  now?: () => Date;
  /** Directory with the built SPA; omitted in API-only tests. */
  clientDist?: string;
  security?: Partial<SecurityOptions>;
  /** Per-IP mutation budget. Defaults: 120 requests / 60s; max 0 disables. */
  rateLimit?: Partial<RateLimitOptions>;
  metricsEnabled?: boolean;
  /** Number of reverse-proxy hops to trust for X-Forwarded-For (0 = none). */
  trustProxyHops?: number;
}

// Route labels must come from a closed set: anything else collapses to
// OTHER so hostile method spray cannot inflate metric cardinality.
const KNOWN_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

let cachedOpenApi: Record<string, unknown> | undefined;
function openApiDocument(): Record<string, unknown> {
  cachedOpenApi ??= buildOpenApiDocument();
  return cachedOpenApi;
}

/**
 * Composition root for the Express app. Dependencies are injected,
 * which is what makes the whole stack testable without network or disk.
 */
export function createApp({
  db,
  logger = silentLogger,
  now,
  clientDist,
  security,
  rateLimit: rateLimitOpts,
  metricsEnabled = true,
  trustProxyHops = 0,
}: AppDeps) {
  const app = express();
  const service = new ApplicationService(db, now);
  const metrics = new MetricsRegistry();
  const lifecycle = createLifecycleState();
  // Exposed for the process entry point (drain flag) and for tests.
  app.locals.metrics = metrics;
  app.locals.lifecycle = lifecycle;

  if (trustProxyHops > 0) app.set('trust proxy', trustProxyHops);
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

  metrics.addCollector(() => {
    let count = -1;
    try {
      count = service.count();
    } catch {
      // DB closed during shutdown — report -1 rather than crash the scrape.
    }
    return [
      '# HELP offerflow_applications Current number of tracked applications.',
      '# TYPE offerflow_applications gauge',
      `offerflow_applications ${count}`,
    ].join('\n');
  });

  // --- /api plumbing: cache policy, metrics, access log -----------------
  app.use('/api', (req, res, next) => {
    // API responses are per-request state; never cache them anywhere.
    res.setHeader('Cache-Control', 'no-store');
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      const method = KNOWN_METHODS.has(req.method) ? req.method : 'OTHER';
      // Pattern, not URL: "/api/applications/:id", never the raw id.
      // The /api prefix is hard-coded because Express restores baseUrl
      // when the stack unwinds on the error path — req.baseUrl at
      // 'finish' time is '' for failed requests but '/api' for happy ones.
      const route = req.route ? `/api${req.route.path as string}` : '/api/unmatched';
      metrics.incRequest(method, route, res.statusCode);
      metrics.observeDuration(method, route, seconds);
    });
    next();
  });
  app.use('/api', accessLog);

  // --- operational GET endpoints (never rate-limited) --------------------
  const ops = Router();
  ops.get('/ready', (_req, res) => {
    const result = checkReadiness(db, lifecycle);
    res.status(result.ready ? 200 : 503).json({ status: result.status });
  });
  ops.get('/metrics', (_req, res) => {
    if (!metricsEnabled) {
      res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
      return;
    }
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(metrics.render());
  });
  ops.get('/openapi.json', (_req, res) => {
    res.json(openApiDocument());
  });
  app.use('/api', ops);

  // --- mutation rate limit BEFORE body parsing: a flood of 429s should
  // not cost a JSON parse each. Reads and probes are unaffected.
  const limiter = rateLimit({
    windowMs: rateLimitOpts?.windowMs ?? 60_000,
    max: rateLimitOpts?.max ?? 120,
    now: rateLimitOpts?.now,
  });
  app.use('/api', (req, res, next) => {
    if (MUTATING_METHODS.has(req.method)) return limiter(req, res, next);
    next();
  });

  app.use(express.json({ limit: '256kb' }));

  const api = createApiRouter(service, db);
  app.use('/api', api);
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
  });

  // Static serving is opt-in: only the composition root (index.ts) passes a
  // directory. Tests get a pure API app with no filesystem coupling.
  if (clientDist && existsSync(clientDist)) {
    app.use(
      express.static(clientDist, {
        setHeaders: (res, filePath) => {
          // Vite emits content-hashed filenames under assets/ — those are
          // safe to cache forever. Everything else must revalidate.
          const isHashedAsset = filePath.includes(`${path.sep}assets${path.sep}`);
          res.setHeader(
            'Cache-Control',
            isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
          );
        },
      }),
    );
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile('index.html', { root: clientDist });
    });
  }

  app.use(errorHandler(logger));
  return app;
}

export type { LifecycleState };
