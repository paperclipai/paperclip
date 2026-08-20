import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HeartbeatRun } from "@paperclipai/shared";
import { useNavigate } from "@/lib/router";
import { issuesApi } from "../api/issues";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { accessApi } from "../api/access";
import { queryKeys } from "../lib/queryKeys";
import { useToastActions } from "../context/ToastContext";
import {
  IssueRecoveryActionCard,
  type RecoveryReissueRequest,
  type RecoveryResolveOutcome,
} from "./IssueRecoveryActionCard";
import {
  canBoardManageRuntime,
  readRecoveryReconcileWorkspaceId,
} from "../lib/recovery-reconcile";
import {
  readReconcileWorkspaceIdFromEvidence,
  readRunWorkspaceValidationEvidence,
  synthesizeRunWorkspaceValidationAction,
} from "../lib/workspace-validation-evidence";

/** The run errorCode Paperclip stamps when it declines a run over a git workspace it can't validate. */
export const WORKSPACE_VALIDATION_RUN_ERROR_CODE = "workspace_validation_failed";

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
 * Reads the source issue id a failed run was working when it was declined over workspace validation.
 * The run's context snapshot pins the issue the recovery action lives on.
 */
function readRunIssueId(run: HeartbeatRun): string | null {
  const context = asRecord(run.contextSnapshot);
  if (!context) return null;
  return asNonEmptyString(context.issueId);
}

/**
 * Run-page recovery surface. When a run *failed* with workspace-validation evidence, this fetches
 * the source issue's active recovery action and renders the same `IssueRecoveryActionCard`
 * (compact) that `IssueDetail` shows — wired to the same reconcile-forward / repair / re-issue /
 * break-glass / resolve handlers — so the divergence can be resolved from the run view directly.
 *
 * Renders nothing unless the run is a workspace-validation failure whose source issue still carries
 * a live `workspace_validation` recovery action.
 */
