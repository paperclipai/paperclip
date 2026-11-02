import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Agent, Issue, IssueCommentMetadata } from "@paperclipai/shared";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import type { WorkspaceBaseRefRecoveryNoticeProps } from "./WorkspaceBaseRefRecoveryNotice";
import { useTranslation } from "@/i18n";
import { WorkspaceRecoveryUiError } from "./workspace-recovery-copy";

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
  const { t } = useTranslation();
  const action = issue.activeRecoveryAction;
  const recordedRunId = action?.evidence?.latestRunId ?? action?.evidence?.runId;
  const runId = typeof recordedRunId === "string" ? recordedRunId : null;
  const { data: run } = useQuery({
    queryKey: ["workspace-base-ref-recovery", issue.companyId, issue.id, runId],
    queryFn: () => heartbeatsApi.get(runId!), enabled: Boolean(runId), staleTime: Infinity, retry: false,
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
      unavailableReason: stale ? t("oct26Transcript.refreshToRetry")
        : unavailableReason
        ?? (issue.executionRunId || issue.checkoutRunId ? t("oct26Transcript.waitForRun") : null)
        ?? (agent?.status === "paused" || agent?.status === "terminated" ? t("oct26Transcript.agentUnavailable") : null)
        ?? (issue.executionState?.status === "pending" ? t("oct26Transcript.completeReview") : null)
        ?? (issue.blockedBy?.some(b => b.status !== "done" && b.status !== "cancelled") ? t("oct26Transcript.resolveBlockers") : null),
      onRetry: async () => {
        try {
          const receipt = await issuesApi.resolveRecoveryAction(issue.id, { actionId: action.id, outcome: "restored", sourceIssueStatus: "todo" });
          if (receipt.issue.status !== "todo" || receipt.issue.assigneeAgentId !== issue.assigneeAgentId) {
            throw new WorkspaceRecoveryUiError("taskChanged");
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
    let repository = t("oct26Transcript.taskRepository");
    if (workspace?.repoUrl) {
      try { const url = new URL(workspace.repoUrl); if (url.protocol === "https:" || url.protocol === "http:") repository = `${url.hostname}${url.pathname.replace(/\.git$/, "")}`; } catch { /* Keep local paths and credentials out of the card. */ }
    }
    const settings = record(issue.executionWorkspaceSettings);
    const currentRef = record(settings.workspaceStrategy).baseRef;
    const stale = action.status !== "active" || issue.status !== "blocked" || issue.assigneeAgentId !== action.returnOwnerAgentId
      || run.agentId !== issue.assigneeAgentId || (typeof currentRef === "string" && Boolean(currentRef.trim()) && currentRef !== requestedRef);
    const reason = stale ? t("oct26Transcript.repairStale")
      : baseRefUnavailableReason ?? unavailableReason
      ?? (issue.executionRunId || issue.checkoutRunId ? t("oct26Transcript.waitForRun") : null)
      ?? (agent?.status === "paused" || agent?.status === "terminated" ? t("oct26Transcript.agentUnavailable") : null)
      ?? (issue.executionState?.status === "pending" ? t("oct26Transcript.completeReview") : null)
      ?? (issue.blockedBy?.some(b => b.status !== "done" && b.status !== "cancelled") ? t("oct26Transcript.resolveBlockers") : null);
    value = { actionId: action.id, runId, props: {
      requestedRef, repository, taskOverride: currentRef === requestedRef, defaultBranch: typeof failure.defaultBranch === "string" ? failure.defaultBranch : null,
      agentName: agent?.name ?? t("oct26Transcript.assignedAgent"), unavailableReason: reason,
      failureKind: typeof failure.fetchError === "string" && failure.fetchError.includes(`couldn't find remote ref refs/heads/${requestedRef}`) ? "missing_branch" : "unresolved_ref",
      onRepair: async branch => {
        try {
          const receipt = await issuesApi.resolveRecoveryAction(issue.id, {
            actionId: action.id, outcome: "restored", sourceIssueStatus: "todo", workspaceBaseRef: { requestedRef, branch },
          });
          if (receipt.issue.status !== "todo" || receipt.issue.assigneeAgentId !== issue.assigneeAgentId
            || record(record(receipt.issue.executionWorkspaceSettings).workspaceStrategy).baseRef !== branch) {
            throw new WorkspaceRecoveryUiError("taskChangedWhileSaving");
          }
        } finally { onRepaired(); }
      },
    } };
  }
  return <RetryContext.Provider value={retry}><Context.Provider value={value}>{children}</Context.Provider></RetryContext.Provider>;
}
