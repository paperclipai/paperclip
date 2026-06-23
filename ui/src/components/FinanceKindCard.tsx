import type { FinanceByKind } from "@paperclipai/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranslation } from "@/i18n";
import { financeEventKindDisplayName, formatCents } from "@/lib/utils";

interface FinanceKindCardProps {
  rows: FinanceByKind[];
}

export function FinanceKindCard({ rows }: FinanceKindCardProps) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader className="px-4 pt-4 pb-1">
        <CardTitle className="text-base">
          {t("components.financeKindCard.title", { defaultValue: "Financial event mix" })}
        </CardTitle>
        <CardDescription>
          {t("components.financeKindCard.description", {
            defaultValue: "Account-level charges grouped by event kind.",
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 px-4 pb-4 pt-3">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("components.financeKindCard.empty", { defaultValue: "No finance events in this period." })}
          </p>
        ) : (
          rows.map((row) => (
            <div
              key={row.eventKind}
              className="flex items-center justify-between gap-3 border border-border px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{financeEventKindDisplayName(row.eventKind)}</div>
                <div className="text-xs text-muted-foreground">
                  {t("components.financeKindCard.eventCount", {
                    count: row.eventCount,
                    defaultValue: "{{count}} event",
                    defaultValue_other: "{{count}} events",
                  })}{" "}
                  ·{" "}
                  {t("components.financeKindCard.billerCount", {
                    count: row.billerCount,
                    defaultValue: "{{count}} biller",
                    defaultValue_other: "{{count}} billers",
                  })}
                </div>
              </div>
              <div className="text-right tabular-nums">
                <div className="text-sm font-medium">{formatCents(row.netCents)}</div>
                <div className="text-xs text-muted-foreground">
                  {t("components.financeKindCard.debits", {
                    amount: formatCents(row.debitCents),
                    defaultValue: "{{amount}} debits",
                  })}
                </div>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
