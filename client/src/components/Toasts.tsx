export interface Toast {
  id: number;
  message: string;
  kind: 'success' | 'error';
}

export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === 'success' ? '✓' : '✕'} {t.message}
        </div>
      ))}
    </div>
  );
}
