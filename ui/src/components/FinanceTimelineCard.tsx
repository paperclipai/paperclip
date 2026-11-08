import { t, useTranslation, Trans } from "@/i18n";
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
  emptyMessage?: string;
}

export function FinanceTimelineCard({
  rows,
  emptyMessage = t("final-components-b:FinanceTimelineCard.No_financial_events_recorded_in_this_period_Events_appear_when_re_1901c3"),
}: FinanceTimelineCardProps) {
  useTranslation("task-components");
  return (
    <Card>
      <CardHeader className="px-4 pt-4 pb-1">
        <CardTitle className="text-base">{t("task-components:recentFinancialEvents_7adc281a")}</CardTitle>
        <CardDescription>{t("task-components:providerChargesSubscriptionsFeesAndCreditsReported_5498cc46")}</CardDescription>
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
                    <Badge variant="secondary">{row.metadataJson?.source === "provider_cost_report" ? t("task-components:providerCostReport_6fc18a35") : financeEventKindDisplayName(row.eventKind)}</Badge>
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
                      {row.externalInvoiceId ? <div><Trans ns="task-components" i18nKey="sentence_82d09453f333" components={{ part1: <>{row.externalInvoiceId}</> }} /></div> : null}
                      {row.region ? <div><Trans ns="task-components" i18nKey="sentence_fff43575d6f9" components={{ part1: <>{row.region}</> }} /></div> : null}
                      {row.pricingTier ? <div><Trans ns="task-components" i18nKey="sentence_746d1ad5ff05" components={{ part1: <>{row.pricingTier}</> }} /></div> : null}
                    </div>
                  )}
                </div>
                <div className="text-right tabular-nums">
                  <div className="text-sm font-semibold">{formatCents(row.amountCents, row.currency)}</div>
                  <div className="text-xs text-muted-foreground">{row.currency}</div>
                  {row.estimated ? <div className="text-(length:--text-micro) uppercase tracking-(--tracking-eyebrow) text-amber-600">{t("task-components:estimated_d342ed82")}</div> : null}
                </div>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
