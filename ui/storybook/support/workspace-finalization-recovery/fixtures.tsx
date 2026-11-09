import type { IssueRecoveryAction } from "@paperclipai/shared";

export const issueId = "00000000-0000-4000-8000-000000000824";
export const stopEvidence = "The deployment platform confirms that previous-controller-7d4f and all its workspace-copyback processes exited. The saved workspace is retained.";

export const recoveryAction: IssueRecoveryAction = {
  id: "00000000-0000-4000-8000-000000000825",
  companyId: "company-storybook", sourceIssueId: issueId, recoveryIssueId: null,
  kind: "active_run_watchdog", status: "escalated", ownerType: "board",
  ownerAgentId: null, ownerUserId: null, previousOwnerAgentId: null, returnOwnerAgentId: null,
  cause: "native_workspace_finalization_owner_unverified", fingerprint: "storybook-saved-result",
  evidence: { runId: "00000000-0000-4000-8000-000000000826", owner: {
    token: "00000000-0000-4000-8000-000000000827", hostname: "previous-controller-7d4f",
    pid: 2, processStartedAt: "2026-10-10T00:02:55.560Z",
    controllerBootId: "00000000-0000-4000-8000-000000000828",
  } },
  nextAction: "Verify the previous controller and its workspace-copyback processes have stopped. Resume workspace finalization without another provider turn.",
  wakePolicy: null, monitorPolicy: null, attemptCount: 1, maxAttempts: 1,
  timeoutAt: null, lastAttemptAt: "2026-10-10T00:10:00.000Z",
  outcome: null, resolutionNote: null, resolvedAt: null,
  createdAt: "2026-10-10T00:10:00.000Z", updatedAt: "2026-10-10T00:10:00.000Z",
};

export const queuedAction: IssueRecoveryAction = {
  ...recoveryAction, evidence: { ...recoveryAction.evidence, workspaceOwnerStop: {
    owner: recoveryAction.evidence.owner, stopEvidence,
    resultId: "00000000-0000-4000-8000-000000000829", actorId: "user-board",
    confirmedAt: "2026-10-10T00:15:00.000Z",
  } },
  nextAction: "Workspace finalization is queued for the saved result. The agent will not repeat its work.",
};

export const automaticAction: IssueRecoveryAction = {
  ...recoveryAction, evidence: { ...recoveryAction.evidence, workspaceOwnerRecovery: { state: "resuming" }, owner: { ...(recoveryAction.evidence.owner as object), worker: {
    provider: "railway", projectId: "fixture-project", environmentId: "fixture-environment", serviceId: "fixture-service", deploymentId: "fixture-old-deployment",
  } } },
};
