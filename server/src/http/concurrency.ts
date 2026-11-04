import { ValidationError } from '../errors.js';

/**
 * Minimal, strict If-Match support for optimistic concurrency.
 * Accepted: a single strong entity tag with the row version ("3") or '*'.
 * '*' means "any existing version" — the existence check already covers it.
 * Anything else is a client error: silently ignoring a malformed
 * precondition would turn a lost-update guard into a no-op.
 */
export function parseIfMatch(header: string | undefined): number | undefined {
  if (header === undefined || header.trim() === '*') return undefined;
  const match = /^"(\d+)"$/.exec(header.trim());
  if (!match) {
    throw new ValidationError([
      { path: 'If-Match', message: 'Expected a quoted row version like "3", or *' },
    ]);
  }
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ValidationError([
      { path: 'If-Match', message: 'Version must be a positive integer' },
    ]);
  }
  return version;
}

/** Strong ETag from the row version — cheap and exact, no hashing. */
export function versionEtag(version: number): string {
  return `"${version}"`;
}
