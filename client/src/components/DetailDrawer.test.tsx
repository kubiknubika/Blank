// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { DetailDrawer } from './DetailDrawer';
import { api } from '../api';
import type { ApplicationWithEvents } from '../types';

/**
 * Drawer regressions:
 *  - parent re-renders (new callback identities) must NOT refetch
 *  - switching cards must not let the older card's response win
 *  - the status select is the touch/keyboard path for moving a card
 */
vi.mock('../api', () => ({
  api: {
    getApplication: vi.fn(),
    updateApplication: vi.fn(),
    addEvent: vi.fn(),
  },
}));

const getMock = vi.mocked(api.getApplication);
const updateMock = vi.mocked(api.updateApplication);

function makeApp(
  id: string,
  overrides: Partial<ApplicationWithEvents> = {},
): ApplicationWithEvents {
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
    followUpAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    events: [],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function renderDrawer(appId: string) {
  const props = {
    appId,
    onClose: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(async () => {}),
    onChanged: vi.fn(),
    onError: vi.fn(),
  };
  const view = render(<DetailDrawer {...props} />);
  return { ...view, props };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DetailDrawer loading', () => {
  it('does not refetch when the parent re-renders with new callback identities', async () => {
    getMock.mockResolvedValue(makeApp('a1'));
    const { rerender, props } = renderDrawer('a1');
    await screen.findByText('Co a1');
    expect(getMock).toHaveBeenCalledTimes(1);

    // Same card, brand-new lambdas — exactly what an App re-render does.
    rerender(
      <DetailDrawer
        {...props}
        onClose={vi.fn()}
        onError={vi.fn()}
        onChanged={vi.fn()}
        onDelete={vi.fn(async () => {})}
      />,
    );
    await screen.findByText('Co a1');
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it('switching cards discards the older card response', async () => {
    const first = deferred<ApplicationWithEvents>();
    const second = deferred<ApplicationWithEvents>();
    getMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { rerender, props } = renderDrawer('a1');
    rerender(<DetailDrawer {...props} appId="a2" />);

    // The NEW card resolves first, the OLD one afterwards.
    second.resolve(makeApp('a2'));
    await screen.findByText('Co a2');
    first.resolve(makeApp('a1'));

    await waitFor(() => expect(screen.getByText('Co a2')).toBeTruthy());
    expect(screen.queryByText('Co a1')).toBeNull();
  });

  it('resets to loading state when the card changes (no stale content flash)', async () => {
    getMock.mockResolvedValueOnce(makeApp('a1'));
    const { rerender, props } = renderDrawer('a1');
    await screen.findByText('Co a1');

    const second = deferred<ApplicationWithEvents>();
    getMock.mockReturnValueOnce(second.promise);
    rerender(<DetailDrawer {...props} appId="a2" />);

    expect(screen.queryByText('Co a1')).toBeNull();
    expect(screen.getByText('Loading…')).toBeTruthy();
    second.resolve(makeApp('a2'));
    await screen.findByText('Co a2');
  });
});

describe('DetailDrawer status select', () => {
  it('changes status via the API, reloads and notifies the board', async () => {
    getMock.mockResolvedValueOnce(makeApp('a1', { status: 'applied' }));
    updateMock.mockResolvedValueOnce(makeApp('a1', { status: 'interview' }));
    const { props } = renderDrawer('a1');

    const select = (await screen.findByLabelText('Application status')) as HTMLSelectElement;
    expect(select.value).toBe('applied');

    getMock.mockResolvedValueOnce(makeApp('a1', { status: 'interview' }));
    fireEvent.change(select, { target: { value: 'interview' } });

    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('a1', { status: 'interview' }));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
    await waitFor(() =>
      expect((screen.getByLabelText('Application status') as HTMLSelectElement).value).toBe(
        'interview',
      ),
    );
    expect(props.onError).not.toHaveBeenCalled();
  });

  it('reports a failed status change without touching the board', async () => {
    getMock.mockResolvedValueOnce(makeApp('a1', { status: 'applied' }));
    updateMock.mockRejectedValueOnce(new Error('network'));
    const { props } = renderDrawer('a1');

    const select = await screen.findByLabelText('Application status');
    fireEvent.change(select, { target: { value: 'offer' } });

    await waitFor(() => expect(props.onError).toHaveBeenCalledWith('Failed to change the status'));
    expect(props.onChanged).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Application status') as HTMLSelectElement).value).toBe(
      'applied',
    );
  });
});

describe('DetailDrawer refreshKey', () => {
  it('reloads in place when refreshKey bumps, without a loading flash', async () => {
    getMock.mockResolvedValueOnce(makeApp('a1', { position: 'FE' }));
    const props = {
      appId: 'a1',
      onClose: vi.fn(),
      onEdit: vi.fn(),
      onDelete: vi.fn(async () => {}),
      onChanged: vi.fn(),
      onError: vi.fn(),
    };
    const view = render(<DetailDrawer {...props} refreshKey={0} />);
    await screen.findByText('Co a1');
    expect(getMock).toHaveBeenCalledTimes(1);

    // The edit form saved: parent bumps dataVersion → drawer must refetch.
    getMock.mockResolvedValueOnce(makeApp('a1', { position: 'Senior FE', version: 2 }));
    view.rerender(<DetailDrawer {...props} refreshKey={1} />);
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));
    await screen.findByText('Senior FE');
    // Old content stayed visible during the reload — no loading reset.
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('same refreshKey with new callback identities still does not refetch', async () => {
    getMock.mockResolvedValue(makeApp('a1'));
    const view = renderDrawer('a1');
    await screen.findByText('Co a1');
    view.rerender(
      <DetailDrawer
        appId="a1"
        onClose={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn(async () => {})}
        onChanged={vi.fn()}
        onError={vi.fn()}
      />,
    );
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(1));
  });
});
