import { useQuery } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { decisionsApi } from "@/api/decisions";
import { useLocation } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { taskChatHashAnchor } from "./task-chat/scroll-navigation";
import { DecisionResolver } from "./DecisionResolver";
import { Button } from "./ui/button";
import { useTranslation } from "@/i18n";

/** A selected Decisions-v1 record belongs to its task, not a second history tab. */
export function TaskDecisionRecord({ companyId, issueId, viewerId, agentMap }: {
  companyId: string; issueId: string; viewerId: string | null; agentMap?: Map<string, Agent>;
}) {
  const { t } = useTranslation();
  const { hash } = useLocation();
  const anchor = taskChatHashAnchor(hash);
  const decisionId = anchor?.startsWith("decision-") ? anchor.slice("decision-".length) : null;
  const record = useQuery({
    queryKey: queryKeys.decisions.taskRecord(companyId, issueId, viewerId, decisionId),
    queryFn: () => decisionsApi.get(decisionId!), enabled: !!decisionId, retry: false,
  });
  if (!decisionId) return null;
  const decision = record.data;
  const matchesTask = decision?.companyId === companyId && decision.originIssueId === issueId;
  const choice = decision?.options.find((option) => option.id === decision.chosenOptionId);
  const statusLabels: Record<string, string> = {
    decided: t("pages.tasks.decided"),
    expired: t("localizationIssueDetail.status_expired"),
    cancelled: t("localizationIssueDetail.status_cancelled"),
  };
  return <section id={anchor!} aria-label={t("nov02Core.decision.record")} className="space-y-3 rounded-xl border border-border bg-card p-4">
    <h2 className="text-sm font-medium">{t("nov02Core.decision.record")}</h2>
    {record.isPending ? <p role="status" className="text-sm text-muted-foreground">{t("nov02Core.decision.loading")}</p> : record.isError ? (
      <div role="alert" className="text-sm"><p>{t("nov02Core.decision.failed")}</p><Button size="sm" variant="ghost" onClick={() => void record.refetch()}>{t("nov02Core.query.retry")}</Button></div>
    ) : !matchesTask ? <p role="alert" className="text-sm text-muted-foreground">{t("nov02Core.decision.unavailable")}</p> : <>
      {decision.status !== "open" ? <dl className="space-y-2 text-sm">
        <div><dt className="text-muted-foreground">{t("nov02Core.decision.choice")}</dt><dd>{choice?.label ?? (decision.chosenOptionId === "dismissed" ? t("nov02Core.decision.dismissed") : statusLabels[decision.status] ?? decision.status)}</dd></div>
        {(decision.inputs ?? []).filter((input) => decision.inputValues?.[input.id] !== undefined).map((input) => <div key={input.id}>
          <dt className="text-muted-foreground">{input.label}</dt><dd className="whitespace-pre-wrap">{decision.inputValues![input.id]}</dd>
        </div>)}
      </dl> : null}
      <DecisionResolver companyId={companyId} decisionId={decisionId} agentMap={agentMap} initialDecision={decision}
        recordedDecision={decision.status === "open" ? undefined : decision} onResolved={() => { void record.refetch(); }} />
    </>}
  </section>;
}
