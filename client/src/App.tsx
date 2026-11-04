import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type ApplicationInput } from './api';
import { STATUS_META, type Application, type Status } from './types';
import { Board } from './components/Board';
import { Dashboard } from './components/Dashboard';
import { ApplicationForm } from './components/ApplicationForm';
import { DetailDrawer } from './components/DetailDrawer';
import { Toasts, type Toast } from './components/Toasts';

type View = 'board' | 'dashboard';

export default function App() {
  const [view, setView] = useState<View>('board');
  const [apps, setApps] = useState<Application[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Application | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dataVersion, setDataVersion] = useState(0);

  const pushToast = useCallback((message: string, kind: Toast['kind'] = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, kind }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await api.listApplications();
      setApps(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load applications');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const bumpVersion = useCallback(() => {
    setDataVersion((v) => v + 1);
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return apps;
    return apps.filter((a) =>
      [a.company, a.position, a.location ?? ''].some((s) => s.toLowerCase().includes(q)),
    );
  }, [apps, query]);

  const moveApp = useCallback(
    async (id: string, status: Status) => {
      const app = apps.find((a) => a.id === id);
      if (!app || app.status === status) return;
      setApps((prev) => prev.map((a) => (a.id === id ? { ...a, status } : a)));
      try {
        await api.updateApplication(id, { status });
        pushToast(`${app.company} moved to ${STATUS_META[status].label}`);
        bumpVersion();
      } catch {
        pushToast('Failed to move the application', 'error');
        void refresh();
      }
    },
    [apps, pushToast, bumpVersion, refresh],
  );

  const handleSubmit = useCallback(
    async (input: Partial<ApplicationInput>) => {
      if (editing) {
        await api.updateApplication(editing.id, input);
        pushToast('Application updated');
      } else {
        await api.createApplication(input);
        pushToast('Application created');
      }
      setFormOpen(false);
      setEditing(null);
      bumpVersion();
    },
    [editing, pushToast, bumpVersion],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      await api.deleteApplication(id);
      pushToast('Application deleted');
      setSelectedId(null);
      bumpVersion();
    },
    [pushToast, bumpVersion],
  );

  const handleResetDemo = useCallback(async () => {
    if (!window.confirm('Replace all data with the demo dataset?')) return;
    try {
      await api.resetDemo();
      pushToast('Demo data restored');
      setSelectedId(null);
      bumpVersion();
    } catch {
      pushToast('Failed to reset demo data', 'error');
    }
  }, [pushToast, bumpVersion]);

  const openCreate = useCallback(() => {
    setEditing(null);
    setFormOpen(true);
  }, []);

  const openEdit = useCallback((app: Application) => {
    setEditing(app);
    setFormOpen(true);
  }, []);

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <div className="logo">
            <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
              <rect width="32" height="32" rx="8" fill="url(#lg)" />
              <defs>
                <linearGradient id="lg" x1="0" y1="0" x2="32" y2="32">
                  <stop stopColor="#6366f1" />
                  <stop offset="1" stopColor="#8b5cf6" />
                </linearGradient>
              </defs>
              <path
                d="M8 22V14M14 22V10M20 22V17M26 22V8"
                stroke="#fff"
                strokeWidth="3"
                strokeLinecap="round"
                transform="translate(-1 0)"
              />
            </svg>
            <span>OfferFlow</span>
          </div>
          <nav className="nav">
            <button
              className={view === 'board' ? 'nav-btn active' : 'nav-btn'}
              onClick={() => setView('board')}
            >
              Board
            </button>
            <button
              className={view === 'dashboard' ? 'nav-btn active' : 'nav-btn'}
              onClick={() => setView('dashboard')}
            >
              Dashboard
            </button>
          </nav>
        </div>
        <div className="header-right">
          {view === 'board' && (
            <input
              className="search"
              type="search"
              placeholder="Search company, role, location…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search applications"
            />
          )}
          <button className="btn ghost" onClick={handleResetDemo} title="Restore the demo dataset">
            Reset demo
          </button>
          <button className="btn primary" onClick={openCreate}>
            + New application
          </button>
        </div>
      </header>

      <main className="main">
        {error && (
          <div className="error-banner">
            {error}{' '}
            <button className="btn ghost" onClick={() => void refresh()}>
              Retry
            </button>
          </div>
        )}
        {loading ? (
          <div className="loading">Loading applications…</div>
        ) : view === 'board' ? (
          <Board apps={filtered} onMove={moveApp} onSelect={setSelectedId} onCreate={openCreate} />
        ) : (
          <Dashboard key={dataVersion} onSelect={setSelectedId} />
        )}
      </main>

      {formOpen && (
        <ApplicationForm
          initial={editing}
          onSubmit={handleSubmit}
          onClose={() => {
            setFormOpen(false);
            setEditing(null);
          }}
        />
      )}

      {selectedId && (
        <DetailDrawer
          appId={selectedId}
          onClose={() => setSelectedId(null)}
          onEdit={openEdit}
          onDelete={handleDelete}
          onChanged={bumpVersion}
          onError={(msg) => pushToast(msg, 'error')}
        />
      )}

      <Toasts toasts={toasts} />
    </div>
  );
}
