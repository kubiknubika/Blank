import { useEffect, useState } from 'react';

/**
 * Tracks browser connectivity (ADR-0017). `navigator.onLine` seeds the
 * value; the `online` / `offline` window events keep it current. The
 * tracker uses it to show an offline banner and to resync the board when
 * the connection returns, so data shown while offline is refreshed rather
 * than left stale.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return online;
}
