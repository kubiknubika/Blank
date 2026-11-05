# 0016 — Accessibility: keyboard and screen-reader parity

Date: 2026-11-05
Status: Accepted

## Context

Twelve rounds hardened the backend, security, and operations, but the
client's accessibility was only partially done. `AuthScreen` was already
exemplary (an `h1`, a `role="tablist"`, errors linked with
`aria-describedby`, a `role="alert"` banner), yet the rest of the app had
the _labels_ of accessibility without the _behaviour_:

- `DetailDrawer` and `ApplicationForm` both declared `role="dialog"
aria-modal="true"` but did **nothing** with focus: no initial focus, no
  trap, no return. A keyboard user Tabbed straight out of the "modal" into
  the background, and a screen-reader user was never told focus had moved.
  `ApplicationForm` did not even close on Escape.
- Every toast — success **and** error — sat in one `role="status"`
  `aria-live="polite"` region, so a failed save could be missed entirely by
  a non-visual user.
- Form fields wrapped their control in a `<label>` (good) but the error
  text was a sibling `<span>` with no `aria-describedby` link and no
  `aria-invalid` on the control, so the error was invisible to a screen
  reader focused on the field.
- No skip link, no top-level `h1` in the tracker (the logo was a `<span>`),
  no `prefers-reduced-motion` handling, and no consistent keyboard focus
  ring on buttons/links.

This round brings the whole client up to the standard `AuthScreen` already
set, following the WAI-ARIA Authoring Practices (APG) dialog pattern.

## Decision 1 — a reusable dialog focus-management hook

`client/src/hooks/useDialog.ts` implements the APG dialog pattern once and
is shared by both dialogs:

1. **Focus in.** On open, focus moves to the first focusable control, or to
   the dialog container itself (`tabIndex={-1}`) while content is still
   loading.
2. **Focus trap.** Tab / Shift+Tab cycle within the dialog; focus can never
   escape to the background. The focusable set is recomputed on each
   keystroke, so it stays correct as the drawer's async content loads.
3. **Escape closes.** Both dialogs now close on Escape (the form previously
   did not).
4. **Focus return.** On close, focus returns to whatever opened the dialog
   (the card, the "New application" button). If the trigger was removed
   from the DOM, `focus()` is a harmless no-op.

`onClose` is held in a ref so the effect runs once per mount rather than on
every parent re-render — the same refs-for-callbacks discipline the drawer
already uses for its load effect. No new dependency: a native `<div>` with
`aria-modal` + a focus trap is sufficient and avoids pulling in a dialog
library for two call sites.

## Decision 2 — severity-aware toast announcements

`Toasts` now gives each toast its own role: errors are `role="alert"`
(assertive — they interrupt the screen reader immediately), successes are
`role="status"` (polite — they wait for a pause). The ✓/✕ glyphs are
`aria-hidden`, and a visually-hidden "Error:"/"Success:" prefix conveys the
kind in words rather than relying on a symbol or colour alone.

## Decision 3 — form errors are announced, not just shown

The `Field` helper now links its error text to the control with
`aria-describedby` and flags the control `aria-invalid`, using `useId` for
stable, collision-free ids and `cloneElement` to attach the attributes to
whatever control is wrapped. A screen reader focused on an invalid field
now hears the problem instead of leaving the user to hunt for red text.

## Decision 4 — global keyboard and motion affordances

- A **skip link** ("Skip to main content") is the first focusable element,
  jumping keyboard users past the header to a focusable `<main id="main"
tabIndex={-1}>`.
- A visually-hidden **`h1`** ("OfferFlow — job application tracker") gives
  the tracker a proper top-level heading; the column `h2`s now nest under
  it.
- A consistent **`:focus-visible`** ring on buttons and links that don't
  define their own (cards and the status select already did).
- **`prefers-reduced-motion: reduce`** collapses animations and transitions
  to near-instant for motion-sensitive users.
- The card's accessible name now includes **priority** (the coloured dot is
  visual-only), and the decorative 📍/💰 emoji are `aria-hidden`.

## Consequences

- The client is usable end-to-end with a keyboard and a screen reader:
  dialogs trap and return focus, errors interrupt, field errors are
  announced on focus, and landmarks/skip-link/headings give structure.
- `client/src/components/Accessibility.test.tsx` (13 tests) locks in the
  dialog pattern for both dialogs (focus in, Tab/Shift+Tab trap, Escape,
  focus return), the toast severity roles, and the field-error association;
  `App.test.tsx` pins the skip link, single `h1`, and focusable `main`.
- No new dependencies; the hook is ~70 lines of native DOM, the rest is
  ARIA attributes and CSS.

## Deferred

- A full `inert` background (beyond `aria-modal` + focus trap) would also
  block pointer interaction with the background; the backdrop already
  intercepts clicks, so the trap is sufficient for the current design.
- Drag-and-drop remains pointer-only by design; the drawer's status select
  is the documented keyboard/touch path for moving a card, so no separate
  keyboard drag scheme is added.
- An automated axe-core scan in CI would catch future regressions broadly;
  the targeted tests here pin the specific behaviours without adding a
  dependency.
