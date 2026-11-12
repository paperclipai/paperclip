import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, type ReactNode } from "react";
import type { Agent, AttentionItem } from "@paperclipai/shared";
import { describeError } from "@/api/errors";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { IssueRecoveryActionCard, type RecoveryResolveOutcome } from "./IssueRecoveryActionCard";
import { Button } from "./ui/button";
import { DecisionCardFooter } from "./DecisionCardFooter";

/** `footerLeading` (an Inbox card's task link) shares one footer row with the recovery actions. */
export function AttentionRecoveryResolver({ item, companyId, agentMap, onResolved, footerLeading }: {
  item: AttentionItem; companyId: string; agentMap?: Map<string, Agent>; onResolved: () => void; footerLeading?: ReactNode;
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
  const withFooter = (content: ReactNode) => <>{content}{footerLeading ? <DecisionCardFooter leading={footerLeading} /> : null}</>;
  if (!issueId || actions.isError) return withFooter(<div role="alert"><p>Recovery actions could not be loaded.</p><Button onClick={() => void actions.refetch()}>Retry</Button></div>);
  if (actions.isPending) return withFooter(<p role="status">Loading recovery actions…</p>);
  if (!action || !["active", "escalated"].includes(action.status)) return withFooter(<p role="status">This recovery is no longer awaiting an action.</p>);
  return <>
    {resolution.error ? <p role="alert" className="text-sm text-destructive">{describeError(resolution.error, { action: "resolve this recovery" }).body}</p> : null}
    <fieldset disabled={resolution.isPending} aria-busy={resolution.isPending}>
      <IssueRecoveryActionCard action={action} agentMap={agentMap} onResolve={resolve} resolvePending={resolution.isPending} footerLeading={footerLeading} />
    </fieldset>
  </>;
}
