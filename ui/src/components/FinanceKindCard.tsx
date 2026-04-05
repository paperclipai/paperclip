import type { FinanceByKind } from "@paperclipai/shared";
import { financeEventKindDisplayName, formatCents } from "@/lib/utils";

interface FinanceKindCardProps {
  rows: FinanceByKind[];
}

export function FinanceKindCard({ rows }: FinanceKindCardProps) {
  return (
    <div className="border border-border rounded-lg bg-card">
      <div className="px-4 pt-4 pb-1">
        <p className="text-base font-semibold">Financial event mix</p>
        <p className="text-sm text-muted-foreground">Account-level charges grouped by event kind.</p>
      </div>
      <div className="space-y-2 px-4 pb-4 pt-3">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No finance events in this period.</p>
        ) : (
          rows.map((row) => (
            <div
              key={row.eventKind}
              className="flex items-center justify-between gap-3 border border-border px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{financeEventKindDisplayName(row.eventKind)}</div>
                <div className="text-xs text-muted-foreground">
                  {row.eventCount} event{row.eventCount === 1 ? "" : "s"} · {row.billerCount} biller{row.billerCount === 1 ? "" : "s"}
                </div>
              </div>
              <div className="text-right tabular-nums">
                <div className="text-sm font-medium">{formatCents(row.netCents)}</div>
                <div className="text-xs text-muted-foreground">
                  {formatCents(row.debitCents)} debits
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
