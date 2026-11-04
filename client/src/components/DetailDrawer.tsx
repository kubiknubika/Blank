import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import {
  PRIORITY_LABELS,
  SOURCE_LABELS,
  STATUS_META,
  WORK_MODE_LABELS,
  type Application,
  type ApplicationWithEvents,
  type EventType,
} from '../types';
import {
  companyColor,
  companyInitials,
  formatDateTime,
  formatSalary,
  relativeDays,
} from '../lib/format';

interface DetailDrawerProps {
  appId: string;
  onClose: () => void;
  onEdit: (app: Application) => void;
  onDelete: (id: string) => Promise<void>;
  onChanged: () => void;
  onError: (message: string) => void;
}

const EVENT_ICONS: Record<EventType, string> = {
  created: '✨',
  status: '🔀',
  note: '📝',
  call: '📞',
  email: '✉️',
  task: '✅',
};

const USER_EVENT_TYPES: EventType[] = ['note', 'call', 'email', 'task'];

export function DetailDrawer({
  appId,
  onClose,
  onEdit,
  onDelete,
  onChanged,
  onError,
}: DetailDrawerProps) {
  const [app, setApp] = useState<ApplicationWithEvents | null>(null);
  const [loading, setLoading] = useState(true);
  const [eventType, setEventType] = useState<EventType>('note');
  const [message, setMessage] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.getApplication(appId);
      setApp(data);
    } catch {
      onError('Failed to load the application');
      onClose();
    } finally {
      setLoading(false);
    }
  }, [appId, onClose, onError]);

  useEffect(() => {
    void load();
  }, [load]);

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
                <span
                  className="status-badge"
                  style={{
                    background: `${STATUS_META[app.status].color}22`,
                    color: STATUS_META[app.status].color,
                  }}
                >
                  {STATUS_META[app.status].label}
                </span>
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
                  <p>{app.notes}</p>
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