export function RunWorkspaceRecoverySurface({ run }: { run: HeartbeatRun }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  const isWorkspaceValidationFailure =
    run.status === "failed" && run.errorCode === WORKSPACE_VALIDATION_RUN_ERROR_CODE;
  const issueId = readRunIssueId(run);

  const { data: issue } = useQuery({
    queryKey: queryKeys.issues.detail(issueId ?? "__none__"),
    queryFn: () => issuesApi.get(issueId!),
    enabled: Boolean(isWorkspaceValidationFailure && issueId),
  });

  const { data: boardAccess } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: Boolean(isWorkspaceValidationFailure && issueId),
    retry: false,
  });

  const recoveryAction = issue?.activeRecoveryAction ?? null;
  const canManageBoardRuntime = canBoardManageRuntime(run.companyId, boardAccess);
  // The run's own workspace-validation evidence (stamped on `resultJson`). Renders the fallback
  // diagnosis card when there is no live recovery action to render (PAP-13568 Phase 4b, plan
  // point #1: never render nothing on a failed workspace-validation run).
  const runEvidence = isWorkspaceValidationFailure
    ? readRunWorkspaceValidationEvidence(run)
    : null;
  // Prefer the workspace pinned by the recovery action's evidence (the workspace that actually
  // diverged) over the run evidence, then the page-level id, which can drift after a re-issue
  // rebinds the issue.
  const reconcileWorkspaceId =
    readRecoveryReconcileWorkspaceId(recoveryAction) ??
    readReconcileWorkspaceIdFromEvidence(runEvidence) ??
    issue?.executionWorkspaceId ??
    null;

  const invalidate = useCallback(() => {
    if (issueId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
    }
    queryClient.invalidateQueries({ queryKey: queryKeys.runIssues(run.id) });
    queryClient.invalidateQueries({ queryKey: queryKeys.runDetail(run.id) });
  }, [issueId, queryClient, run.id]);

  const reconcile = useMutation({
    mutationFn: (
      input:
        | { workspaceId: string; mode: "forward" }
        | { workspaceId: string; mode: "override"; reason: string }
        | { workspaceId: string; mode: "quarantine_restore" }
        | { workspaceId: string; mode: "restore" },
    ) => {
      const { workspaceId, ...body } = input;
      return executionWorkspacesApi.reconcile(workspaceId, body);
    },
    onSuccess: (_result, variables) => {
      invalidate();
      if (variables.mode === "quarantine_restore") {
        pushToast({
          title: "Workspace repaired",
          body: "Dirty changes were quarantined onto a rescue branch and the recorded branch restored; the task will resume.",
          tone: "success",
        });
      } else if (variables.mode === "restore") {
        pushToast({
          title: "Recorded branch restored",
          body: "The workspace was checked back out onto its recorded branch (the parked branch keeps its commits); the task will resume.",
          tone: "success",
        });
      } else {
        pushToast({
          title: "Workspace branch reconciled",
          body: "The recorded branch now matches the live branch; the task will resume.",
          tone: "success",
        });
      }
    },
    onError: (err) => {
      pushToast({
        title: "Reconcile failed",
        body: err instanceof Error ? err.message : "Unable to reconcile the workspace branch.",
        tone: "error",
      });
    },
  });

  const reissue = useMutation({
    mutationFn: async (request: RecoveryReissueRequest) => {
      if (!issue) throw new Error("Task is not loaded yet.");
      const sourceLabel = issue.identifier ?? "the stalled task";
      const descriptionLines = [
        `Re-issued from ${sourceLabel} on an isolated git worktree after a workspace branch divergence.`,
        "",
        `- Base ref (live branch): \`${request.baseRef}\``,
        ...(request.expectedBranch ? [`- Recorded branch: \`${request.expectedBranch}\``] : []),
        "",
        "---",
        "",
        issue.description ?? "",
      ];
      return issuesApi.create(issue.companyId, {
        title: `Re-issue (isolated): ${issue.title ?? sourceLabel}`,
        description: descriptionLines.join("\n"),
        priority: issue.priority,
        projectId: issue.projectId ?? null,
        parentId: issue.parentId ?? null,
        assigneeAgentId:
          recoveryAction?.returnOwnerAgentId ??
          recoveryAction?.previousOwnerAgentId ??
          issue.assigneeAgentId ??
          null,
        executionWorkspacePreference: "isolated_workspace",
        executionWorkspaceSettings: {
          mode: "isolated_workspace",
          workspaceStrategy: { type: "git_worktree", baseRef: request.baseRef },
        },
      });
    },
    onSuccess: (created) => {
      invalidate();
      pushToast({
        title: "Isolated re-issue created",
        body: created.identifier
          ? `${created.identifier} will run on a fresh isolated workspace.`
          : "A fresh isolated re-issue was created.",
        tone: "success",
      });
      if (created.identifier) {
        navigate(`/issues/${created.identifier}`);
      }
    },
    onError: (err) => {
      pushToast({
        title: "Re-issue failed",
        body: err instanceof Error ? err.message : "Unable to create an isolated re-issue.",
        tone: "error",
      });
    },
  });

  const resolve = useMutation({
    mutationFn: (data: {
      outcome: "restored" | "false_positive";
      sourceIssueStatus: "todo" | "done" | "in_review";
    }) => {
      if (!issueId || !recoveryAction) throw new Error("No recovery action to resolve.");
      return issuesApi.resolveRecoveryAction(issueId, {
        actionId: recoveryAction.id,
        outcome: data.outcome,
        sourceIssueStatus: data.sourceIssueStatus,
      });
    },
    onSuccess: () => {
      invalidate();
    },
    onError: (err) => {
      pushToast({
        title: "Recovery resolution failed",
        body: err instanceof Error ? err.message : "Unable to resolve recovery action",
        tone: "error",
      });
    },
  });

  const handleReconcileForward = useCallback(() => {
    if (!reconcileWorkspaceId) return;
    void reconcile.mutateAsync({ workspaceId: reconcileWorkspaceId, mode: "forward" });
  }, [reconcile, reconcileWorkspaceId]);

  const handleBreakGlass = useCallback(
    (reason: string) => {
      if (!reconcileWorkspaceId) return;
      void reconcile.mutateAsync({ workspaceId: reconcileWorkspaceId, mode: "override", reason });
    },
    [reconcile, reconcileWorkspaceId],
  );

  const handleQuarantineRestore = useCallback(() => {
    if (!reconcileWorkspaceId) return;
    void reconcile.mutateAsync({ workspaceId: reconcileWorkspaceId, mode: "quarantine_restore" });
  }, [reconcile, reconcileWorkspaceId]);

  const handleRestoreRecordedBranch = useCallback(() => {
    if (!reconcileWorkspaceId) return;
    void reconcile.mutateAsync({ workspaceId: reconcileWorkspaceId, mode: "restore" });
  }, [reconcile, reconcileWorkspaceId]);

  const handleReissue = useCallback(
    (request: RecoveryReissueRequest) => {
      void reissue.mutateAsync(request);
    },
    [reissue],
  );

  const handleResolve = useCallback(
    (outcome: RecoveryResolveOutcome) => {
      switch (outcome) {
        case "todo":
          void resolve.mutateAsync({ outcome: "restored", sourceIssueStatus: "todo" });
          return;
        case "done":
          void resolve.mutateAsync({ outcome: "restored", sourceIssueStatus: "done" });
          return;
        case "in_review":
          void resolve.mutateAsync({ outcome: "restored", sourceIssueStatus: "in_review" });
          return;
        case "false_positive_done":
          void resolve.mutateAsync({ outcome: "false_positive", sourceIssueStatus: "done" });
          return;
        case "false_positive_in_review":
          void resolve.mutateAsync({ outcome: "false_positive", sourceIssueStatus: "in_review" });
          return;
      }
    },
    [resolve],
  );

  if (!isWorkspaceValidationFailure || !issueId) return null;

  const hasLiveRecoveryAction =
    recoveryAction !== null && recoveryAction.kind === "workspace_validation";

  // Fallback path: no live recovery action (e.g. the source issue is blocked / has a pending
  // interaction, so no action was promoted — PAP-13568 L3), but the run stamped branch-incoherence
  // evidence. Render the same card from the run's own evidence via a presentational synthetic action.
  // No `onResolve` is wired — there is no persisted action to resolve; the repair CTAs target the
  // evidence's workspace id.
  const fallbackAction =
    !hasLiveRecoveryAction && runEvidence
      ? synthesizeRunWorkspaceValidationAction(run, runEvidence, issueId)
      : null;

  const cardAction = hasLiveRecoveryAction ? recoveryAction : fallbackAction;
  if (!cardAction) return null;

  const isFallback = !hasLiveRecoveryAction;

  return (
    <div className="space-y-2" data-testid="run-workspace-recovery-surface" data-fallback={isFallback ? "true" : undefined}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">Workspace recovery</span>
        {issue?.identifier ? (
          <a
            href={`/issues/${issue.identifier}`}
            className="font-mono text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={(event) => {
              event.preventDefault();
              navigate(`/issues/${issue.identifier}`);
            }}
          >
            {issue.identifier}
          </a>
        ) : null}
      </div>
      <IssueRecoveryActionCard
        action={cardAction}
        variant="compact"
        // The fallback card has no persisted action to resolve, so its resolve/false-positive menu
        // is intentionally omitted; the live-action card keeps it.
        onResolve={isFallback ? undefined : handleResolve}
        forcedState={isFallback ? "needed" : undefined}
        onReissueIsolated={handleReissue}
        reissuePending={reissue.isPending}
        onReconcileForward={handleReconcileForward}
        onBreakGlassOverride={handleBreakGlass}
        onQuarantineRestore={handleQuarantineRestore}
        quarantineRestorePending={reconcile.isPending}
        onRestoreRecordedBranch={handleRestoreRecordedBranch}
        restorePending={reconcile.isPending}
        reconcilePending={reconcile.isPending}
        canBreakGlass={canManageBoardRuntime}
      />
    </div>
  );
}

export default RunWorkspaceRecoverySurface;
