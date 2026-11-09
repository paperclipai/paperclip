import { useTranslation } from "@/i18n";
import { useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IssueRecoveryAction, WorkspaceSourceInspection } from "@paperclipai/shared";
import { isNativeWorkspaceExportRepairCause } from "@paperclipai/shared";
import { isTransientError } from "../api/errors";
import { useQueryView } from "./QueryView";
import { accessApi } from "../api/access";
import { issuesApi } from "../api/issues";
import { useDraftOwner, useDraftOwnerReader } from "../hooks/useDraftOwner";
import { canBoardConfirmOwnerStop, canBoardResolveRecoveryAction, isRetainedWorkspaceExportCause } from "../lib/recovery-reconcile";
import { queryKeys } from "../lib/queryKeys";
import { classifySendFailure, pendingSendKeyFor, readPendingSend, writePendingSend } from "../lib/pending-send";
import { asObject, cn } from "../lib/utils";
import { createUuid } from "../lib/uuid";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

/** Reports whether this surface owns the task's next recovery action. The task's
 * generic Retry stays hidden only while this surface offers its own control. */
function ReportRecoveryControl({ owns, onChange }: { owns: boolean; onChange?: (owns: boolean) => void }) {
  useLayoutEffect(() => {
    onChange?.(owns);
    return () => onChange?.(false);
  }, [owns, onChange]);
  return null;
}

const CONTROLLER_HOST_UNVERIFIED = "native_controller_host_unverified";
const OWNER_UNPROVABLE = "ownership_owner_unprovable";

/** What the stuck record is, by ownership kind, for the board's confirmation. */
const OWNER_GONE_RESOURCE: Record<string, string> = {
  environment_run_lease_active: "environmentRunLease",
  legacy_controller_lease: "legacyController",
  environment_teardown_claim: "environmentTeardown",
  sandbox_creation_intent: "sandboxCreation",
  workspace_runtime_control_operation: "workspaceRuntimeControl",
  native_workspace_finalize_attempt: "nativeFinalizeAttempt",
  native_finalizer_lease: "nativeFinalizerLease",
  native_cleanup_lease: "nativeCleanupLease",
};
const OWNER_GONE_DEFAULT = "defaultResource";

/** Causes whose one action is the board's previous-server stop confirmation;
 * the generic recovery card must not offer other resolutions for them. */
export function isPreviousServerStopCause(cause: string | null | undefined) {
  return cause === "native_workspace_finalization_owner_unverified" || cause === CONTROLLER_HOST_UNVERIFIED
    || cause === OWNER_UNPROVABLE;
}

