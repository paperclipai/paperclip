import { t, useTranslation } from "@/i18n";
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IssueRecoveryAction } from "@paperclipai/shared";
import { isNativeWorkspaceExportRepairCause } from "@paperclipai/shared";
import { isTransientError } from "../api/errors";
import { useQueryView } from "./QueryView";
import { accessApi } from "../api/access";
import { issuesApi } from "../api/issues";
import { useDraftOwner, useDraftOwnerReader } from "../hooks/useDraftOwner";
import { canBoardResolveRecoveryAction, isRetainedWorkspaceExportCause } from "../lib/recovery-reconcile";
import { queryKeys } from "../lib/queryKeys";
import { classifySendFailure, pendingSendKeyFor, readPendingSend, writePendingSend } from "../lib/pending-send";
import { asObject, cn } from "../lib/utils";
import { createUuid } from "../lib/uuid";
import { Button } from "./ui/button";

/** Requests preservation; the existing worker owns stop, copyback and verification. */
export function WorkspaceExportRecovery({ action, className, issueId, companyId, showStatus = true }: {
  className?: string; action: IssueRecoveryAction | null; issueId?: string; companyId?: string; showStatus?: boolean;
}) {
  useTranslation("task-components");
  if (action && issueId && companyId && isRetainedExport(action, issueId, companyId)) {
    return <RetainedFilesRecovery key={`${companyId}:${issueId}:${action.id}:${action.evidence.runId}`}
      action={action} issueId={issueId} companyId={companyId} className={className} />;
  }
  if (!showStatus) return null;
  const ownerRecovery = action?.cause === "native_workspace_finalization_owner_unverified";
  if (!action || (!ownerRecovery && !isNativeWorkspaceExportRepairCause(action.cause)) || action.ownerType !== "board"
    || !["active", "escalated"].includes(action.status) || typeof action.evidence.runId !== "string") return null;
  const queued = !!action.evidence.workspaceOwnerStop || action.wakePolicy?.kind === "resume_native_run";
  const automatic = queued || (ownerRecovery && asObject(action.evidence.workspaceOwnerRecovery).state === "resuming");
  return <p role="status" className={cn("text-sm text-muted-foreground", className)}>
    {automatic ? t("task-components:restoringSavedWork_d6ea858b") : t("task-components:workspaceRecoveryNeedsOperatorAssistanceTheAgent_fc09f0ee")}
  </p>;
}

function isRetainedExport(action: IssueRecoveryAction, issueId: string, companyId: string) {
  return action.companyId === companyId && action.sourceIssueId === issueId
    && action.kind === "active_run_watchdog" && ["active", "escalated"].includes(action.status)
    && ["board", "system"].includes(action.ownerType)
    && isRetainedWorkspaceExportCause(action.cause)
    && typeof action.evidence.runId === "string" && action.evidence.runId.length > 0;
}

type RecoveryFeedback = { key: string; detail?: RecoveryFeedback } | { raw: string };
class RecoveryUiError extends Error {
  constructor(readonly key: string) { super(key); }
}
function recoveryFeedback(error: unknown, fallbackKey: string): RecoveryFeedback {
  return error instanceof RecoveryUiError ? { key: error.key } : error instanceof Error ? { raw: error.message } : { key: fallbackKey };
}
function displayRecoveryFeedback(feedback: RecoveryFeedback): string {
  return "raw" in feedback ? feedback.raw : t(feedback.key, feedback.detail ? { detail: displayRecoveryFeedback(feedback.detail) } : {});
}

type RecoveryInput = { actionId: string; runId: string };

