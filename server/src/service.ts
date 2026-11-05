import type { DatabaseSync } from 'node:sqlite';
import type { Application, ApplicationWithEvents, AppEvent } from '@offerflow/shared';
import type {
  CreateApplicationInput,
  CreateEventInput,
  ListApplicationsQuery,
  UpdateApplicationInput,
} from '@offerflow/shared/schemas';
import { transaction } from './db.js';
import { NotFoundError, PreconditionFailedError, QuotaExceededError } from './errors.js';
import { ApplicationRepository, MAX_EVENTS_PER_APPLICATION } from './repository.js';
import { parseImport, toCsv } from './csv.js';

/**
 * Per-account application quota. One CSV import writes up to 1000 rows
 * per request, so the mutation rate limit alone does not bound storage
 * growth — without a quota a single client can add ~100k rows/minute.
 * The cap covers active AND archived rows and is enforced inside the
 * write transaction (create) and as an atomic pre-check (import).
 */
export const MAX_APPLICATIONS_PER_USER = 5000;

export interface ServiceLimits {
  maxApplicationsPerUser: number;
  maxEventsPerApplication: number;
}

/**
 * Business rules live here, between HTTP and SQL:
 *  - creating an application atomically records a `created` event
 *  - a status change atomically records a `status` event
 *  - moving to `applied` stamps appliedAt if the caller didn't provide one
 *  - scheduling/clearing a follow-up records a `reminder` event
 *  - moving to `rejected` clears a pending follow-up (nothing to chase)
 *  - archive/restore are idempotent and record `archive` events
 *  - CSV import is all-or-nothing: validate every row, then write once
 *  - reads compose application + events into one aggregate
 *
 * Multi-user: every data operation goes through forUser(userId), which
 * binds ownership into every repository call. There is deliberately no
 * unscoped read/write API — forgetting to scope is a compile error, not
 * a data leak. Cross-user ids surface as 404, never 403: the API does not
 * confirm that someone else's row exists.
 *
 * The clock is injected so tests are deterministic.
 */
export interface UserScope {
  listPage(query: ListApplicationsQuery): { items: Application[]; total: number };
  /** Applications with a follow-up date, soonest first. */
  listReminders(): Application[];
  get(id: string): ApplicationWithEvents;
  create(input: CreateApplicationInput): ApplicationWithEvents;
  update(
    id: string,
    input: UpdateApplicationInput,
    expectedVersion?: number,
  ): ApplicationWithEvents;
  delete(id: string): void;
  addEvent(id: string, input: CreateEventInput): AppEvent;
  count(): number;
  resetDemo(seed: (scope: UserScope) => void): number;
  archive(id: string): ApplicationWithEvents;
  restore(id: string): ApplicationWithEvents;
  exportCsv(): string;
  importCsv(csv: string): { imported: number };
}

export class ApplicationService {
  private repo: ApplicationRepository;

  constructor(
    private db: DatabaseSync,
    private now: () => Date = () => new Date(),
    private limits: ServiceLimits = {
      maxApplicationsPerUser: MAX_APPLICATIONS_PER_USER,
      maxEventsPerApplication: MAX_EVENTS_PER_APPLICATION,
    },
  ) {
    this.repo = new ApplicationRepository(db, this.limits.maxEventsPerApplication);
  }

  /** Global count for liveness/metrics — never user-facing data. */
  count(): number {
    return this.repo.count();
  }