/** Requests preservation; the existing worker owns stop, copyback and verification. */
export function WorkspaceExportRecovery({ action, className, issueId, companyId, showStatus = true, onRecoveryControlChange }: {
  className?: string; action: IssueRecoveryAction | null; issueId?: string; companyId?: string; showStatus?: boolean;
  onRecoveryControlChange?: (owns: boolean) => void;
}) {
  const { t } = useTranslation();
  // A restart killed the copyback owner of retained saved-work recovery. Recovery
  // and any accepted Retry wait on its receipt; the confirmation is the one action.
  const retainedOwnerToken = action && issueId && companyId && isRetainedExport(action, issueId, companyId)
    ? retainedOwnerStopToken(action) : null;
  if (action && issueId && companyId && retainedOwnerToken) {
    return <><ReportRecoveryControl owns onChange={onRecoveryControlChange} />
      <PreviousServerStopConfirmation key={`${action.id}:${String(action.evidence.runId)}:${retainedOwnerToken}`}
        action={action} ownerToken={retainedOwnerToken} issueId={issueId} companyId={companyId} className={className} /></>;
  }
  if (action && issueId && companyId && isRetainedExport(action, issueId, companyId)) {
    return <RetainedFilesRecovery key={`${companyId}:${issueId}:${action.id}:${action.evidence.runId}`}
      action={action} issueId={issueId} companyId={companyId} className={className}
      onRecoveryControlChange={onRecoveryControlChange} />;
  }
  // An ephemeral server cannot judge a pre-upgrade controller row by PID.
  if (action?.cause === CONTROLLER_HOST_UNVERIFIED && issueId && companyId
    && isControllerStopRequired(action, issueId, companyId)) {
    return <><ReportRecoveryControl owns onChange={onRecoveryControlChange} />
      <PreviousServerStopConfirmation key={`${action.id}:${String(action.evidence.runId)}`}
        action={action} issueId={issueId} companyId={companyId} className={className}
        confirmStop={stopEvidence => issuesApi.confirmControllerStopped(issueId, {
          actionId: action.id, runId: action.evidence.runId as string, stopEvidence })}
        copy={{ waiting: t("workspaces.WorkspaceExportRecovery.controllerHostWaiting"),
          question: t("workspaces.WorkspaceExportRecovery.previousServerStopQuestion"),
          placeholder: t("workspaces.WorkspaceExportRecovery.previousServerStopPlaceholder"),
          resuming: t("workspaces.WorkspaceExportRecovery.resumingRun") }} /></>;
  }
  // A resource held by a server recorded before Paperclip stored which server held it.
  if (action?.cause === OWNER_UNPROVABLE && issueId && companyId && isOwnerGoneRequired(action, issueId, companyId)) {
    const resource = OWNER_GONE_RESOURCE[String(action.evidence.kind)] ?? OWNER_GONE_DEFAULT;
    return <><ReportRecoveryControl owns onChange={onRecoveryControlChange} />
      {/* Keyed by the record version: a request refreshed to a newer version resets an open form, so
          the board never confirms a version it was not shown. */}
      <PreviousServerStopConfirmation key={`${action.id}:${String(action.evidence.recordId)}:${String(action.evidence.recordUpdatedAt ?? "")}`}
        action={action} issueId={issueId} companyId={companyId} className={className}
        confirmStop={stopEvidence => issuesApi.confirmOwnerGone(issueId, {
          actionId: action.id, recordId: action.evidence.recordId as string, stopEvidence,
          // The version shown here: a request refreshed since must be confirmed again.
          ...(typeof action.evidence.recordUpdatedAt === "string" ? { recordVersion: action.evidence.recordUpdatedAt } : {}) })}
        copy={{ waiting: t("workspaces.WorkspaceExportRecovery.ownerGoneWaiting", { what: t(`workspaces.WorkspaceExportRecovery.ownerGoneWhat.${resource}`) }),
          question: t("workspaces.WorkspaceExportRecovery.previousServerStopQuestion"),
          placeholder: t("workspaces.WorkspaceExportRecovery.previousServerStopPlaceholder"),
          resuming: t(`workspaces.WorkspaceExportRecovery.ownerGoneReleasing.${resource}`) }} /></>;
  }
  const ownerRecovery = action?.cause === "native_workspace_finalization_owner_unverified";
  // The task's interruption names this wait; the confirmation is its one action.
  if (ownerRecovery && issueId && companyId && isOwnerStopRequired(action, issueId, companyId)) {
    return <><ReportRecoveryControl owns onChange={onRecoveryControlChange} />
      <PreviousServerStopConfirmation key={`${action.id}:${String(action.evidence.runId)}`}
        action={action} ownerToken={asObject(action.evidence.owner).token as string}
        issueId={issueId} companyId={companyId} className={className} /></>;
  }
  if (!showStatus) return <ReportRecoveryControl owns={false} onChange={onRecoveryControlChange} />;
  if (!action || (!ownerRecovery && !isNativeWorkspaceExportRepairCause(action.cause)) || action.ownerType !== "board"
    || !["active", "escalated"].includes(action.status) || typeof action.evidence.runId !== "string")
    return <ReportRecoveryControl owns={false} onChange={onRecoveryControlChange} />;
  const queued = !!action.evidence.workspaceOwnerStop || action.wakePolicy?.kind === "resume_native_run";
  const automatic = queued || (ownerRecovery && asObject(action.evidence.workspaceOwnerRecovery).state === "resuming");
  return <><ReportRecoveryControl owns={false} onChange={onRecoveryControlChange} />
    <p role="status" className={cn("text-sm text-muted-foreground", className)}>
      {automatic ? t("workspaces.WorkspaceExportRecovery.restoringSavedWork") : t("workspaces.WorkspaceExportRecovery.savedWorkNotRecovered")}
    </p></>;
}

