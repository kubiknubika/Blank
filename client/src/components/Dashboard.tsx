import { useEffect, useState } from 'react';
import { api } from '../api';
import { STATUS_META, type AnalyticsOverview } from '../types';
import { formatDateTime } from '../lib/format';
import { WeeklyChart } from './charts/WeeklyChart';
import { StatusFunnel } from './charts/StatusFunnel';
import { SourceBars } from './charts/SourceBars';

interface DashboardProps {
  onSelect: (id: string) => void;
}

export function Dashboard({ onSelect }: DashboardProps) {
  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .overview()
      .then((d) => {
        if (!cancelled) setData(d);
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
