import type { Application, Status } from '../types';

/**
 * Overlay in-flight optimistic status changes onto a fresh server snapshot.
 *
 * Field report: a list refetch that was dispatched *before* an optimistic
 * mutation resolved can return the pre-mutation status and visually "undo"
 * the move (CupThread/CupThreadReactNativeSDK#75). While a mutation for an
 * id is still pending, its optimistic status wins over the server snapshot.
 *
 * Pure function — kept separate from the hook so the merge rule is unit
 * testable without a DOM.
 */
export function overlayPendingStatuses(
  apps: Application[],
  pending: ReadonlyMap<string, Status>,
): Application[] {
  if (pending.size === 0) return apps;
  return apps.map((app) => {
    const status = pending.get(app.id);
    return status === undefined || status === app.status ? app : { ...app, status };
  });
}
