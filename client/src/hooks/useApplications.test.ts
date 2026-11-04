// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';
import { useApplications } from './useApplications';
import { api } from '../api';
import type { Application, ApplicationWithEvents } from '../types';

/**
 * Race regressions reproduced from published bug reports
 * (docs/adr/0005-hardening-from-field-reports.md). Single-call tests miss
 * these bugs by construction — every scenario below fires TWO overlapping
 * async operations and resolves them out of order.
 */
vi.mock('../api', () => ({
  api: {
    listApplications: vi.fn(),
    updateApplication: vi.fn(),
  },
}));

const listMock = vi.mocked(api.listApplications);
const updateMock = vi.mocked(api.updateApplication);

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
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function withEvents(app: Application): ApplicationWithEvents {
  return { ...app, events: [] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useApplications: refresh ordering', () => {
  it('loads the list on mount', async () => {
    listMock.mockResolvedValueOnce([makeApp()]);
    const { result } = renderHook(() => useApplications({ notify: vi.fn() }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.apps).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it('discards a stale refresh that resolves after a newer one', async () => {
    listMock.mockResolvedValueOnce([makeApp()]);
    const { result } = renderHook(() => useApplications({ notify: vi.fn() }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const slow = deferred<Application[]>();
    const fast = deferred<Application[]>();
    listMock.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
    act(() => {
      void result.current.refresh();
      void result.current.refresh();
    });

    await act(async () => fast.resolve([makeApp({ company: 'New Co' })]));
    await act(async () => slow.resolve([makeApp({ company: 'Old Co' })]));

    expect(result.current.apps[0].company).toBe('New Co');
  });

  it('a stale refresh failure does not surface an error over newer data', async () => {
    listMock.mockResolvedValueOnce([makeApp()]);
    const { result } = renderHook(() => useApplications({ notify: vi.fn() }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const slow = deferred<Application[]>();
    const fast = deferred<Application[]>();
    listMock.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
    act(() => {
      void result.current.refresh();
      void result.current.refresh();
    });

    await act(async () => fast.resolve([makeApp({ company: 'New Co' })]));
    await act(async () => slow.reject(new Error('stale network failure')));

    expect(result.current.error).toBeNull();
    expect(result.current.apps[0].company).toBe('New Co');
  });
});

describe('useApplications: overlapping optimistic moves', () => {
  it('a superseded failure neither rolls back nor toasts over the newer move', async () => {
    listMock.mockResolvedValueOnce([makeApp({ status: 'applied' })]);
    const notify = vi.fn();
    const { result } = renderHook(() => useApplications({ notify }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const move1 = deferred<ApplicationWithEvents>();
    const move2 = deferred<ApplicationWithEvents>();
    updateMock.mockReturnValueOnce(move1.promise).mockReturnValueOnce(move2.promise);
    listMock.mockResolvedValue([makeApp({ status: 'offer' })]); // server truth

    act(() => void result.current.moveApp('a1', 'interview'));
    act(() => void result.current.moveApp('a1', 'offer'));
    expect(result.current.apps[0].status).toBe('offer'); // optimistic

    // The NEWER request confirms first, the OLDER one fails afterwards.
    await act(async () => move2.resolve(withEvents(makeApp({ status: 'offer' }))));
    await act(async () => move1.reject(new Error('late failure')));

    expect(result.current.apps[0].status).toBe('offer');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Offer'), 'success');
  });

  it('an in-flight refresh does not clobber a pending optimistic status', async () => {
    listMock.mockResolvedValueOnce([makeApp({ status: 'applied' })]);
    const { result } = renderHook(() => useApplications({ notify: vi.fn() }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // A refresh is dispatched BEFORE the move and resolves DURING it,
    // carrying the pre-move server snapshot.
    const staleRefresh = deferred<Application[]>();
    listMock.mockReturnValueOnce(staleRefresh.promise);
    act(() => void result.current.refresh());

    const move = deferred<ApplicationWithEvents>();
    updateMock.mockReturnValueOnce(move.promise);
    act(() => void result.current.moveApp('a1', 'interview'));
    expect(result.current.apps[0].status).toBe('interview');

    await act(async () => staleRefresh.resolve([makeApp({ status: 'applied' })]));
    expect(result.current.apps[0].status).toBe('interview'); // overlay wins

    listMock.mockResolvedValue([makeApp({ status: 'interview' })]);
    await act(async () => move.resolve(withEvents(makeApp({ status: 'interview' }))));
    expect(result.current.apps[0].status).toBe('interview');
  });

  it('a lone failed move rolls back via refresh and shows one error toast', async () => {
    listMock.mockResolvedValueOnce([makeApp({ status: 'applied' })]);
    const notify = vi.fn();
    const { result } = renderHook(() => useApplications({ notify }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    updateMock.mockRejectedValueOnce(new Error('boom'));
    listMock.mockResolvedValue([makeApp({ status: 'applied' })]);
    await act(async () => result.current.moveApp('a1', 'interview'));

    await waitFor(() => expect(result.current.apps[0].status).toBe('applied'));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('Failed to move the application', 'error');
  });

  it('ignores a move to the current status (no request, no toast)', async () => {
    listMock.mockResolvedValueOnce([makeApp({ status: 'applied' })]);
    const notify = vi.fn();
    const { result } = renderHook(() => useApplications({ notify }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => result.current.moveApp('a1', 'applied'));
    expect(updateMock).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
