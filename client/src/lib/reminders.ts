import type { Application } from '../types';

/**
 * Follow-up bucketing in the USER's local timezone. The API stores and
 * returns plain YYYY-MM-DD dates and a flat soonest-first list; whether
 * a date is "overdue" or "today" depends on where the user is, so the
 * bucketing happens here, not on the server.
 */
export type ReminderBucket = 'overdue' | 'today' | 'upcoming';

/** Local YYYY-MM-DD (NOT toISOString — that would shift across midnight). */
export function localDateString(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function reminderBucket(dateStr: string, today: string = localDateString()): ReminderBucket {
  if (dateStr < today) return 'overdue';
  if (dateStr === today) return 'today';
  return 'upcoming';
}

export interface BucketedReminders {
  overdue: Application[];
  today: Application[];
  upcoming: Application[];
}

export function bucketReminders(
  apps: Application[],
  today: string = localDateString(),
): BucketedReminders {
  const out: BucketedReminders = { overdue: [], today: [], upcoming: [] };
  for (const app of apps) {
    if (!app.followUpAt) continue;
    out[reminderBucket(app.followUpAt, today)].push(app);
  }
  // The API already sorts soonest-first; keep that order within buckets.
  return out;
}

/** "in 3 days" / "today" / "2 days overdue" for badges and lists. */
export function followUpLabel(dateStr: string, today: string = localDateString()): string {
  const bucket = reminderBucket(dateStr, today);
  if (bucket === 'today') return 'today';
  const days = Math.round(
    (new Date(`${dateStr}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) /
      86400000,
  );
  if (bucket === 'overdue') {
    const n = -days;
    return n === 1 ? '1 day overdue' : `${n} days overdue`;
  }
  return days === 1 ? 'tomorrow' : `in ${days} days`;
}
