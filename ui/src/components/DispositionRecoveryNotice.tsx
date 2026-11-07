import { t, useTranslation, Trans } from "@/i18n";
import { createContext, useContext, useId, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import type { Agent, Issue, IssueCommentMetadata, IssueRecoveryAction } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/timeAgo";

export type DispositionRecoverySnapshot = NonNullable<IssueCommentMetadata["recovery"]>;
export type DispositionRecoveryContextValue = {
  issue: Pick<Issue, "status" | "assigneeAgentId" | "executionRunId" | "checkoutRunId" | "executionState" | "blockedBy"> & {
    activeRecoveryAction?: Pick<IssueRecoveryAction, "id" | "status" | "kind" | "ownerType" | "returnOwnerAgentId" | "wakePolicy"> & { evidence?: IssueRecoveryAction["evidence"] } | null;
  };
  agentMap?: ReadonlyMap<string, Pick<Agent, "name" | "status">>;
  hasPendingInteraction?: boolean;
  unavailableReason?: string | null;
  onRetry: (actionId: string) => Promise<void>;
};

const RecoveryContext = createContext<DispositionRecoveryContextValue | null>(null);
export function DispositionRecoveryProvider({ value, children }: { value: DispositionRecoveryContextValue; children: ReactNode }) {
  useTranslation("task-components");
  return <RecoveryContext.Provider value={value}>{children}</RecoveryContext.Provider>;
}

/** Older notices can be identified by their stored action/run IDs, never their copy. */
export function readDispositionRecoverySnapshot(metadata: IssueCommentMetadata | null | undefined, action?: DispositionRecoveryContextValue["issue"]["activeRecoveryAction"]): DispositionRecoverySnapshot | null {
  if (metadata?.recovery?.kind === "disposition_repair_escalated") return metadata.recovery;
  if (!metadata || !action || action.kind !== "deliberate_wait_without_target" || action.ownerType !== "board" || action.wakePolicy?.type !== "board_escalation") return null;
  const evidence = action.evidence;
  if (!metadata.sourceRunId || metadata.sourceRunId !== evidence?.latestRunId) return null;
  if (!metadata.sections.some(section => section.rows.some(row => row.type === "key_value" && row.value === action.id))) return null;
  if (typeof evidence.terminalReason !== "string" || typeof evidence.sourceAttemptCount !== "number" || !Number.isInteger(evidence.sourceAttemptCount) || evidence.sourceAttemptCount < 0 || typeof evidence.sourceMaxAttempts !== "number" || !Number.isInteger(evidence.sourceMaxAttempts) || evidence.sourceMaxAttempts <= 0) return null;
  return { kind: "disposition_repair_escalated", actionId: action.id, attemptCount: evidence.sourceAttemptCount, maxAttempts: evidence.sourceMaxAttempts, reason: evidence.terminalReason, assigneeAgentId: action.returnOwnerAgentId };
}

export function useDispositionRecoverySnapshot(metadata: IssueCommentMetadata | null | undefined) {
  return readDispositionRecoverySnapshot(metadata, useContext(RecoveryContext)?.issue.activeRecoveryAction);
}

/** UI affordance only; the server rechecks the current action and all execution gates. */
export function dispositionRetryUnavailableReason(snapshot: DispositionRecoverySnapshot, context: DispositionRecoveryContextValue | null): string | null {
  if (!context) return t("deep-ui:open_the_task_to_review_its_current_state_ed21d6");
  const { issue } = context;
  const action = issue.activeRecoveryAction;
  if (!action || action.id !== snapshot.actionId || action.status !== "active") return t("deep-ui:this_recovery_notice_is_no_longer_active_8bcc81");
  if (issue.status !== "blocked") return t("deep-ui:the_task_s_state_has_changed_review_its_current_state_before_71e317");
  if (action.kind !== "deliberate_wait_without_target" || action.ownerType !== "board" || action.wakePolicy?.type !== "board_escalation") return t("deep-ui:the_task_s_recovery_state_has_changed_refresh_to_see_the_cur_2b6e7c");
  if (!snapshot.assigneeAgentId || issue.assigneeAgentId !== snapshot.assigneeAgentId || action.returnOwnerAgentId !== snapshot.assigneeAgentId) return t("deep-ui:the_assigned_agent_has_changed_review_the_task_before_retryi_bbbc9c");
  if (context.unavailableReason) return context.unavailableReason;
  if (context.hasPendingInteraction) return t("deep-ui:respond_to_the_pending_question_or_confirmation_before_retry_8ffb0d");
  if (issue.executionRunId || issue.checkoutRunId) return t("deep-ui:the_task_already_has_an_active_run_wait_for_it_to_finish_a7b645");
  if (issue.executionState?.status === "pending") return t("deep-ui:the_task_is_waiting_for_a_review_or_approval_e82e5e");
  if (issue.blockedBy?.some(blocker => blocker.status !== "done" && blocker.status !== "cancelled")) return t("deep-ui:resolve_the_task_s_blockers_before_retrying_be0f8f");
  const agent = context.agentMap?.get(snapshot.assigneeAgentId);
  if (agent?.status === "paused") return t("deep-ui:the_assigned_agent_is_paused_resume_the_agent_before_retryin_4e52ab");
  if (agent?.status === "terminated") return t("deep-ui:the_assigned_agent_is_no_longer_available_8cf16b");
  return null;
}

function descriptionFor(snapshot: DispositionRecoverySnapshot) {
  if (snapshot.reason === "owner_budget_blocked") return t("deep-ui:recovery_budget_stopped");
  if (snapshot.reason === "owner_not_invokable") return t("deep-ui:recovery_owner_unavailable");
  if (snapshot.reason === "unchanged_source_state_exhausted") return t("deep-ui:recovery_exhausted", { count: snapshot.attemptCount, attempts: snapshot.attemptCount === 2 ? t("deep-ui:recovery_two") : snapshot.attemptCount });
  return t("deep-ui:recovery_stopped");
}

/** Same component in both task interfaces and Storybook; no prose controls actions. */
export function DispositionRecoveryNotice({ snapshot, createdAt, defaultExpanded = false }: {
  snapshot: DispositionRecoverySnapshot;
  createdAt?: string;
  defaultExpanded?: boolean;
}) {
  useTranslation("task-components");
  const context = useContext(RecoveryContext);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [pending, setPending] = useState(false);
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState<{ raw: string } | { key: string } | null>(null);
  const inFlight = useRef(false);
  const detailsId = useId();
  const titleId = useId();
  const unavailableId = useId();
  const unavailableReason = dispositionRetryUnavailableReason(snapshot, context);
  const historical = Boolean(context && context.issue.activeRecoveryAction?.id !== snapshot.actionId);
  const agentName = (snapshot.assigneeAgentId && context?.agentMap?.get(snapshot.assigneeAgentId)?.name) || t("deep-ui:the_assigned_agent_52c658");
  const HeadingIcon = requested || historical ? Check : TriangleAlert;

  async function retry() {
    if (!context || unavailableReason || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await context.onRetry(snapshot.actionId);
      setRequested(true);
    } catch (cause) {
      setError(cause instanceof Error ? { raw: cause.message } : { key: "recovery_retry_failed" });
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <section aria-labelledby={titleId} className="flex min-w-0 gap-2.5 py-3" data-testid="disposition-recovery-notice">
      <HeadingIcon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", requested || historical ? "text-muted-foreground" : "text-(--status-task-icon-todo)")} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-col gap-1" role="status" aria-live="polite">
          <h2 id={titleId} className="break-words text-sm font-medium text-foreground">
            {requested ? t("task-components:retryRequested_6ef56fa4") : historical ? t("task-components:agentNeededAttention_cf12a1b6") : t("task-components:agentNeedsAttention_fca5d0b0")}
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {requested ? t("task-components:theTaskWasReturnedToToDo_764021e0", { value1: agentName }) : descriptionFor(snapshot)}
          </p>
        </div>
        {unavailableReason && !requested ? (
          <p id={unavailableId} className="text-xs leading-relaxed text-muted-foreground">
            {!historical && <span className="font-medium text-foreground">{t("task-components:retryUnavailable_458cbe4c")}{" "}</span>}{unavailableReason}
          </p>
        ) : null}
        {error ? <p role="alert" className="text-sm text-destructive"><Trans ns="task-components" i18nKey="sentence_ef7ba0fde40a" components={{ part1: <>{error && ("raw" in error ? error.raw : t(`deep-ui:${error.key}`))}</> }} /></p> : null}
        <div className="flex flex-wrap items-center gap-2">
          {!requested && !historical ? (
            <Button size="xs" variant="outline" disabled={pending || Boolean(unavailableReason)} aria-describedby={unavailableReason ? unavailableId : undefined} onClick={() => void retry()}>
              {pending ? <Loader2 aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" /> : <RotateCcw aria-hidden="true" className="size-3" />}
              {pending ? t("task-components:requestingRetry_bb24a440") : t("task-components:retryAgent_542baccf")}
            </Button>
          ) : null}
          <Button size="xs" variant="ghost" className="text-muted-foreground" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(current => !current)}>
            {expanded ? t("task-components:hideDetails_c9722a7a") : t("task-components:viewDetails_d1bf045b")}
            <ChevronDown aria-hidden="true" className={cn("size-3", expanded && "rotate-180")} />
          </Button>
          {createdAt ? <time dateTime={createdAt} className="font-mono text-xs text-muted-foreground sm:ml-auto">{timeAgo(createdAt)}</time> : null}
        </div>
        {expanded ? (
          <div id={detailsId} className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-3">
            <dl className="flex flex-col gap-2 text-xs">
              <div className="flex flex-wrap justify-between gap-1"><dt className="text-muted-foreground">{t("task-components:assignedWhenRecoveryStopped_38214f4d")}</dt><dd>{agentName}</dd></div>
              <div className="flex flex-wrap justify-between gap-1"><dt className="text-muted-foreground">{t("task-components:automaticAttempts_35a02e3b")}</dt><dd className="font-mono">{t("deep-ui:recovery_attempts", { count: snapshot.attemptCount, max: snapshot.maxAttempts })}</dd></div>
              <div className="flex flex-wrap justify-between gap-1"><dt className="text-muted-foreground">{t("task-components:automaticRetriesForThisRecovery_1ac4415a")}</dt><dd>{t("task-components:stopped_1a4f630a")}</dd></div>
            </dl>
            <p className="text-xs leading-relaxed text-muted-foreground">{t("task-components:recoveryAskedTheAssignedAgentToRecord_4970e649")}</p>
            <div className="flex flex-col gap-1"><span className="text-xs text-muted-foreground">{t("task-components:technicalReason_8469882d")}</span><code className="break-all font-mono text-xs">{snapshot.reason}</code></div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
