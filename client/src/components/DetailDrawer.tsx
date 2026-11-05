import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import {
  PRIORITY_LABELS,
  SOURCE_LABELS,
  STATUS_META,
  STATUSES,
  USER_EVENT_TYPES,
  WORK_MODE_LABELS,
  type Application,
  type ApplicationWithEvents,
  type EventType,
  type Status,
} from '../types';
import {
  companyColor,
  companyInitials,
  formatDateTime,
  formatSalary,
  relativeDays,
} from '../lib/format';
import { followUpLabel, reminderBucket } from '../lib/reminders';
import { Markdown } from '../lib/markdown';

interface DetailDrawerProps {
  appId: string;
  onClose: () => void;
  onEdit: (app: Application) => void;
  onDelete: (id: string) => Promise<void>;
  onArchiveToggle?: (app: Application) => Promise<void>;
  onChanged: () => void;
  onError: (message: string) => void;
  /** Bumped by the parent on any data change; triggers an in-place reload. */
  refreshKey?: number;
}

const EVENT_ICONS: Record<EventType, string> = {
  created: '✨',
  status: '🔀',
  reminder: '🔔',
  archive: '📂',
  note: '📝',
  call: '📞',
  email: '✉️',
  task: '✅',
};

export function DetailDrawer({
  appId,
  onClose,
  onEdit,
  onDelete,
  onArchiveToggle,
  onChanged,
  onError,
  refreshKey = 0,
}: DetailDrawerProps) {
  const [app, setApp] = useState<ApplicationWithEvents | null>(null);
  const [loading, setLoading] = useState(true);
  const [eventType, setEventType] = useState<EventType>('note');
  const [message, setMessage] = useState('');
  const [adding, setAdding] = useState(false);
  const [savingStatus, setSavingStatus] = useState(false);

  // Callbacks live in refs so `load` depends ONLY on appId. Previously
  // inline lambdas from the parent changed every render, retriggering the
  // effect and refetching the drawer on any unrelated App state change.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // Sequence guard: switching between cards (or a manual reload racing
  // with one) must never let an older response overwrite a newer one.
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const data = await api.getApplication(appId);
      if (seq !== loadSeq.current) return;
      setApp(data);
    } catch {
      if (seq !== loadSeq.current) return;
      onErrorRef.current('Failed to load the application');
      onCloseRef.current();
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [appId]);

  // Reset the visible state only when switching to a DIFFERENT card;
  // a refreshKey bump (e.g. the edit form saved) reloads in place, without
  // a loading flicker. Without this, saving an edit left the open drawer
  // showing stale data until it was closed and reopened.
  const loadedIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (loadedIdRef.current !== appId) {
      loadedIdRef.current = appId;
      setApp(null);
      setLoading(true);
    }
    void load();
  }, [load, appId, refreshKey]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleAddEvent = async (e: FormEvent) => {
    e.preventDefault();
    if (!message.trim()) return;
    setAdding(true);
    try {
      await api.addEvent(appId, eventType, message.trim());
      setMessage('');
      await load();
      onChanged();
    } catch {
      onError('Failed to add the event');
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async () => {
    if (!app) return;
    if (!window.confirm(`Delete the application for ${app.company}?`)) return;
    try {
      await onDelete(app.id);
    } catch {
      onError('Failed to delete the application');
    }
  };

  // Touch devices have no HTML5 drag-and-drop — the select is the only
  // way to move a card there, and a keyboard-friendly path everywhere.
  const handleStatusChange = async (status: Status) => {
    if (!app || app.status === status) return;
    setSavingStatus(true);
    try {
      await api.updateApplication(appId, { status });
      await load();
      onChanged();
    } catch {
      onError('Failed to change the status');
    } finally {
      setSavingStatus(false);
    }
  };

  const salary = app ? formatSalary(app) : null;

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Application details"
        onClick={(e) => e.stopPropagation()}
      >
        {loading || !app ? (
          <div className="loading">Loading…</div>
        ) : (
          <>
            <header className="drawer-header">
              <span className="avatar large" style={{ background: companyColor(app.company) }}>
                {companyInitials(app.company)}
              </span>
              <div className="drawer-title">
                <h2>{app.company}</h2>
                <p>{app.position}</p>
                <select
                  className="status-select"
                  value={app.status}
                  disabled={savingStatus}
                  onChange={(e) => void handleStatusChange(e.target.value as Status)}
                  aria-label="Application status"
                  style={{
                    background: `${STATUS_META[app.status].color}22`,
                    color: STATUS_META[app.status].color,
                  }}
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_META[s].label}
                    </option>
                  ))}
                </select>
              </div>
              <button className="icon-btn" onClick={onClose} aria-label="Close">
                ✕
              </button>
            </header>

            <div className="drawer-body">
              <dl className="details">
                {app.location && (
                  <>
                    <dt>Location</dt>
                    <dd>
                      {app.location} · {WORK_MODE_LABELS[app.workMode]}
                    </dd>
                  </>
                )}
                {salary && (
                  <>
                    <dt>Salary</dt>
                    <dd>{salary} / year</dd>
                  </>
                )}
                <dt>Source</dt>
                <dd>{SOURCE_LABELS[app.source]}</dd>
                <dt>Priority</dt>
                <dd>{PRIORITY_LABELS[app.priority]}</dd>
                {app.appliedAt && (
                  <>
                    <dt>Applied</dt>
                    <dd>
                      {app.appliedAt} ({relativeDays(app.appliedAt)})
                    </dd>
                  </>
                )}
                {app.followUpAt && (
                  <>
                    <dt>Follow-up</dt>
                    <dd>
                      <span
                        className={`reminder-due reminder-due-${reminderBucket(app.followUpAt)}`}
                      >
                        🔔 {app.followUpAt} ({followUpLabel(app.followUpAt)})
                      </span>
                    </dd>
                  </>
                )}
                {app.url && (
                  <>
                    <dt>Posting</dt>
                    <dd>
                      <a href={app.url} target="_blank" rel="noreferrer">
                        Open job posting ↗
                      </a>
                    </dd>
                  </>
                )}
              </dl>

              {app.notes && (
                <section className="notes-block">
                  <h3>Notes</h3>
                  <Markdown text={app.notes} />
                </section>
              )}

              <section>
                <h3>Timeline</h3>
                <form className="event-form" onSubmit={handleAddEvent}>
                  <select
                    value={eventType}
                    onChange={(e) => setEventType(e.target.value as EventType)}
                    aria-label="Event type"
                  >
                    {USER_EVENT_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {EVENT_ICONS[t]} {t}
                      </option>
                    ))}
                  </select>
                  <input
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="Log a call, note, task…"
                    maxLength={2000}
                    aria-label="Event message"
                  />
                  <button
                    className="btn primary small"
                    type="submit"
                    disabled={adding || !message.trim()}
                  >
                    Add
                  </button>
                </form>
                <ul className="timeline">
                  {app.events.map((ev) => (
                    <li key={ev.id}>
                      <span className="timeline-icon">{EVENT_ICONS[ev.type]}</span>
                      <div>
                        <p>{ev.message}</p>
                        <span className="muted">{formatDateTime(ev.createdAt)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            </div>

            <footer className="drawer-footer">
              <button className="btn danger ghost" onClick={handleDelete}>
                Delete
              </button>
              {onArchiveToggle && (
                <button className="btn ghost" onClick={() => void onArchiveToggle(app)}>
                  {app.archivedAt ? 'Restore' : 'Archive'}
                </button>
              )}
              <button className="btn primary" onClick={() => onEdit(app)}>
                Edit
              </button>
            </footer>
          </>
        )}
      </aside>
    </div>
  );
}
