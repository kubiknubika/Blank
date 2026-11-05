// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { Dashboard } from './Dashboard';
import { api } from '../api';
import type { AnalyticsOverview, Application } from '../types';

vi.mock('../api', () => ({
  api: {
    overview: vi.fn(),
    reminders: vi.fn(),
  },
}));

const overviewMock = vi.mocked(api.overview);
const remindersMock = vi.mocked(api.reminders);

const overview: AnalyticsOverview = {
  totals: {
    total: 1,
    active: 1,
    offers: 0,
    responseRate: 0,
    offerRate: 0,
    medianSalary: null,
  },
  byStatus: [],
  bySource: [],
  weekly: [],
  recentEvents: [],
};

function reminderApp(id: string, followUpAt: string): Application {
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

// Pin "today" so bucket assertions don't depend on the real calendar.
const TODAY = '2026-11-04';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 10, 4, 12, 0));
  overviewMock.mockResolvedValue(overview);
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('Dashboard reminders panel', () => {
  it('groups follow-ups into Overdue / Today / Upcoming and links to the drawer', async () => {
    remindersMock.mockResolvedValue([
      reminderApp('late', '2026-11-01'),
      reminderApp('now', TODAY),
      reminderApp('soon', '2026-11-09'),
    ]);
    const onSelect = vi.fn();
    render(<Dashboard onSelect={onSelect} />);

    const panel = await screen.findByRole('region', { name: 'Follow-ups' });
    expect(panel.textContent).toContain('Overdue');
    expect(panel.textContent).toContain('Today');
    expect(panel.textContent).toContain('Upcoming');
    expect(panel.textContent).toContain('3 days overdue');
    expect(panel.textContent).toContain('in 5 days');

    fireEvent.click(screen.getByText('Co now'));
    expect(onSelect).toHaveBeenCalledWith('now');
  });

  it('hides the panel entirely when there are no reminders', async () => {
    remindersMock.mockResolvedValue([]);
    render(<Dashboard onSelect={vi.fn()} />);
    await waitFor(() => expect(overviewMock).toHaveBeenCalled());
    await screen.findByText('Total applications');
    expect(screen.queryByRole('region', { name: 'Follow-ups' })).toBeNull();
  });

  it('a reminders failure degrades to no panel, dashboard still renders', async () => {
    remindersMock.mockRejectedValue(new Error('reminders down'));
    render(<Dashboard onSelect={vi.fn()} />);
    expect(await screen.findByText('Total applications')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Follow-ups' })).toBeNull();
  });
});