function isRetainedExport(action: IssueRecoveryAction, issueId: string, companyId: string) {
  return action.companyId === companyId && action.sourceIssueId === issueId
    && action.kind === "active_run_watchdog" && ["active", "escalated"].includes(action.status)
    && ["board", "system"].includes(action.ownerType)
    && isRetainedWorkspaceExportCause(action.cause)
    && typeof action.evidence.runId === "string" && action.evidence.runId.length > 0;
}

function isControllerStopRequired(action: IssueRecoveryAction, issueId: string, companyId: string) {
  return action.companyId === companyId && action.sourceIssueId === issueId
    && action.ownerType === "board" && ["active", "escalated"].includes(action.status)
    && typeof action.evidence.runId === "string" && !action.evidence.controllerStop;
}

function isOwnerGoneRequired(action: IssueRecoveryAction, issueId: string, companyId: string) {
  return action.companyId === companyId && action.sourceIssueId === issueId
    && action.ownerType === "board" && ["active", "escalated"].includes(action.status)
    && typeof action.evidence.recordId === "string" && !action.evidence.ownerGone;
}

function isOwnerStopRequired(action: IssueRecoveryAction, issueId: string, companyId: string) {
  return action.companyId === companyId && action.sourceIssueId === issueId
    && action.ownerType === "board" && ["active", "escalated"].includes(action.status)
    && typeof action.evidence.runId === "string" && typeof asObject(action.evidence.owner).token === "string"
    && !action.evidence.workspaceOwnerStop && asObject(action.evidence.workspaceOwnerRecovery).state !== "resuming";
}

/** The exact receipt #19721 records when retained recovery waits on a stopped copyback owner. */
function retainedOwnerStopToken(action: IssueRecoveryAction): string | null {
  const hold = asObject(action.evidence.workspaceOwnerRecovery);
  const token = asObject(hold.owner).token;
  return hold.state === "operator_required" && !action.evidence.workspaceOwnerStop
    && typeof action.evidence.runId === "string" && typeof token === "string" && token.length > 0 ? token : null;
}

/** A previous server that can no longer report cannot confirm its own stop.
 * The board confirms it once; the saved result then finishes without another agent turn. */
