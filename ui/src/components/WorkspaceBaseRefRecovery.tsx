import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Agent, Issue, IssueCommentMetadata } from "@paperclipai/shared";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import type { WorkspaceBaseRefRecoveryNoticeProps } from "./WorkspaceBaseRefRecoveryNotice";
import { retryTransientOnly } from "../lib/query-client";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

type RecoveryValue = { actionId: string; runId: string; props: WorkspaceBaseRefRecoveryNoticeProps };
const Context = createContext<RecoveryValue | null>(null);

/** Bind the repair to the server-owned action and its latest failed run. */
export function useWorkspaceBaseRefRecovery(metadata: IssueCommentMetadata | null | undefined) {
  const value = useContext(Context);
  return value && metadata?.sourceRunId === value.runId
    && metadata.sections.some(section => section.rows.some(row => row.type === "key_value" && row.value === value.actionId))
    ? value : null;
}

export function WorkspaceBaseRefRecoveryProvider({ issue, agentMap, unavailableReason, onRepaired, children }: {
  issue: Issue;
  agentMap: ReadonlyMap<string, Pick<Agent, "name" | "status">>;
  unavailableReason: string | null;
  onRepaired: () => void;
  children: ReactNode;
}) {
  const action = issue.activeRecoveryAction;
  const runId = action?.cause === "configuration_incomplete" && typeof action.evidence.latestRunId === "string"
    ? action.evidence.latestRunId : null;
  const { data: run } = useQuery({
    queryKey: ["workspace-base-ref-recovery", issue.companyId, issue.id, runId],
    queryFn: () => heartbeatsApi.get(runId!), enabled: Boolean(runId), staleTime: Infinity, retry: retryTransientOnly(0),
  });
  const failure = record(record(run?.resultJson).configurationIncomplete);
  let value: RecoveryValue | null = null;
  if (action && runId && run?.companyId === issue.companyId && record(run.contextSnapshot).issueId === issue.id
    && failure.reason === "workspace_base_ref_unresolved" && typeof failure.requestedRef === "string") {
    const agent = issue.assigneeAgentId ? agentMap.get(issue.assigneeAgentId) : undefined;
    const requestedRef = failure.requestedRef;
    const workspace = issue.project?.workspaces?.find(w => w.id === issue.projectWorkspaceId)
      ?? issue.project?.primaryWorkspace;
    let repository = "The task’s repository";
    if (workspace?.repoUrl) {
      try { const url = new URL(workspace.repoUrl); if (url.protocol === "https:" || url.protocol === "http:") repository = `${url.hostname}${url.pathname.replace(/\.git$/, "")}`; } catch { /* Keep local paths and credentials out of the card. */ }
    }
    const settings = record(issue.executionWorkspaceSettings);
    const currentRef = record(settings.workspaceStrategy).baseRef;
    const stale = action.status !== "active" || issue.status !== "blocked" || issue.assigneeAgentId !== action.returnOwnerAgentId
      || run.agentId !== issue.assigneeAgentId || (typeof currentRef === "string" && Boolean(currentRef.trim()) && currentRef !== requestedRef);
    const reason = stale ? "This repair no longer matches the task. Refresh to review its current state."
      : unavailableReason
      ?? (issue.executionRunId || issue.checkoutRunId ? "Wait for the current run to finish." : null)
      ?? (agent?.status === "paused" || agent?.status === "terminated" ? "The assigned agent is unavailable." : null)
      ?? (issue.executionState?.status === "pending" ? "Complete the pending review or approval before retrying." : null)
      ?? (issue.blockedBy?.some(b => b.status !== "done" && b.status !== "cancelled") ? "Resolve the task’s blockers before retrying." : null);
    value = { actionId: action.id, runId, props: {
      requestedRef, repository, taskOverride: currentRef === requestedRef, defaultBranch: typeof failure.defaultBranch === "string" ? failure.defaultBranch : null,
      agentName: agent?.name ?? "The assigned agent", unavailableReason: reason,
      failureKind: typeof failure.fetchError === "string" && failure.fetchError.includes(`couldn't find remote ref refs/heads/${requestedRef}`) ? "missing_branch" : "unresolved_ref",
      onRepair: async branch => {
        try {
          const receipt = await issuesApi.resolveRecoveryAction(issue.id, {
            actionId: action.id, outcome: "restored", sourceIssueStatus: "todo", workspaceBaseRef: { requestedRef, branch },
          });
          if (receipt.issue.status !== "todo" || receipt.issue.assigneeAgentId !== issue.assigneeAgentId
            || record(record(receipt.issue.executionWorkspaceSettings).workspaceStrategy).baseRef !== branch) {
            throw new Error("The task changed while saving. Refresh to check its current state.");
          }
        } finally { onRepaired(); }
      },
    } };
  }
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
