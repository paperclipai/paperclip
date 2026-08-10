import { useContext, useMemo, useState } from "react";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import type {
  Agent,
  IssueBlockerAttention,
  IssueRecoveryAction,
  IssueRelationIssueSummary,
  IssueScheduledRetry,
  IssueThreadInteraction,
  SuccessfulRunHandoffState,
} from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { StatusGlyph } from "../StatusGlyph";
import { Curtain } from "../DecisionShelf";
import { IssueBlockedNotice } from "../IssueBlockedNotice";
import {
  IssueRecoveryActionCard,
  type RecoveryReissueRequest,
  type RecoveryResolveOutcome,
} from "../IssueRecoveryActionCard";
import { IssueScheduledRetryCard } from "../IssueScheduledRetryCard";
import {
  resolveTaskNextAction,
  TASK_NEXT_ACTION_GLYPH,
  type TaskDecisionShelf,
} from "./task-next-action";

/**
 * Sticky "Decision / Next action" bar for the redesigned task thread (flag:
 * enableTaskChatRedesign) — the per-task mirror of the global Decision Queue.
 *
 * It ALWAYS renders (never null): the two positive rungs ("On track…", "All
 * caught up") are the reassuring/dopamine states. The verdict is derived purely
 * by {@link resolveTaskNextAction} from props already passed to the thread; the
 * only fetch is the shared per-issue approvals query (deduped with the Activity
 * tab). `expand` CTAs disclose a Curtain whose body is the EXISTING banner
 * (IssueBlockedNotice / IssueRecoveryActionCard / IssueScheduledRetryCard),
 * verbatim — this is also the redesign's replacement for those banners, which
 * the thread otherwise dropped.
 */
export interface TaskDecisionBarProps {
  issueId: string | null;
  issueStatus?: string;
  isMobile: boolean;
  /** True while a run is streaming for this task (drives the "working" rung). */
  hasLiveRun: boolean;
  agentName?: string | null;
  /** Ordering of the thread — flips where "latest" is for the review CTA. */
  newestFirst: boolean;

  // Resolver + shelf data (passthrough from the thread's props).
  blockedBy: IssueRelationIssueSummary[];
  liveIssueIds?: ReadonlySet<string>;
  blockerAttention?: IssueBlockerAttention | null;
  successfulRunHandoff?: SuccessfulRunHandoffState | null;
  scheduledRetry?: IssueScheduledRetry | null;
  recoveryAction?: IssueRecoveryAction | null;
  interactions?: IssueThreadInteraction[];
  agentMap?: Map<string, Agent>;

  // Recovery-action handlers (wired verbatim into IssueRecoveryActionCard).
  onResolveRecoveryAction?: (outcome: RecoveryResolveOutcome) => void;
  onReissueIsolatedRecoveryAction?: (request: RecoveryReissueRequest) => void;
  reissueIsolatedRecoveryActionPending?: boolean;
  onReconcileForwardRecoveryAction?: () => void;
  onBreakGlassOverrideRecoveryAction?: (reason: string) => void;
  onQuarantineRestoreRecoveryAction?: () => void;
  quarantineRestoreRecoveryActionPending?: boolean;
  canBreakGlassRecoveryAction?: boolean;
  reconcileRecoveryActionPending?: boolean;
  canFalsePositiveRecoveryAction?: boolean;
}

/**
 * Fallback client for hosts that mount the bar without a QueryClientProvider
 * (isolated unit-test / preview renders). The approvals query is disabled in
 * that case, so this client never fetches — it only keeps `useQuery` from
 * throwing. Mirrors the pattern in `useTaskChatRedesignEnabled`.
 */
let detachedClient: QueryClient | null = null;
function getDetachedClient(): QueryClient {
  detachedClient ??= new QueryClient();
  return detachedClient;
}

const SHELF_LABEL: Record<TaskDecisionShelf, string> = {
  recovery: "Recovery",
  blocked: "Blockers",
  retry: "Scheduled retry",
  handoff: "Next step",
};

