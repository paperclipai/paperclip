import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IssueRecoveryAction } from "@paperclipai/shared";
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

/** Requests preservation; the existing worker owns stop, copyback and verification. */
export function WorkspaceExportRecovery({ action, className, issueId, companyId, showStatus = true }: {
  className?: string; action: IssueRecoveryAction | null; issueId?: string; companyId?: string; showStatus?: boolean;
}) {
  // A restart killed the copyback owner of retained saved-work recovery. Recovery
  // and any accepted Retry wait on its receipt; the confirmation is the one action.
  const retainedOwnerToken = action && issueId && companyId && isRetainedExport(action, issueId, companyId)
    ? retainedOwnerStopToken(action) : null;
  if (action && issueId && companyId && retainedOwnerToken) {
    return <PreviousServerStopConfirmation key={`${action.id}:${String(action.evidence.runId)}:${retainedOwnerToken}`}
      action={action} ownerToken={retainedOwnerToken} issueId={issueId} companyId={companyId} className={className} />;
  }
  if (action && issueId && companyId && isRetainedExport(action, issueId, companyId)) {
    return <RetainedFilesRecovery key={`${companyId}:${issueId}:${action.id}:${action.evidence.runId}`}
      action={action} issueId={issueId} companyId={companyId} className={className} />;
  }
  const ownerRecovery = action?.cause === "native_workspace_finalization_owner_unverified";
  // The task's interruption names this wait; the confirmation is its one action.
  if (ownerRecovery && issueId && companyId && isOwnerStopRequired(action, issueId, companyId)) {
    return <PreviousServerStopConfirmation key={`${action.id}:${String(action.evidence.runId)}`}
      action={action} ownerToken={asObject(action.evidence.owner).token as string}
      issueId={issueId} companyId={companyId} className={className} />;
  }
  if (!showStatus) return null;
  if (!action || (!ownerRecovery && !isNativeWorkspaceExportRepairCause(action.cause)) || action.ownerType !== "board"
    || !["active", "escalated"].includes(action.status) || typeof action.evidence.runId !== "string") return null;
  const queued = !!action.evidence.workspaceOwnerStop || action.wakePolicy?.kind === "resume_native_run";
  const automatic = queued || (ownerRecovery && asObject(action.evidence.workspaceOwnerRecovery).state === "resuming");
  return <p role="status" className={cn("text-sm text-muted-foreground", className)}>
    {automatic ? "Restoring saved work…" : "Workspace recovery needs operator assistance. The agent’s result is saved."}
  </p>;
}

function isRetainedExport(action: IssueRecoveryAction, issueId: string, companyId: string) {
  return action.companyId === companyId && action.sourceIssueId === issueId
    && action.kind === "active_run_watchdog" && ["active", "escalated"].includes(action.status)
    && ["board", "system"].includes(action.ownerType)
    && isRetainedWorkspaceExportCause(action.cause)
    && typeof action.evidence.runId === "string" && action.evidence.runId.length > 0;
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
function PreviousServerStopConfirmation({ action, ownerToken, issueId, companyId, className }: {
  action: IssueRecoveryAction; ownerToken: string; issueId: string; companyId: string; className?: string;
}) {
  const runId = action.evidence.runId as string;
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [evidence, setEvidence] = useState("");
  const access = useQuery({ queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess() });
  const accessView = useQueryView(access);
  const canConfirm = (accessView.kind === "ready" || accessView.kind === "stale") && canBoardConfirmOwnerStop(companyId, access.data);
  const confirm = useMutation({ retry: false, // query-error-ok: an explicit board confirmation; the error is shown below.
    mutationFn: () => issuesApi.resumeWorkspaceFinalization(issueId, { actionId: action.id, runId, ownerToken,
      controllerAndCopybackStopped: true, stopEvidence: evidence.trim() }),
    onSuccess: () => {
      setOpen(false);
      void client.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
      void client.invalidateQueries({ queryKey: queryKeys.issues.runs(issueId) });
      void client.invalidateQueries({ queryKey: queryKeys.runDetail(runId) });
    } });
  const ready = evidence.trim().length >= 20;
  return <div className={cn("flex flex-col gap-2 text-sm", className)} data-testid="previous-server-stop">
    <p role="status">{confirm.isSuccess ? "Restoring saved work…"
      : "The previous server stopped while it was saving this task’s files, and Paperclip can’t verify that it stopped. The agent’s result is saved."}</p>
    {confirm.isSuccess ? null : !canConfirm
      ? <p className="text-xs text-muted-foreground">{accessView.kind === "loading" || accessView.kind === "reconnecting"
        ? "Checking access…" : "A company owner or administrator can confirm that the previous server stopped."}</p>
      : !open ? <Button variant="outline" size="sm" className="self-start" onClick={() => setOpen(true)}>
        Confirm the previous server stopped</Button>
      : <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); if (ready && !confirm.isPending) confirm.mutate(); }}>
        <label htmlFor={`previous-server-stop-${action.id}`} className="text-xs text-muted-foreground">
          How did you confirm that the previous server and its file copy stopped?</label>
        <Textarea id={`previous-server-stop-${action.id}`} value={evidence} onChange={event => setEvidence(event.target.value)}
          placeholder="For example: the old server process exited and was not restarted." maxLength={12000} rows={3} />
        <div className="flex items-center justify-between gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={confirm.isPending} onClick={() => setOpen(false)}>Cancel</Button>
          <Button type="submit" size="sm" disabled={!ready || confirm.isPending}>
            {confirm.isPending ? "Confirming…" : "Confirm and resume"}</Button>
        </div>
      </form>}
    {confirm.error ? <p role="alert" className="text-sm text-destructive">
      {confirm.error instanceof Error ? confirm.error.message : "The confirmation was not accepted. Refresh the task and try again."}</p> : null}
  </div>;
}

