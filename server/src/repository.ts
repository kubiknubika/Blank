import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Application, AppEvent, EventType, Status } from '@offerflow/shared';
import type { CreateApplicationInput, UpdateApplicationInput } from '@offerflow/shared/schemas';

/**
 * Pure data access. No business rules here — the service layer owns those.
 * Every method is synchronous because node:sqlite is synchronous; callers
 * that need atomicity wrap calls in transaction().
 */

interface ApplicationRow {
  id: string;
  company: string;
  position: string;
  status: string;
  source: string;
  priority: string;
  location: string | null;
  work_mode: string;
  salary_min: number | null;
  salary_max: number | null;
  currency: string;
  url: string | null;
  notes: string | null;
  applied_at: string | null;
  follow_up_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

interface EventRow {
  id: string;
  application_id: string;
  type: string;
  message: string;
  created_at: string;
}

function toApplication(row: ApplicationRow): Application {
  return {
    id: row.id,
    company: row.company,
    position: row.position,
    status: row.status as Application['status'],
    source: row.source as Application['source'],
    priority: row.priority as Application['priority'],
    location: row.location,
    workMode: row.work_mode as Application['workMode'],
    salaryMin: row.salary_min,
    salaryMax: row.salary_max,
    currency: row.currency,
    url: row.url,
    notes: row.notes,
    appliedAt: row.applied_at,
    followUpAt: row.follow_up_at,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

function toEvent(row: EventRow): AppEvent {
  return {
    id: row.id,
    applicationId: row.application_id,
    type: row.type as EventType,
    message: row.message,
    createdAt: row.created_at,
  };
}

const FIELD_TO_COLUMN = {
  company: 'company',
  position: 'position',
  status: 'status',
  source: 'source',
  priority: 'priority',
  location: 'location',
  workMode: 'work_mode',
  salaryMin: 'salary_min',
  salaryMax: 'salary_max',
  currency: 'currency',
  url: 'url',
  notes: 'notes',
  appliedAt: 'applied_at',
  followUpAt: 'follow_up_at',
} as const satisfies Record<string, string>;

/**
 * Escape LIKE metacharacters so a search for "100%" or "a_b" matches those
 * literal strings instead of acting as wildcards. Paired with ESCAPE '\'
 * in every LIKE clause below.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export interface ListFilter {
  status?: Status;
  q?: string;
  /** 'true' = archived rows only; default = active board. */
  archived?: 'true' | 'false';
  limit?: number;
  offset?: number;
}

export class ApplicationRepository {
  constructor(private db: DatabaseSync) {}

  /** Shared WHERE builder so list() and countFiltered() can never drift. */
  private buildFilter(
    userId: string,
    filter: ListFilter,
  ): { where: string; params: (string | number)[] } {
    // Ownership is the FIRST clause and not optional: every list/count is
    // scoped to one user, by construction rather than by caller discipline.
    const clauses: string[] = ['user_id = ?'];
    const params: (string | number)[] = [userId];
    // The board and the archive are disjoint views of the same table.
    clauses.push(filter.archived === 'true' ? 'archived_at IS NOT NULL' : 'archived_at IS NULL');
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    if (filter.q) {
      clauses.push(
        `(company LIKE ? ESCAPE '\\' OR position LIKE ? ESCAPE '\\' OR location LIKE ? ESCAPE '\\')`,
      );
      const like = `%${escapeLike(filter.q)}%`;
      params.push(like, like, like);
    }
    return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }

  list(userId: string, filter: ListFilter = {}): Application[] {
    const { where, params } = this.buildFilter(userId, filter);
    const rows = this.db
      .prepare(`SELECT * FROM applications ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...params, filter.limit ?? 100, filter.offset ?? 0) as unknown as ApplicationRow[];
    return rows.map(toApplication);
  }

  /** Total matching the filter, ignoring limit/offset — for X-Total-Count. */
  countFiltered(userId: string, filter: ListFilter = {}): number {
    const { where, params } = this.buildFilter(userId, filter);
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM applications ${where}`)
      .get(...params) as { n: number };
    return row.n;
  }

  /** Ownership-scoped: another user's id reads as absent, never as forbidden. */
  getById(userId: string, id: string): Application | null {
    const row = this.db
      .prepare('SELECT * FROM applications WHERE id = ? AND user_id = ?')
      .get(id, userId) as ApplicationRow | undefined;
    return row ? toApplication(row) : null;
  }

  insert(userId: string, input: CreateApplicationInput, now: string): Application {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO applications
         (id, user_id, company, position, status, source, priority, location, work_mode,
          salary_min, salary_max, currency, url, notes, applied_at, follow_up_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        userId,
        input.company,
        input.position,
        input.status,
        input.source,
        input.priority,
        input.location,
        input.workMode,
        input.salaryMin,
        input.salaryMax,
        input.currency,
        input.url,
        input.notes,
        input.appliedAt,
        input.followUpAt,
        now,
        now,
      );
    return this.getById(userId, id)!;
  }

  /**
   * Bumps version on every field update. With expectedVersion the UPDATE
   * is conditional (WHERE version = ?): 0 changed rows → null, which the
   * service turns into 412. The caller runs inside a transaction, so the
   * existence check and the conditional write cannot interleave.
   */
  update(
    userId: string,
    id: string,
    input: UpdateApplicationInput,
    now: string,
    expectedVersion?: number,
  ): Application | null {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    for (const [field, column] of Object.entries(FIELD_TO_COLUMN)) {
      if (field in input) {
        sets.push(`${column} = ?`);
        params.push((input as Record<string, string | number | null>)[field]);
      }
    }
    sets.push('updated_at = ?', 'version = version + 1');
    params.push(now, id, userId);
    let sql = `UPDATE applications SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`;
    if (expectedVersion !== undefined) {
      sql += ' AND version = ?';
      params.push(expectedVersion);
    }
    const result = this.db.prepare(sql).run(...params);
    if (result.changes === 0) return null;
    return this.getById(userId, id)!;
  }

  delete(userId: string, id: string): boolean {
    const result = this.db
      .prepare('DELETE FROM applications WHERE id = ? AND user_id = ?')
      .run(id, userId);
    return result.changes > 0;
  }

  insertEvent(applicationId: string, type: EventType, message: string, now: string): AppEvent {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO events (id, application_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, applicationId, type, message, now);
    return { id, applicationId, type, message, createdAt: now };
  }

  listEvents(applicationId: string): AppEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE application_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(applicationId) as unknown as EventRow[];
    return rows.map(toEvent);
  }

  /**
   * All applications carrying a reminder, soonest first. Date-only
   * strings sort lexicographically = chronologically (YYYY-MM-DD).
   * The partial index idx_applications_follow_up serves this exactly.
   */
  listReminders(userId: string): Application[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM applications
         WHERE user_id = ? AND follow_up_at IS NOT NULL AND archived_at IS NULL
         ORDER BY follow_up_at ASC, created_at ASC`,
      )
      .all(userId) as unknown as ApplicationRow[];
    return rows.map(toApplication);
  }

  /**
   * Every row the user owns, active AND archived — the CSV export is a
   * full backup, so it must not silently drop the archive.
   */
  listAllForExport(userId: string): Application[] {
    const rows = this.db
      .prepare(`SELECT * FROM applications WHERE user_id = ? ORDER BY created_at ASC, rowid ASC`)
      .all(userId) as unknown as ApplicationRow[];
    return rows.map(toApplication);
  }

  setArchived(userId: string, id: string, archivedAt: string | null, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE applications SET archived_at = ?, updated_at = ?, version = version + 1
         WHERE id = ? AND user_id = ?`,
      )
      .run(archivedAt, now, id, userId);
    return result.changes > 0;
  }

  /** Global count — liveness/metrics only, never user-facing data. */
  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM applications').get() as { n: number };
    return row.n;
  }

  countForUser(userId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM applications WHERE user_id = ?')
      .get(userId) as { n: number };
    return row.n;
  }

  deleteAllForUser(userId: string): void {
    // Events cascade via FK; the subquery keeps the delete ownership-scoped.
    this.db.prepare('DELETE FROM applications WHERE user_id = ?').run(userId);
  }
}