/** Scroll a `data-item-id` row into view, or to the latest end of the thread. */
function scrollToDecisionTarget(targetId: string | null, newestFirst: boolean) {
  if (typeof document === "undefined") return;
  if (targetId) {
    const selector = `[data-item-id="${targetId.replace(/"/g, '\\"')}"]`;
    document.querySelector(selector)?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  // "Latest" — newest sits at the top when newest-first, else at the bottom.
  const scroller = document.querySelector('[data-testid="task-chat-scroller"]');
  if (scroller instanceof HTMLElement) {
    scroller.scrollTo({ top: newestFirst ? 0 : scroller.scrollHeight, behavior: "smooth" });
    return;
  }
  const doc = document.scrollingElement ?? document.documentElement;
  window.scrollTo({ top: newestFirst ? 0 : doc.scrollHeight, behavior: "smooth" });
}

export function TaskDecisionBar(props: TaskDecisionBarProps) {
  const {
    issueId,
    issueStatus,
    isMobile,
    hasLiveRun,
    agentName,
    newestFirst,
    blockedBy,
    liveIssueIds,
    blockerAttention,
    successfulRunHandoff,
    scheduledRetry,
    recoveryAction,
    interactions,
    agentMap,
  } = props;

  // Shared per-issue approvals query — same key as IssueDetail's Activity tab,
  // so it dedupes rather than adding a second request. Reads the context client
  // directly (with a detached fallback) so the bar stays mountable without a
  // QueryClientProvider, e.g. in isolated tests/previews.
  const contextClient = useContext(QueryClientContext);
  const { data: approvals } = useQuery(
    {
      queryKey: queryKeys.issues.approvals(issueId ?? ""),
      queryFn: () => issuesApi.listApprovals(issueId ?? ""),
      enabled: !!issueId && contextClient != null,
    },
    contextClient ?? getDetachedClient(),
  );
  const pendingApproval = useMemo(
    () => (approvals ?? []).find((approval) => approval.status === "pending") ?? null,
    [approvals],
  );

  const action = useMemo(
    () =>
      resolveTaskNextAction({
        issueId,
        issueStatus,
        recoveryAction,
        blockedBy,
        pendingApproval,
        interactions,
        scheduledRetry,
        successfulRunHandoff,
        liveIssueIds,
        hasLiveRun,
        agentName,
      }),
    [
      issueId,
      issueStatus,
      recoveryAction,
      blockedBy,
      pendingApproval,
      interactions,
      scheduledRetry,
      successfulRunHandoff,
      liveIssueIds,
      hasLiveRun,
      agentName,
    ],
  );

  const [openShelf, setOpenShelf] = useState<TaskDecisionShelf | null>(null);
  const cta = action.cta;
  const expandShelf = cta?.type === "expand" ? cta.shelf : null;
  const shelfOpen = expandShelf != null && openShelf === expandShelf;

  const unresolvedBlockers = useMemo(
    () => blockedBy.filter((blocker) => blocker.status !== "done" && blocker.status !== "cancelled"),
    [blockedBy],
  );

  const renderShelfBody = (shelf: TaskDecisionShelf) => {
    if (shelf === "recovery" && recoveryAction) {
      return (
        <IssueRecoveryActionCard
          action={recoveryAction}
          agentMap={agentMap}
          onResolve={props.onResolveRecoveryAction}
          onReissueIsolated={props.onReissueIsolatedRecoveryAction}
          reissuePending={props.reissueIsolatedRecoveryActionPending}
          onReconcileForward={props.onReconcileForwardRecoveryAction}
          onBreakGlassOverride={props.onBreakGlassOverrideRecoveryAction}
          onQuarantineRestore={props.onQuarantineRestoreRecoveryAction}
          quarantineRestorePending={props.quarantineRestoreRecoveryActionPending}
          canBreakGlass={props.canBreakGlassRecoveryAction}
          reconcilePending={props.reconcileRecoveryActionPending}
          canFalsePositive={props.canFalsePositiveRecoveryAction}
        />
      );
    }
    if (shelf === "retry") {
      return <IssueScheduledRetryCard issueId={issueId} scheduledRetry={scheduledRetry} />;
    }
    // blocked + handoff both route through IssueBlockedNotice, which renders the
    // blocker list and/or the successful-run handoff notice as applicable.
    return (
      <IssueBlockedNotice
        issueId={issueId}
        issueStatus={issueStatus}
        blockers={unresolvedBlockers}
        allBlockers={blockedBy}
        liveIssueIds={liveIssueIds}
        blockerAttention={blockerAttention}
        successfulRunHandoff={successfulRunHandoff}
        scheduledRetry={scheduledRetry}
        agentName={
          successfulRunHandoff?.assigneeAgentId
            ? agentMap?.get(successfulRunHandoff.assigneeAgentId)?.name ?? null
            : null
        }
      />
    );
  };

  return (
    <div
      data-testid="task-decision-bar"
      data-decision-kind={action.kind}
      className={cn(
        "border-b border-border/60 bg-background",
        isMobile && "sticky top-0 z-20 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60",
      )}
    >
      <div className="mx-auto flex w-full max-w-(--tc-shell-max-w) items-center gap-2 px-4 py-2">
        <StatusGlyph status={TASK_NEXT_ACTION_GLYPH[action.kind]} size="sm" />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{action.title}</span>
        {cta ? (
          cta.type === "href" ? (
            <Button asChild variant="outline" size="xs" className="shrink-0 gap-1">
              <Link to={cta.href}>
                {cta.label}
                <ExternalLink className="h-3.5 w-3.5" />
              </Link>
            </Button>
          ) : cta.type === "scroll" ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="shrink-0"
              onClick={() => scrollToDecisionTarget(cta.targetId, newestFirst)}
            >
              {cta.label}
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="shrink-0 gap-1"
              aria-expanded={shelfOpen}
              onClick={() => setOpenShelf((current) => (current === cta.shelf ? null : cta.shelf))}
            >
              {cta.label}
              {shelfOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </Button>
          )
        ) : null}
      </div>
      {expandShelf != null && shelfOpen ? (
        // The bar's CTA is the primary opener; the mounted Curtain adds a
        // labelled header that also collapses it. Only mounted while open, so
        // the collapsed state is the one-line bar alone (no duplicate header).
        <div className="mx-auto w-full max-w-(--tc-shell-max-w) px-4 pb-2">
          <Curtain
            label={SHELF_LABEL[expandShelf]}
            open
            onToggle={() => setOpenShelf(null)}
          >
            {renderShelfBody(expandShelf)}
          </Curtain>
        </div>
      ) : null}
    </div>
  );
}
