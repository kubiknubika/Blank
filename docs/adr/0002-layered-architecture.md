# 2. Layered server architecture

Date: 2026-11-04 · Status: accepted

## Context

The first version put business rules (status-change events, `appliedAt`
stamping) inside the repository, next to SQL. That makes rules hard to test
without a database and impossible to reuse, and it mixes two kinds of change
(schema changes vs. rule changes) in one file.

## Decision

Split the server into layers with one responsibility each:

```
HTTP (routes)  →  Service (business rules)  →  Repository (SQL)
     ↑                    ↑
middleware owns      transactions own
error responses      atomicity
```

- **Routes** parse input with shared Zod schemas and delegate. No logic.
- **Service** owns invariants: created/status events, `appliedAt` stamping,
  atomic multi-write operations. The clock is injected (`now: () => Date`)
  so tests are deterministic.
- **Repository** is pure data access. No rules, no HTTP concepts.
- **Middleware** is the only place that maps errors to HTTP responses.
  Services throw typed `AppError`s; unknown errors become 500s with the
  stack logged server-side and never leaked.
- **`createApp(deps)`** is a composition root: db, logger, clock and static
  directory are injected, so tests run the full stack in-memory.

## Consequences

- Each layer is testable in isolation; service tests need no HTTP.
- Adding a rule means touching one file; adding a column means touching
  the repository and a migration — different changes, different places.
- Slightly more files. At this size that is the point: the structure teaches
  where things go before the codebase grows into them.
