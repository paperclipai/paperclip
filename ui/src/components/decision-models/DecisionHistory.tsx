import { t, useTranslation } from "@/i18n";
import { useQuery } from "@tanstack/react-query";
import type { DecisionHistoryEntry } from "@paperclipai/shared";
import { decisionModelsApi } from "@/api/decision-models";
import { Link } from "@/lib/router";
import { formatDateTime, formatTokens, formatDetailedCents, formatNumber } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { decisionHistoryValueDisplay } from "@/lib/decision-history-display";

export function DecisionHistoryTable({ entries, fastResponse = false, fastResponsesEnabled = true }: { entries: (DecisionHistoryEntry & { publicationStatus?: string; connectionName?: string | null })[]; fastResponse?: boolean; fastResponsesEnabled?: boolean }) {
  useTranslation();
  if (!entries.length) return <p className="text-sm text-muted-foreground">{fastResponse ? t("oct19Core.newSurface028") : t("oct19Core.newSurface029")} <Link to={fastResponse && !fastResponsesEnabled ? "/company/settings/instance/experimental" : "/company/settings/connections"} className="underline underline-offset-4">{fastResponse ? fastResponsesEnabled ? t("oct19Core.newSurface030") : t("oct19Core.newSurface032") : t("oct19Core.newSurface031")}</Link>{t("oct19Core.runTestLinkSuffix")}</p>;
  return <div className="space-y-3">
    <p className="text-xs text-muted-foreground">{t("oct19Core.newSurface033")}</p>
    <div className="overflow-x-auto"><table className="w-full text-sm" aria-label={fastResponse ? t("oct19Core.fastResponses") : t("oct19Core.newSurface034")}>
      <thead><tr className="border-b border-border text-muted-foreground">{[t("oct19Core.whenFeature"), t("oct19Core.responsible"), t("oct19Core.task"), ...(fastResponse ? [t("oct19Core.connection")] : []), t("oct19Core.newSurface085"), t("oct19Core.status"), t("oct19Core.duration"), t("oct19Core.tokensInOut"), t("oct19Core.cost")].map(label => <th key={label} className="px-3 py-2 text-left font-medium">{label}</th>)}</tr></thead>
      <tbody>{entries.map(row => <tr key={row.id} className="border-b border-border last:border-0">
        <td className="px-3 py-3"><div className="whitespace-nowrap">{formatDateTime(row.startedAt)}</div><div className="text-xs text-muted-foreground">{decisionHistoryValueDisplay("feature", row.feature)}</div></td>
        <td className="px-3 py-3">{row.actorType === "system" ? t("oct19Core.paperclipServices") : row.userName ?? (row.responsibleUserId === "local-board" ? t("oct19Core.newSurface036") : t("oct19Core.newSurface037"))}</td>
        <td className="px-3 py-3">{row.issueId ? <Link className="underline underline-offset-4" to={`/issues/${row.issueIdentifier ?? row.issueId}`}>{row.issueIdentifier ?? t("oct19Core.newSurface038")}</Link> : "—"}</td>
        {fastResponse && <td className="px-3 py-3">{row.connectionName ?? (row.connectionId ? t("oct19Core.newSurface039") : "—")}</td>}
        <td className="px-3 py-3 font-mono text-xs">{row.model}</td>
        <td className="px-3 py-3"><div>{row.status === "succeeded" ? t("oct19Core.newSurface040") : row.status === "running" ? t("oct19Core.newSurface041") : row.status === "unknown" ? t("oct19Core.newSurface042") : row.status === "skipped" ? t("oct19Core.newSurface043") : row.status === "pending" ? t("oct19Core.newSurface044") : t("oct19Core.newSurface045")}</div>{row.publicationStatus && <div className="text-xs text-muted-foreground">{decisionHistoryValueDisplay("publication", row.publicationStatus)}</div>}{row.errorCode && <div className="text-xs text-muted-foreground">{decisionHistoryValueDisplay("error", row.errorCode)}</div>}</td>
        <td className="px-3 py-3 font-mono">{row.durationMs === null ? "—" : t("oct19Core.secondsShort", { seconds: formatNumber(row.durationMs / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}</td>
        <td className="whitespace-nowrap px-3 py-3 font-mono">{row.inputTokens === null ? "—" : formatTokens(row.inputTokens)} / {row.outputTokens === null ? "—" : formatTokens(row.outputTokens)}</td>
        <td className="px-3 py-3 font-mono"><div>{row.costCents === null ? t("oct19Core.newSurface046") : formatDetailedCents(row.costCents)}</div>{row.costStatus !== "unpriced" && row.costStatus && <span className="text-xs text-muted-foreground">{row.costStatus === "estimated" ? t("oct19Core.newSurface047") : t("oct19Core.newSurface048")}</span>}</td>
      </tr>)}</tbody>
    </table></div>
  </div>;
}
export function DecisionHistory({ companyId, from, to }: { companyId: string; from?: string | null; to?: string | null }) {
  useTranslation();
  const query = useQuery({ queryKey: ["decision-history", companyId, from, to], queryFn: () => decisionModelsApi.history(companyId, from, to), refetchInterval: q => q.state.data?.some(row => row.status === "running") ? 5000 : false });
  if (query.isPending) return <p className="text-sm text-muted-foreground">{t("oct19Core.newSurface049")}</p>;
  if (query.error) return <div role="alert" className="space-y-2"><p className="text-sm text-destructive">{t("oct19Core.newSurface050")}</p><Button variant="outline" onClick={() => void query.refetch()}>{t("oct19Core.tryAgain")}</Button></div>;
  return <DecisionHistoryTable entries={query.data ?? []} />;
}
