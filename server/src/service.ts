import type { DatabaseSync } from 'node:sqlite';
import type { Application, ApplicationWithEvents, AppEvent } from '@offerflow/shared';
import type {
  CreateApplicationInput,
  CreateEventInput,
  ListApplicationsQuery,
  UpdateApplicationInput,
} from '@offerflow/shared/schemas';
import { transaction } from './db.js';
import { NotFoundError, PreconditionFailedError } from './errors.js';
import { ApplicationRepository } from './repository.js';

/**
 * Business rules live here, between HTTP and SQL:
 *  - creating an application atomically records a `created` event
 *  - a status change atomically records a `status` event
 *  - moving to `applied` stamps appliedAt if the caller didn't provide one
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
}

export class ApplicationService {
  private repo: ApplicationRepository;

  constructor(
    private db: DatabaseSync,
    private now: () => Date = () => new Date(),
  ) {
    this.repo = new ApplicationRepository(db);
  }

  /** Global count for liveness/metrics — never user-facing data. */
  count(): number {
    return this.repo.count();
  }

  forUser(userId: string): UserScope {
    const repo = this.repo;
    const db = this.db;
    const now = this.now;

    const scope: UserScope = {
      /**
       * One page plus the total matching the filter. Both queries run
       * synchronously back-to-back in the same handler — node:sqlite cannot
       * interleave a write between them in this single-process model.
       */
      listPage(query) {
        return { items: repo.list(userId, query), total: repo.countFiltered(userId, query) };
      },

      get(id) {
        const app = repo.getById(userId, id);
        if (!app) throw new NotFoundError();
        return { ...app, events: repo.listEvents(id) };
      },

      create(input) {
        const ts = now().toISOString();
        return transaction(db, () => {
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
    };

    return scope;
  }
}