function PreviousServerStopConfirmation({ action, ownerToken, issueId, companyId, className, confirmStop, copy }: {
  action: IssueRecoveryAction; issueId: string; companyId: string; className?: string;
  /** Saved-work copyback owner; used when no custom confirmation is given. */
  ownerToken?: string;
  confirmStop?: (stopEvidence: string) => Promise<unknown>;
  copy?: { waiting: string; question: string; placeholder: string; resuming: string };
}) {
  const { t } = useTranslation();
  const runId = action.evidence.runId as string;
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [evidence, setEvidence] = useState("");
  const access = useQuery({ queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess() });
  const accessView = useQueryView(access);
  const canConfirm = (accessView.kind === "ready" || accessView.kind === "stale") && canBoardConfirmOwnerStop(companyId, access.data);
  const confirm = useMutation({ retry: false, // query-error-ok: an explicit board confirmation; the error is shown below.
    mutationFn: () => confirmStop ? confirmStop(evidence.trim())
      : issuesApi.resumeWorkspaceFinalization(issueId, { actionId: action.id, runId, ownerToken: ownerToken!,
        controllerAndCopybackStopped: true, stopEvidence: evidence.trim() }),
    onSuccess: () => {
      setOpen(false);
      void client.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
      void client.invalidateQueries({ queryKey: queryKeys.issues.runs(issueId) });
      void client.invalidateQueries({ queryKey: queryKeys.runDetail(runId) });
    } });
  const ready = evidence.trim().length >= 20;
  return <div className={cn("flex flex-col gap-2 text-sm", className)} data-testid="previous-server-stop">
    <p role="status">{confirm.isSuccess ? copy?.resuming ?? t("workspaces.WorkspaceExportRecovery.restoringSavedWork")
      : copy?.waiting ?? t("workspaces.WorkspaceExportRecovery.defaultStopWaiting")}</p>
    {confirm.isSuccess ? null : !canConfirm
      ? <p className="text-xs text-muted-foreground">{accessView.kind === "loading" || accessView.kind === "reconnecting"
        ? t("workspaces.WorkspaceExportRecovery.checkingAccess") : t("workspaces.WorkspaceExportRecovery.waitingToConfirmStop")}</p>
      : !open ? <Button variant="outline" size="sm" className="self-start" onClick={() => setOpen(true)}>
        {t("workspaces.WorkspaceExportRecovery.confirmThePreviousServer")}</Button>
      : <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); if (ready && !confirm.isPending) confirm.mutate(); }}>
        <label htmlFor={`previous-server-stop-${action.id}`} className="text-xs text-muted-foreground">
          {copy?.question ?? t("workspaces.WorkspaceExportRecovery.howDidYouConfirm")}</label>
        <Textarea id={`previous-server-stop-${action.id}`} value={evidence} onChange={event => setEvidence(event.target.value)}
          placeholder={copy?.placeholder ?? t("workspaces.WorkspaceExportRecovery.forExampleTheOld")} maxLength={12000} rows={3} />
        <div className="flex items-center justify-between gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={confirm.isPending} onClick={() => setOpen(false)}>{t("workspaces.WorkspaceExportRecovery.cancel")}</Button>
          <Button type="submit" size="sm" disabled={!ready || confirm.isPending}>
            {confirm.isPending ? t("workspaces.WorkspaceExportRecovery.confirming") : t("workspaces.WorkspaceExportRecovery.confirmAndResume")}</Button>
        </div>
      </form>}
    {confirm.error ? <p role="alert" className="text-sm text-destructive">
      {confirm.error instanceof Error ? confirm.error.message : t("workspaces.WorkspaceExportRecovery.confirmationNotAccepted")}</p> : null}
  </div>;
}

type RecoveryInput = { actionId: string; runId: string };

/** Plain wording for a source inspection that did not verify. The code stays visible for support. */
function unverifiedSourceText(inspected: WorkspaceSourceInspection | undefined, t: ReturnType<typeof useTranslation>["t"]): string {
  if (!inspected || inspected.status === "verified") return "";
  if (inspected.status === "not_inspected")
    return t("workspaces.WorkspaceExportRecovery.tooManySources");
  const code = inspected.sourceVerification?.reason ?? inspected.failureCode;
  return code === "allocation_ownership_ambiguous"
    ? t("workspaces.WorkspaceExportRecovery.ambiguousOwnership")
    : t("workspaces.WorkspaceExportRecovery.cannotVerifySource", { code });
}

