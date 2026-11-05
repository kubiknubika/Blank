# 4. Observability and process lifecycle

Date: 2026-11-04 · Status: accepted

## Context

`console.log` debugging does not survive contact with production: no levels,
no structure, no way to correlate a user-visible error with server logs.
The process also died instantly on SIGTERM, cutting off in-flight requests.

## Decision

- **Structured logging**: a dependency-free JSON-lines logger with levels
  and child bindings. Every request gets an id (honoring an inbound
  `x-request-id`), echoed in the response header and included in every error
  body — a user can quote one string and find the exact log line.
- **Access log**: one line per API request with method, path, status and
  duration. Static assets are excluded as noise.
- **Fail-fast config**: all environment variables are parsed by Zod at
  startup; an invalid value aborts boot with a readable message instead of
  surfacing as a mystery failure later. No other module reads `process.env`.
- **Graceful shutdown**: SIGTERM/SIGINT stop the listener, let in-flight
  requests finish, close the database, then exit. A watchdog forces exit
  after `SHUTDOWN_TIMEOUT_MS` so a stuck connection cannot hang a deploy.

## Consequences

- Errors are traceable end-to-end (UI → response body → logs) with zero
  external services.
- The logger interface is intentionally pino-shaped; swapping in pino later
  is a one-file change.
- Container orchestrators (Docker, Kubernetes) can roll the app without
  dropping requests.
