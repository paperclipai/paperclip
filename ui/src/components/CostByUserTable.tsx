import { t, useTranslation } from "@/i18n";
import type { CostByUserReport } from "@paperclipai/shared";
import { CostAmount } from "./CostAmount";
import { Identity } from "./Identity";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { formatNumber, formatTokens } from "../lib/utils";

export function CostByUserTable({ report }: { report: CostByUserReport }) {
  useTranslation();
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="gap-0 px-5">
        <CardTitle className="text-base">{t("oct19Core.coverage031")}</CardTitle>
      </CardHeader>
      <CardContent className="px-5">
        <div className="overflow-x-auto">
          <table aria-label={t("oct19Core.coverage032")} className="w-full text-sm">
            <thead className="text-muted-foreground">
              <tr className="border-b border-border">
                <th scope="col" className="py-2 pr-4 text-left font-medium">{t("oct19Core.coverage033")}</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">{t("oct19Core.coverage034")}</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">{t("oct19Core.coverage035")}</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">{t("oct19Core.coverage036")}</th>
                <th scope="col" className="py-2 pl-4 text-right font-medium">{t("oct19Core.cost")}</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.length === 0 && (
                <tr><td colSpan={5} className="py-3 text-muted-foreground">{t("oct19Core.coverage037")}</td></tr>
              )}
              {report.rows.map(row => (
                <tr key={row.userId ?? "unattributed"} className="border-b border-border last:border-0">
                  <th scope="row" className="py-3 pr-4 text-left font-normal">
                    {row.userId ? <Identity name={row.userName ?? t("oct19Core.coverage038")} avatarUrl={row.userImage} /> : t("oct19Core.coverage039")}
                  </th>
                  <td className="px-4 py-3 text-right tabular-nums">{formatNumber(row.runCount)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatTokens(row.inputTokens + row.cachedInputTokens)}
                    {row.cachedInputTokens > 0 && <div className="whitespace-nowrap text-xs text-muted-foreground">{t("oct19Core.costCachedTokens", { tokens: formatTokens(row.cachedInputTokens) })}</div>}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatTokens(row.outputTokens)}</td>
                  <td className="py-3 pl-4 text-right tabular-nums">
                    <CostAmount costCents={row.costCents} eventCount={row.eventCount} estimatedEventCount={row.estimatedEventCount} unpricedEventCount={row.unpricedEventCount} />
                    {row.unpricedEventCount > 0 && <div className="whitespace-nowrap text-xs text-muted-foreground">{t("oct19Core.unpricedUserCharges", { count: row.unpricedEventCount })}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {report.rows.some(row => row.userId === null) && (
          <p className="mt-3 text-xs text-muted-foreground">{t("oct19Core.coverage040")}</p>
        )}
      </CardContent>
    </Card>
  );
}
