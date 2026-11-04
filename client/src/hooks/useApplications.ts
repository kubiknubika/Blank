import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { overlayPendingStatuses } from '../lib/optimistic';
import { STATUS_META, type Application, type Status } from '../types';

export interface UseApplicationsOptions {
  notify: (message: string, kind: 'success' | 'error') => void;
}

/**
 * Application list state with two race guards learned from published bug
 * reports (see docs/adr/0005-hardening-from-field-reports.md):
 *
 * 1. Latest-only refetch — responses that arrive out of order must not
 *    overwrite newer data (trailheadapps/multiframework-recipes#82).
 *    Every refresh takes a sequence number; stale responses are dropped,
 *    including their errors and loading-flag updates.
 *
 * 2. Per-item mutation sequence — when two moves of the same card overlap,
 *    the *older* request's failure must not roll back or toast over the
 *    newer confirmed state (remigiusz-antczak/deep-code-review#978), and an
 *    in-flight refetch must not clobber a pending optimistic status
 *    (CupThread/CupThreadReactNativeSDK#75).
 */
export function useApplications({ notify }: UseApplicationsOptions) {
  const [apps, setApps] = useState<Application[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dataVersion, setDataVersion] = useState(0);

  // Mirrors so callbacks stay stable across renders (no stale closures,
  // no dependency churn for consumers like DetailDrawer).
  const appsRef = useRef(apps);
  appsRef.current = apps;
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const fetchSeq = useRef(0);
  const moveSeq = useRef(new Map<string, number>());
  const pendingStatuses = useRef(new Map<string, Status>());

  const refresh = useCallback(async () => {
    const seq = ++fetchSeq.current;
    try {
      const data = await api.listAllApplications();
      if (seq !== fetchSeq.current) return; // a newer refresh was dispatched
      setApps(overlayPendingStatuses(data, pendingStatuses.current));
      setError(null);
    } catch (e) {
      if (seq !== fetchSeq.current) return; // stale failure: stay quiet
      setError(e instanceof Error ? e.message : 'Failed to load applications');
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const bumpVersion = useCallback(() => {
    setDataVersion((v) => v + 1);
    void refresh();
  }, [refresh]);

  const moveApp = useCallback(
    async (id: string, status: Status) => {
      const app = appsRef.current.find((a) => a.id === id);
      if (!app || app.status === status) return;

      const seq = (moveSeq.current.get(id) ?? 0) + 1;
      moveSeq.current.set(id, seq);
      pendingStatuses.current.set(id, status);
      setApps((prev) => prev.map((a) => (a.id === id ? { ...a, status } : a)));

      try {
        await api.updateApplication(id, { status });
        if (moveSeq.current.get(id) !== seq) return; // superseded by a newer move
        pendingStatuses.current.delete(id);
        notifyRef.current(`${app.company} moved to ${STATUS_META[status].label}`, 'success');
        bumpVersion();
      } catch {
        // Superseded failure: the newer move owns this card's state now.
        // Rolling back or toasting here would clobber confirmed newer data.
        if (moveSeq.current.get(id) !== seq) return;
        pendingStatuses.current.delete(id);
        notifyRef.current('Failed to move the application', 'error');
        void refresh();
      }
    },
    [refresh, bumpVersion],
  );

  return { apps, loading, error, dataVersion, refresh, bumpVersion, moveApp };
}
