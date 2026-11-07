import { localizeUiError } from "@/lib/localized-ui-error";
import { t, useTranslation } from "@/i18n";
import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HeartbeatRun } from "@paperclipai/shared";
import { isNativeWorkspaceExportRepairCause } from "@paperclipai/shared";
import { RunWorkspaceSourceInspection } from "./RunWorkspaceSourceInspection";
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
  useTranslation("task-components");
  const issueId = readRunIssueId(run);
  const cause = run.execution?.cause ?? run.errorCode;
  if (issueId && (isNativeWorkspaceExportRepairCause(cause) || cause === "native_workspace_sync_out_unrecoverable"))
    return <RunWorkspaceSourceInspection key={run.id} issueId={issueId} runId={run.id} companyId={run.companyId} />;
  return <WorkspaceValidationRecoverySurface run={run} />;
}

function WorkspaceValidationRecoverySurface({ run }: { run: HeartbeatRun }) {
  useTranslation("task-components");
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
  });

  const recoveryAction = issue?.activeRecoveryAction ?? null;
  const canManageBoardRuntime = canBoardManageRuntime(run.companyId, boardAccess);
  // Prefer the workspace pinned by the recovery action's evidence (the workspace that actually
  // diverged) over the page-level id, which can drift after a re-issue rebinds the issue.
  const reconcileWorkspaceId =
    readRecoveryReconcileWorkspaceId(recoveryAction) ?? issue?.executionWorkspaceId ?? null;

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
        | { workspaceId: string; mode: "quarantine_restore" },
    ) => {
      const { workspaceId, ...body } = input;
      return executionWorkspacesApi.reconcile(workspaceId, body);
    },
    onSuccess: (_result, variables) => {
      invalidate();
      pushToast(
        variables.mode === "quarantine_restore"
          ? {
              title: t("task-components:workspaceRepaired_22f46fd2"),
              body: "Dirty changes were quarantined onto a rescue branch and the recorded branch restored; the task will resume.",
              presentation: { body: { key: "final-components-b:recovery.Dirty_changes_were_quarantined_onto_a_rescue_branch_and_the_recorded_b_22a698" } },
              tone: "success",
            }
          : {
              title: t("task-components:workspaceBranchReconciled_a01d3ef7"),
              body: "The recorded branch now matches the live branch; the task will resume.",
              presentation: { body: { key: "final-components-b:recovery.The_recorded_branch_now_matches_the_live_branch_the_task_will_resume_f5ddea" } },
              tone: "success",
            },
      );
    },
    onError: (err) => {
      pushToast({
        title: t("task-components:reconcileFailed_45e78183"),
        body: err instanceof Error ? err.message : "Unable to reconcile the workspace branch.",
        presentation: { ...(err instanceof Error ? { error: { cause: err } } : { body: { key: "final-components-b:recovery.Unable_to_reconcile_the_workspace_branch_fced34" } }), title: { key: "task-components:reconcileFailed_45e78183" } },
        tone: "error",
      });
    },
  });

  const reissue = useMutation({
    mutationFn: async (request: RecoveryReissueRequest) => {
      if (!issue) throw localizeUiError(new Error("Task is not loaded yet."), { key: "final-components-b:error.Task_is_not_loaded_yet_b74b33" });
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
        title: t("task-components:reIssueIsolated_329af416", { value1: issue.title ?? sourceLabel }),
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
        title: t("task-components:isolatedReIssueCreated_6d112862"),
        body: created.identifier
          ? `${created.identifier} will run on a fresh isolated workspace.`
          : "A fresh isolated re-issue was created.",
        presentation: { ...({ body: created.identifier ? { key: "final-components-b:recovery.identifier_will_run_on_a_fresh_isolated_workspace_c7de48", values: { identifier: created.identifier } } : { key: "final-components-b:recovery.A_fresh_isolated_re_issue_was_created_eeeadd" } }), title: { key: "task-components:isolatedReIssueCreated_6d112862" } },
        tone: "success",
      });
      if (created.identifier) {
        navigate(`/issues/${created.identifier}`);
      }
    },
    onError: (err) => {
      pushToast({
        title: t("task-components:reIssueFailed_d2f4dc96"),
        body: err instanceof Error ? err.message : "Unable to create an isolated re-issue.",
        presentation: { ...(err instanceof Error ? { error: { cause: err } } : { body: { key: "final-components-b:recovery.Unable_to_create_an_isolated_re_issue_7d1353" } }), title: { key: "task-components:reIssueFailed_d2f4dc96" } },
        tone: "error",
      });
    },
  });

  const resolve = useMutation({
    mutationFn: (data: {
      outcome: "restored" | "false_positive";
      sourceIssueStatus: "todo" | "done" | "in_review";
    }) => {
      if (!issueId || !recoveryAction) throw localizeUiError(new Error("No recovery action to resolve."), { key: "final-components-b:error.No_recovery_action_to_resolve_b17bdd" });
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
        title: t("task-components:recoveryResolutionFailed_f9244c72"),
        body: err instanceof Error ? err.message : "Unable to resolve recovery action",
        presentation: { ...(err instanceof Error ? { error: { cause: err } } : { body: { key: "final-components-b:recovery.Unable_to_resolve_recovery_action_448a20" } }), title: { key: "task-components:recoveryResolutionFailed_f9244c72" } },
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
  if (!recoveryAction || recoveryAction.kind !== "workspace_validation") return null;

  return (
    <div className="space-y-2" data-testid="run-workspace-recovery-surface">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{t("task-components:workspaceRecovery_9869a222")}</span>
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
        action={recoveryAction}
        variant="compact"
        onResolve={handleResolve}
        onReissueIsolated={handleReissue}
        reissuePending={reissue.isPending}
        onReconcileForward={handleReconcileForward}
        onBreakGlassOverride={handleBreakGlass}
        onQuarantineRestore={handleQuarantineRestore}
        quarantineRestorePending={reconcile.isPending}
        reconcilePending={reconcile.isPending}
        canBreakGlass={canManageBoardRuntime}
      />
    </div>
  );
}

export default RunWorkspaceRecoverySurface;
