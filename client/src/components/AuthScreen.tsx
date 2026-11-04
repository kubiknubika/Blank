import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { ApiError } from '../api';
import type { AuthUser } from '../types';

type Mode = 'login' | 'register';

/**
 * Sign-in / registration screen. Deliberately dependency-free: two tabs,
 * one form, one demo button. Server-side validation errors are shown
 * verbatim (they're already user-facing English), field errors get
 * attached to the relevant input via aria-describedby.
 */
export function AuthScreen({ onAuth }: { onAuth: (user: AuthUser) => void }) {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === 'login'
          ? await api.login({ email, password })
          : await api.register({
              email,
              password,
              ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
            });
      onAuth(result.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const handleDemo = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.demo();
      onAuth(result.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card" role="region" aria-label="Sign in to OfferFlow">
        <div className="auth-logo">
          <svg width="34" height="34" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="8" fill="url(#alg)" />
            <defs>
              <linearGradient id="alg" x1="0" y1="0" x2="32" y2="32">
                <stop stopColor="#6366f1" />
                <stop offset="1" stopColor="#8b5cf6" />
              </linearGradient>
            </defs>
            <path
              d="M8 22V14M14 22V10M20 22V17M26 22V8"
              stroke="#fff"
              strokeWidth="3"
              strokeLinecap="round"
              transform="translate(-1 0)"
            />
          </svg>
          <h1>OfferFlow</h1>
        </div>
        <p className="auth-tagline">Track every application. Land the offer.</p>

        <div className="auth-tabs" role="tablist" aria-label="Authentication mode">
          <button
            role="tab"
            aria-selected={mode === 'login'}
            className={mode === 'login' ? 'auth-tab active' : 'auth-tab'}
            onClick={() => switchMode('login')}
            type="button"
          >
            Sign in
          </button>
          <button
            role="tab"
            aria-selected={mode === 'register'}
            className={mode === 'register' ? 'auth-tab active' : 'auth-tab'}
            onClick={() => switchMode('register')}
            type="button"
          >
            Create account
          </button>
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              placeholder="you@example.com"
            />
          </label>
          {mode === 'register' && (
            <label>
              Display name <span className="optional">(optional)</span>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={80}
                autoComplete="nickname"
                placeholder="How should we call you?"
              />
            </label>
          )}
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={mode === 'register' ? 8 : 1}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              placeholder={mode === 'register' ? 'At least 8 characters' : 'Your password'}
            />
          </label>

          {error && (
            <div className="auth-error" role="alert">
              {error}
            </div>
          )}

          <button className="btn primary auth-submit" type="submit" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <div className="auth-divider">
          <span>or</span>
        </div>

        <button className="btn ghost auth-demo" onClick={handleDemo} disabled={busy} type="button">
          Try demo — no account needed
        </button>
        <p className="auth-note">
          The demo account is shared and public; anything you add there can be reset by anyone.
        </p>
      </div>
    </div>
  );
}
