import type { FinanceEvent } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranslation } from "@/i18n";
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
  emptyMessage,
}: FinanceTimelineCardProps) {
  const { t } = useTranslation();
  const resolvedEmptyMessage =
    emptyMessage ??
    t("components.financeTimelineCard.emptyMessage", {
      defaultValue: "No financial events in this period.",
    });
  return (
    <Card>
      <CardHeader className="px-4 pt-4 pb-1">
        <CardTitle className="text-base">
          {t("components.financeTimelineCard.title", { defaultValue: "Recent financial events" })}
        </CardTitle>
        <CardDescription>
          {t("components.financeTimelineCard.description", {
            defaultValue: "Top-ups, fees, credits, commitments, and other non-request charges.",
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-4 pb-4 pt-3">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{resolvedEmptyMessage}</p>
        ) : (
          rows.map((row) => (
            <div
              key={row.id}
              className="border border-border p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{financeEventKindDisplayName(row.eventKind)}</Badge>
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
                      {row.externalInvoiceId ? (
                        <div>
                          {t("components.financeTimelineCard.invoiceLabel", {
                            invoiceId: row.externalInvoiceId,
                            defaultValue: "invoice {{invoiceId}}",
                          })}
                        </div>
                      ) : null}
                      {row.region ? (
                        <div>
                          {t("components.financeTimelineCard.regionLabel", {
                            region: row.region,
                            defaultValue: "region {{region}}",
                          })}
                        </div>
                      ) : null}
                      {row.pricingTier ? (
                        <div>
                          {t("components.financeTimelineCard.tierLabel", {
                            tier: row.pricingTier,
                            defaultValue: "tier {{tier}}",
                          })}
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
                <div className="text-right tabular-nums">
                  <div className="text-sm font-semibold">{formatCents(row.amountCents)}</div>
                  <div className="text-xs text-muted-foreground">{row.currency}</div>
                  {row.estimated ? (
                    <div className="text-[11px] uppercase tracking-[0.12em] text-amber-600">
                      {t("components.financeTimelineCard.estimated", { defaultValue: "estimated" })}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