function RetainedFilesRecovery({ action, issueId, companyId, className }: {
  action: IssueRecoveryAction; issueId: string; companyId: string; className?: string;
}) {
  useTranslation("task-components");
  const runId = action.evidence.runId as string;
  const owner = useDraftOwner();
  const readOwner = useDraftOwnerReader();
  const client = useQueryClient();
  const busy = useRef(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [checkedUnconfirmed, setCheckedUnconfirmed] = useState(false);
  const [notice, setNotice] = useState<RecoveryFeedback | null>(null);
  const access = useQuery({ queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess() });
  const accessView = useQueryView(access);
  const accessReady = accessView.kind === "ready" || accessView.kind === "stale";
  const canMutate = Boolean(accessReady && owner && (access.data?.source === "local_implicit"
    || owner !== "signed-out" && access.data?.userId === owner)
    && canBoardResolveRecoveryAction(companyId, access.data));
  const source = useQuery({ queryKey: queryKeys.issues.recoveryActions(issueId, action.id, runId),
    queryFn: () => issuesApi.recoveryActions(issueId, { runId, actionId: action.id }), enabled: canMutate });
  const sourceView = useQueryView(source);
  const sourceReady = sourceView.kind === "ready" || sourceView.kind === "stale";
  const storageKey = owner ? pendingSendKeyFor(`workspace-file-recovery:${companyId}:${issueId}:${action.id}:${runId}`, owner) : null;
  const matchesInput = (value: unknown): value is RecoveryInput => {
    const input = asObject(value);
    return input.actionId === action.id && input.runId === runId;
  };
  const pending = storageKey ? readPendingSend(storageKey, matchesInput) : null;
  function boundAction(data: typeof source.data) {
    const current = data?.actions.find(item => item.id === action.id);
    const inspected = data?.sourceInspection;
    const state = asObject(current?.evidence.workspaceRecovery);
    return current && isRetainedExport(current, issueId, companyId) && current.evidence.runId === runId
      && state.runId === runId && state.schema === "paperclip.workspace-recovery.v1"
      && inspected?.actionId === action.id && inspected.runId === runId && inspected.status === "verified" ? current : null;
  }
  const current = sourceReady ? boundAction(source.data) : null;
  const recovery = asObject(current?.evidence.workspaceRecovery);
  const system = asObject(current?.evidence.systemRecovery);
  const serverAcknowledged = Boolean(pending && Array.isArray(recovery.requestIds) && recovery.requestIds.includes(pending.idempotencyKey));
  const restoring = ["queued", "recovering"].includes(String(recovery.status));
  const saved = recovery.status === "recovered" && system.state === "complete"
    && Array.isArray(system.preservationOperationIds) && system.preservationOperationIds.length > 0
    && system.preservationOperationIds.every(id => typeof id === "string" && id.length > 0);
  const retryable = recovery.status === "blocked" && recovery.retryable === true;
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
    void client.invalidateQueries({ queryKey: queryKeys.issues.runs(issueId) });
    void client.invalidateQueries({ queryKey: queryKeys.runDetail(runId) });
  };
  const request = useMutation({ retry: false, mutationFn: async (restartFailedAttempt: boolean) => { // query-error-ok: recovery requests require an explicit action and receipt reconciliation.
    if (busy.current) return;
    busy.current = true;
    setNotice(null);
    setCheckedUnconfirmed(false);
    setAcknowledged(false);
    try {
      const observed = await source.refetch();
      const fresh = boundAction(observed.data);
      const state = asObject(fresh?.evidence.workspaceRecovery);
      if (observed.error || !fresh || state.status !== "blocked" || state.retryable !== true)
        throw new RecoveryUiError("deep-ui:recovery_20a57f7e22");
      if (!canMutate || !owner || readOwner() !== owner || !storageKey)
        throw new RecoveryUiError("deep-ui:recovery_7d6e47bcf7");
      const previous = readPendingSend(storageKey, matchesInput);
      if (restartFailedAttempt && (!previous || !Array.isArray(state.requestIds)
        || !state.requestIds.includes(previous.idempotencyKey)
        || asObject(fresh.evidence.systemRecovery).state !== "exhausted"))
        throw new RecoveryUiError("deep-ui:recovery_c8aaf22fa9");
      // Unknown acceptance reuses its identity. A new bounded request requires
      // an explicit operator click and a freshly confirmed exhausted attempt.
      const record = (!restartFailedAttempt && previous) || {
        idempotencyKey: createUuid(), payload: { actionId: action.id, runId }, createdAt: Date.now(),
      };
      if (!writePendingSend(storageKey, record))
        throw new RecoveryUiError("deep-ui:recovery_8aed336c3a");
      try {
        const result = await issuesApi.recoverWorkspace(issueId, { ...record.payload, idempotencyKey: record.idempotencyKey });
        if (result.actionId !== action.id || !["queued", "recovering", "blocked", "recovered"].includes(result.status))
          throw new RecoveryUiError("deep-ui:recovery_f0e02b2af6");
        setAcknowledged(true);
        setCheckedUnconfirmed(false);
        invalidate();
        await source.refetch();
      } catch (error) {
        setNotice(classifySendFailure(error) === "rejected"
          ? { key: "deep-ui:file_request_rejected", detail: recoveryFeedback(error, "deep-ui:file_inspect_status") }
          : { key: "deep-ui:file_request_unknown" });
      }
    } catch (error) {
      setNotice(recoveryFeedback(error, "deep-ui:file_inspect_failed"));
    } finally { busy.current = false; }
  } });
  const check = useMutation({ retry: false, mutationFn: async () => { // query-error-ok: operator checks run once; the source read uses the shared query retry policy.
    const observed = await source.refetch();
    if (observed.error) throw observed.error;
    const fresh = boundAction(observed.data);
    if (!fresh) throw new RecoveryUiError("deep-ui:recovery_c04c43b199");
    const state = asObject(fresh.evidence.workspaceRecovery);
    const ids = state.requestIds;
    const unconfirmed = Boolean(pending && Array.isArray(ids) && !ids.includes(pending.idempotencyKey));
    setCheckedUnconfirmed(unconfirmed);
    setNotice(unconfirmed ? { key: "deep-ui:file_unconfirmed" } : null);
    invalidate();
  } });
  const checkError = isTransientError(check.error) ? null : check.error;
  const failedReceipt = serverAcknowledged && recovery.status === "blocked";
  const confirmedFailedAttempt = failedReceipt && retryable && system.state === "exhausted";
  const waiting = !failedReceipt && !saved && (restoring || acknowledged || serverAcknowledged);
  const unconfirmed = Boolean(pending && !acknowledged && !serverAcknowledged);
  return <div className={cn("flex flex-col gap-2 text-sm", className)} data-testid="retained-file-recovery">
    <p role="status">{saved ? t("deep-ui:saved_files_recovered_task_recovery_is_still_being_checked_23263f")
      : failedReceipt ? t("deep-ui:file_recovery_has_not_finished_the_saved_source_remains_prot_5b9843")
      : restoring ? t("deep-ui:recovering_saved_files_work_remains_paused_until_recovery_is_752bf9")
        : waiting ? t("deep-ui:file_recovery_is_queued_waiting_for_verified_saved_files_f1167e")
          : t("deep-ui:the_saved_files_need_recovery_before_work_can_continue_300875")}</p>
    {canMutate ? <>
      {current && retryable && !waiting && (!pending || unconfirmed && checkedUnconfirmed || confirmedFailedAttempt) ? <Button variant="outline" size="sm"
        className="self-start" disabled={request.isPending || check.isPending}
        onClick={() => request.mutate(confirmedFailedAttempt)}>{request.isPending ? t("deep-ui:requesting_file_recovery_edd29e")
          : confirmedFailedAttempt ? t("deep-ui:try_file_recovery_again_037552") : t("deep-ui:recover_saved_files_f38e40")}</Button> : null}
      {waiting || unconfirmed || failedReceipt || source.error || sourceReady && !current ? <Button variant="ghost" size="sm" className="self-start"
        disabled={request.isPending || check.isPending} onClick={() => check.mutate()}>
        {check.isPending ? t("deep-ui:checking_file_recovery_0267be") : t("deep-ui:check_file_recovery_status_0561b3")}
      </Button> : null}
      {sourceView.kind === "loading" || sourceView.kind === "reconnecting" ? <p className="text-xs text-muted-foreground">{t("task-components:sentence_72d7b1bc06b7")}</p> : null}
      {sourceView.kind === "error" || checkError || notice ? <p role="alert" className="text-sm text-destructive">
        {notice ? displayRecoveryFeedback(notice) : displayRecoveryFeedback(recoveryFeedback(checkError, "deep-ui:file_check_failed"))}
      </p> : null}
      {current && recovery.status === "blocked" && (serverAcknowledged || recovery.retryable !== true)
        ? <p role="alert">{t("task-components:sentence_292c74098a73")}</p> : null}
      {sourceReady && !current ? <p role="alert">{t("task-components:sentence_f64c8f1d5baa")}</p> : null}
    </> : accessView.kind === "error" ? <p role="alert" className="text-sm text-destructive">{t("task-components:sentence_1db596b7d1c6")}</p>
      : accessView.kind === "loading" || accessView.kind === "reconnecting" || !owner ? <p role="status" className="text-xs text-muted-foreground">{t("task-components:sentence_d12e084c0b1f")}</p>
        : <p className="text-xs text-muted-foreground">{t("task-components:sentence_366e78263687")}</p>}
  </div>;
}
