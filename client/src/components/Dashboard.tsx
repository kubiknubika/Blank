import { useEffect, useState } from 'react';
import { api } from '../api';
import { STATUS_META, type AnalyticsOverview, type Application } from '../types';
import { formatDateTime } from '../lib/format';
import { bucketReminders, followUpLabel } from '../lib/reminders';
import { WeeklyChart } from './charts/WeeklyChart';
import { StatusFunnel } from './charts/StatusFunnel';
import { SourceBars } from './charts/SourceBars';

interface DashboardProps {
  onSelect: (id: string) => void;
}

export function Dashboard({ onSelect }: DashboardProps) {
  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [reminders, setReminders] = useState<Application[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Reminders are a nice-to-have panel: a failure there must not take
    // the whole dashboard down, so it degrades to an empty list.
    Promise.all([api.overview(), api.reminders().catch(() => [] as Application[])])
      .then(([d, r]) => {
        if (!cancelled) {
          setData(d);
          setReminders(r);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load analytics');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return <div className="loading">Loading analytics…</div>;

  const { totals } = data;
  const salaryLabel =
    totals.medianSalary != null ? `€${Math.round(totals.medianSalary / 1000)}k` : '—';

  return (
    <div className="dashboard">
      <div className="stats-grid">
        <StatCard label="Total applications" value={String(totals.total)} hint="incl. wishlist" />
        <StatCard
          label="Active"
          value={String(totals.active)}
          hint="in progress"
          accent="#60a5fa"
        />
        <StatCard
          label="Response rate"
          value={`${totals.responseRate}%`}
          hint="screening or later"
          accent="#a78bfa"
        />
        <StatCard
          label="Offers"
          value={String(totals.offers)}
          hint={`${totals.offerRate}% offer rate`}
          accent="#34d399"
        />
        <StatCard
          label="Median salary"
          value={salaryLabel}
          hint="midpoint of ranges"
          accent="#fbbf24"
        />
      </div>

      <RemindersPanel apps={reminders} onSelect={onSelect} />

      <div className="charts-grid">
        <section className="panel">
          <h3>Applications per week</h3>
          <WeeklyChart data={data.weekly} />
        </section>
        <section className="panel">
          <h3>Pipeline</h3>
          <StatusFunnel data={data.byStatus} />
        </section>
        <section className="panel">
          <h3>Sources</h3>
          {data.bySource.length > 0 ? (
            <SourceBars data={data.bySource} />
          ) : (
            <p className="muted">No applications yet.</p>
          )}
        </section>
      </div>

      <section className="panel">
        <h3>Recent activity</h3>
        {data.recentEvents.length === 0 ? (
          <p className="muted">Activity will appear here as you track applications.</p>
        ) : (
          <ul className="activity">
            {data.recentEvents.map((e) => (
              <li key={e.id}>
                <button className="activity-link" onClick={() => onSelect(e.applicationId)}>
                  <strong>{e.company}</strong>
                  <span className="muted"> · {e.position}</span>
                </button>
                <span className="activity-message">{e.message}</span>
                <span className="muted activity-time">{formatDateTime(e.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="muted legend-note">
        {Object.entries(STATUS_META)
          .map(([, m]) => m.label)
          .join(' → ')}
      </p>
    </div>
  );
}

function RemindersPanel({
  apps,
  onSelect,
}: {
  apps: Application[];
  onSelect: (id: string) => void;
}) {
  const buckets = bucketReminders(apps);
  const total = buckets.overdue.length + buckets.today.length + buckets.upcoming.length;
  if (total === 0) return null;
  const groups = [
    { key: 'overdue', title: 'Overdue', items: buckets.overdue },
    { key: 'today', title: 'Today', items: buckets.today },
    { key: 'upcoming', title: 'Upcoming', items: buckets.upcoming },
  ] as const;
  return (
    <section className="panel reminders-panel" aria-label="Follow-ups">
      <h3>🔔 Follow-ups</h3>
      <div className="reminders-groups">
        {groups.map(
          (g) =>
            g.items.length > 0 && (
              <div key={g.key} className={`reminders-group reminders-${g.key}`}>
                <h4>
                  {g.title} <span className="reminders-count">{g.items.length}</span>
                </h4>
                <ul>
                  {g.items.map((a) => (
                    <li key={a.id}>
                      <button className="activity-link" onClick={() => onSelect(a.id)}>
                        <strong>{a.company}</strong>
                        <span className="muted"> · {a.position}</span>
                      </button>
                      <span className={`reminder-due reminder-due-${g.key}`}>
                        {followUpLabel(a.followUpAt!)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ),
        )}
      </div>
    </section>
  );
}

function StatCard({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint: string;
  accent?: string;
}) {
  return (
    <div className="stat-card" style={accent ? { borderTopColor: accent } : undefined}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      <span className="stat-hint">{hint}</span>
    </div>
  );
}
