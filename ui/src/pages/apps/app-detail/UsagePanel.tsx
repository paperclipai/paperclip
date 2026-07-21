import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, BarChart3 } from "lucide-react";
import type { ConnectionUsageDailyBucket } from "@paperclipai/shared";

import { toolsApi } from "@/api/tools";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Range = "7d" | "30d";

function MiniBarChart({
  buckets,
  getValue,
  color,
  label,
}: {
  buckets: ConnectionUsageDailyBucket[];
  getValue: (b: ConnectionUsageDailyBucket) => number;
  color: string;
  label: string;
}) {
  const values = buckets.map(getValue);
  const max = Math.max(...values, 1);
  const total = values.reduce((a, b) => a + b, 0);

  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        <span className="text-xl font-bold tabular-nums text-foreground">{fmt(total)}</span>
      </div>
      <div className="flex h-20 items-end gap-0.5">
        {buckets.map((bucket, i) => {
          const v = getValue(bucket);
          const height = max === 0 ? 0 : Math.max(v === 0 ? 0 : 2, Math.round((v / max) * 80));
          const date = new Date(bucket.date);
          const dayLabel = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
          return (
            <div key={i} className="group relative flex flex-1 flex-col justify-end" title={`${dayLabel}: ${v}`}>
              <div
                className={cn("w-full rounded-sm transition-opacity group-hover:opacity-80", color)}
                style={{ height: `${height}px` }}
              />
              {/* tooltip on hover */}
              <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded bg-popover px-2 py-1 text-xs text-popover-foreground shadow group-hover:block">
                {dayLabel}: {v}
              </div>
            </div>
          );
        })}
      </div>
      {buckets.length > 0 && (
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>
            {new Date(buckets[0].date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          </span>
          <span>
            {new Date(buckets[buckets.length - 1].date).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })}
          </span>
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
      <BarChart3 className="h-8 w-8 opacity-40" />
      <p className="text-sm">No usage data yet for this period.</p>
    </div>
  );
}

export function UsagePanel({ connectionId }: { connectionId: string }) {
  const [range, setRange] = useState<Range>("7d");

  const usageQuery = useQuery({
    queryKey: queryKeys.tools.connectionUsage(connectionId, range),
    queryFn: () => toolsApi.getConnectionUsage(connectionId, range),
  });

  const buckets = usageQuery.data?.buckets ?? [];
  const hasData = buckets.some(
    (b) => b.issuances.total > 0 || b.invocations.total > 0 || b.deliveries.received + b.deliveries.forwarded > 0,
  );

  return (
    <div className="space-y-4">
      {/* Range picker */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Usage over time</h3>
        <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-0.5">
          {(["7d", "30d"] as const).map((r) => (
            <Button
              key={r}
              variant="ghost"
              size="sm"
              onClick={() => setRange(r)}
              className={cn(
                "h-6 rounded-md px-2.5 text-xs",
                range === r && "bg-background text-foreground shadow-sm",
              )}
            >
              {r === "7d" ? "7 days" : "30 days"}
            </Button>
          ))}
        </div>
      </div>

      {usageQuery.isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : !hasData ? (
        <EmptyState />
      ) : (
        <div className="grid gap-4 sm:grid-cols-3">
          <MiniBarChart
            buckets={buckets}
            getValue={(b) => b.issuances.total}
            color="bg-blue-500/80 dark:bg-blue-400/70"
            label="Token issuances"
          />
          <MiniBarChart
            buckets={buckets}
            getValue={(b) => b.invocations.total}
            color="bg-violet-500/80 dark:bg-violet-400/70"
            label="Tool invocations"
          />
          <MiniBarChart
            buckets={buckets}
            getValue={(b) => b.deliveries.received + b.deliveries.forwarded}
            color="bg-emerald-500/80 dark:bg-emerald-400/70"
            label="Deliveries"
          />
        </div>
      )}
    </div>
  );
}
