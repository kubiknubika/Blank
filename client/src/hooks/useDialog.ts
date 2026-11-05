import { useEffect, useRef } from 'react';

/**
 * WAI-ARIA APG dialog focus management (ADR-0016).
 *
 * A `role="dialog" aria-modal="true"` element is only half of an accessible
 * modal: without focus management a keyboard user Tabs straight out into
 * the background, and a screen-reader user is never told focus moved.
 * This hook supplies the other half:
 *
 *  1. On open, focus moves INTO the dialog (first control, or the dialog
 *     container itself while content is still loading).
 *  2. Tab / Shift+Tab cycle within the dialog — focus can never escape to
 *     the inert background (a focus trap).
 *  3. Escape closes the dialog.
 *  4. On close, focus returns to whatever opened it (the card, the button),
 *     so keyboard users are not dumped at the top of the document.
 *
 * Attach the returned ref to the dialog element and give it tabIndex={-1}
 * so the container can receive focus as a fallback. onClose is kept in a
 * ref so the effect runs once per mount, not on every parent re-render.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useDialog<T extends HTMLElement>(onClose: () => void) {
  const ref = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = () =>
      Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getAttribute('aria-hidden') !== 'true',
      );

    // Move focus into the dialog. While the drawer is still loading there
    // are no controls yet, so focus the container (tabIndex=-1) instead.
    (focusables()[0] ?? node).focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        node.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || active === node) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        // Leaving the last control wraps to the first. (From the container
        // itself, native Tab already enters the first control.)
        e.preventDefault();
        first.focus();
      }
    };

    node.addEventListener('keydown', onKeyDown);
    return () => {
      node.removeEventListener('keydown', onKeyDown);
      // Return focus to the trigger. If it was removed from the DOM (e.g.
      // the card was deleted), focus() is a harmless no-op.
      previouslyFocused?.focus?.();
    };
    // Mount-only: the dialog owns focus for its whole lifetime.
  }, []);

  return ref;
}
