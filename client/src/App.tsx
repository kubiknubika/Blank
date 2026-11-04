import { useCallback, useEffect, useState } from 'react';
import { api, UNAUTHORIZED_EVENT } from './api';
import type { AuthUser } from './types';
import { AuthScreen } from './components/AuthScreen';
import { Tracker } from './components/Tracker';

type AuthState =
  { status: 'loading' } | { status: 'anonymous' } | { status: 'authenticated'; user: AuthUser };

/**
 * Auth shell. Resolves the session once on mount, then either renders
 * the sign-in screen or mounts the tracker. The tracker (and its data
 * hooks) only exist while authenticated, so no request races the login.
 *
 * A 401 from any data call fires UNAUTHORIZED_EVENT (see api.ts) and
 * drops the shell back to the sign-in screen — expired sessions degrade
 * gracefully instead of spamming error toasts.
 */
export default function App() {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then((user) => {
        if (cancelled) return;
        setAuth(user ? { status: 'authenticated', user } : { status: 'anonymous' });
      })
      .catch(() => {
        // Network/server failure: show the sign-in screen; its own
        // errors will surface if the backend is really down.
        if (!cancelled) setAuth({ status: 'anonymous' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onUnauthorized = () => setAuth({ status: 'anonymous' });
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const handleAuth = useCallback((user: AuthUser) => {
    setAuth({ status: 'authenticated', user });
  }, []);

  const handleLogout = useCallback(() => {
    void api.logout().catch(() => {
      // Even if the revoke call fails, drop local state; the cookie is
      // cleared server-side on success and expires on its own otherwise.
    });
    setAuth({ status: 'anonymous' });
  }, []);

  if (auth.status === 'loading') {
    return (
      <div className="auth-screen">
        <div className="loading" role="status">
          Loading OfferFlow…
        </div>
      </div>
    );
  }

  if (auth.status === 'anonymous') {
    return <AuthScreen onAuth={handleAuth} />;
  }

  // key: remount on account switch so no stale data crosses users.
  return <Tracker key={auth.user.id} user={auth.user} onLogout={handleLogout} />;
}
