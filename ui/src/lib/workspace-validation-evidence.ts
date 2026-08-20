import type { HeartbeatRun, IssueRecoveryAction } from "@paperclipai/shared";

/**
 * PAP-13568 Phase 4b — run-page fallback diagnosis evidence.
 *
 * A run that Paperclip declines over git workspace validation stamps its structured
 * `GitWorktreeBranchIncoherenceEvidence` under `resultJson.workspaceValidation`. The run-page
 * recovery surface renders a diagnosis card from *this* evidence directly — no `activeRecoveryAction`
 * required — so a failed run never renders nothing (plan point #1). These helpers read that evidence
 * off a run and derive the reconcile target, mirroring the equivalent action-based readers in
 * `recovery-reconcile.ts`.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Returns the run's `workspaceValidation` evidence record when it is a git-worktree
 * branch-incoherence failure (the only shape the diagnosis card renders). Null otherwise.
 */
export function readRunWorkspaceValidationEvidence(
  run: Pick<HeartbeatRun, "resultJson">,
): Record<string, unknown> | null {
  const resultJson = asRecord(run.resultJson);
  if (!resultJson) return null;
  const workspaceValidation = asRecord(resultJson.workspaceValidation);
  if (!workspaceValidation) return null;
  if (workspaceValidation.reason !== "git_worktree_branch_incoherence") return null;
  return workspaceValidation;
}

/**
 * The execution workspace a reconcile/restore should target, read from the run's evidence. The
 * branch-incoherence failure records the diverged workspace under `persistedExecutionWorkspaceId`;
 * older/other shapes use `executionWorkspaceId`. Accept either so the reconcile pins the workspace
 * that actually diverged rather than a page-level id that may have drifted.
 */
export function readReconcileWorkspaceIdFromEvidence(
  evidence: Record<string, unknown> | null,
): string | null {
  if (!evidence) return null;
  return (
    asNonEmptyString(evidence.persistedExecutionWorkspaceId) ??
    asNonEmptyString(evidence.executionWorkspaceId)
  );
}

/**
 * Builds a *presentational-only* synthetic recovery action that carries the run's evidence so the
 * shared `IssueRecoveryActionCard` (compact) can render the same diagnosis + repair CTAs from run
 * evidence alone. This is never persisted and never resolved (no `onResolve` is wired for it): the
 * repair CTAs target the evidence's workspace id, not this synthetic action id. `forcedState` on the
 * card drives the tone, so the state-ish fields here are placeholders.
 */
export function synthesizeRunWorkspaceValidationAction(
  run: Pick<HeartbeatRun, "id" | "companyId">,
  evidence: Record<string, unknown>,
  sourceIssueId: string | null,
): IssueRecoveryAction {
  return {
    id: `run-evidence:${run.id}`,
    companyId: run.companyId,
    sourceIssueId: sourceIssueId ?? "",
    recoveryIssueId: null,
    kind: "workspace_validation",
    status: "active",
    ownerType: "system",
    ownerAgentId: null,
    ownerUserId: null,
    previousOwnerAgentId: null,
    returnOwnerAgentId: null,
    cause: "workspace_validation_failed",
    fingerprint: `run-evidence:${run.id}`,
    evidence: { workspaceValidation: evidence },
    nextAction: "",
    wakePolicy: null,
    monitorPolicy: null,
    attemptCount: 1,
    maxAttempts: null,
    timeoutAt: null,
    lastAttemptAt: null,
    outcome: null,
    resolutionNote: null,
    resolvedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}
