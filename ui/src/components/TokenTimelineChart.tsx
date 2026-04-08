import { useMemo, useState } from "react";
import type { CostByAgentDaily } from "@paperclipai/shared";
import { formatTokens } from "../lib/utils";

/** Stable palette for up to 8 agents; wraps if more. */
const AGENT_COLORS = [
  "#3b82f6", // blue
  "#10b981", // emerald
  "#f59e0b", // amber
  "#8b5cf6", // violet
  "#ef4444", // red
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#84cc16", // lime
];

const CHART_HEIGHT = 140;
const Y_TICK_COUNT = 4;

function getLast14Days(): string[] {
  return Array.from({ length: 14 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (13 - i));
    return d.toISOString().slice(0, 10);
  });
}

function formatDayLabel(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** Round up to a nice number for the Y axis. */
function niceMax(value: number): number {
  if (value <= 0) return 1000;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const normalized = value / magnitude;
  if (normalized <= 1) return magnitude;
  if (normalized <= 2) return 2 * magnitude;
  if (normalized <= 5) return 5 * magnitude;
  return 10 * magnitude;
}

interface HoverInfo {
  agentId: string;
  agentName: string;
  tokens: number;
  day: string;
  dayTotal: number;
  color: string;
  x: number;
  y: number;
}

export function TokenTimelineChart({ rows }: { rows: CostByAgentDaily[] }) {
  const days = useMemo(() => getLast14Days(), []);
  const [hover, setHover] = useState<HoverInfo | null>(null);

  const { agentNames, agentIds, grouped, maxTotal } = useMemo(() => {
    const agentTotals = new Map<string, { name: string; total: number }>();
    for (const row of rows) {
      const entry = agentTotals.get(row.agentId) ?? {
        name: row.agentName ?? row.agentId,
        total: 0,
      };
      entry.total += row.totalTokens;
      agentTotals.set(row.agentId, entry);
    }
    const sorted = [...agentTotals.entries()].sort(
      (a, b) => b[1].total - a[1].total,
    );
    const ids = sorted.map(([id]) => id);
    const names = new Map(sorted.map(([id, v]) => [id, v.name]));

    const map = new Map<string, Map<string, number>>();
    for (const day of days) map.set(day, new Map());
    for (const row of rows) {
      const dayMap = map.get(row.date);
      if (!dayMap) continue;
      dayMap.set(row.agentId, (dayMap.get(row.agentId) ?? 0) + row.totalTokens);
    }

    let max = 1;
    for (const dayMap of map.values()) {
      let dayTotal = 0;
      for (const v of dayMap.values()) dayTotal += v;
      if (dayTotal > max) max = dayTotal;
    }

    return { agentNames: names, agentIds: ids, grouped: map, maxTotal: niceMax(max) };
  }, [rows, days]);

  const yTicks = useMemo(() => {
    const ticks: number[] = [];
    for (let i = 0; i <= Y_TICK_COUNT; i++) {
      ticks.push(Math.round((maxTotal / Y_TICK_COUNT) * i));
    }
    return ticks;
  }, [maxTotal]);

  const hasData = rows.length > 0;

  if (!hasData) {
    return (
      <p className="text-xs text-muted-foreground">No token usage data yet.</p>
    );
  }

  return (
    <div className="relative" onMouseLeave={() => setHover(null)}>
      {/* Chart area with Y axis */}
      <div className="flex">
        {/* Y axis labels */}
        <div
          className="flex flex-col justify-between pr-2 shrink-0"
          style={{ height: CHART_HEIGHT }}
        >
          {[...yTicks].reverse().map((tick) => (
            <span
              key={tick}
              className="text-[9px] text-muted-foreground tabular-nums leading-none text-right"
              style={{ minWidth: 32 }}
            >
              {formatTokens(tick)}
            </span>
          ))}
        </div>

        {/* Bars */}
        <div className="flex items-end gap-[3px] flex-1" style={{ height: CHART_HEIGHT }}>
          {days.map((day) => {
            const dayMap = grouped.get(day)!;
            let dayTotal = 0;
            for (const v of dayMap.values()) dayTotal += v;
            const heightPct = (dayTotal / maxTotal) * 100;

            return (
              <div
                key={day}
                className="flex-1 h-full flex flex-col justify-end"
              >
                {dayTotal > 0 ? (
                  <div
                    className="flex flex-col-reverse overflow-hidden rounded-t-sm"
                    style={{ height: `${heightPct}%`, minHeight: 2 }}
                  >
                    {agentIds.map((agentId, i) => {
                      const tokens = dayMap.get(agentId) ?? 0;
                      if (tokens <= 0) return null;
                      const color = AGENT_COLORS[i % AGENT_COLORS.length];
                      return (
                        <div
                          key={agentId}
                          className="transition-opacity duration-75"
                          style={{
                            flex: tokens,
                            backgroundColor: color,
                            opacity:
                              hover && (hover.agentId !== agentId || hover.day !== day)
                                ? 0.35
                                : 1,
                          }}
                          onMouseEnter={(e) => {
                            const rect = (e.target as HTMLElement).getBoundingClientRect();
                            const containerRect = (e.target as HTMLElement).closest(".relative")!.getBoundingClientRect();
                            setHover({
                              agentId,
                              agentName: agentNames.get(agentId) ?? agentId,
                              tokens,
                              day,
                              dayTotal,
                              color,
                              x: rect.left - containerRect.left + rect.width / 2,
                              y: rect.top - containerRect.top,
                            });
                          }}
                        />
                      );
                    })}
                  </div>
                ) : (
                  <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* X-axis labels */}
      <div className="flex gap-[3px] mt-1.5" style={{ paddingLeft: 40 }}>
        {days.map((day, i) => (
          <div key={day} className="flex-1 text-center">
            {i === 0 || i === 6 || i === 13 ? (
              <span className="text-[9px] text-muted-foreground tabular-nums">
                {formatDayLabel(day)}
              </span>
            ) : null}
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 mt-2">
        {agentIds.map((id, i) => (
          <span
            key={id}
            className="flex items-center gap-1 text-[9px] text-muted-foreground"
          >
            <span
              className="h-1.5 w-1.5 rounded-full shrink-0"
              style={{
                backgroundColor: AGENT_COLORS[i % AGENT_COLORS.length],
              }}
            />
            {agentNames.get(id)}
          </span>
        ))}
      </div>

      {/* Tooltip */}
      {hover && (
        <div
          className="absolute z-50 pointer-events-none rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md"
          style={{
            left: hover.x,
            top: hover.y - 8,
            transform: "translate(-50%, -100%)",
          }}
        >
          <div className="flex items-center gap-1.5 font-medium">
            <span
              className="h-2 w-2 rounded-full shrink-0"
              style={{ backgroundColor: hover.color }}
            />
            {hover.agentName}
          </div>
          <div className="mt-1 tabular-nums text-muted-foreground">
            {formatTokens(hover.tokens)} tokens
          </div>
          <div className="tabular-nums text-muted-foreground">
            {formatDayLabel(hover.day)} &middot; day total {formatTokens(hover.dayTotal)}
          </div>
        </div>
      )}
    </div>
  );
}
