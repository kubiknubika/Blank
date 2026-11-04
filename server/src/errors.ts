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
