import { getLast14Days, DateLabels, ChartLegend, ChartCard, formatDayLabel } from "./ActivityCharts";
import type { CostDaily } from "../api/costs";

/* ---- Spending Velocity Chart ---- */

export function SpendingVelocityChart({ data }: { data: CostDaily[] }) {
  const days = getLast14Days();

  const grouped = new Map<string, number>();
  for (const day of days) grouped.set(day, 0);
  for (const row of data) {
    const day = row.date.slice(0, 10);
    if (grouped.has(day)) {
      grouped.set(day, (grouped.get(day) ?? 0) + row.costCents);
    }
  }

  const values = Array.from(grouped.values());
  const maxValue = Math.max(...values, 1);
  const avg = values.reduce((a, b) => a + b, 0) / days.length;
  const hasData = values.some(v => v > 0);

  if (!hasData) return <p className="text-xs text-muted-foreground">No spend data</p>;

  return (
    <div>
      <div className="flex items-end gap-[3px] h-20">
        {days.map(day => {
          const cents = grouped.get(day) ?? 0;
          const heightPct = (cents / maxValue) * 100;
          const color = cents === 0
            ? undefined
            : cents > avg * 1.5
              ? "#ef4444"
              : cents > avg * 0.7
                ? "#eab308"
                : "#10b981";
          return (
            <div key={day} className="flex-1 h-full flex flex-col justify-end" title={`${day}: ${cents}c`}>
              {cents > 0 ? (
                <div style={{ height: `${heightPct}%`, minHeight: 2, backgroundColor: color }} />
              ) : (
                <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
              )}
            </div>
          );
        })}
      </div>
      <DateLabels days={days} />
      <ChartLegend items={[
        { color: "#10b981", label: "Normal" },
        { color: "#eab308", label: ">70% avg" },
        { color: "#ef4444", label: ">150% avg" },
      ]} />
    </div>
  );
}

/* ---- Heartbeat Frequency Chart ---- */

const hbColors = {
  success: "#10b981",
  failed: "#ef4444",
  idle: "#6b7280",
  circuit_breaker: "#f59e0b",
} as const;

type HbCategory = keyof typeof hbColors;

export function HeartbeatFrequencyChart({
  data,
  statusBreakdown,
}: {
  data: CostDaily[];
  statusBreakdown?: Map<string, Record<HbCategory, number>>;
}) {
  const days = getLast14Days();

  // If no per-status breakdown provided, just show total heartbeat counts
  const grouped = new Map<string, Record<HbCategory, number>>();
  for (const day of days) grouped.set(day, { success: 0, failed: 0, idle: 0, circuit_breaker: 0 });

  if (statusBreakdown) {
    for (const [day, counts] of statusBreakdown) {
      if (grouped.has(day)) grouped.set(day, counts);
    }
  } else {
    // Fall back to using heartbeat count from daily data as "success"
    for (const row of data) {
      const day = row.date.slice(0, 10);
      const entry = grouped.get(day);
      if (entry) entry.success += row.heartbeats;
    }
  }

  const maxValue = Math.max(
    ...Array.from(grouped.values()).map(v => v.success + v.failed + v.idle + v.circuit_breaker),
    1,
  );
  const hasData = Array.from(grouped.values()).some(
    v => v.success + v.failed + v.idle + v.circuit_breaker > 0,
  );

  if (!hasData) return <p className="text-xs text-muted-foreground">No heartbeat data</p>;

  const categories: HbCategory[] = ["success", "failed", "idle", "circuit_breaker"];

  return (
    <div>
      <div className="flex items-end gap-[3px] h-20">
        {days.map(day => {
          const entry = grouped.get(day)!;
          const total = entry.success + entry.failed + entry.idle + entry.circuit_breaker;
          const heightPct = (total / maxValue) * 100;
          return (
            <div key={day} className="flex-1 h-full flex flex-col justify-end" title={`${day}: ${total} heartbeats`}>
              {total > 0 ? (
                <div className="flex flex-col-reverse gap-px overflow-hidden" style={{ height: `${heightPct}%`, minHeight: 2 }}>
                  {categories.map(cat => entry[cat] > 0 ? (
                    <div key={cat} style={{ flex: entry[cat], backgroundColor: hbColors[cat] }} />
                  ) : null)}
                </div>
              ) : (
                <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
              )}
            </div>
          );
        })}
      </div>
      <DateLabels days={days} />
      <ChartLegend items={[
        { color: hbColors.success, label: "Success" },
        { color: hbColors.failed, label: "Failed" },
        { color: hbColors.idle, label: "Idle" },
        { color: hbColors.circuit_breaker, label: "Breaker" },
      ]} />
    </div>
  );
}
