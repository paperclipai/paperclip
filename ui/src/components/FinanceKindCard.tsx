import { t, useTranslation, Trans } from "@/i18n";
import type { FinanceByKind } from "@paperclipai/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { financeEventKindDisplayName, formatCents } from "@/lib/utils";

interface FinanceKindCardProps {
  rows: FinanceByKind[];
}

export function FinanceKindCard({ rows }: FinanceKindCardProps) {
  useTranslation("task-components");
  return (
    <Card>
      <CardHeader className="px-4 pt-4 pb-1">
        <CardTitle className="text-base">{t("task-components:financialEventMix_ca44745d")}</CardTitle>
        <CardDescription>{t("task-components:accountLevelChargesGroupedByEventKind_61cc3a6e")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 px-4 pb-4 pt-3">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("task-components:noFinanceEventsInThisPeriod_66810e6a")}</p>
        ) : (
          rows.map((row) => (
            <div
              key={`${row.eventKind}:${row.currency}`}
              className="flex items-center justify-between gap-3 border border-border px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{financeEventKindDisplayName(row.eventKind)}</div>
                <div className="text-xs text-muted-foreground"><Trans ns="task-components" i18nKey="sentence_429e7aad6f03" components={{ part1: <>{row.eventCount}</>, part2: <>{t("task-components:pluralSuffix", { count: row.eventCount })}</>, part3: <>{row.billerCount}</>, part4: <>{t("task-components:pluralSuffix", { count: row.billerCount })}</> }} /></div>
              </div>
              <div className="text-right tabular-nums">
                <div className="text-sm font-medium">{formatCents(row.netCents, row.currency)}</div>
                <div className="text-xs text-muted-foreground"><Trans ns="task-components" i18nKey="sentence_0b23fc49f8f7" components={{ part1: <>{formatCents(row.debitCents, row.currency)}</> }} /></div>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
