import type { FinanceByKind } from "@paperclipai/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { financeEventKindDisplayName, formatCents } from "@/lib/utils";
import { useLocale } from "../context/LocaleContext";

interface FinanceKindCardProps {
  rows: FinanceByKind[];
}

export function FinanceKindCard({ rows }: FinanceKindCardProps) {
  const { t } = useLocale();
  return (
    <Card>
      <CardHeader className="px-4 pt-4 pb-1">
        <CardTitle className="text-base">{t("financeKindCard.title")}</CardTitle>
        <CardDescription>{t("financeKindCard.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 px-4 pb-4 pt-3">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("financeKindCard.empty")}</p>
        ) : (
          rows.map((row) => (
            <div
              key={row.eventKind}
              className="flex items-center justify-between gap-3 border border-border px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{financeEventKindDisplayName(row.eventKind)}</div>
                <div className="text-xs text-muted-foreground">
                  {t("financeKindCard.eventCount", { count: row.eventCount, suffix: row.eventCount === 1 ? "" : "s" })} · {t("financeKindCard.billerCount", { count: row.billerCount, suffix: row.billerCount === 1 ? "" : "s" })}
                </div>
              </div>
              <div className="text-right tabular-nums">
                <div className="text-sm font-medium">{formatCents(row.netCents)}</div>
                <div className="text-xs text-muted-foreground">
                  {t("financeKindCard.debits", { amount: formatCents(row.debitCents) })}
                </div>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
