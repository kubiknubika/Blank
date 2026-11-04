import { describe, it, expect } from 'vitest';
import { overlayPendingStatuses } from './optimistic';
import type { Application } from '../types';

function makeApp(overrides: Partial<Application> = {}): Application {
  return {
    id: 'a1',
    company: 'Acme',
    position: 'FE',
    status: 'applied',
    source: 'linkedin',
    priority: 'medium',
    location: null,
    workMode: 'remote',
    salaryMin: null,
    salaryMax: null,
    currency: 'EUR',
    url: null,
    notes: null,
    appliedAt: null,
    followUpAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

describe('overlayPendingStatuses', () => {
  it('returns the snapshot untouched when nothing is pending', () => {
    const apps = [makeApp()];
    expect(overlayPendingStatuses(apps, new Map())).toBe(apps);
  });

  it('keeps the optimistic status while a mutation is in flight', () => {
    const snapshot = [makeApp({ status: 'applied' }), makeApp({ id: 'a2', status: 'offer' })];
    const result = overlayPendingStatuses(snapshot, new Map([['a1', 'interview']]));
    expect(result[0].status).toBe('interview');
    expect(result[1].status).toBe('offer'); // unrelated card untouched
  });

  it('does not mutate the server snapshot', () => {
    const snapshot = [makeApp({ status: 'applied' })];
    overlayPendingStatuses(snapshot, new Map([['a1', 'rejected']]));
    expect(snapshot[0].status).toBe('applied');
  });

  it('ignores pending ids that are not in the snapshot (deleted card)', () => {
    const snapshot = [makeApp()];
    const result = overlayPendingStatuses(snapshot, new Map([['gone', 'offer']]));
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('applied');
  });
});
