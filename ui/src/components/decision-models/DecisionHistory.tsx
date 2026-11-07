import { useTranslation } from "@/i18n";
import { useQuery } from "@tanstack/react-query";
import type { DecisionHistoryEntry } from "@paperclipai/shared";
import { decisionModelsApi } from "@/api/decision-models";
import { Link } from "@/lib/router";
import { formatDateTime, formatTokens, formatDetailedCents } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export function DecisionHistoryTable({ entries, fastResponse = false, fastResponsesEnabled = true }: { entries: (DecisionHistoryEntry & { publicationStatus?: string; connectionName?: string | null })[]; fastResponse?: boolean; fastResponsesEnabled?: boolean }) {
  const { t } = useTranslation("connections");
  if (!entries.length) return <p className="text-sm text-muted-foreground">{fastResponse ? t("no_fast_responses_in_this_period_9daaa48") : t("no_decision_requests_in_this_period_cf97040")} <Link to={fastResponse && !fastResponsesEnabled ? "/company/settings/instance/experimental" : "/company/settings/connections"} className="underline underline-offset-4">{fastResponse ? fastResponsesEnabled ? t("configure_fast_response_ace284f") : t("enable_experimental_fast_responses_a00490d") : t("configure_a_decision_model_8857190")}</Link>{t("to_run_a_test_84760ac")}</p>;
  return <div className="space-y-3">
    <p className="text-xs text-muted-foreground">{t("recent_requests_inputs_are_not_retained_85a51b1")}</p>
    <div className="overflow-x-auto"><table className="w-full text-sm" aria-label={fastResponse ? t("fast_responses_9fa5be8") : t("decision_requests_1a0854a")}>
      <thead><tr className="border-b border-border text-muted-foreground">{[t("when_feature_bc34006"), t("responsible_96cd625"), t("task_7bb0ddf"), ...(fastResponse ? [t("connection_6512ee1")] : []), t("model_68c2cc7"), t("status_bae7d5b"), t("duration_1370004"), t("tokens_in_out_d03b54f"), t("cost_64ae43e")].map(label => <th key={label} className="px-3 py-2 text-left font-medium">{label}</th>)}</tr></thead>
      <tbody>{entries.map(row => <tr key={row.id} className="border-b border-border last:border-0">
        <td className="px-3 py-3"><div className="whitespace-nowrap">{formatDateTime(row.startedAt)}</div><div className="text-xs text-muted-foreground">{row.feature === "settings.test" ? t("setup_test_624ea17") : row.feature}</div></td>
        <td className="px-3 py-3">{row.actorType === "system" ? t("paperclip_services_f8fc3bb") : row.userName ?? (row.responsibleUserId === "local-board" ? t("board_e879b0b") : t("former_user_10e4f4b"))}</td>
        <td className="px-3 py-3">{row.issueId ? <Link className="underline underline-offset-4" to={`/issues/${row.issueIdentifier ?? row.issueId}`}>{row.issueIdentifier ?? t("view_task_39e023c")}</Link> : "—"}</td>
        {fastResponse && <td className="px-3 py-3">{row.connectionName ?? (row.connectionId ? t("removed_connection_505176c") : "—")}</td>}
        <td className="px-3 py-3 font-mono text-xs">{row.model}</td>
        <td className="px-3 py-3"><div>{row.status === "succeeded" ? t("succeeded_c8fbda9") : row.status === "running" ? t("running_73989d9") : row.status === "unknown" ? t("unresolved_eeccd83") : row.status === "skipped" ? t("skipped_5a000ad") : row.status === "pending" ? t("pending_96f608c") : t("failed_09fef5d")}</div>{row.publicationStatus && <div className="text-xs text-muted-foreground">{row.publicationStatus}</div>}{row.errorCode && <div className="text-xs text-muted-foreground">{row.errorCode.replaceAll("_", " ")}</div>}</td>
        <td className="px-3 py-3 font-mono">{row.durationMs === null ? "—" : t("s_877e2e1", { value: (row.durationMs / 1000).toFixed(1) })}</td>
        <td className="whitespace-nowrap px-3 py-3 font-mono">{row.inputTokens === null ? "—" : formatTokens(row.inputTokens)} / {row.outputTokens === null ? "—" : formatTokens(row.outputTokens)}</td>
        <td className="px-3 py-3 font-mono"><div>{row.costCents === null ? t("unknown_bc7819b") : formatDetailedCents(row.costCents)}</div>{row.costStatus !== "unpriced" && row.costStatus && <span className="text-xs text-muted-foreground">{row.costStatus === "estimated" ? t("estimated_ae64c7c") : t("reported_73c20de")}</span>}</td>
      </tr>)}</tbody>
    </table></div>
  </div>;
}
export function DecisionHistory({ companyId, from, to }: { companyId: string; from?: string | null; to?: string | null }) {
  const { t } = useTranslation("connections");
  const query = useQuery({ queryKey: ["decision-history", companyId, from, to], queryFn: () => decisionModelsApi.history(companyId, from, to), refetchInterval: q => q.state.data?.some(row => row.status === "running") ? 5000 : false });
  if (query.isPending) return <p className="text-sm text-muted-foreground">{t("loading_decision_requests_c1e74ea")}</p>;
  if (query.error) return <div role="alert" className="space-y-2"><p className="text-sm text-destructive">{t("could_not_load_decision_requests_6247d83")}</p><Button variant="outline" onClick={() => void query.refetch()}>{t("try_again_042c862")}</Button></div>;
  return <DecisionHistoryTable entries={query.data ?? []} />;
}
