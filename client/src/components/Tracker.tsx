import { useCallback, useMemo, useRef, useState } from 'react';
import { api, ApiError, type ApplicationInput } from '../api';
import { useApplications } from '../hooks/useApplications';
import { useTheme } from '../hooks/useTheme';
import type { Application, AuthUser } from '../types';
import { Board } from './Board';
import { Dashboard } from './Dashboard';
import { ApplicationForm } from './ApplicationForm';
import { DetailDrawer } from './DetailDrawer';
import { Toasts, type Toast } from './Toasts';

type View = 'board' | 'dashboard';

/**
 * The authenticated tracker. Mounted only with a live session, so the
 * data hooks below never fire unauthenticated requests.
 */
export function Tracker({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const [view, setView] = useState<View>('board');
  const [query, setQuery] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Application | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const { theme, toggle: toggleTheme } = useTheme();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const pushToast = useCallback((message: string, kind: Toast['kind'] = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, kind }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  const { apps, loading, error, dataVersion, refresh, bumpVersion, moveApp } = useApplications({
    notify: pushToast,
    archived: showArchived,
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return apps;
    return apps.filter((a) =>
      [a.company, a.position, a.location ?? ''].some((s) => s.toLowerCase().includes(q)),
    );
  }, [apps, query]);

  const handleSubmit = useCallback(
    async (input: Partial<ApplicationInput>, baseVersion?: number) => {
      if (editing) {
        // Form edits carry the version the user started from: if another
        // tab saved first, the API answers 412 instead of silently
        // overwriting their changes (drag-and-drop moves stay last-write-
        // wins — they are single-intent and race-guarded client-side).
        await api.updateApplication(editing.id, input, {
          ifMatch: baseVersion ?? editing.version,
        });
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

  const handleExport = useCallback(async () => {
    try {
      const blob = await api.exportCsv();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `offerflow-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      // Revoke on the next tick: some browsers resolve the download
      // asynchronously, and revoking synchronously can cancel it.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      pushToast('CSV exported');
    } catch {
      pushToast('Export failed', 'error');
    }
  }, [pushToast]);

  const handleImportFile = useCallback(
    async (file: File) => {
      // Reject oversized files before reading them into memory — the
      // server's 256 KiB JSON limit would bounce them anyway, and the
      // JSON wrapper only makes the payload larger than the raw CSV.
      if (file.size > 256 * 1024) {
        pushToast('File is too large — the import limit is 256 KiB', 'error');
        return;
      }
      try {
        const csv = await file.text();
        const { imported } = await api.importCsv(csv);
        pushToast(`Imported ${imported} application${imported === 1 ? '' : 's'}`);
        bumpVersion();
      } catch (err) {
        if (err instanceof ApiError && err.details?.length) {
          // Show the first few row errors — the full list is in the response.
          const summary = err.details
            .slice(0, 3)
            .map((d) => `${d.path}: ${d.message}`)
            .join('; ');
          pushToast(`Import rejected — ${summary}${err.details.length > 3 ? '…' : ''}`, 'error');
        } else {
          pushToast(err instanceof Error ? err.message : 'Import failed', 'error');
        }
      }
    },
    [pushToast, bumpVersion],
  );

  const handleArchiveToggle = useCallback(
    async (app: Application) => {
      try {
        if (app.archivedAt) {
          await api.restoreApplication(app.id);
          pushToast('Application restored');
        } else {
          await api.archiveApplication(app.id);
          pushToast('Application archived');
        }
        setSelectedId(null);
        bumpVersion();
      } catch {
        pushToast('Archive action failed', 'error');
      }
    },
    [pushToast, bumpVersion],
  );

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
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <h1 className="sr-only">OfferFlow — job application tracker</h1>
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
          {view === 'board' && (
            <button
              className={showArchived ? 'btn ghost active-toggle' : 'btn ghost'}
              onClick={() => setShowArchived((v) => !v)}
              aria-pressed={showArchived}
              title={showArchived ? 'Back to the active board' : 'View archived applications'}
            >
              {showArchived ? '📂 Archive' : '📂 Archive'}
            </button>
          )}
          <button
            className="btn ghost"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            title="Toggle theme"
          >
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          <button className="btn ghost" onClick={handleExport} title="Download all data as CSV">
            ⬇ CSV
          </button>
          <button
            className="btn ghost"
            onClick={() => fileInputRef.current?.click()}
            title="Import applications from CSV"
          >
            ⬆ CSV
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            hidden
            aria-label="Import CSV file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleImportFile(file);
              e.target.value = ''; // allow re-importing the same file
            }}
          />
          {user.isDemo && (
            <button
              className="btn ghost"
              onClick={handleResetDemo}
              title="Restore the demo dataset"
            >
              Reset demo
            </button>
          )}
          <button className="btn primary" onClick={openCreate}>
            + New application
          </button>
          <div className="user-chip" title={user.email}>
            <span className="user-avatar" aria-hidden="true">
              {user.displayName.slice(0, 1).toUpperCase()}
            </span>
            <span className="user-name">{user.displayName}</span>
            {user.isDemo && <span className="demo-badge">demo</span>}
          </div>
          <button className="btn ghost" onClick={onLogout} aria-label="Sign out">
            Sign out
          </button>
        </div>
      </header>

      <main id="main" className="main" tabIndex={-1}>
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
          refreshKey={dataVersion}
          onClose={() => setSelectedId(null)}
          onEdit={openEdit}
          onDelete={handleDelete}
          onArchiveToggle={handleArchiveToggle}
          onChanged={bumpVersion}
          onError={(msg) => pushToast(msg, 'error')}
        />
      )}

      <Toasts toasts={toasts} />
    </div>
  );
}
