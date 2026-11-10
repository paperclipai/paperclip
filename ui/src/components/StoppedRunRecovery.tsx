import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { requiresExecutionReconciliation, type ExecutionBlocker, type ExecutionReconciliation, type IssueRecoveryAction } from "@paperclipai/shared";
import { accessApi } from "../api/access";
import { issuesApi } from "../api/issues";
import { useDraftOwner, useDraftOwnerReader } from "../hooks/useDraftOwner";
import { useTranslation } from "../i18n";
import { canBoardResolveRecoveryAction } from "../lib/recovery-reconcile";
import { queryKeys } from "../lib/queryKeys";
import { asObject, cn } from "../lib/utils";
import { Link } from "@/lib/router";
import { useQueryView } from "./QueryView";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

export function hasStoppedRunReview(blocker: ExecutionBlocker | null | undefined) {
  return Boolean(blocker?.recoveryActionId && blocker.runId && requiresExecutionReconciliation(blocker.cause)
    && !blocker.workspaceRepairRequired);
}

/** Uses the blocker identity, not activeRecoveryAction: a settled no-replay hold
 * still needs review. Keep the confirmed receipt visible after the task refresh. */
export function StoppedRunRecovery({ issueId, companyId, blocker, className }: {
  issueId: string; companyId: string; blocker: ExecutionBlocker | null | undefined; className?: string;
}) {
  const { t } = useTranslation();
  const owner = useDraftOwner();
  const [saved, setSaved] = useState<{ runId: string; actionId: string; owner: string | undefined } | null>(null);
  if (saved && saved.owner === owner && (!blocker || blocker.runId === saved.runId && blocker.recoveryActionId === saved.actionId)) {
    return <p role="status" className={cn("text-sm text-muted-foreground", className)}>{t("stoppedRun.saved", {
      defaultValue: "Outcome review saved. Continuation requested; existing execution gates still apply.",
    })}</p>;
  }
  if (!hasStoppedRunReview(blocker)) return null;
  return <StoppedRunReview key={`${companyId}:${issueId}:${blocker!.recoveryActionId}:${blocker!.runId}:${blocker!.agentId}:${owner}`}
    issueId={issueId} companyId={companyId} blocker={blocker!} owner={owner} className={className}
    onSaved={() => setSaved({ runId: blocker!.runId!, actionId: blocker!.recoveryActionId!, owner })} />;
}