  forUser(userId: string): UserScope {
    const repo = this.repo;
    const db = this.db;
    const now = this.now;
    const limits = this.limits;

    const scope: UserScope = {
      /**
       * One page plus the total matching the filter. Both queries run
       * synchronously back-to-back in the same handler — node:sqlite cannot
       * interleave a write between them in this single-process model.
       */
      listPage(query) {
        return { items: repo.list(userId, query), total: repo.countFiltered(userId, query) };
      },

      listReminders() {
        return repo.listReminders(userId);
      },

      get(id) {
        const app = repo.getById(userId, id);
        if (!app) throw new NotFoundError();
        return { ...app, events: repo.listEvents(id) };
      },

      create(input) {
        const ts = now().toISOString();
        return transaction(db, () => {
          if (repo.countForUser(userId) >= limits.maxApplicationsPerUser) {
            throw new QuotaExceededError(
              `Application quota reached (${limits.maxApplicationsPerUser} per account, archive included). Delete rows to free space.`,
            );
          }
          const app = repo.insert(userId, input, ts);
          repo.insertEvent(
            app.id,
            'created',
            `Application created for ${app.position} at ${app.company}`,
            ts,
          );
          return { ...app, events: repo.listEvents(app.id) };
        });
      },

      /**
       * expectedVersion (from If-Match) makes this a compare-and-swap: a
       * concurrent writer that committed first causes 412 instead of a silent
       * lost update. Omitted → last-write-wins, kept for intent-style writes
       * (drag-and-drop status moves) and backward compatibility.
       */
      update(id, input, expectedVersion) {
        const ts = now().toISOString();
        return transaction(db, () => {
          const existing = repo.getById(userId, id);
          if (!existing) throw new NotFoundError();

          const patch: UpdateApplicationInput = { ...input };
          const statusChanged = input.status !== undefined && input.status !== existing.status;
          if (
            statusChanged &&
            input.status === 'applied' &&
            !existing.appliedAt &&
            input.appliedAt === undefined
          ) {
            patch.appliedAt = ts.slice(0, 10);
          }
          // A rejection ends the chase: drop a pending follow-up unless the
          // caller explicitly set one in the same patch.
          const reminderAutoCleared =
            statusChanged &&
            input.status === 'rejected' &&
            existing.followUpAt !== null &&
            input.followUpAt === undefined;
          if (reminderAutoCleared) patch.followUpAt = null;

          const app = repo.update(userId, id, patch, ts, expectedVersion);
          if (!app) throw new PreconditionFailedError();
          if (statusChanged) {
            repo.insertEvent(
              id,
              'status',
              `Status changed: ${existing.status} → ${input.status}`,
              ts,
            );
          }
          const reminderChanged =
            patch.followUpAt !== undefined && patch.followUpAt !== existing.followUpAt;
          if (reminderChanged) {
            repo.insertEvent(
              id,
              'reminder',
              patch.followUpAt === null
                ? reminderAutoCleared
                  ? 'Follow-up cleared (application rejected)'
                  : 'Follow-up cleared'
                : `Follow-up scheduled for ${patch.followUpAt}`,
              ts,
            );
          }
          return { ...app, events: repo.listEvents(id) };
        });
      },

      delete(id) {
        transaction(db, () => {
          const deleted = repo.delete(userId, id);
          if (!deleted) throw new NotFoundError();
        });
      },

      addEvent(id, input) {
        return transaction(db, () => {
          if (!repo.getById(userId, id)) throw new NotFoundError();
          return repo.insertEvent(id, input.type, input.message, now().toISOString());
        });
      },

      count() {
        return repo.countForUser(userId);
      },

      resetDemo(seed) {
        return transaction(db, () => {
          repo.deleteAllForUser(userId);
          seed(scope);
          return repo.countForUser(userId);
        });
      },

      /** Idempotent: archiving an archived row changes nothing (no event, no version bump). */
      archive(id) {
        return transaction(db, () => {
          const existing = repo.getById(userId, id);
          if (!existing) throw new NotFoundError();
          if (existing.archivedAt === null) {
            const ts = now().toISOString();
            repo.setArchived(userId, id, ts, ts);
            repo.insertEvent(id, 'archive', 'Application archived', ts);
          }
          return scope.get(id);
        });
      },

      restore(id) {
        return transaction(db, () => {
          const existing = repo.getById(userId, id);
          if (!existing) throw new NotFoundError();
          if (existing.archivedAt !== null) {
            const ts = now().toISOString();
            repo.setArchived(userId, id, null, ts);
            repo.insertEvent(id, 'archive', 'Application restored', ts);
          }
          return scope.get(id);
        });
      },

      exportCsv() {
        return toCsv(repo.listAllForExport(userId));
      },

      importCsv(csv) {
        // Parse + validate the WHOLE file first — a rejection writes nothing.
        const rows = parseImport(csv);
        return transaction(db, () => {
          // Atomic quota pre-check: reject the whole file up front rather
          // than failing on row N and rolling back a half-consumed budget.
          const existing = repo.countForUser(userId);
          if (existing + rows.length > limits.maxApplicationsPerUser) {
            throw new QuotaExceededError(
              `Import would exceed the application quota (${existing} of ${limits.maxApplicationsPerUser} used, ${rows.length} requested).`,
            );
          }
          for (const row of rows) {
            const created = scope.create(row.input);
            if (row.archived) scope.archive(created.id);
          }
          return { imported: rows.length };
        });
      },
    };

    return scope;
  }
}
