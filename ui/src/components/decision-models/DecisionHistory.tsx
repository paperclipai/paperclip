import { useQuery } from "@tanstack/react-query";
import type { DecisionHistoryEntry } from "@paperclipai/shared";
import { decisionModelsApi } from "@/api/decision-models";
import { Link } from "@/lib/router";
import { formatDateTime, formatTokens, formatDetailedCents } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";

export function DecisionHistoryTable({ entries, fastResponse = false, fastResponsesEnabled = true }: { entries: (DecisionHistoryEntry & { publicationStatus?: string; connectionName?: string | null })[]; fastResponse?: boolean; fastResponsesEnabled?: boolean }) {
  const { t } = useTranslation();
  if (!entries.length) return <p className="text-sm text-muted-foreground">{fastResponse ? t("inbox.decisionHistoryTable.noFastResponses") : t("inbox.decisionHistoryTable.noDecisionRequests")} <Link to={fastResponse && !fastResponsesEnabled ? "/company/settings/instance/experimental" : "/company/settings/connections"} className="underline underline-offset-4">{fastResponse ? fastResponsesEnabled ? t("inbox.decisionHistoryTable.configureFastResponse") : t("inbox.decisionHistoryTable.enableFastResponses") : t("inbox.decisionHistoryTable.configureDecisionModel")}</Link> {t("inbox.decisionHistoryTable.toRunTest")}</p>;
  return <div className="space-y-3">
    <p className="text-xs text-muted-foreground">{t("inbox.decisionHistoryTable.recentRequests")}</p>
    <div className="overflow-x-auto"><table className="w-full text-sm" aria-label={fastResponse ? t("inbox.decisionHistoryTable.fastResponsesLabel") : t("inbox.decisionHistoryTable.decisionRequestsLabel")}>
      <thead><tr className="border-b border-border text-muted-foreground">{[t("inbox.decisionHistoryTable.when"), t("inbox.decisionHistoryTable.responsible"), t("inbox.decisionHistoryTable.task"), ...(fastResponse ? [t("inbox.decisionHistoryTable.connection")] : []), t("inbox.decisionHistoryTable.model"), t("inbox.decisionHistoryTable.status"), t("inbox.decisionHistoryTable.duration"), t("inbox.decisionHistoryTable.tokensInOut"), t("inbox.decisionHistoryTable.cost")].map(label => <th key={label} className="px-3 py-2 text-left font-medium">{label}</th>)}</tr></thead>
      <tbody>{entries.map(row => <tr key={row.id} className="border-b border-border last:border-0">
        <td className="px-3 py-3"><div className="whitespace-nowrap">{formatDateTime(row.startedAt)}</div><div className="text-xs text-muted-foreground">{row.feature === "settings.test" ? t("inbox.decisionHistoryTable.setupTest") : row.feature}</div></td>
        <td className="px-3 py-3">{row.actorType === "system" ? t("inbox.decisionHistoryTable.paperclipServices") : row.userName ?? (row.responsibleUserId === "local-board" ? t("inbox.decisionHistoryTable.board") : t("inbox.decisionHistoryTable.formerUser"))}</td>
        <td className="px-3 py-3">{row.issueId ? <Link className="underline underline-offset-4" to={`/issues/${row.issueIdentifier ?? row.issueId}`}>{row.issueIdentifier ?? t("inbox.decisionHistoryTable.viewTask")}</Link> : "—"}</td>
        {fastResponse && <td className="px-3 py-3">{row.connectionName ?? (row.connectionId ? "Removed connection" : "—")}</td>}
        <td className="px-3 py-3 font-mono text-xs">{row.model}</td>
        <td className="px-3 py-3"><div>{row.status === "succeeded" ? t("inbox.decisionHistoryTable.succeeded") : row.status === "running" ? t("inbox.decisionHistoryTable.running") : row.status === "unknown" ? t("inbox.decisionHistoryTable.unresolved") : row.status === "skipped" ? t("inbox.decisionHistoryTable.skipped") : row.status === "pending" ? t("inbox.decisionHistoryTable.pending") : t("inbox.decisionHistoryTable.failed")}</div>{row.publicationStatus && <div className="text-xs text-muted-foreground">{row.publicationStatus}</div>}{row.errorCode && <div className="text-xs text-muted-foreground">{row.errorCode.replaceAll("_", " ")}</div>}</td>
        <td className="px-3 py-3 font-mono">{row.durationMs === null ? "—" : `${(row.durationMs / 1000).toFixed(1)}s`}</td>
        <td className="whitespace-nowrap px-3 py-3 font-mono">{row.inputTokens === null ? "—" : formatTokens(row.inputTokens)} / {row.outputTokens === null ? "—" : formatTokens(row.outputTokens)}</td>
        <td className="px-3 py-3 font-mono"><div>{row.costCents === null ? t("inbox.decisionHistoryTable.unknown") : formatDetailedCents(row.costCents)}</div>{row.costStatus !== "unpriced" && row.costStatus && <span className="text-xs text-muted-foreground">{row.costStatus === "estimated" ? t("inbox.decisionHistoryTable.estimated") : t("inbox.decisionHistoryTable.reported")}</span>}</td>
      </tr>)}</tbody>
    </table></div>
  </div>;
}
export function DecisionHistory({ companyId, from, to }: { companyId: string; from?: string | null; to?: string | null }) {
  const query = useQuery({ queryKey: ["decision-history", companyId, from, to], queryFn: () => decisionModelsApi.history(companyId, from, to), refetchInterval: q => q.state.data?.some(row => row.status === "running") ? 5000 : false });
  const { t } = useTranslation();
  if (query.isPending) return <p className="text-sm text-muted-foreground">{t("inbox.decisionHistory.loading")}</p>;
  if (query.error) return <div role="alert" className="space-y-2"><p className="text-sm text-destructive">{t("inbox.decisionHistory.loadError")}</p><Button variant="outline" onClick={() => void query.refetch()}>{t("inbox.decisionHistory.tryAgain")}</Button></div>;
  return <DecisionHistoryTable entries={query.data ?? []} />;
}
