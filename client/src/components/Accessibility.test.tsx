// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ApplicationForm } from './ApplicationForm';
import { DetailDrawer } from './DetailDrawer';
import { Toasts } from './Toasts';
import { Card } from './Card';
import { api, ApiError } from '../api';
import type { Application, ApplicationWithEvents } from '../types';

/**
 * Accessibility regressions (ADR-0016). These lock in the WAI-ARIA APG
 * dialog pattern (focus in / trap / Escape / focus return), assertive error
 * announcements, and form-error association — the behaviours that make the
 * client usable with a keyboard and a screen reader.
 */
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { getApplication: vi.fn() } };
});
const getMock = vi.mocked(api.getApplication);

function makeApp(id = 'a1'): ApplicationWithEvents {
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
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    events: [],
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** A focusable trigger outside the dialog, to prove focus returns to it. */
function makeTrigger() {
  const trigger = document.createElement('button');
  trigger.textContent = 'Open';
  document.body.appendChild(trigger);
  trigger.focus();
  return trigger;
}

function focusablesIn(dialog: HTMLElement) {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href]'),
  );
}

describe('ApplicationForm dialog focus management', () => {
  const renderForm = (onClose = vi.fn()) =>
    render(<ApplicationForm initial={null} onSubmit={vi.fn(async () => {})} onClose={onClose} />);

  it('moves focus into the dialog on open', () => {
    renderForm();
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('traps Tab: leaving the last control wraps to the first', () => {
    renderForm();
    const dialog = screen.getByRole('dialog');
    const items = focusablesIn(dialog);
    const first = items[0];
    const last = items[items.length - 1];
    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
  });

  it('traps Shift+Tab: leaving the first control wraps to the last', () => {
    renderForm();
    const dialog = screen.getByRole('dialog');
    const items = focusablesIn(dialog);
    const first = items[0];
    const last = items[items.length - 1];
    first.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('Escape closes the dialog', () => {
    const onClose = vi.fn();
    renderForm(onClose);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('returns focus to the trigger on close', () => {
    const trigger = makeTrigger();
    const { unmount } = renderForm();
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});

describe('ApplicationForm field error association', () => {
  it('flags the control invalid and links the error text via aria-describedby', async () => {
    const onSubmit = vi.fn(async () => {
      throw new ApiError('Validation failed', 400, 'VALIDATION_FAILED', [
        { path: 'company', message: 'Company is required' },
      ]);
    });
    // Edit mode: required fields are pre-filled so jsdom lets the submit
    // through; the server then rejects the company field.
    render(<ApplicationForm initial={makeApp()} onSubmit={onSubmit} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Save changes'));
    await screen.findByText('Company is required');

    const company = screen.getByPlaceholderText('Acme Corp');
    expect(company.getAttribute('aria-invalid')).toBe('true');
    const describedBy = company.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toBe('Company is required');
  });

  it('a valid control has no aria-invalid or aria-describedby', () => {
    render(<ApplicationForm initial={null} onSubmit={vi.fn(async () => {})} onClose={vi.fn()} />);
    const company = screen.getByPlaceholderText('Acme Corp');
    expect(company.getAttribute('aria-invalid')).toBeNull();
    expect(company.getAttribute('aria-describedby')).toBeNull();
  });
});

describe('Toasts announce by severity', () => {
  it('errors are assertive alerts', () => {
    render(<Toasts toasts={[{ id: 1, message: 'Save failed', kind: 'error' }]} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Save failed');
    expect(alert.textContent).toContain('Error:');
  });

  it('successes are polite status messages', () => {
    render(<Toasts toasts={[{ id: 1, message: 'Saved', kind: 'success' }]} />);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Saved');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Card accessible name', () => {
  const cardApp: Application = {
    id: 'c1',
    company: 'Acme',
    position: 'FE',
    status: 'applied',
    source: 'other',
    priority: 'high',
    location: 'Berlin',
    workMode: 'remote',
    salaryMin: 50000,
    salaryMax: 70000,
    currency: 'EUR',
    url: null,
    notes: null,
    appliedAt: '2026-01-01',
    followUpAt: null,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
  };
  const renderCard = () =>
    render(
      <Card
        app={cardApp}
        dragging={false}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
        onClick={vi.fn()}
      />,
    );

  it('includes priority in the accessible name (the dot is visual-only)', () => {
    renderCard();
    expect(screen.getByRole('button', { name: 'FE at Acme, high priority' })).toBeTruthy();
  });

  it('hides the decorative 📍/💰 emoji from screen readers', () => {
    const { container } = renderCard();
    const hidden = Array.from(container.querySelectorAll('[aria-hidden="true"]')).map(
      (el) => el.textContent,
    );
    expect(hidden).toContain('📍');
    expect(hidden).toContain('💰');
  });
});

describe('DetailDrawer dialog focus management', () => {
  const renderDrawer = (onClose = vi.fn()) =>
    render(
      <DetailDrawer
        appId="a1"
        onClose={onClose}
        onEdit={vi.fn()}
        onDelete={vi.fn(async () => {})}
        onChanged={vi.fn()}
        onError={vi.fn()}
      />,
    );

  it('moves focus into the drawer and returns it to the trigger on close', async () => {
    getMock.mockResolvedValue(makeApp('a1'));
    const trigger = makeTrigger();
    const { unmount } = renderDrawer();
    await screen.findByText('Co a1');
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('Escape closes the drawer', async () => {
    getMock.mockResolvedValue(makeApp('a1'));
    const onClose = vi.fn();
    renderDrawer(onClose);
    await screen.findByText('Co a1');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
