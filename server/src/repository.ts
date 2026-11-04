import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Application, AppEvent, ApplicationWithEvents, EventType, Status } from './types.js';
import type {
  CreateApplicationInput,
  CreateEventInput,
  UpdateApplicationInput,
} from './validation.js';

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

const FIELD_TO_COLUMN: Record<string, string> = {
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
};

export class ApplicationRepository {
  constructor(private db: DatabaseSync) {}

  list(filter: { status?: Status; q?: string } = {}): Application[] {
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
      .prepare(`SELECT * FROM applications ${where} ORDER BY updated_at DESC`)
      .all(...params) as unknown as ApplicationRow[];
    return rows.map(toApplication);
  }

  getById(id: string): ApplicationWithEvents | null {
    const row = this.db.prepare('SELECT * FROM applications WHERE id = ?').get(id) as
      ApplicationRow | undefined;
    if (!row) return null;
    const events = this.db
      .prepare('SELECT * FROM events WHERE application_id = ? ORDER BY created_at DESC')
      .all(id) as unknown as EventRow[];
    return { ...toApplication(row), events: events.map(toEvent) };
  }

  create(input: CreateApplicationInput): ApplicationWithEvents {
    const id = randomUUID();
    const now = new Date().toISOString();
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
    this.addEvent(id, 'created', `Application created for ${input.position} at ${input.company}`);
    return this.getById(id)!;
  }

  update(id: string, input: UpdateApplicationInput): ApplicationWithEvents | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    for (const [field, column] of Object.entries(FIELD_TO_COLUMN)) {
      if (field in input) {
        sets.push(`${column} = ?`);
        params.push((input as Record<string, string | number | null>)[field]);
      }
    }
    const now = new Date().toISOString();
    sets.push('updated_at = ?');
    params.push(now, id);
    this.db.prepare(`UPDATE applications SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    if (input.status && input.status !== existing.status) {
      this.addEvent(id, 'status', `Status changed: ${existing.status} → ${input.status}`);
      if (input.status === 'applied' && !existing.appliedAt && input.appliedAt === undefined) {
        const today = now.slice(0, 10);
        this.db.prepare('UPDATE applications SET applied_at = ? WHERE id = ?').run(today, id);
      }
    }
    return this.getById(id);
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM applications WHERE id = ?').run(id);
    return result.changes > 0;
  }

  addEvent(applicationId: string, type: EventType, message: string): AppEvent {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO events (id, application_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, applicationId, type, message, now);
    return { id, applicationId, type, message, createdAt: now };
  }

  createUserEvent(applicationId: string, input: CreateEventInput): AppEvent | null {
    const exists = this.db.prepare('SELECT 1 FROM applications WHERE id = ?').get(applicationId);
    if (!exists) return null;
    return this.addEvent(applicationId, input.type, input.message);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM applications').get() as { n: number };
    return row.n;
  }
}
