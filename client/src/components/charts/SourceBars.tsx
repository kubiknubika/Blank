import { SOURCE_LABELS, type Source } from '../../types';

interface SourceBarsProps {
  data: { source: Source; count: number; offers: number }[];
}

export function SourceBars({ data }: SourceBarsProps) {
  const sorted = [...data].sort((a, b) => b.count - a.count);
  const max = Math.max(1, ...sorted.map((d) => d.count));

  return (
    <div className="funnel">
      {sorted.map((d) => (
        <div key={d.source} className="funnel-row">
          <span className="funnel-label">{SOURCE_LABELS[d.source]}</span>
          <div className="funnel-track">
            <div
              className="funnel-fill"
              style={{ width: `${(d.count / max) * 100}%`, background: '#6366f1' }}
            />
          </div>
          <span className="funnel-count">
            {d.count}
            {d.offers > 0 && <em className="offers-badge">{d.offers} 🎉</em>}
          </span>
        </div>
      ))}
    </div>
  );
}
