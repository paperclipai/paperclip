import { FinancialEventEntry } from "./FinancialEventEntry";
import type { FinanceEvent } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  financeDirectionDisplayName,
  financeEventKindDisplayName,
  formatCents,
  formatDateTime,
  providerDisplayName,
} from "@/lib/utils";

interface FinanceTimelineCardProps {
  rows: FinanceEvent[];
  companyId?: string;
  emptyMessage?: string;
}

export function FinanceTimelineCard({
  rows,
  companyId,
  emptyMessage = "No financial events recorded in this period. Charges and credits appear after they are imported or recorded; agent runs do not add them automatically.",
}: FinanceTimelineCardProps) {
  return (
    <Card>
      <CardHeader className="px-4 pt-4 pb-1">
        <CardTitle className="text-base">Recent financial events</CardTitle>
        <CardDescription>Provider charges, subscriptions, fees, and credits. Reported separately from run-cost estimates.</CardDescription>
        {companyId && <FinancialEventEntry companyId={companyId} />}
      </CardHeader>
      <CardContent className="space-y-3 px-4 pb-4 pt-3">
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
                    <Badge variant="secondary">{row.metadataJson?.source === "provider_cost_report" ? "Provider cost report" : financeEventKindDisplayName(row.eventKind)}</Badge>
                    <Badge variant={row.direction === "credit" ? "outline" : "secondary"}>
                      {financeDirectionDisplayName(row.direction)}
                    </Badge>
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
                  <div className="text-sm font-semibold">{formatCents(row.amountCents, row.currency)}</div>
                  <div className="text-xs text-muted-foreground">{row.currency}</div>
                  {row.estimated ? <div className="text-(length:--text-micro) uppercase tracking-(--tracking-eyebrow) text-amber-600">estimated</div> : null}
                </div>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
