import type { DatabaseSync } from 'node:sqlite';
import { SOURCES, STATUSES, type AnalyticsOverview, type Source, type Status } from './types.js';

function mondayOf(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export function buildOverview(db: DatabaseSync): AnalyticsOverview {
  const statusRows = db
    .prepare('SELECT status, COUNT(*) AS count FROM applications GROUP BY status')
    .all() as unknown as { status: Status; count: number }[];
  const statusMap = new Map(statusRows.map((r) => [r.status, r.count]));
  const byStatus = STATUSES.map((status) => ({ status, count: statusMap.get(status) ?? 0 }));

  const total = byStatus.reduce((sum, s) => sum + s.count, 0);
  const offers = statusMap.get('offer') ?? 0;
  const active = total - (statusMap.get('wishlist') ?? 0) - (statusMap.get('rejected') ?? 0);
  const responded = (statusMap.get('screening') ?? 0) + (statusMap.get('interview') ?? 0) + offers;
  const sent = total - (statusMap.get('wishlist') ?? 0);
  const responseRate = sent > 0 ? Math.round((responded / sent) * 100) : 0;
  const offerRate = sent > 0 ? Math.round((offers / sent) * 100) : 0;

  const sourceRows = db
    .prepare(
      `SELECT source, COUNT(*) AS count,
              SUM(CASE WHEN status = 'offer' THEN 1 ELSE 0 END) AS offers
       FROM applications GROUP BY source`,
    )
    .all() as unknown as { source: Source; count: number; offers: number }[];
  const sourceMap = new Map(sourceRows.map((r) => [r.source, r]));
  const bySource = SOURCES.map(
    (source) => sourceMap.get(source) ?? { source, count: 0, offers: 0 },
  ).filter((s) => s.count > 0);

  const salaryRows = db
    .prepare(
      `SELECT salary_min, salary_max FROM applications
       WHERE salary_min IS NOT NULL OR salary_max IS NOT NULL`,
    )
    .all() as unknown as { salary_min: number | null; salary_max: number | null }[];
  const midpoints = salaryRows.map((r) =>
    r.salary_min != null && r.salary_max != null
      ? (r.salary_min + r.salary_max) / 2
      : (r.salary_min ?? r.salary_max)!,
  );

  // Applications sent per week over the last 8 weeks.
  const weeks: { week: string; label: string; applied: number }[] = [];
  const now = new Date();
  const currentMonday = mondayOf(now);
  for (let i = 7; i >= 0; i--) {
    const monday = new Date(currentMonday);
    monday.setUTCDate(monday.getUTCDate() - i * 7);
    const iso = monday.toISOString().slice(0, 10);
    const label = monday.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
    weeks.push({ week: iso, label, applied: 0 });
  }
  const appliedRows = db
    .prepare(`SELECT applied_at FROM applications WHERE applied_at IS NOT NULL`)
    .all() as unknown as { applied_at: string }[];
  const weekIndex = new Map(weeks.map((w, i) => [w.week, i]));
  for (const row of appliedRows) {
    const week = mondayOf(new Date(row.applied_at)).toISOString().slice(0, 10);
    const idx = weekIndex.get(week);
    if (idx !== undefined) weeks[idx].applied += 1;
  }

  const recentEvents = db
    .prepare(
      `SELECT e.id, e.application_id, e.type, e.message, e.created_at, a.company, a.position
       FROM events e JOIN applications a ON a.id = e.application_id
       ORDER BY e.created_at DESC LIMIT 12`,
    )
    .all()
    .map((row) => {
      const r = row as unknown as {
        id: string;
        application_id: string;
        type: string;
        message: string;
        created_at: string;
        company: string;
        position: string;
      };
      return {
        id: r.id,
        applicationId: r.application_id,
        type: r.type as AnalyticsOverview['recentEvents'][number]['type'],
        message: r.message,
        createdAt: r.created_at,
        company: r.company,
        position: r.position,
      };
    });

  return {
    totals: {
      total,
      active,
      offers,
      responseRate,
      offerRate,
      medianSalary: median(midpoints),
    },
    byStatus,
    bySource,
    weekly: weeks,
    recentEvents,
  };
}
