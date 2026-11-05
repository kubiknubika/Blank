// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ApplicationForm } from './ApplicationForm';
import { api, ApiError, type ApplicationInput } from '../api';
import type { ApplicationWithEvents } from '../types';

/**
 * Lost-update UX: a 412 must not be a dead end. The form offers "Load
 * latest", rebases the fields AND the base version, so the next save
 * compares against the fresh row.
 */
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: {
      getApplication: vi.fn(),
    },
  };
});

const getMock = vi.mocked(api.getApplication);

type SubmitFn = (input: Partial<ApplicationInput>, baseVersion?: number) => Promise<void>;
const submitMock = (impl?: SubmitFn) => vi.fn<SubmitFn>(impl ?? (async () => {}));

function makeApp(overrides: Partial<ApplicationWithEvents> = {}): ApplicationWithEvents {
  return {
    id: 'a1',
    company: 'Acme',
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
    notes: 'original',
    appliedAt: null,
    followUpAt: null,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    events: [],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ApplicationForm conflict flow', () => {
  it('passes the opening version as baseVersion on submit', async () => {
    const onSubmit = submitMock();
    render(
      <ApplicationForm initial={makeApp({ version: 7 })} onSubmit={onSubmit} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][1]).toBe(7);
  });

  it('shows the conflict banner on 412 and keeps the dialog open', async () => {
    const onSubmit = submitMock(async () => {
      throw new ApiError('changed elsewhere', 412, 'PRECONDITION_FAILED');
    });
    render(<ApplicationForm initial={makeApp()} onSubmit={onSubmit} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Save changes'));
    await screen.findByRole('alert');
    expect(screen.getByText('Load latest')).toBeTruthy();
    expect(
      screen.getByText('This application was changed in another tab while you were editing.'),
    ).toBeTruthy();
  });

  it('Load latest rebases fields and the base version for the next submit', async () => {
    let first = true;
    const onSubmit = submitMock(async () => {
      if (first) {
        first = false;
        throw new ApiError('changed elsewhere', 412, 'PRECONDITION_FAILED');
      }
    });
    getMock.mockResolvedValueOnce(makeApp({ notes: 'their newer notes', version: 5 }));

    render(<ApplicationForm initial={makeApp()} onSubmit={onSubmit} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Save changes'));
    await screen.findByRole('alert');

    fireEvent.click(screen.getByText('Load latest'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(
      (screen.getByPlaceholderText('Anything worth remembering…') as HTMLTextAreaElement).value,
    ).toBe('their newer notes');

    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit.mock.calls[1][1]).toBe(5); // rebased, not the stale 1
  });

  it('validation errors still map onto fields (412 path did not break them)', async () => {
    const onSubmit = submitMock(async () => {
      throw new ApiError('Validation failed', 400, 'VALIDATION_FAILED', [
        { path: 'company', message: 'Company is required' },
      ]);
    });
    render(<ApplicationForm initial={makeApp()} onSubmit={onSubmit} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Save changes'));
    await screen.findByText('Please fix the highlighted fields.');
    expect(screen.getByText('Company is required')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('create mode submits without a base version', async () => {
    const onSubmit = submitMock();
    render(<ApplicationForm initial={null} onSubmit={onSubmit} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('Acme Corp'), { target: { value: 'New Co' } });
    fireEvent.change(screen.getByPlaceholderText('Frontend Engineer'), { target: { value: 'BE' } });
    fireEvent.click(screen.getByText('Create application'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][1]).toBeUndefined();
  });
});

describe('ApplicationForm unsaved-changes guard (ADR-0017)', () => {
  afterEach(() => {
    vi.restoreAllMocks(); // drop the window.confirm spy so it can't leak
  });

  const renderForm = (onClose = vi.fn(), initial: ApplicationWithEvents | null = null) =>
    render(
      <ApplicationForm initial={initial} onSubmit={vi.fn(async () => {})} onClose={onClose} />,
    );

  it('a pristine form closes on Escape without asking', () => {
    const onClose = vi.fn();
    renderForm(onClose);
    const confirmSpy = vi.spyOn(window, 'confirm');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('a pristine edit form also closes without asking', () => {
    const onClose = vi.fn();
    renderForm(onClose, makeApp());
    const confirmSpy = vi.spyOn(window, 'confirm');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('typed changes trigger a confirm; declining keeps the form open', () => {
    const onClose = vi.fn();
    renderForm(onClose);
    fireEvent.change(screen.getByPlaceholderText('Acme Corp'), { target: { value: 'New Co' } });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('confirming discards the changes and closes', () => {
    const onClose = vi.fn();
    renderForm(onClose);
    fireEvent.change(screen.getByPlaceholderText('Acme Corp'), { target: { value: 'New Co' } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the Cancel button is guarded too', () => {
    const onClose = vi.fn();
    renderForm(onClose);
    fireEvent.change(screen.getByPlaceholderText('Acme Corp'), { target: { value: 'X' } });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByText('Cancel'));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('beforeunload is prevented only while dirty', () => {
    renderForm();
    const pristine = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(pristine);
    expect(pristine.defaultPrevented).toBe(false);

    fireEvent.change(screen.getByPlaceholderText('Acme Corp'), { target: { value: 'X' } });
    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });

  it('rebasing via "Load latest" resets the baseline (no phantom dirty)', async () => {
    // Open on a stale row, hit a 412, load the latest, then close: the
    // rebase must not leave the form falsely "dirty".
    const latest = { ...makeApp(), company: 'Rebased Co', version: 5 };
    vi.mocked(api.getApplication).mockResolvedValueOnce(latest);
    const onClose = vi.fn();
    const onSubmit = vi.fn(async () => {
      throw new ApiError('changed elsewhere', 412, 'PRECONDITION_FAILED');
    });
    render(<ApplicationForm initial={makeApp()} onSubmit={onSubmit} onClose={onClose} />);
    fireEvent.click(screen.getByText('Save changes'));
    await screen.findByText('Load latest');
    fireEvent.click(screen.getByText('Load latest'));
    await waitFor(() => expect(screen.getByDisplayValue('Rebased Co')).toBeTruthy());

    const confirmSpy = vi.spyOn(window, 'confirm');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
