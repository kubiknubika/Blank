# 0017 — Client resilience: protect unsaved work, survive network loss

Date: 2026-11-05
Status: Accepted

## Context

The backend is durable (ADR-0015) and the client is accessible (ADR-0016),
but two everyday failure modes still lost the user's work or confused them:

1. **The form discarded typing silently.** Round 13 (correctly) made the
   create/edit dialog close on Escape and backdrop click — which made it
   _easier_ to accidentally throw away a half-filled form. There was no
   dirty check, no confirmation, and no `beforeunload` guard, so a stray
   Escape or a tab reload wiped the input with no warning.
2. **Network loss surfaced as a raw browser error.** `fetch` rejects with
   `TypeError: Failed to fetch` when the server is unreachable; that string
   leaked into error banners and toasts. There was no offline indicator and
   no resync when the connection returned, so a user who went offline on the
   train kept staring at a stale board with no explanation.

This round makes the client resilient to both, without new dependencies.

## Decision 1 — an unsaved-changes guard on the form

`ApplicationForm` now diffs its current field values against a baseline
(the values it opened with) using a fixed-order string snapshot
(`fieldValues`). Any divergence marks the form **dirty**:

- **Escape, backdrop click, Cancel, and the close icon** all route through a
  single `requestClose`, which asks `Discard unsaved changes?` via
  `window.confirm` when dirty and only closes on confirmation. A pristine
  form still closes instantly — no friction where there is nothing to lose.
- **`beforeunload`** is prevented while dirty, so a tab close / reload also
  warns.
- **"Load latest" rebases the baseline.** After a 412 conflict, loading the
  fresh row resets the baseline to that row, so the rebase itself does not
  leave the form falsely dirty.

The guard uses the same `window.confirm` already used for delete and demo
reset — consistent, dependency-free, and trivially testable.

## Decision 2 — a typed, friendly network error

`api.ts` adds `NetworkError`, distinct from `ApiError`:

- `ApiError` = the server **answered** with an error status.
- `NetworkError` = the server was **unreachable** (offline, DNS, refused).

`requestRaw` wraps `fetch` and converts a rejection into `NetworkError`
with a user-facing message ("Cannot reach the server. Check your connection
and try again."), while letting an explicit `AbortError` pass through
untouched. Because `NetworkError extends Error`, every place that already
renders `err.message` (the board's error banner, the form's save error, the
auth screen) now shows the friendly text instead of "Failed to fetch". The
auth screen's `ApiError`-only check was widened to include `NetworkError`.

## Decision 3 — offline awareness and resync

A small `useOnline` hook seeds from `navigator.onLine` and tracks the
`online` / `offline` window events. The tracker uses it to:

- show an **offline banner** (`role="status"`, amber "degraded" styling,
  theme-aware) explaining that the board shows the last loaded data and
  saving will fail until the connection returns;
- **resync the board on reconnect** — an offline→online transition triggers
  a `refresh()`, guarded by a `wasOffline` ref so it fires only on a real
  transition, not on the initial mount or unrelated re-renders.

## Consequences

- A half-filled form can no longer be lost to a stray Escape, backdrop
  click, or tab reload without an explicit confirmation.
- Network loss is explained in plain language and the board self-heals on
  reconnect instead of staying silently stale.
- Tests: 7 form-guard tests (pristine closes free, dirty asks, decline
  keeps open, confirm discards, Cancel guarded, `beforeunload` only while
  dirty, rebase resets the baseline), 3 `NetworkError` tests (friendly
  wrap, `AbortError` passthrough, server errors stay `ApiError`), 2
  `useOnline` tests, and 2 tracker tests (offline banner, resync on
  reconnect). Client suite grows 92 → 106.
- No new dependencies; the guard is a snapshot diff + `window.confirm`, the
  network layer is a `try/catch`, and connectivity is two event listeners.

## Deferred

- A custom in-app confirmation dialog (instead of `window.confirm`) would
  match the visual language better, but the native confirm is accessible,
  blocking, and consistent with the existing delete/reset flows; swapping it
  is a cosmetic follow-up.
- Optimistic offline writes with a sync queue (true offline-first) is a much
  larger feature; this round deliberately keeps the model simple — reads
  survive offline, writes are clearly reported as unavailable.
