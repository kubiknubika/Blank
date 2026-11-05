import { describe, it, expect } from 'vitest';
import { bucketReminders, followUpLabel, localDateString, reminderBucket } from './reminders';
import type { Application } from '../types';

function app(id: string, followUpAt: string | null): Application {
  return {
    id,
    company: `Co ${id}`,
    position: 'FE',
    status: 'applied',
    source: 'other',
    priority: 'medium',
    location: null,
    workMode: 'remote',
    salaryMin: null,
    salaryMax: null,
    currency: 'EUR',
    url: null,
    notes: null,
    appliedAt: null,
    followUpAt,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
  };
}

const TODAY = '2026-11-04';

describe('reminderBucket', () => {
  it('classifies against the local today, not UTC midnight', () => {
    expect(reminderBucket('2026-11-03', TODAY)).toBe('overdue');
    expect(reminderBucket('2026-11-04', TODAY)).toBe('today');
    expect(reminderBucket('2026-11-05', TODAY)).toBe('upcoming');
  });

  it('localDateString uses local components (a late-evening UTC- date stays that day)', () => {
    // 23:30 local on Nov 4 — toISOString could already be Nov 5 in UTC+.
    const local = new Date(2026, 10, 4, 23, 30);
    expect(localDateString(local)).toBe('2026-11-04');
  });
});

describe('bucketReminders', () => {
  it('splits into overdue/today/upcoming and skips undated rows', () => {
    const buckets = bucketReminders(
      [
        app('a', '2026-11-01'),
        app('b', null),
        app('c', '2026-11-04'),
        app('d', '2026-11-10'),
        app('e', '2026-11-02'),
      ],
      TODAY,
    );
    expect(buckets.overdue.map((x) => x.id)).toEqual(['a', 'e']); // API order preserved
    expect(buckets.today.map((x) => x.id)).toEqual(['c']);
    expect(buckets.upcoming.map((x) => x.id)).toEqual(['d']);
  });

  it('empty input yields empty buckets', () => {
    const buckets = bucketReminders([], TODAY);
    expect(buckets.overdue).toHaveLength(0);
    expect(buckets.today).toHaveLength(0);
    expect(buckets.upcoming).toHaveLength(0);
  });
});

describe('followUpLabel', () => {
  it('renders human phrases for each horizon', () => {
    expect(followUpLabel('2026-11-04', TODAY)).toBe('today');
    expect(followUpLabel('2026-11-05', TODAY)).toBe('tomorrow');
    expect(followUpLabel('2026-11-07', TODAY)).toBe('in 3 days');
    expect(followUpLabel('2026-11-03', TODAY)).toBe('1 day overdue');
    expect(followUpLabel('2026-11-01', TODAY)).toBe('3 days overdue');
  });

  it('crosses month boundaries correctly', () => {
    expect(followUpLabel('2026-12-01', TODAY)).toBe('in 27 days');
    expect(followUpLabel('2026-10-30', TODAY)).toBe('5 days overdue');
  });
});
