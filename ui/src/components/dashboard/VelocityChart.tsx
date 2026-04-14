import { useState } from "react";
import type { VelocityWeek } from "../../api/velocity";

export function VelocityChart({ weeks, onWeekClick }: { weeks: VelocityWeek[]; onWeekClick?: (weekStart: string) => void }) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const maxVal = Math.max(...weeks.map((w) => w.issuesCompleted + w.issuesCancelled), 1);
  const chartW = 400;
  const chartH = 120;
  const barGap = 4;
  const barW = Math.max(4, (chartW - barGap * weeks.length) / weeks.length);
  const labelY = chartH + 14;

  return (
    <div>
      <svg viewBox={`0 0 ${chartW} ${chartH + 24}`} className="w-full" preserveAspectRatio="xMidYMid meet">
        {/* Subtle gridlines */}
        {[0.25, 0.5, 0.75, 1].map((frac) => (
          <line
            key={frac}
            x1={0}
            y1={chartH - chartH * frac}
            x2={chartW}
            y2={chartH - chartH * frac}
            className="stroke-border/30"
            strokeWidth={0.5}
            strokeDasharray="4 4"
          />
        ))}
        {/* Zero baseline */}
        <line x1={0} y1={chartH} x2={chartW} y2={chartH} className="stroke-border/50" strokeWidth={0.5} />
        {weeks.map((w, i) => {
          const total = w.issuesCompleted + w.issuesCancelled;
          const totalH = (total / maxVal) * chartH;
          const completedH = (w.issuesCompleted / maxVal) * chartH;
          const cancelledH = (w.issuesCancelled / maxVal) * chartH;
          const x = i * (barW + barGap) + barGap / 2;

          const d = new Date(w.weekStart);
          const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
          const showLabel = i === 0 || i === weeks.length - 1 || i % 3 === 0;
          const isHovered = hoveredIdx === i;

          return (
            <g
              key={w.weekStart}
              style={{ cursor: onWeekClick ? "pointer" : "default" }}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
              onClick={() => onWeekClick?.(w.weekStart)}
            >
              {isHovered && (
                <rect
                  x={x - 1}
                  y={0}
                  width={barW + 2}
                  height={chartH}
                  className="fill-accent/30"
                  rx={2}
                />
              )}
              {completedH > 0 && (
                <rect
                  x={x}
                  y={chartH - totalH}
                  width={barW}
                  height={completedH}
                  rx={2}
                  className={isHovered ? "fill-emerald-400" : "fill-emerald-500"}
                />
              )}
              {cancelledH > 0 && (
                <rect
                  x={x}
                  y={chartH - cancelledH}
                  width={barW}
                  height={cancelledH}
                  rx={2}
                  className="fill-muted-foreground/30"
                />
              )}
              {total === 0 && (
                <rect
                  x={x}
                  y={chartH - 2}
                  width={barW}
                  height={2}
                  rx={1}
                  className="fill-muted/30"
                />
              )}
              {showLabel && (
                <text
                  x={x + barW / 2}
                  y={labelY}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[10px]"
                >
                  {label}
                </text>
              )}
              {isHovered && (
                <g>
                  <rect
                    x={Math.max(0, Math.min(chartW - 110, x + barW / 2 - 55))}
                    y={Math.max(0, chartH - totalH - 36)}
                    width={110}
                    height={28}
                    rx={4}
                    className="fill-popover stroke-border"
                    strokeWidth={0.5}
                  />
                  <text
                    x={Math.max(55, Math.min(chartW - 55, x + barW / 2))}
                    y={Math.max(12, chartH - totalH - 18)}
                    textAnchor="middle"
                    className="fill-foreground text-[7px] font-medium"
                  >
                    {label}: {w.issuesCompleted}done, {w.issuesCancelled}cancelled
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </svg>
      <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
          Completed
        </span>
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30 shrink-0" />
          Cancelled
        </span>
        {onWeekClick && (
          <span className="ml-auto text-[10px] text-muted-foreground/80">Click a bar to filter missions</span>
        )}
      </div>
    </div>
  );
}