function StoppedRunReview({ issueId, companyId, blocker, owner, className, onSaved }: {
  issueId: string; companyId: string; blocker: ExecutionBlocker; owner: string | undefined;
  className?: string; onSaved: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const client = useQueryClient();
  const readOwner = useDraftOwnerReader();
  const mounted = useRef(true);
  const busy = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<ExecutionReconciliation["actionOutcome"] | "">("");
  const [evidence, setEvidence] = useState("");
  const actionId = blocker.recoveryActionId!;
  const runId = blocker.runId!;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const access = useQuery({ queryKey: queryKeys.access.currentBoardAccess, queryFn: () => accessApi.getCurrentBoardAccess() });
  const accessView = useQueryView(access);
  const matchesAccount = (value: typeof access.data) => Boolean(owner && (value?.source === "local_implicit"
    || owner !== "signed-out" && value?.userId === owner) && canBoardResolveRecoveryAction(companyId, value));
  const canReview = ["ready", "stale"].includes(accessView.kind) && matchesAccount(access.data);
  const source = useQuery({ queryKey: queryKeys.issues.recoveryActions(issueId, null, null),
    queryFn: () => issuesApi.recoveryActions(issueId), enabled: canReview });
  const sourceView = useQueryView(source);
  function boundAction(data: typeof source.data): IssueRecoveryAction | null {
    if (data?.active && data.active.id !== actionId) return null;
    const current = data?.actions.find(item => item.id === actionId);
    if (!current || current.companyId !== companyId || current.sourceIssueId !== issueId || current.cause !== blocker.cause
      || (current.evidence.runId ?? current.evidence.sourceRunId) !== runId
      || current.returnOwnerAgentId !== blocker.agentId || current.evidence.executionReconciliation
      || current.evidence.workspaceRestoreRecovery) return null;
    return ["active", "escalated"].includes(current.status)
      || ["resolved", "cancelled"].includes(current.status) && asObject(current.evidence.automaticRecovery).replay === "blocked"
      ? current : null;
  }
  const current = ["ready", "stale"].includes(sourceView.kind) ? boundAction(source.data) : null;
  const ready = outcome !== "" && evidence.trim().length >= 20 && evidence.trim().length <= 12000;
  const refreshTask = () => {
    void client.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
    void client.invalidateQueries({ queryKey: queryKeys.issues.runs(issueId) });
    void client.invalidateQueries({ queryKey: queryKeys.issues.activity(issueId) });
    void client.invalidateQueries({ queryKey: queryKeys.runDetail(runId) });
  };
  const save = useMutation({ retry: false, // query-error-ok: explicit evidence submission; errors stay beside the retained draft.
    mutationFn: async () => {
      if (!ready || !canReview || !current) { busy.current = false; return; }
      const decision: ExecutionReconciliation = { runId, providerStopped: true,
        actionOutcome: outcome as ExecutionReconciliation["actionOutcome"], outcomeEvidence: evidence.trim() };
      try {
        const [freshSource, freshAccess] = await Promise.all([source.refetch(), access.refetch()]);
        if (!mounted.current || readOwner() !== owner) return;
        if (freshAccess.error) throw freshAccess.error;
        if (!matchesAccount(freshAccess.data)) throw new Error(t("stoppedRun.accessChanged", {
          defaultValue: "Your board access changed. Refresh the task before continuing.",
        }));
        if (freshSource.error) throw freshSource.error;
        const fresh = boundAction(freshSource.data);
        if (!fresh || fresh.status !== current.status || fresh.fingerprint !== current.fingerprint) {
          refreshTask();
          throw new Error(changedText);
        }
        // The server independently verifies terminal state, provider stop, leases,
        // ownership and admission gates. This is never a generic Retry.
        const result = await issuesApi.resolveRecoveryAction(issueId, {
          actionId, outcome: "restored", sourceIssueStatus: "todo", executionReconciliation: decision,
        });
        if (!mounted.current || readOwner() !== owner) return;
        const receipt = result?.recoveryAction;
        const recorded = asObject(receipt?.evidence?.executionReconciliation);
        if (result?.issue?.id !== issueId || result.issue.companyId !== companyId || receipt?.id !== actionId
          || receipt.companyId !== companyId || receipt.sourceIssueId !== issueId || receipt.cause !== blocker.cause
          || receipt.status !== "resolved" || receipt.returnOwnerAgentId !== blocker.agentId
          || (receipt.evidence.runId ?? receipt.evidence.sourceRunId) !== runId
          || recorded.runId !== runId || recorded.providerStopped !== true || recorded.actionOutcome !== decision.actionOutcome
          || recorded.outcomeEvidence !== decision.outcomeEvidence || !recorded.recordedAt || !recorded.actorId
          || asObject(receipt.evidence.automaticRecovery).replay === "blocked"
          || !["pending", "delivered", "delegated"].includes(String(receipt.evidence.continuationDelivery))) {
          throw new Error(unconfirmedText);
        }
        onSaved();
        refreshTask();
        void client.invalidateQueries({ queryKey: queryKeys.issues.allRecoveryActions(issueId) });
      } finally { busy.current = false; }
    },
  });
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const changedText = t("stoppedRun.changed", { defaultValue: "This recovery record is no longer available for review. Refresh the task to load its current state." });
  const unconfirmedText = t("stoppedRun.unconfirmed", { defaultValue: "The reconciliation could not be confirmed. Refresh the task to check its saved state before trying again." });
  const outcomeLabels = {
    completed: t("stoppedRun.outcomes.completed", { defaultValue: "All actions completed" }),
    not_performed: t("stoppedRun.outcomes.not_performed", { defaultValue: "No actions were performed" }),
    mixed: t("stoppedRun.outcomes.mixed", { defaultValue: "Some actions completed, others did not" }),
  };
  return <section className={cn("flex min-w-0 flex-col gap-3 rounded-lg bg-destructive/10 p-4 text-sm", className)}
    aria-label={t("stoppedRun.title", { defaultValue: "Stopped run review" })}>
    <p>{t("stoppedRun.description", { defaultValue: "This run needs an outcome review before work can continue. Recorded work is preserved; uncertain actions will not be replayed." })}</p>
    {!canReview ? <p role={accessView.kind === "error" ? "alert" : "status"} className="text-foreground/80">
      {accessView.kind === "loading" || accessView.kind === "reconnecting" ? t("stoppedRun.checkingAccess", { defaultValue: "Checking access…" })
        : accessView.kind === "error" ? t("stoppedRun.accessUnavailable", { defaultValue: "Could not verify board access. Refresh the task to check again." })
          : t("stoppedRun.boardOnly", { defaultValue: "A board operator can record the verified outcomes here." })}</p>
      : <>
        <Button ref={trigger} variant="outline" size="sm" className="h-auto min-h-9 max-w-full self-start whitespace-normal py-2" aria-expanded={open} aria-controls={`${id}-form`}
          onClick={() => open ? close() : setOpen(true)}>{t("stoppedRun.review", { defaultValue: "Review stopped run" })}</Button>
        {open ? <div id={`${id}-form`} className="flex min-w-0 flex-col gap-3"
          onKeyDown={event => { if (event.key === "Escape" && !save.isPending) { event.stopPropagation(); close(); } }}>
          <p className="text-foreground/80">{t("stoppedRun.run", { defaultValue: "Run" })} {blocker.agentId
            ? <Link to={`/agents/${blocker.agentId}/runs/${runId}`} className="break-all font-mono underline">{runId}</Link>
            : <span className="break-all font-mono">{runId}</span>}</p>
          {blocker.runError ? <details><summary className="cursor-pointer">{t("stoppedRun.details", { defaultValue: "Why the run stopped" })}</summary>
            <p className="break-words text-foreground/80">{blocker.runError}</p></details> : null}
          {current ? <form className="flex flex-col gap-3" aria-busy={save.isPending}
            onSubmit={event => {
              event.preventDefault();
              if (ready && !busy.current && !save.isPending) { busy.current = true; save.mutate(); }
            }}>
            <fieldset className="flex flex-col gap-2" disabled={save.isPending} aria-describedby={`${id}-help`}>
              <legend className="font-medium">{t("stoppedRun.outcome", { defaultValue: "What happened to this run’s actions?" })}</legend>
              {(["completed", "not_performed", "mixed"] as const).map(value => <label key={value} className="flex items-center gap-2 py-1">
                <input type="radio" name={`${id}-outcome`} value={value} checked={outcome === value}
                  onChange={() => setOutcome(value)} required />{outcomeLabels[value]}
              </label>)}
            </fieldset>
            <p id={`${id}-help`} className="text-foreground/80">{t("stoppedRun.outcomeHelp", { defaultValue: "Choose only a verified outcome. If any outcome is still unknown, leave this review open until you have evidence." })}</p>
            <div className="flex flex-col gap-2">
              <label htmlFor={`${id}-evidence`} className="font-medium">{t("stoppedRun.evidence", { defaultValue: "Outcome evidence" })}</label>
              <Textarea id={`${id}-evidence`} value={evidence} onChange={event => setEvidence(event.target.value)}
                disabled={save.isPending} rows={4} maxLength={12000} required aria-describedby={`${id}-evidence-help`} />
              <p id={`${id}-evidence-help`} className="text-foreground/80">{t("stoppedRun.evidenceHelp", { defaultValue: "Describe what you verified and link supporting records. For mixed outcomes, identify which actions completed. Use 20–12,000 characters." })}</p>
            </div>
            <p className="text-foreground/80">{t("stoppedRun.continuation", { defaultValue: "Saving checks that the previous execution has stopped and requests continuation with these outcomes. Existing approvals, blockers and execution limits still apply." })}</p>
            <div className="flex items-center justify-between gap-2">
              <Button type="button" variant="ghost" size="sm" className="h-auto min-h-9 min-w-0 shrink whitespace-normal py-2" disabled={save.isPending} onClick={close}>{t("stoppedRun.cancel", { defaultValue: "Cancel" })}</Button>
              <Button type="submit" size="sm" className="h-auto min-h-9 min-w-0 shrink whitespace-normal py-2" disabled={!ready || save.isPending}>{save.isPending
                ? t("stoppedRun.saving", { defaultValue: "Checking and saving…" }) : t("stoppedRun.save", { defaultValue: "Save and continue" })}</Button>
            </div>
          </form> : <>
            <p role={sourceView.kind === "loading" || sourceView.kind === "reconnecting" ? "status" : "alert"}>
              {sourceView.kind === "loading" || sourceView.kind === "reconnecting" ? t("stoppedRun.loading", { defaultValue: "Loading the stopped-run record…" })
                : sourceView.kind === "error" ? t("stoppedRun.loadFailed", { defaultValue: "Could not load the stopped-run record. Refresh to try again." }) : changedText}</p>
            <Button variant="outline" size="sm" className="h-auto min-h-9 max-w-full self-start whitespace-normal py-2" disabled={source.isFetching}
              onClick={() => { sourceView.retry(); refreshTask(); }}>{t("stoppedRun.refresh", { defaultValue: "Refresh recovery" })}</Button>
          </>}
        </div> : null}
      </>}
    {save.error ? <p role="alert" className="break-words font-medium">{save.error instanceof Error ? save.error.message : unconfirmedText}</p> : null}
  </section>;
}
