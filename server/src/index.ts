import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { createApp } from './app.js';
import { createLogger } from './logger.js';
import { ApplicationService } from './service.js';
import { DEMO_USER_ID } from './auth.js';
import { seedDatabase } from './seed.js';

/**
 * Process entry point: config → logger → db → app → graceful shutdown.
 * Everything interesting lives in modules; this file only wires them.
 */
function main(): void {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL, { env: config.NODE_ENV });

  const db = createDb(config.DB_PATH, { busyTimeoutMs: config.DB_BUSY_TIMEOUT_MS });
  const service = new ApplicationService(db);

  const demoScope = service.forUser(DEMO_USER_ID);
  if (config.SEED_ON_EMPTY && demoScope.count() === 0) {
    demoScope.resetDemo(seedDatabase);
    logger.info('seeded demo data', { applications: demoScope.count() });
  }

  const clientDist = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../client/dist',
  );
  const app = createApp({
    db,
    logger,
    clientDist,
    security: {
      trustedOrigins: config.TRUSTED_ORIGINS,
      trustedHosts: config.TRUSTED_HOSTS,
      isDevelopment: config.NODE_ENV !== 'production',
      frameAncestors: config.CSP_FRAME_ANCESTORS || undefined,
    },
    rateLimit: { max: config.RATE_LIMIT_MAX, windowMs: config.RATE_LIMIT_WINDOW_MS },
    readRateLimit: { max: config.READ_RATE_LIMIT_MAX, windowMs: config.RATE_LIMIT_WINDOW_MS },
    metricsEnabled: config.METRICS_ENABLED,
    trustProxyHops: config.TRUST_PROXY_HOPS,
    credentialRateLimit: {
      max: config.CREDENTIAL_RATE_LIMIT_MAX,
      windowMs: config.RATE_LIMIT_WINDOW_MS,
    },
  });
  const server = app.listen(config.PORT, config.HOST, () => {
    logger.info('server listening', {
      host: config.HOST,
      port: config.PORT,
      dbPath: config.DB_PATH,
    });
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });

    // Flip readiness FIRST so load balancers stop routing new traffic
    // while in-flight requests are still allowed to finish.
    (app.locals.lifecycle as { draining: boolean }).draining = true;

    // Stop accepting connections, let in-flight requests finish, then close the DB.
    const timer = setTimeout(() => {
      logger.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, config.SHUTDOWN_TIMEOUT_MS);
    timer.unref();

    server.close((err) => {
      if (err) logger.error('error while closing server', { error: err.message });
      db.close();
      logger.info('shutdown complete');
      clearTimeout(timer);
      process.exit(err ? 1 : 0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
