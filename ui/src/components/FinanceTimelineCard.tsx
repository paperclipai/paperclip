import type { FinanceEvent } from "@paperclipai/shared";
import {
  financeDirectionDisplayName,
  financeEventKindDisplayName,
  formatCents,
  formatDateTime,
  providerDisplayName,
} from "@/lib/utils";

interface FinanceTimelineCardProps {
  rows: FinanceEvent[];
  emptyMessage?: string;
}

export function FinanceTimelineCard({
  rows,
  emptyMessage = "No financial events in this period.",
}: FinanceTimelineCardProps) {
  return (
    <div className="border border-border rounded-lg bg-card">
      <div className="px-4 pt-4 pb-1">
        <p className="text-base font-semibold">Recent financial events</p>
        <p className="text-sm text-muted-foreground">Top-ups, fees, credits, commitments, and other non-request charges.</p>
      </div>
      <div className="space-y-3 px-4 pb-4 pt-3">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyMessage}</p>
        ) : (
          rows.map((row) => (
            <div
              key={row.id}
              className="border border-border p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs font-medium">
                      {financeEventKindDisplayName(row.eventKind)}
                    </span>
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${row.direction === "credit" ? "border-border text-muted-foreground" : "border-border bg-muted text-muted-foreground"}`}>
                      {financeDirectionDisplayName(row.direction)}
                    </span>
                    <span className="text-xs text-muted-foreground">{formatDateTime(row.occurredAt)}</span>
                  </div>
                  <div className="text-sm font-medium">
                    {providerDisplayName(row.biller)}
                    {row.provider ? ` -> ${providerDisplayName(row.provider)}` : ""}
                    {row.model ? <span className="ml-1 font-mono text-xs text-muted-foreground">{row.model}</span> : null}
                  </div>
                  {(row.description || row.externalInvoiceId || row.region || row.pricingTier) && (
                    <div className="space-y-1 text-xs text-muted-foreground">
                      {row.description ? <div>{row.description}</div> : null}
                      {row.externalInvoiceId ? <div>invoice {row.externalInvoiceId}</div> : null}
                      {row.region ? <div>region {row.region}</div> : null}
                      {row.pricingTier ? <div>tier {row.pricingTier}</div> : null}
                    </div>
                  )}
                </div>
                <div className="text-right tabular-nums">
                  <div className="text-sm font-semibold">{formatCents(row.amountCents)}</div>
                  <div className="text-xs text-muted-foreground">{row.currency}</div>
                  {row.estimated ? <div className="text-[11px] uppercase tracking-[0.12em] text-amber-600">estimated</div> : null}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
