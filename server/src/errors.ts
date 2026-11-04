import type { ErrorCode } from '@offerflow/shared';

/**
 * Domain errors carry everything the HTTP layer needs to render a response.
 * Services throw these; routes never build error payloads themselves.
 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly status: number,
    public readonly details?: { path: string; message: string }[],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Application') {
    super(`${resource} not found`, 'NOT_FOUND', 404);
  }
}

export class ValidationError extends AppError {
  constructor(details: { path: string; message: string }[]) {
    super('Validation failed', 'VALIDATION_FAILED', 400, details);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Request forbidden') {
    super(message, 'FORBIDDEN', 403);
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(message = 'Unsupported media type') {
    super(message, 'UNSUPPORTED_MEDIA_TYPE', 415);
  }
}

/** If-Match did not match the current row version — a lost-update guard. */
export class PreconditionFailedError extends AppError {
  constructor(message = 'Application was modified by another request. Refresh and retry.') {
    super(message, 'PRECONDITION_FAILED', 412);
  }
}

/** No valid session — the caller must sign in. */
export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 'UNAUTHORIZED', 401);
  }
}

/** Uniqueness violation (e.g. email already registered). */
export class ConflictError extends AppError {
  constructor(message = 'Resource already exists') {
    super(message, 'CONFLICT', 409);
  }
}

/** Per-IP mutation budget exhausted; Retry-After is set by the limiter. */
export class RateLimitedError extends AppError {
  constructor(retryAfterSeconds: number) {
    super(`Too many requests. Retry in ${retryAfterSeconds} second(s).`, 'RATE_LIMITED', 429);
    this.retryAfterSeconds = retryAfterSeconds;
  }
  readonly retryAfterSeconds: number;
}
