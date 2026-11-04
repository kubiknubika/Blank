# OfferFlow

**A full-stack job application tracker** — kanban pipeline, activity timeline, and analytics dashboard. Built to turn a chaotic job search into a measurable process.

![CI](https://github.com/kubiknubika/Blank/actions/workflows/ci.yml/badge.svg)
![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)

## Why

Job hunting produces dozens of applications across different stages, sources, and deadlines. Spreadsheets don't show you _where the process leaks_. OfferFlow does: drag cards through the pipeline, log every interaction, and watch response/offer rates update in real time.

## Features

- **Kanban board** — six-stage pipeline (Wishlist → Applied → Screening → Interview → Offer / Rejected) with native drag-and-drop and optimistic UI updates
- **Analytics dashboard** — response rate, offer rate, median salary, weekly activity chart, pipeline funnel, and source effectiveness (which channel actually produces offers)
- **Activity timeline** — every status change is recorded automatically; log calls, emails, notes, and tasks per application
- **Full CRUD** — create/edit forms with client- and server-side validation, search by company/role/location
- **Demo mode** — one-click reset to a realistic seeded dataset (16 applications across European tech companies)
- **Zero-dependency charts** — SVG charts hand-built without chart libraries
- **Production-ready** — Docker multi-stage build, GitHub Actions CI, health checks, strict TypeScript everywhere

## Tech stack

| Layer    | Technology                                                    |
| -------- | ------------------------------------------------------------- |
| Frontend | React 18, TypeScript (strict), Vite, hand-rolled SVG charts   |
| Backend  | Node.js 22, Express 5, Zod validation                         |
| Database | SQLite via built-in `node:sqlite` (no native deps, WAL mode)  |
| Testing  | Vitest, Supertest — 51 API, service, migration and unit tests |
| Tooling  | ESLint 9 (flat config), Prettier, npm workspaces              |
| DevOps   | GitHub Actions CI, multi-stage Dockerfile, non-root container |

## Architecture

```mermaid
flowchart LR
    subgraph Shared["@offerflow/shared"]
        Contract[Domain types + Zod schemas]
    end
    subgraph Client["React SPA (Vite)"]
        UI[Kanban Board] --- Dash[Dashboard]
        UI --- Drawer[Detail Drawer + Timeline]
        EB[Error Boundary]
    end
    subgraph Server["Express 5 API"]
        MW[Middleware: request id, access log, error mapping]
        Routes[Thin routes] --> Service[Service: business rules + transactions]
        Service --> Repo[Repository: pure SQL]
        Service --> Analytics[Analytics aggregation]
    end
    Contract -. "single source of truth" .-> Client
    Contract -. "runtime validation" .-> Server
    Client -- "/api/* (JSON)" --> MW --> Routes
    Repo --> DB[(SQLite: WAL, migrations, CHECK constraints)]
```

- **Monorepo** with npm workspaces: `shared/`, `client/`, `server/`
- **Shared contract**: domain types and Zod schemas live in `@offerflow/shared` — contract drift becomes a compile error, not a runtime bug
- **Layered server**: routes → service → repository; business rules are testable without HTTP, SQL without rules
- **Atomic writes**: application + events commit in one transaction (re-entrant via SAVEPOINTs)
- **Forward-only migrations** with baselining for pre-existing databases
- **Observability**: structured JSON logs, per-request ids echoed to the client, coded error bodies
- **Graceful shutdown**: SIGTERM drains in-flight requests before closing the DB
- In production the Express server serves the built SPA — **one container, one port**

Design rationale is documented as ADRs in [`docs/adr/`](docs/adr/).

## Quick start

```bash
# requires Node.js >= 22
npm install
npm run dev        # API on :3000, Vite dev server on :5173 (proxies /api)
```

Open http://localhost:5173 — the database is created and seeded with demo data automatically.

### Production build

```bash
npm run build      # builds client, then server
npm start          # serves API + built SPA on :3000
```

### Docker

```bash
docker build -t offerflow .
docker run -p 3000:3000 -v offerflow-data:/data offerflow
```

## Scripts

| Command             | Description                           |
| ------------------- | ------------------------------------- |
| `npm run dev`       | Run API + client in watch mode        |
| `npm test`          | Run all test suites (server + client) |
| `npm run lint`      | ESLint across the monorepo            |
| `npm run typecheck` | Strict TypeScript checks              |
| `npm run build`     | Production build (client + server)    |
| `npm start`         | Serve production build                |
| `npm run format`    | Prettier                              |

## API reference

| Method   | Endpoint                       | Description                              |
| -------- | ------------------------------ | ---------------------------------------- |
| `GET`    | `/api/health`                  | Health check + application count         |
| `GET`    | `/api/applications`            | List; filter with `?status=` and `?q=`   |
| `POST`   | `/api/applications`            | Create (Zod-validated)                   |
| `GET`    | `/api/applications/:id`        | Details with full event timeline         |
| `PATCH`  | `/api/applications/:id`        | Partial update; auto-logs status changes |
| `DELETE` | `/api/applications/:id`        | Delete (cascades events)                 |
| `POST`   | `/api/applications/:id/events` | Log a note / call / email / task         |
| `GET`    | `/api/analytics/overview`      | Aggregated metrics for the dashboard     |
| `POST`   | `/api/demo/reset`              | Restore the demo dataset                 |

Validation errors return `400` with a structured `details` array (`{ path, message }`) that the UI maps onto form fields.

## Testing

```bash
npm test
```

- **API tests** (Supertest): CRUD, filtering, pagination, validation edge cases, coded errors (`VALIDATION_FAILED`, `NOT_FOUND`, `INVALID_JSON`), request-id propagation, analytics correctness, empty-DB safety
- **Service tests**: business rules with an injected clock — deterministic timestamps, `appliedAt` stamping rules, atomic rollback of a failing demo reset, SAVEPOINT semantics
- **Migration tests**: idempotency, baselining a legacy database, persistence across reopen, CHECK-constraint enforcement
- **Config/logger tests**: fail-fast env validation, log levels, structured bindings
- **Client unit tests**: salary/date formatting, relative time, deterministic avatar colors
- CI runs lint → typecheck → tests → build on every push and PR

## Project structure

```
├── shared/                 # @offerflow/shared — the contract
│   └── src/
│       ├── types.ts        # domain types + enums (browser-safe, zero deps)
│       └── schemas.ts      # Zod schemas (separate entry point)
├── client/                 # React SPA
│   └── src/
│       ├── components/     # Board, Card, Dashboard, Form, Drawer, charts/, ErrorBoundary
│       ├── lib/            # pure helpers (+ unit tests)
│       ├── api.ts          # typed fetch client (codes + request ids)
│       └── types.ts        # re-exports shared contract + UI metadata
├── server/                 # Express API
│   ├── src/
│   │   ├── app.ts          # composition root (dependency injection)
│   │   ├── http/           # thin routes + middleware (errors, logging, request id)
│   │   ├── service.ts      # business rules, transactions, injected clock
│   │   ├── repository.ts   # pure SQL data access
│   │   ├── db.ts           # migrations, baselining, transaction helper
│   │   ├── analytics.ts    # metric aggregation
│   │   ├── config.ts       # fail-fast env validation
│   │   ├── logger.ts       # structured JSON logger
│   │   ├── errors.ts       # typed domain errors
│   │   └── seed.ts         # demo dataset
│   └── tests/              # API, service, migration, config suites
├── docs/adr/               # architecture decision records
├── .github/workflows/      # CI
└── Dockerfile              # multi-stage, non-root, healthcheck
```

## Design decisions

Full rationale lives in [`docs/adr/`](docs/adr/); the short version:

- **Shared contract package** ([ADR-0001](docs/adr/0001-shared-contract-package.md)) — types and Zod schemas in one workspace package; contract drift fails the build on both sides.
- **Layered server** ([ADR-0002](docs/adr/0002-layered-architecture.md)) — routes → service → repository, with an injected clock and a composition root for testability.
- **Migrations + transactions** ([ADR-0003](docs/adr/0003-migrations-and-transactions.md)) — forward-only schema history, baselining for legacy DBs, atomic multi-writes via re-entrant SAVEPOINTs, CHECK constraints as a safety net.
- **Observability + lifecycle** ([ADR-0004](docs/adr/0004-observability-and-lifecycle.md)) — structured logs, request ids end-to-end, fail-fast config, graceful shutdown.
- **`node:sqlite` over an ORM** — the domain is small; plain SQL with a repository layer keeps the data flow explicit and the dependency tree tiny.
- **Native HTML5 drag-and-drop** — no dnd library needed for a single-board use case; keyboard users can still open cards and change status via the form.
- **Hand-built SVG charts** — three focused visualizations don't justify a 300 KB charting dependency.
- **Optimistic updates** — moving a card updates the UI instantly and rolls back on API failure.
- **Events as a first-class table** — status history is never overwritten, which makes the timeline and analytics trustworthy.

## Roadmap

- [ ] Authentication & multi-user support
- [ ] CSV import/export
- [ ] Interview reminders
- [ ] Playwright end-to-end tests

## License

[MIT](LICENSE)
