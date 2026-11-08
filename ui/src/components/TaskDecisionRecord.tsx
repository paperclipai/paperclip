import { t, useTranslation } from "@/i18n";
import { useQueryView } from "@/components/QueryView";
import { useQuery } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { decisionsApi } from "@/api/decisions";
import { useLocation } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { taskChatHashAnchor } from "./task-chat/scroll-navigation";
import { DecisionResolver } from "./DecisionResolver";
import { Button } from "./ui/button";

/** A selected Decisions-v1 record belongs to its task, not a second history tab. */
export function TaskDecisionRecord({ companyId, issueId, viewerId, agentMap }: {
  companyId: string; issueId: string; viewerId: string | null; agentMap?: Map<string, Agent>;
}) {
  useTranslation("task-components");
  const { hash } = useLocation();
  const anchor = taskChatHashAnchor(hash);
  const decisionId = anchor?.startsWith("decision-") ? anchor.slice("decision-".length) : null;
  const record = useQuery({
    queryKey: queryKeys.decisions.taskRecord(companyId, issueId, viewerId, decisionId),
    queryFn: () => decisionsApi.get(decisionId!), enabled: !!decisionId, });
  const recordView = useQueryView(record);
  if (!decisionId) return null;
  const decision = record.data;
  const matchesTask = decision?.companyId === companyId && decision.originIssueId === issueId;
  const choice = decision?.options.find((option) => option.id === decision.chosenOptionId);
  return <section id={anchor!} aria-label={t("final-components-a:decisionRecord_c33f22e6")} className="space-y-3 rounded-xl border border-border bg-card p-4">
    <h2 className="text-sm font-medium">{t("task-components:sentence_c33f22e66587")}</h2>
    {["loading", "reconnecting"].includes(recordView.kind) ? <p role="status" className="text-sm text-muted-foreground">{t("task-components:loadingDecision_ad0b2287")}</p> : (recordView.kind === "error") ? (
      <div role="alert" className="text-sm"><p>{t("task-components:sentence_004853eadb84")}</p><Button size="sm" variant="ghost" onClick={() => void record.refetch()}>{t("task-components:retry_942087cc")}</Button></div>
    ) : !matchesTask ? <p role="alert" className="text-sm text-muted-foreground">{t("task-components:sentence_23e9834f5913")}</p> : <>
      {decision.status !== "open" ? <dl className="space-y-2 text-sm">
        <div><dt className="text-muted-foreground">{t("task-components:sentence_41bdde8778b7")}</dt><dd>{choice?.label ?? (decision.chosenOptionId === "dismissed" ? t("task-components:dismissed_9d747277") : decision.status)}</dd></div>
        {(decision.inputs ?? []).filter((input) => decision.inputValues?.[input.id] !== undefined).map((input) => <div key={input.id}>
          <dt className="text-muted-foreground">{input.label}</dt><dd className="whitespace-pre-wrap">{decision.inputValues![input.id]}</dd>
        </div>)}
      </dl> : null}
      <DecisionResolver companyId={companyId} decisionId={decisionId} agentMap={agentMap} initialDecision={decision}
        recordedDecision={decision.status === "open" ? undefined : decision} onResolved={() => { void record.refetch(); }} />
    </>}
  </section>;
}
