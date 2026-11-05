# 1. Shared contract package

Date: 2026-11-04 · Status: accepted

## Context

Client and server each declared their own copy of the domain types
(`Status`, `Application`, …). Two copies of a contract always drift:
a field renamed on one side compiles fine and fails at runtime.

## Decision

Extract `@offerflow/shared` — a workspace package that owns:

- domain types and enums (`types.ts`) — pure, zero dependencies, safe for the browser;
- Zod validation schemas (`schemas.ts`) — a separate entry point so the
  client bundle never pulls Zod in.

Both sides import the contract. The server validates with the same schemas
the client's form types are derived from.

## Consequences

- A contract change breaks compilation on **both** sides until they agree —
  drift becomes a build error, not a production incident.
- The shared package must be built before client/server (`npm run build`
  handles the ordering).
- UI metadata (labels, colors) deliberately stays in the client: presentation
  is not part of the API contract.
