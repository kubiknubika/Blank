import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import type { ApiErrorBody } from '@offerflow/shared';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      log: Logger;
    }
  }
}

// Caller-provided ids are echoed into a response header and written to
// logs, so they must be header-safe and log-safe: a conservative charset
// (no spaces, control chars or unicode) and a hard length cap. Anything
// else is replaced with a generated id rather than rejected — tracing
// should never break a request.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Assigns a request id, echoes it back, and binds a child logger. */
export function requestContext(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const raw = req.headers['x-request-id'];
    const requestId = typeof raw === 'string' && REQUEST_ID_PATTERN.test(raw) ? raw : randomUUID();
    req.requestId = requestId;
    req.log = logger.child({ requestId });
    res.setHeader('x-request-id', requestId);
    next();
  };
}

/** One structured log line per completed request. */
export function accessLog(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    req.log.info('request', {
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
    });
  });
  next();
}

/**
 * The only place that turns errors into HTTP responses.
 * Known errors keep their code/status; unknown ones become 500s and are
 * logged with a stack trace — never leaked to the client.
 */
export function errorHandler(logger: Logger) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const requestId = req.requestId;

    if (err instanceof ZodError) {
      const body: ApiErrorBody = {
        error: 'Validation failed',
        code: 'VALIDATION_FAILED',
        requestId,
        details: err.issues.map((e) => ({ path: e.path.join('.'), message: e.message })),
      };
      res.status(400).json(body);
      return;
    }

    if (err instanceof AppError) {
      const body: ApiErrorBody = {
        error: err.message,
        code: err.code,
        requestId,
        ...(err.details ? { details: err.details } : {}),
      };
      res.status(err.status).json(body);
      return;
    }

    if (err instanceof SyntaxError && 'body' in err) {
      const body: ApiErrorBody = { error: 'Invalid JSON body', code: 'INVALID_JSON', requestId };
      res.status(400).json(body);
      return;
    }

    // body-parser rejects oversized/malformed bodies with typed http-errors.
    // Without this branch they fell through to the generic 500 handler —
    // wrong status AND a stack trace logged per request (log-flood vector).
    if (err instanceof Error && 'type' in err) {
      const type = (err as Error & { type: string }).type;
      if (type === 'entity.too.large') {
        const body: ApiErrorBody = {
          error: 'Request body exceeds the 256 KiB limit',
          code: 'PAYLOAD_TOO_LARGE',
          requestId,
        };
        res.status(413).json(body);
        return;
      }
      if (type === 'encoding.unsupported') {
        const body: ApiErrorBody = {
          error: 'Unsupported content encoding',
          code: 'UNSUPPORTED_MEDIA_TYPE',
          requestId,
        };
        res.status(415).json(body);
        return;
      }
      if (type === 'request.aborted' || type === 'request.size.invalid') {
        const body: ApiErrorBody = {
          error: 'Invalid request body',
          code: 'INVALID_JSON',
          requestId,
        };
        res.status(400).json(body);
        return;
      }
    }

    logger.error('unhandled error', {
      requestId,
      method: req.method,
      path: req.path,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    const body: ApiErrorBody = { error: 'Internal server error', code: 'INTERNAL', requestId };
    res.status(500).json(body);
  };
}
