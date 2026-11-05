// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import App from './App';
import { api, UNAUTHORIZED_EVENT } from './api';
import type { AuthUser } from './types';

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return {
    ...actual,
    api: {
      me: vi.fn(),
      logout: vi.fn(),
      login: vi.fn(),
      register: vi.fn(),
      demo: vi.fn(),
      listAllApplications: vi.fn().mockResolvedValue([]),
      overview: vi.fn(),
    },
  };
});

const meMock = vi.mocked(api.me);
const logoutMock = vi.mocked(api.logout);

const user: AuthUser = {
  id: 'u1',
  email: 'alice@example.com',
  displayName: 'Alice',
  isDemo: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listAllApplications).mockResolvedValue([]);
  logoutMock.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('App auth shell', () => {
  it('shows the sign-in screen when there is no session', async () => {
    meMock.mockResolvedValue(null);
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /try demo/i })).toBeTruthy();
  });

  it('mounts the tracker directly when a session exists', async () => {
    meMock.mockResolvedValue(user);
    render(<App />);
    expect(await screen.findByText('Alice')).toBeTruthy();
    expect(screen.getByRole('button', { name: '+ New application' })).toBeTruthy();
    // Regular account: no demo reset button.
    expect(screen.queryByRole('button', { name: 'Reset demo' })).toBeNull();
  });

  it('shows the demo badge and reset button for the demo account', async () => {
    meMock.mockResolvedValue({ ...user, id: 'demo', displayName: 'Demo User', isDemo: true });
    render(<App />);
    expect(await screen.findByText('demo')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reset demo' })).toBeTruthy();
  });

  it('sign out revokes the session and returns to the auth screen', async () => {
    meMock.mockResolvedValue(user);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(logoutMock).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: /try demo/i })).toBeTruthy();
  });

  it('a mid-session 401 event drops back to the sign-in screen', async () => {
    meMock.mockResolvedValue(user);
    render(<App />);
    await screen.findByText('Alice');
    fireEvent(window, new CustomEvent(UNAUTHORIZED_EVENT));
    expect(await screen.findByRole('button', { name: /try demo/i })).toBeTruthy();
  });
});

describe('Tracker accessibility landmarks (ADR-0016)', () => {
  it('provides a skip link, a single h1, and a focusable main landmark', async () => {
    meMock.mockResolvedValue(user);
    render(<App />);
    await screen.findByText('Alice');

    const skip = screen.getByRole('link', { name: /skip to main content/i });
    expect(skip.getAttribute('href')).toBe('#main');

    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toMatch(/OfferFlow/);

    const main = screen.getByRole('main');
    expect(main.getAttribute('id')).toBe('main');
    expect(main.getAttribute('tabindex')).toBe('-1');
  });
});
