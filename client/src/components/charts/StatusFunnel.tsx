import { STATUS_META, type Status } from '../../types';

interface StatusFunnelProps {
  data: { status: Status; count: number }[];
}

export function StatusFunnel({ data }: StatusFunnelProps) {
  const pipeline = data.filter((d) => d.status !== 'rejected');
  const max = Math.max(1, ...pipeline.map((d) => d.count));
  const rejected = data.find((d) => d.status === 'rejected');

  return (
    <div className="funnel">
      {pipeline.map((d) => {
        const meta = STATUS_META[d.status];
        return (
          <div key={d.status} className="funnel-row">
            <span className="funnel-label">{meta.label}</span>
            <div className="funnel-track">
              <div
                className="funnel-fill"
                style={{ width: `${(d.count / max) * 100}%`, background: meta.color }}
              />
            </div>
            <span className="funnel-count">{d.count}</span>
          </div>
        );
      })}
      {rejected && rejected.count > 0 && (
        <p className="muted funnel-rejected">
          {rejected.count} rejected application{rejected.count === 1 ? '' : 's'}
        </p>
      )}
    </div>
  );
}
