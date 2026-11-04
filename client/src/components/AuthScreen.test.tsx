// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { AuthScreen } from './AuthScreen';
import { api, ApiError } from '../api';
import type { AuthUser } from '../types';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: {
      login: vi.fn(),
      register: vi.fn(),
      demo: vi.fn(),
    },
  };
});

const loginMock = vi.mocked(api.login);
const registerMock = vi.mocked(api.register);
const demoMock = vi.mocked(api.demo);

const user: AuthUser = {
  id: 'u1',
  email: 'alice@example.com',
  displayName: 'Alice',
  isDemo: false,
};

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('AuthScreen', () => {
  it('signs in with email + password and reports the user', async () => {
    loginMock.mockResolvedValue({ user, expiresAt: '2026-11-11T00:00:00.000Z' });
    const onAuth = vi.fn();
    render(<AuthScreen onAuth={onAuth} />);

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'alice@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/^password/i), {
      target: { value: 'my-password-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(onAuth).toHaveBeenCalledWith(user));
    expect(loginMock).toHaveBeenCalledWith({
      email: 'alice@example.com',
      password: 'my-password-1',
    });
  });

  it('switches to the register tab and submits a display name', async () => {
    registerMock.mockResolvedValue({ user, expiresAt: '2026-11-11T00:00:00.000Z' });
    const onAuth = vi.fn();
    render(<AuthScreen onAuth={onAuth} />);

    fireEvent.click(screen.getByRole('tab', { name: 'Create account' }));
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'alice@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/display name/i), {
      target: { value: 'Alice' },
    });
    fireEvent.change(screen.getByLabelText(/^password/i), {
      target: { value: 'my-password-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(onAuth).toHaveBeenCalledWith(user));
    expect(registerMock).toHaveBeenCalledWith({
      email: 'alice@example.com',
      password: 'my-password-1',
      displayName: 'Alice',
    });
  });

  it('shows the server error verbatim on a failed login', async () => {
    loginMock.mockRejectedValue(new ApiError('Invalid email or password', 401, 'UNAUTHORIZED'));
    render(<AuthScreen onAuth={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'alice@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/^password/i), {
      target: { value: 'wrong-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Invalid email or password');
  });

  it('the demo button signs in without credentials', async () => {
    const demoUser: AuthUser = { ...user, id: 'demo', isDemo: true, displayName: 'Demo User' };
    demoMock.mockResolvedValue({ user: demoUser, expiresAt: '2026-11-11T00:00:00.000Z' });
    const onAuth = vi.fn();
    render(<AuthScreen onAuth={onAuth} />);

    fireEvent.click(screen.getByRole('button', { name: /try demo/i }));
    await waitFor(() => expect(onAuth).toHaveBeenCalledWith(demoUser));
    expect(demoMock).toHaveBeenCalledWith();
  });

  it('register enforces the 8-char password minimum natively', () => {
    render(<AuthScreen onAuth={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Create account' }));
    expect(screen.getByLabelText(/^password/i).getAttribute('minlength')).toBe('8');
  });
});
