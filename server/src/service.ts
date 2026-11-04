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
 * The clock is injected so tests are deterministic.
 */
export class ApplicationService {
  private repo: ApplicationRepository;

  constructor(
    private db: DatabaseSync,
    private now: () => Date = () => new Date(),
  ) {
    this.repo = new ApplicationRepository(db);
  }

  /**
   * One page plus the total matching the filter. Both queries run
   * synchronously back-to-back in the same handler — node:sqlite cannot
   * interleave a write between them in this single-process model.
   */
  listPage(query: ListApplicationsQuery): { items: Application[]; total: number } {
    return { items: this.repo.list(query), total: this.repo.countFiltered(query) };
  }

  get(id: string): ApplicationWithEvents {
    const app = this.repo.getById(id);
    if (!app) throw new NotFoundError();
    return { ...app, events: this.repo.listEvents(id) };
  }

  create(input: CreateApplicationInput): ApplicationWithEvents {
    const now = this.now().toISOString();
    return transaction(this.db, () => {
      const app = this.repo.insert(input, now);
      this.repo.insertEvent(
        app.id,
        'created',
        `Application created for ${app.position} at ${app.company}`,
        now,
      );
      return { ...app, events: this.repo.listEvents(app.id) };
    });
  }

  /**
   * expectedVersion (from If-Match) makes this a compare-and-swap: a
   * concurrent writer that committed first causes 412 instead of a silent
   * lost update. Omitted → last-write-wins, kept for intent-style writes
   * (drag-and-drop status moves) and backward compatibility.
   */
  update(
    id: string,
    input: UpdateApplicationInput,
    expectedVersion?: number,
  ): ApplicationWithEvents {
    const now = this.now().toISOString();
    return transaction(this.db, () => {
      const existing = this.repo.getById(id);
      if (!existing) throw new NotFoundError();

      const patch: UpdateApplicationInput = { ...input };
      const statusChanged = input.status !== undefined && input.status !== existing.status;
      if (
        statusChanged &&
        input.status === 'applied' &&
        !existing.appliedAt &&
        input.appliedAt === undefined
      ) {
        patch.appliedAt = now.slice(0, 10);
      }

      const app = this.repo.update(id, patch, now, expectedVersion);
      if (!app) throw new PreconditionFailedError();
      if (statusChanged) {
        this.repo.insertEvent(
          id,
          'status',
          `Status changed: ${existing.status} → ${input.status}`,
          now,
        );
      }
      return { ...app, events: this.repo.listEvents(id) };
    });
  }

  delete(id: string): void {
    transaction(this.db, () => {
      const deleted = this.repo.delete(id);
      if (!deleted) throw new NotFoundError();
    });
  }

  addEvent(id: string, input: CreateEventInput): AppEvent {
    return transaction(this.db, () => {
      if (!this.repo.getById(id)) throw new NotFoundError();
      return this.repo.insertEvent(id, input.type, input.message, this.now().toISOString());
    });
  }

  count(): number {
    return this.repo.count();
  }

  resetDemo(seed: (service: ApplicationService) => void): number {
    return transaction(this.db, () => {
      this.repo.deleteAll();
      seed(this);
      return this.repo.count();
    });
  }
}
