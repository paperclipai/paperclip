import type { FinanceByKind } from "@paperclipai/shared";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCents } from "@/lib/utils";

interface FinanceKindCardProps {
  rows: FinanceByKind[];
}

export function FinanceKindCard({ rows }: FinanceKindCardProps) {
  const { t } = useTranslation("costs");
  return (
    <Card>
      <CardHeader className="px-4 pt-4 pb-1">
        <CardTitle className="text-base">{t("finance_kind.title")}</CardTitle>
        <CardDescription>{t("finance_kind.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 px-4 pb-4 pt-3">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("finance_kind.no_events")}</p>
        ) : (
          rows.map((row) => (
            <div
              key={row.eventKind}
              className="flex items-center justify-between gap-3 border border-border px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{t(`finance_event_kind.${row.eventKind}`)}</div>
                <div className="text-xs text-muted-foreground">
                  {t("finance_kind.events", { count: row.eventCount })} · {t("finance_kind.billers", { count: row.billerCount })}
                </div>
              </div>
              <div className="text-right tabular-nums">
                <div className="text-sm font-medium">{formatCents(row.netCents)}</div>
                <div className="text-xs text-muted-foreground">
                  {formatCents(row.debitCents)} {t("finance_kind.debits")}
                </div>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
