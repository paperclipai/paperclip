import { localizeUiError } from "@/lib/localized-ui-error";
import { t, useTranslation } from "@/i18n";
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
type RetryValue = { actionId: string; runId: string; unavailableReason: string | null; onRetry: () => Promise<void> };
const RetryContext = createContext<RetryValue | null>(null);

export function useCurrentWorkspaceRetry() {
  return useContext(RetryContext);
}

export function useWorkspaceRetry(metadata: IssueCommentMetadata | null | undefined) {
  const value = useCurrentWorkspaceRetry();
  return value && metadata?.sections.some(section => section.rows.some(row => row.type === "key_value" && row.value === value.actionId))
    ? value : null;
}

/** Bind the repair to the server-owned action and its latest failed run. */
export function useWorkspaceBaseRefRecovery(metadata: IssueCommentMetadata | null | undefined) {
  const value = useContext(Context);
  return value && metadata?.sourceRunId === value.runId
    && metadata.sections.some(section => section.rows.some(row => row.type === "key_value" && row.value === value.actionId))
    ? value : null;
}

export function WorkspaceBaseRefRecoveryProvider({ issue, agentMap, unavailableReason, baseRefUnavailableReason, onRepaired, children }: {
  issue: Issue;
  agentMap: ReadonlyMap<string, Pick<Agent, "name" | "status">>;
  unavailableReason: string | null;
  baseRefUnavailableReason?: string | null;
  onRepaired: () => void;
  children: ReactNode;
}) {
  useTranslation("final-components-a");
  const action = issue.activeRecoveryAction;
  const recordedRunId = action?.evidence?.latestRunId ?? action?.evidence?.runId;
  const runId = typeof recordedRunId === "string" ? recordedRunId : null;
  const { data: run } = useQuery({
    queryKey: ["workspace-base-ref-recovery", issue.companyId, issue.id, runId],
    queryFn: () => heartbeatsApi.get(runId!), enabled: Boolean(runId), staleTime: Infinity, retry: retryTransientOnly(0),
  });
  const failure = record(record(run?.resultJson).configurationIncomplete);
  const execution = record(record(run?.resultJson).executionRecovery);
  let retry: RetryValue | null = null;
  if (action && runId && run?.status === "failed" && run.companyId === issue.companyId
    && record(run.contextSnapshot).issueId === issue.id && execution.kind === "bootstrap" && execution.providerWorkStarted === false
    && (failure.reason === "workspace_source_restricted"
      || (run.errorCode === "setup_failed" && run.error === "Task workspace access is no longer available"))) {
    const agent = issue.assigneeAgentId ? agentMap.get(issue.assigneeAgentId) : undefined;
    const stale = action.status !== "active" || issue.status !== "blocked" || action.ownerType !== "board"
      || !issue.assigneeAgentId || issue.assigneeAgentId !== action.returnOwnerAgentId || run.agentId !== issue.assigneeAgentId;
    retry = { actionId: action.id, runId,
      unavailableReason: stale ? t("final-components-a:refreshTheTaskToRetry_e61e6c32")
        : unavailableReason
        ?? (issue.executionRunId || issue.checkoutRunId ? t("final-components-a:waitForTheCurrentRun_a85d72b1") : null)
        ?? (agent?.status === "paused" || agent?.status === "terminated" ? t("final-components-a:theAssignedAgentIsUnavailable_c49c4bae") : null)
        ?? (issue.executionState?.status === "pending" ? t("final-components-a:completeThePendingReviewOr_5066bafc") : null)
        ?? (issue.blockedBy?.some(b => b.status !== "done" && b.status !== "cancelled") ? t("final-components-a:resolveTheTaskSBlockers_be0f8f68") : null),
      onRetry: async () => {
        try {
          const receipt = await issuesApi.resolveRecoveryAction(issue.id, { actionId: action.id, outcome: "restored", sourceIssueStatus: "todo" });
          if (receipt.issue.status !== "todo" || receipt.issue.assigneeAgentId !== issue.assigneeAgentId) {
            throw localizeUiError(new Error("The task changed. Refresh and try again."), { key: "final-components-a:theTaskChangedRefreshAnd_7d938a34" });
          }
        } finally { onRepaired(); }
      },
    };
  }
  let value: RecoveryValue | null = null;
  if (action && runId && run?.companyId === issue.companyId && record(run.contextSnapshot).issueId === issue.id
    && failure.reason === "workspace_base_ref_unresolved" && typeof failure.requestedRef === "string") {
    const agent = issue.assigneeAgentId ? agentMap.get(issue.assigneeAgentId) : undefined;
    const requestedRef = failure.requestedRef;
    const workspace = issue.project?.workspaces?.find(w => w.id === issue.projectWorkspaceId)
      ?? issue.project?.primaryWorkspace;
    let repository = t("final-components-a:theTaskSRepository_02ea1195");
    if (workspace?.repoUrl) {
      try { const url = new URL(workspace.repoUrl); if (url.protocol === "https:" || url.protocol === "http:") repository = `${url.hostname}${url.pathname.replace(/\.git$/, "")}`; } catch { /* Keep local paths and credentials out of the card. */ }
    }
    const settings = record(issue.executionWorkspaceSettings);
    const currentRef = record(settings.workspaceStrategy).baseRef;
    const stale = action.status !== "active" || issue.status !== "blocked" || issue.assigneeAgentId !== action.returnOwnerAgentId
      || run.agentId !== issue.assigneeAgentId || (typeof currentRef === "string" && Boolean(currentRef.trim()) && currentRef !== requestedRef);
    const reason = stale ? t("final-components-a:thisRepairNoLongerMatches_03388852")
      : baseRefUnavailableReason ?? unavailableReason
      ?? (issue.executionRunId || issue.checkoutRunId ? t("final-components-a:waitForTheCurrentRun_a85d72b1") : null)
      ?? (agent?.status === "paused" || agent?.status === "terminated" ? t("final-components-a:theAssignedAgentIsUnavailable_c49c4bae") : null)
      ?? (issue.executionState?.status === "pending" ? t("final-components-a:completeThePendingReviewOr_5066bafc") : null)
      ?? (issue.blockedBy?.some(b => b.status !== "done" && b.status !== "cancelled") ? t("final-components-a:resolveTheTaskSBlockers_be0f8f68") : null);
    value = { actionId: action.id, runId, props: {
      requestedRef, repository, taskOverride: currentRef === requestedRef, defaultBranch: typeof failure.defaultBranch === "string" ? failure.defaultBranch : null,
      agentName: agent?.name ?? t("final-components-a:theAssignedAgent_7a6c723b"), unavailableReason: reason,
      failureKind: typeof failure.fetchError === "string" && failure.fetchError.includes(`couldn't find remote ref refs/heads/${requestedRef}`) ? "missing_branch" : "unresolved_ref",
      onRepair: async branch => {
        try {
          const receipt = await issuesApi.resolveRecoveryAction(issue.id, {
            actionId: action.id, outcome: "restored", sourceIssueStatus: "todo", workspaceBaseRef: { requestedRef, branch },
          });
          if (receipt.issue.status !== "todo" || receipt.issue.assigneeAgentId !== issue.assigneeAgentId
            || record(record(receipt.issue.executionWorkspaceSettings).workspaceStrategy).baseRef !== branch) {
            throw localizeUiError(new Error("The task changed while saving. Refresh to check its current state."), { key: "final-components-a:theTaskChangedWhileSaving_276f13bd" });
          }
        } finally { onRepaired(); }
      },
    } };
  }
  return <RetryContext.Provider value={retry}><Context.Provider value={value}>{children}</Context.Provider></RetryContext.Provider>;
}
