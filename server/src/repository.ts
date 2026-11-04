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
  created_at: string;
  updated_at: string;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
} as const satisfies Record<string, string>;

export class ApplicationRepository {
  constructor(private db: DatabaseSync) {}

  list(
    filter: { status?: Status; q?: string; limit?: number; offset?: number } = {},
  ): Application[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    if (filter.q) {
      clauses.push('(company LIKE ? OR position LIKE ? OR location LIKE ?)');
      const like = `%${filter.q}%`;
      params.push(like, like, like);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM applications ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...params, filter.limit ?? 100, filter.offset ?? 0) as unknown as ApplicationRow[];
    return rows.map(toApplication);
  }

  getById(id: string): Application | null {
    const row = this.db.prepare('SELECT * FROM applications WHERE id = ?').get(id) as
      ApplicationRow | undefined;
    return row ? toApplication(row) : null;
  }

  insert(input: CreateApplicationInput, now: string): Application {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO applications
         (id, company, position, status, source, priority, location, work_mode,
          salary_min, salary_max, currency, url, notes, applied_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
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
        now,
        now,
      );
    return this.getById(id)!;
  }

  update(id: string, input: UpdateApplicationInput, now: string): Application {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    for (const [field, column] of Object.entries(FIELD_TO_COLUMN)) {
      if (field in input) {
        sets.push(`${column} = ?`);
        params.push((input as Record<string, string | number | null>)[field]);
      }
    }
    sets.push('updated_at = ?');
    params.push(now, id);
    this.db.prepare(`UPDATE applications SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return this.getById(id)!;
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM applications WHERE id = ?').run(id);
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

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM applications').get() as { n: number };
    return row.n;
  }

  deleteAll(): void {
    // events first: explicit order keeps intent clear even though FK cascade exists
    this.db.exec('DELETE FROM events; DELETE FROM applications;');
  }
}
