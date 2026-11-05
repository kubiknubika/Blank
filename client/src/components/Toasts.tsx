export interface Toast {
  id: number;
  message: string;
  kind: 'success' | 'error';
}

/**
 * Errors are `role="alert"` (assertive) so they interrupt the screen reader
 * immediately; successes are `role="status"` (polite) so they wait for a
 * pause. Previously every toast was polite, which meant a failed save could
 * be missed entirely by a non-visual user (ADR-0016). The ✓/✕ glyphs are
 * decorative (aria-hidden); a visually-hidden "Error:"/"Success:" prefix
 * conveys the kind in words.
 */
export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast ${t.kind}`}
          role={t.kind === 'error' ? 'alert' : 'status'}
        >
          <span aria-hidden="true">{t.kind === 'success' ? '✓' : '✕'}</span>{' '}
          <span className="sr-only">{t.kind === 'error' ? 'Error: ' : 'Success: '}</span>
          {t.message}
        </div>
      ))}
    </div>
  );
}
