// Trend Chart Components (pure SVG, no external deps)

const CHART_W = 560;
const CHART_H = 80;
const CHART_PAD_X = 0;
const CHART_PAD_Y = 8;

export function WeeklyLineChart({
  data,
  formatValue,
}: {
  data: Array<{ label: string; value: number }>;
  formatValue: (v: number) => string;
}) {
  const max = Math.max(...data.map((d) => d.value), 1);
  const n = data.length;
  const stepX = (CHART_W - CHART_PAD_X * 2) / Math.max(n - 1, 1);
  const points = data.map((d, i) => {
    const x = CHART_PAD_X + i * stepX;
    const y =
      CHART_PAD_Y + (1 - d.value / max) * (CHART_H - CHART_PAD_Y * 2);
    return { x, y, d };
  });
  const pathD = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H + 20}`}
        className="w-full"
        aria-label="Weekly spend trend chart"
      >
        <line
          x1={CHART_PAD_X}
          y1={CHART_PAD_Y + (CHART_H - CHART_PAD_Y * 2) / 2}
          x2={CHART_W - CHART_PAD_X}
          y2={CHART_PAD_Y + (CHART_H - CHART_PAD_Y * 2) / 2}
          stroke="currentColor"
          strokeOpacity={0.1}
          strokeWidth={1}
        />
        <path
          d={pathD}
          fill="none"
          stroke="hsl(var(--primary))"
          strokeWidth={2}
          strokeLinejoin="round"
        />
        {points.map((p, i) => (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r={3} fill="hsl(var(--primary))" />
            {i === n - 1 && (
              <text
                x={p.x}
                y={p.y - 6}
                textAnchor="middle"
                fontSize={9}
                fill="currentColor"
                opacity={0.7}
              >
                {formatValue(p.d.value)}
              </text>
            )}
            <text
              x={p.x}
              y={CHART_H + 18}
              textAnchor="middle"
              fontSize={8}
              fill="currentColor"
              opacity={0.5}
            >
              {p.d.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

export function WeeklyBarChart({
  data,
}: {
  data: Array<{ label: string; value: number }>;
}) {
  const max = Math.max(...data.map((d) => d.value), 1);
  const n = data.length;
  const totalW = CHART_W - CHART_PAD_X * 2;
  const barW = (totalW / n) * 0.65;
  const gap = (totalW / n) * 0.35;

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H + 20}`}
        className="w-full"
        aria-label="Weekly missions completed bar chart"
      >
        {data.map((d, i) => {
          const barH =
            max > 0
              ? (d.value / max) * (CHART_H - CHART_PAD_Y * 2)
              : 0;
          const x = CHART_PAD_X + i * (barW + gap);
          const y = CHART_PAD_Y + (CHART_H - CHART_PAD_Y * 2) - barH;
          return (
            <g key={i}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={barH}
                rx={2}
                fill={i === n - 1 ? "hsl(var(--primary))" : "hsl(var(--primary) / 0.4)"}
              />
              {d.value > 0 && (
                <text
                  x={x + barW / 2}
                  y={y - 3}
                  textAnchor="middle"
                  fontSize={9}
                  fill="currentColor"
                  opacity={0.8}
                >
                  {d.value}
                </text>
              )}
              <text
                x={x + barW / 2}
                y={CHART_H + 18}
                textAnchor="middle"
                fontSize={8}
                fill="currentColor"
                opacity={0.5}
              >
                {d.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
