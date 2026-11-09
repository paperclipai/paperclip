import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import type { Agent, AttentionItem } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { IssueRecoveryActionCard, type RecoveryResolveOutcome } from "./IssueRecoveryActionCard";
import { Button } from "./ui/button";

export function AttentionRecoveryResolver({ item, companyId, agentMap, onResolved }: {
  item: AttentionItem; companyId: string; agentMap?: Map<string, Agent>; onResolved: () => void;
}) {
  const queryClient = useQueryClient();
  const resolving = useRef(false);
  const issueId = item.relatedIssue?.id ?? String(item.subject.metadata?.sourceIssueId ?? "");
  const actions = useQuery({ queryKey: queryKeys.issues.allRecoveryActions(issueId),
    queryFn: () => issuesApi.recoveryActions(issueId), enabled: Boolean(issueId) });
  const action = actions.data?.actions.find(entry => entry.id === item.subject.id);
  const resolution = useMutation({ mutationFn: (outcome: RecoveryResolveOutcome) => issuesApi.resolveRecoveryAction(issueId, {
    actionId: item.subject.id,
    outcome: outcome.startsWith("false_positive") ? "false_positive" : "restored",
    sourceIssueStatus: outcome === "false_positive_done" ? "done" : outcome === "false_positive_in_review" ? "in_review" : outcome as "todo" | "done" | "in_review",
  }), onSuccess: () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.issues.allRecoveryActions(issueId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
    onResolved();
  }, onSettled: () => { resolving.current = false; } });
  const resolve = (outcome: RecoveryResolveOutcome) => {
    if (resolving.current) return;
    resolving.current = true;
    resolution.mutate(outcome);
  };
  if (!issueId || actions.isError) return <div role="alert"><p>Recovery actions could not be loaded.</p><Button onClick={() => void actions.refetch()}>Retry</Button></div>;
  if (actions.isPending) return <p role="status">Loading recovery actions…</p>;
  if (!action || !["active", "escalated"].includes(action.status)) return <p role="status">This recovery is no longer awaiting an action.</p>;
  return <>
    {resolution.error ? <p role="alert">{resolution.error.message}</p> : null}
    <fieldset disabled={resolution.isPending} aria-busy={resolution.isPending}>
      <IssueRecoveryActionCard action={action} agentMap={agentMap} onResolve={resolve} resolvePending={resolution.isPending} />
    </fieldset>
  </>;
}