type RecoveryInput = { actionId: string; runId: string };

function RetainedFilesRecovery({ action, issueId, companyId, className }: {
  action: IssueRecoveryAction; issueId: string; companyId: string; className?: string;
}) {
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
        throw new Error("File recovery changed. Inspect its current status before requesting recovery.");
      if (!canMutate || !owner || readOwner() !== owner || !storageKey)
        throw new Error("Your account changed. Refresh before requesting file recovery.");
      const previous = readPendingSend(storageKey, matchesInput);
      if (restartFailedAttempt && (!previous || !Array.isArray(state.requestIds)
        || !state.requestIds.includes(previous.idempotencyKey)
        || asObject(fresh.evidence.systemRecovery).state !== "exhausted"))
        throw new Error("The previous failed recovery is not confirmed. Check its status before trying again.");
      // Unknown acceptance reuses its identity. A new bounded request requires
      // an explicit operator click and a freshly confirmed exhausted attempt.
      const record = (!restartFailedAttempt && previous) || {
        idempotencyKey: createUuid(), payload: { actionId: action.id, runId }, createdAt: Date.now(),
      };
      if (!writePendingSend(storageKey, record))
        throw new Error("The recovery request could not be saved in this browser. No request was sent.");
      try {
        const result = await issuesApi.recoverWorkspace(issueId, { ...record.payload, idempotencyKey: record.idempotencyKey });
        if (result.actionId !== action.id || !["queued", "recovering", "blocked", "recovered"].includes(result.status))
          throw new Error("The recovery acknowledgement could not be confirmed.");
        setAcknowledged(true);
        setCheckedUnconfirmed(false);
        invalidate();
        await source.refetch();
      } catch (error) {
        setNotice(classifySendFailure(error) === "rejected"
          ? `Recovery request was not confirmed: ${error instanceof Error ? error.message : "Inspect its status."}`
          : "The recovery request could not be confirmed. Check its status before trying again; the saved request will be reused.");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to inspect file recovery.");
    } finally { busy.current = false; }
  } });
  const check = useMutation({ retry: false, mutationFn: async () => { // query-error-ok: operator checks run once; the source read uses the shared query retry policy.
    const observed = await source.refetch();
    if (observed.error) throw observed.error;
    const fresh = boundAction(observed.data);
    if (!fresh) throw new Error("File recovery changed. Refresh the task to inspect the current recovery.");
    const state = asObject(fresh.evidence.workspaceRecovery);
    const ids = state.requestIds;
    const unconfirmed = Boolean(pending && Array.isArray(ids) && !ids.includes(pending.idempotencyKey));
    setCheckedUnconfirmed(unconfirmed);
    setNotice(unconfirmed ? "No recovery request is confirmed yet. Trying again will reuse the saved request." : null);
    invalidate();
  } });
  const checkError = isTransientError(check.error) ? null : check.error;
  const failedReceipt = serverAcknowledged && recovery.status === "blocked";
  const confirmedFailedAttempt = failedReceipt && retryable && system.state === "exhausted";
  const waiting = !failedReceipt && !saved && (restoring || acknowledged || serverAcknowledged);
  const unconfirmed = Boolean(pending && !acknowledged && !serverAcknowledged);
  return <div className={cn("flex flex-col gap-2 text-sm", className)} data-testid="retained-file-recovery">
    <p role="status">{saved ? "Saved files recovered. Task recovery is still being checked."
      : failedReceipt ? "File recovery has not finished. The saved source remains protected."
      : restoring ? "Recovering saved files. Work remains paused until recovery is verified."
        : waiting ? "File recovery is queued. Waiting for verified saved files."
          : "The saved files need recovery before work can continue."}</p>
    {canMutate ? <>
      {current && retryable && !waiting && (!pending || unconfirmed && checkedUnconfirmed || confirmedFailedAttempt) ? <Button variant="outline" size="sm"
        className="self-start" disabled={request.isPending || check.isPending}
        onClick={() => request.mutate(confirmedFailedAttempt)}>{request.isPending ? "Requesting file recovery…"
          : confirmedFailedAttempt ? "Try file recovery again" : "Recover saved files"}</Button> : null}
      {waiting || unconfirmed || failedReceipt || source.error || sourceReady && !current ? <Button variant="ghost" size="sm" className="self-start"
        disabled={request.isPending || check.isPending} onClick={() => check.mutate()}>
        {check.isPending ? "Checking file recovery…" : "Check file recovery status"}
      </Button> : null}
      {sourceView.kind === "loading" || sourceView.kind === "reconnecting" ? <p className="text-xs text-muted-foreground">Inspecting the recorded file source…</p> : null}
      {sourceView.kind === "error" || checkError || notice ? <p role="alert" className="text-sm text-destructive">
        {notice ?? (checkError instanceof Error ? checkError.message : "File recovery could not be inspected. Check its status again.")}
      </p> : null}
      {current && recovery.status === "blocked" && (serverAcknowledged || recovery.retryable !== true)
        ? <p role="alert">File recovery has not finished. The saved source remains protected; service assistance is needed.</p> : null}
      {sourceReady && !current ? <p role="alert">The recorded source is unavailable or has changed. Inspect recovery before continuing.</p> : null}
    </> : accessView.kind === "error" ? <p role="alert" className="text-sm text-destructive">Task access could not be checked. Refresh before requesting file recovery.</p>
      : accessView.kind === "loading" || accessView.kind === "reconnecting" || !owner ? <p role="status" className="text-xs text-muted-foreground">Checking file recovery access…</p>
        : <p className="text-xs text-muted-foreground">A board member with task access can request file recovery.</p>}
  </div>;
}
