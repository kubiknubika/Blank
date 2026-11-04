interface WeeklyChartProps {
  data: { week: string; label: string; applied: number }[];
}

export function WeeklyChart({ data }: WeeklyChartProps) {
  const W = 560;
  const H = 200;
  const PAD = { top: 16, right: 12, bottom: 28, left: 28 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const max = Math.max(1, ...data.map((d) => d.applied));
  const step = innerW / data.length;
  const barW = Math.min(36, step * 0.55);

  const ticks = Array.from(new Set([0, Math.ceil(max / 2), max]));

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="chart"
      role="img"
      aria-label="Applications sent per week"
    >
      {ticks.map((t) => {
        const y = PAD.top + innerH - (t / max) * innerH;
        return (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} className="grid-line" />
            <text x={PAD.left - 6} y={y + 4} textAnchor="end" className="tick">
              {t}
            </text>
          </g>
        );
      })}
      {data.map((d, i) => {
        const h = (d.applied / max) * innerH;
        const x = PAD.left + i * step + (step - barW) / 2;
        const y = PAD.top + innerH - h;
        return (
          <g key={d.week}>
            <rect
              x={x}
              y={y}
              width={barW}
              height={Math.max(h, d.applied > 0 ? 3 : 0)}
              rx={5}
              className="bar"
            >
              <title>{`${d.label}: ${d.applied} applications`}</title>
            </rect>
            {d.applied > 0 && (
              <text x={x + barW / 2} y={y - 6} textAnchor="middle" className="bar-value">
                {d.applied}
              </text>
            )}
            <text x={PAD.left + i * step + step / 2} y={H - 8} textAnchor="middle" className="tick">
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