function RetainedFilesRecovery({ action, issueId, companyId, className, onRecoveryControlChange }: {
  action: IssueRecoveryAction; issueId: string; companyId: string; className?: string;
  onRecoveryControlChange?: (owns: boolean) => void;
}) {
  const { t } = useTranslation();
  const runId = action.evidence.runId as string;
  const owner = useDraftOwner();
  const readOwner = useDraftOwnerReader();
  const client = useQueryClient();
  const busy = useRef(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [checkedUnconfirmed, setCheckedUnconfirmed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
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
  // The recovery record is bound by its own identity. Source inspection is a
  // separate read-only probe: it gates only the physical file-recovery request.
  // It legitimately reports "blocked" after files were recovered, or when a
  // sandbox predates ownership receipts; the recorded state stays authoritative.
  function boundAction(data: typeof source.data) {
    const current = data?.actions.find(item => item.id === action.id);
    const inspected = data?.sourceInspection;
    const state = asObject(current?.evidence.workspaceRecovery);
    return current && isRetainedExport(current, issueId, companyId) && current.evidence.runId === runId
      && state.runId === runId && state.schema === "paperclip.workspace-recovery.v1"
      && inspected?.actionId === action.id && inspected.runId === runId ? current : null;
  }
  const sourceVerified = (data: typeof source.data) => Boolean(boundAction(data)) && data?.sourceInspection?.status === "verified";
  const current = sourceReady ? boundAction(source.data) : null;
  const verified = sourceReady && sourceVerified(source.data);
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
        throw new Error(t("workspaces.WorkspaceExportRecovery.recoveryChanged"));
      if (!sourceVerified(observed.data))
        throw new Error(unverifiedSourceText(observed.data?.sourceInspection, t) || t("workspaces.WorkspaceExportRecovery.sourceCouldNotBeVerified"));
      if (!canMutate || !owner || readOwner() !== owner || !storageKey)
        throw new Error(t("workspaces.WorkspaceExportRecovery.accountChanged"));
      const previous = readPendingSend(storageKey, matchesInput);
      if (restartFailedAttempt && (!previous || !Array.isArray(state.requestIds)
        || !state.requestIds.includes(previous.idempotencyKey)
        || asObject(fresh.evidence.systemRecovery).state !== "exhausted"))
        throw new Error(t("workspaces.WorkspaceExportRecovery.previousFailedNotConfirmed"));
      // Unknown acceptance reuses its identity. A new bounded request requires
      // an explicit operator click and a freshly confirmed exhausted attempt.
      const record = (!restartFailedAttempt && previous) || {
        idempotencyKey: createUuid(), payload: { actionId: action.id, runId }, createdAt: Date.now(),
      };
      if (!writePendingSend(storageKey, record))
        throw new Error(t("workspaces.WorkspaceExportRecovery.requestNotSaved"));
      try {
        const result = await issuesApi.recoverWorkspace(issueId, { ...record.payload, idempotencyKey: record.idempotencyKey });
        if (result.actionId !== action.id || !["queued", "recovering", "blocked", "recovered"].includes(result.status))
          throw new Error(t("workspaces.WorkspaceExportRecovery.ackNotConfirmed"));
        setAcknowledged(true);
        setCheckedUnconfirmed(false);
        invalidate();
        await source.refetch();
      } catch (error) {
        setNotice(classifySendFailure(error) === "rejected"
          ? t("workspaces.WorkspaceExportRecovery.requestRejected", { message: error instanceof Error ? error.message : t("workspaces.WorkspaceExportRecovery.inspectItsStatus") })
          : t("workspaces.WorkspaceExportRecovery.requestNotConfirmedReuse"));
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t("workspaces.WorkspaceExportRecovery.unableToInspect"));
    } finally { busy.current = false; }
  } });
  const check = useMutation({ retry: false, mutationFn: async () => { // query-error-ok: operator checks run once; the source read uses the shared query retry policy.
    const observed = await source.refetch();
    if (observed.error) throw observed.error;
    const fresh = boundAction(observed.data);
    if (!fresh) {
      // The task's current recovery replaced this record. Reload the task so it
      // shows that recovery, instead of asking for a refresh that changes nothing.
      invalidate();
      throw new Error(t("workspaces.WorkspaceExportRecovery.recoveryReplacedShowing"));
    }
    const state = asObject(fresh.evidence.workspaceRecovery);
    const ids = state.requestIds;
    const unconfirmed = Boolean(pending && Array.isArray(ids) && !ids.includes(pending.idempotencyKey));
    setCheckedUnconfirmed(unconfirmed);
    setNotice(unconfirmed ? t("workspaces.WorkspaceExportRecovery.noRequestConfirmedYet") : null);
    invalidate();
  } });
  const checkError = isTransientError(check.error) ? null : check.error;
  const failedReceipt = serverAcknowledged && recovery.status === "blocked";
  const confirmedFailedAttempt = failedReceipt && retryable && system.state === "exhausted";
  const waiting = !failedReceipt && !saved && (restoring || acknowledged || serverAcknowledged);
  const unconfirmed = Boolean(pending && !acknowledged && !serverAcknowledged);
  const sourceLoading = sourceView.kind === "loading" || sourceView.kind === "reconnecting";
  // A verified source makes this panel the governed recovery path. Otherwise the
  // task's own Retry (renewed, re-verified recovery) remains the next action.
  const ownsRecoveryControl = canMutate && (sourceLoading || Boolean(current && verified && !saved));
  // `waiting` already excludes a failed accepted request, so the reason stays
  // visible after a failed attempt and hides only while recovery is running.
  const unverified = Boolean(current && !verified && !saved && !waiting);
  return <div className={cn("flex flex-col gap-2 text-sm", className)} data-testid="retained-file-recovery">
    <ReportRecoveryControl owns={ownsRecoveryControl} onChange={onRecoveryControlChange} />
    <p role="status">{saved ? t("workspaces.WorkspaceExportRecovery.statusSaved")
      : failedReceipt ? t("workspaces.WorkspaceExportRecovery.statusFailedReceipt")
      : restoring ? t("workspaces.WorkspaceExportRecovery.statusRestoring")
        : waiting ? t("workspaces.WorkspaceExportRecovery.statusWaiting")
          : t("workspaces.WorkspaceExportRecovery.statusNeedsRecovery")}</p>
    {canMutate ? <>
      {current && verified && retryable && !waiting && (!pending || unconfirmed && checkedUnconfirmed || confirmedFailedAttempt) ? <Button variant="outline" size="sm"
        className="self-start" disabled={request.isPending || check.isPending}
        onClick={() => request.mutate(confirmedFailedAttempt)}>{request.isPending ? t("workspaces.WorkspaceExportRecovery.requestingRecovery")
          : confirmedFailedAttempt ? t("workspaces.WorkspaceExportRecovery.tryRecoveryAgain") : t("workspaces.WorkspaceExportRecovery.recoverSavedFiles")}</Button> : null}
      {waiting || unconfirmed || failedReceipt || source.error || sourceReady && !current ? <Button variant="ghost" size="sm" className="self-start"
        disabled={request.isPending || check.isPending} onClick={() => check.mutate()}>
        {check.isPending ? t("workspaces.WorkspaceExportRecovery.checkingRecovery") : t("workspaces.WorkspaceExportRecovery.checkRecoveryStatus")}
      </Button> : null}
      {sourceView.kind === "loading" || sourceView.kind === "reconnecting" ? <p className="text-xs text-muted-foreground">{t("workspaces.WorkspaceExportRecovery.inspectingTheRecordedFile")}</p> : null}
      {sourceView.kind === "error" || checkError || notice ? <p role="alert" className="text-sm text-destructive">
        {notice ?? (checkError instanceof Error ? checkError.message : t("workspaces.WorkspaceExportRecovery.couldNotInspectFallback"))}
      </p> : null}
      {current && recovery.status === "blocked" && (serverAcknowledged || recovery.retryable !== true)
        ? <p role="alert">{t("workspaces.WorkspaceExportRecovery.fileRecoveryHasNot")}</p> : null}
      {unverified ? <p role="status" className="text-muted-foreground">
        {unverifiedSourceText(source.data?.sourceInspection, t)} {t("workspaces.WorkspaceExportRecovery.doesNotApplyUnverified")}
      </p> : null}
      {sourceReady && !current ? <p role="alert">{t("workspaces.WorkspaceExportRecovery.theRecordedSourceIs")}</p> : null}
    </> : accessView.kind === "error" ? <p role="alert" className="text-sm text-destructive">{t("workspaces.WorkspaceExportRecovery.taskAccessCouldNot")}</p>
      : accessView.kind === "loading" || accessView.kind === "reconnecting" || !owner ? <p role="status" className="text-xs text-muted-foreground">{t("workspaces.WorkspaceExportRecovery.checkingFileRecoveryAccess")}</p>
        : <p className="text-xs text-muted-foreground">{t("workspaces.WorkspaceExportRecovery.aBoardMemberWith")}</p>}
  </div>;
}
