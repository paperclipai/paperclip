import { memo, useState, type KeyboardEvent, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  CalendarClock,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Loader2,
  UserRound,
} from "lucide-react";
import { type Agent, type AttentionDetailImage, type AttentionItem } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { accessApi } from "../api/access";
import { approvalsApi } from "../api/approvals";
import { issuesApi } from "../api/issues";
import { getAdapterLabel } from "../adapters/adapter-display-registry";
import { queryKeys } from "../lib/queryKeys";
import { ApprovalCardPanel } from "./ApprovalCardPanel";
import { DecisionCardFooter } from "./DecisionCardFooter";
import { NeedsYouPanel, NeedsYouPanelNote, NeedsYouPanelRow } from "./coordinator/NeedsYouCardKit";
import { useToastActions } from "../context/ToastContext";
import { invalidateAttentionRecordViews } from "../lib/attention-record-views";
import { claimReviseDraftWork, clearReviseDraft, releaseReviseDraftWork, reviseDraftKey, useReviseDraft, type ReviseDraftWork } from "../lib/revise-draft-store";
import { describeAttentionResolverAudience, type InteractionAudienceDescription } from "../lib/interaction-audience";
import { interactionResolutionErrorMessage } from "../lib/interaction-resolution-error";
import {
  attentionDetailImages,
  attentionDetailLine,
  attentionImageUrl,
  attentionStatus,
  attentionTaskRef,
  decideByLabel,
  isInlineResolvable,
  sourceMeta,
} from "../lib/attention";
import { cn, relativeTime } from "../lib/utils";
import { DecisionTriageStrip } from "./DecisionTriageStrip";
import { InteractionAudienceLine } from "./InteractionAudienceLine";
import { AttentionAudienceLine } from "./AttentionViews";
import { attentionAudienceLineNamesResponders } from "../lib/attention-views";
import { AttentionObligationEvidence } from "./AttentionObligationEvidence";
import { StatusGlyph } from "./StatusGlyph";
import { Button } from "./ui/button";
import { Collapsible, CollapsibleContent } from "./ui/collapsible";
import { Textarea } from "./ui/textarea";
import { AttentionCloseMenu, AttentionForOtherGate, AttentionHiddenChip, AttentionStaleChip } from "./AttentionCloseMenu";
import { BudgetAlertActions, FailedRunActions } from "./AttentionInlineVerbs";
import { AttentionInteractionResolver } from "./AttentionInteractionResolver";
import { DecisionResolver } from "./DecisionResolver";
import { StalledReviewActions } from "./StalledReviewActions";
import { readIssueReviewPolicyMetadata } from "../lib/review-policy";
import { attentionOtherAudienceUserId } from "../lib/attention-close";

// Decision-action buttons: a comfortable tap target when the row is narrow
// (h-9 / text-sm), shrinking back to the dense pill (h-6 / text-xs) once the
// row's own container is wide enough (`@xl` ≈ 576px). Container-query driven so
// the row also reflows correctly inside narrow side panels, not just on phones.
const ACTION_BTN = "h-9 gap-1.5 px-3 text-sm @xl:h-6 @xl:gap-1 @xl:px-2 @xl:text-xs";

interface AttentionQueueRowProps {
  item: AttentionItem;
  companyId: string;
  expanded: boolean;
  /** Receives the row's item so the parent can pass one stable callback for every row. */
  onToggleExpand: (item: AttentionItem) => void;
  /** "Archive for me" in the Close… menu: hides the card for you only (PAP-749 Rule 6). */
  onDismiss: (item: AttentionItem) => void;
  /** "Snooze for me" in the Close… menu. */
  onSnooze?: (item: AttentionItem, snoozedUntil: string) => void;
  /** "Withdraw request" closes it for everyone; only cards whose `closeModes` allow it. */
  onWithdraw?: (item: AttentionItem, reason: string) => void;
  /** "Transfer to @x" (interactions only). */
  onTransfer?: (item: AttentionItem, userId: string) => void;
  /** A close or transfer of this card is in flight. */
  closing?: boolean;
  /**
   * Restore a card you archived or snoozed (the Archived view, PAP-749 plan
   * §3). The row then says when it was archived or when it comes back, and
   * its Close… menu offers Restore instead of Archive. The card stays
   * answerable like any other row.
   */
  onRestore?: (item: AttentionItem) => void;
  agentMap?: Map<string, Agent>;
  /** Company agents, for the triage strip's route-to-agent picker. */
  agents?: Agent[];
  /** Render the per-card triage strip (queue/decide-by/snooze/route) when expanded. */
  showTriage?: boolean;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
  /** Claim an ownerless card (PAP-749). Pass one stable callback for every row. */
  onClaim?: (item: AttentionItem) => void;
  claiming?: boolean;
  selected?: boolean;
  /**
   * The rest of this card's obligation (PAP-749 plan §2, Rule 11), folded in
   * as one line each. Pass a stable array; the row is memoized.
   */
  evidence?: readonly AttentionItem[];
}

/**
 * Memoized (PAP-13784): the queue renders every feed row in one flat list, so
 * without memo a single keyboard-selection or expand toggle re-renders every
 * row (each carrying a Radix dropdown + mutation). All props are stable or
 * primitive; `item` identity is preserved across refetches by react-query's
 * structural sharing.
 */
export const AttentionQueueRow = memo(function AttentionQueueRow({
  item,
  companyId,
  expanded,
  onToggleExpand,
  onDismiss,
  onSnooze,
  onWithdraw,
  onTransfer,
  closing = false,
  onRestore,
  agentMap,
  agents,
  showTriage = false,
  currentUserId,
  userLabelMap,
  onClaim,
  claiming = false,
  selected = false,
  evidence,
}: AttentionQueueRowProps) {
  const meta = sourceMeta(item.sourceKind);
  // Colour + glyph are borrowed wholesale from the task status system, so a
  // blocking decision reads exactly like a blocked task (DESIGN.md principle 5).
  const status = attentionStatus(item);
  // The task this row belongs to, whichever field the feed put it in.
  const taskRef = attentionTaskRef(item);
  const inline = isInlineResolvable(item);
  const href = item.subject.href;
  const detailLine = attentionDetailLine(item) ?? item.whyNow;
  const images = attentionDetailImages(item);
  const hasImages = images.length > 0;
  // The issue (or source) this row points at — used as the target for the
  // "n more" affordance in the expanded gallery.
  const issueHref = item.relatedIssue?.href ?? href;
  // Inline-resolvable active rows expand to reveal their resolver; rows with
  // images expand to reveal a larger gallery (PAP-13544); triage-enabled rows
  // expand to reveal the per-card triage strip (PAP-16032 §4.5). Any of these
  // gives a header/thumbnail click somewhere to go. Non-inline, image-less rows
  // with no triage keep the explicit Open button and never toggle on a stray click.
  const triageEnabled = showTriage;
  const expandable = inline || hasImages || triageEnabled;
  const activate = () => {
    if (expandable) onToggleExpand(item);
  };
  const onHeaderKeyDown = (e: KeyboardEvent) => {
    if (!expandable) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onToggleExpand(item);
    }
  };

  // Which rows contribute an action bar. Inline rows carry compact decision
  // verbs; deep-link rows carry an Open button.
  // A card for a different person asks "This is for @x. Continue?" before any
  // answer (PAP-749 plan §6), so it offers no one-click verbs while collapsed.
  const forOther = attentionOtherAudienceUserId(item, currentUserId) !== null;
  const compactActions = !forOther ? collectCompactActions(item) : [];
  // Who the server will let resolve this interaction. A collapsed row offers
  // Accept/Reject before anything fetches the interaction, so the audience
  // travels with the feed item; null for every non-interaction source and for a
  // feed built before the metadata existed (PAP-17287).
  const audience = describeAttentionResolverAudience(item);
  const audienceLineNamesResponders = attentionAudienceLineNamesResponders(item, currentUserId);
  const showOpen = !inline && !!href;
  // An expanded inline row hands its footer to the resolver, which owns the
  // decision verbs — so the toggle rides alongside them on one row rather than
  // stranding a lone "See less" under the buttons. That makes the collapsed
  // footer a swap rather than a survivor, so it crossfades with the panel.
  const hasCollapsedOnlyContent = hasImages || inline;

  // Disclosure control. Now the row's only expand affordance: it names what it
  // does instead of leaving a bare chevron to be decoded, and it sits at the
  // bottom-left where the eye lands after reading the row.
  const toggle = expandable ? (
    <button
      type="button"
      className="inline-flex shrink-0 items-center gap-1 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:ring-ring focus-visible:ring-(length:--rad-3) focus-visible:outline-none"
      aria-label={expanded ? "Collapse decision" : "Expand decision"}
      aria-expanded={expanded}
      onClick={activate}
    >
      {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      {expanded ? "See less" : "See more"}
    </button>
  ) : null;

  /**
   * The row's action bar: disclosure on the left, decision verbs on the right.
   * Rendered either inside the collapsed-only cluster (inline rows, where the
   * resolver takes it over once expanded) or as a standing sibling (everything
   * else). `compact` is false for the standing copy so an expanded row does not
   * show collapsed verbs beside the panel's own.
   */
  const renderFooter = ({ compact }: { compact: boolean }) => {
    const showCompact = compactActions.length > 0 && (compact || !expanded);
    if (!toggle && !showCompact && !showOpen) return null;
    return (
      <div className="flex flex-wrap items-center justify-between gap-2" data-attention-actions="true">
        {toggle ?? <span />}

        <div className="flex flex-wrap items-center gap-2 @xl:justify-end">
          {showCompact && (
            <CompactDecisionActions
              item={item}
              companyId={companyId}
              audience={audience}
              onOpen={() => onToggleExpand(item)}
            />
          )}

          {showOpen && (
            <Button asChild variant="default" size="xs" className={ACTION_BTN}>
              <Link to={href!}>
                Open
                <ExternalLink className="h-3 w-3" />
              </Link>
            </Button>
          )}

        </div>
      </div>
    );
  };

  return (
    <div
      className={cn(
        "@container relative flex flex-col gap-4 overflow-hidden rounded-xl border border-border bg-card px-4 pt-3 pb-4",
        // The feed is uncapped, so off-screen rows must not cost layout/paint
        // while scrolling. The intrinsic-size estimate only matters before a
        // row's first paint; `auto` keeps the real measured height afterwards.
        "[content-visibility:auto] [contain-intrinsic-size:auto_104px]",
        "motion-safe:transition-[opacity,transform,border-color,background-color] motion-safe:duration-200 motion-safe:ease-out hover:border-border/80",
        selected && "border-ring ring-1 ring-ring",
      )}
      id={`attention-row-${item.id}`}
      data-attention-row
      data-attention-row-id={item.id}
      data-attention-source={item.sourceKind}
      data-attention-severity={item.severity}
    >
      {/* Meta band: one breadcrumb of identity on the left (kind → task →
          project), recency + overflow on the right. Not part of the clickable
          headline, so the menu never toggles it. */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
            <StatusGlyph status={status} size="md" />
            {meta.label}
          </span>
          {taskRef && (
            <>
              <EyebrowSeparator />
              <Link
                to={taskRef.href ?? "#"}
                className="font-mono text-(length:--text-nano) text-muted-foreground hover:text-foreground"
                onClick={(e) => e.stopPropagation()}
              >
                {taskRef.identifier}
              </Link>
            </>
          )}
          {item.decideBy && (
            <>
              <EyebrowSeparator />
              <span
                className="inline-flex items-center gap-1 text-(length:--text-nano) text-muted-foreground"
                data-attention-decide-by={item.decideBy}
                title={decideByProvenance(item) ? `Set by ${decideByProvenance(item)}` : undefined}
              >
                <CalendarClock className="h-3 w-3" />
                {decideByLabel(item.decideBy)}
                {decideByProvenance(item) && (
                  <span className="text-muted-foreground/80">· set by {decideByProvenance(item)}</span>
                )}
              </span>
            </>
          )}
          {onRestore && item.dismissal?.isActive && (
            <>
              <EyebrowSeparator />
              <AttentionHiddenChip item={item} />
            </>
          )}
          {item.stale && (
            <>
              <EyebrowSeparator />
              <AttentionStaleChip item={item} />
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1" data-attention-menu="true">
          <span className="text-(length:--text-nano) text-muted-foreground">{relativeTime(item.activityAt)}</span>
          <AttentionCloseMenu
            item={item}
            currentUserId={currentUserId}
            userLabelMap={userLabelMap}
            onWithdraw={onWithdraw}
            onArchive={onDismiss}
            onSnooze={onSnooze}
            onTransfer={onTransfer}
            onRestore={onRestore}
            busy={closing}
          />
        </div>
      </div>

      {/* Headline — the primary expand target for inline rows. Title wraps to
          two lines instead of truncating to a sliver on narrow screens. */}
      <div
        className={cn(
          "min-w-0 rounded-md",
          expandable && "cursor-pointer focus-visible:ring-ring focus-visible:ring-(length:--rad-3) focus-visible:outline-none",
        )}
        {...(expandable
          ? {
              role: "button",
              tabIndex: 0,
              "aria-expanded": expanded,
              "aria-label": expanded ? "Collapse decision" : "Expand decision",
              onClick: activate,
              onKeyDown: onHeaderKeyDown,
            }
          : {})}
      >
        <span className="line-clamp-2 text-sm font-medium text-foreground" title={item.subject.title ?? undefined}>
          {item.subject.title ?? meta.label}
        </span>
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{detailLine}</p>
      </div>

      {/* Why this card is here (PAP-749 plan §1, Rule 4): "Why me?", "For
          @name", or why an ownerless card is yours to answer, with Claim. */}
      <AttentionAudienceLine
        item={item}
        currentUserId={currentUserId}
        userLabelMap={userLabelMap}
        onClaim={onClaim}
        claiming={claiming}
        className="-mt-2"
      />

      {/* One card for each obligation (PAP-749 Rule 11): the task waiting on
          this approval, or the work this failed run blocks. */}
      <AttentionObligationEvidence item={item} evidence={evidence} />

      {/* Collapsed-only content. It has no counterpart to morph into — the
          thumbnail strip becomes a full gallery, and an inline row's footer is
          replaced by the resolver's own — so it rides an inverse disclosure and
          crossfades against the panel below: this shrinks and fades out on the
          same tokens as that grows and fades in, instead of popping. */}
      {hasCollapsedOnlyContent && (
        <Collapsible open={!expanded} className="contents">
          <CollapsibleContent data-decision-disclosure className="-mt-4">
            <div className="flex flex-col gap-4 pt-4">
              {hasImages && <ThumbnailStack images={images} />}
              {/* The audience reads *before* the verbs it qualifies: a compact
                  Accept sitting alone asks for a decision without saying whose
                  it is (PAP-17287). */}
              {/* The audience line above already names who may answer when
                  it knows the viewer; a second clause would contradict it
                  (PAP-767). */}
              {audience && !audienceLineNamesResponders && <InteractionAudienceLine audience={audience} variant="compact" />}
              {inline && renderFooter({ compact: true })}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* The disclosure panel. Collapsible measures the panel and publishes its
          height, so the card grows and shrinks to a real number rather than
          snapping open. `contents` keeps the Root out of the layout, so a
          collapsed row does not pay a flex gap for an empty wrapper — and once
          the exit finishes Radix unmounts the panel, so a collapsed row is not
          left with a live resolver behind it. */}
      <Collapsible open={expanded} onOpenChange={() => onToggleExpand(item)} className="contents">
        <CollapsibleContent data-decision-disclosure className="-mt-4">
          <div className="flex flex-col gap-4 pt-4">
            {hasImages && <ExpandedImages images={images} issueHref={issueHref} />}
            {triageEnabled && <DecisionTriageStrip item={item} companyId={companyId} agents={agents} />}
            {inline && (
              <AttentionForOtherGate item={item} currentUserId={currentUserId} userLabelMap={userLabelMap}>
                <InlineResolver
                  item={item}
                  companyId={companyId}
                  agentMap={agentMap}
                  currentUserId={currentUserId}
                  userLabelMap={userLabelMap}
                  toggle={toggle}
                />
              </AttentionForOtherGate>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* A non-inline row keeps one footer across both states — its Open
          button and its toggle are the same control either way, so it stays
          put rather than crossfading with itself. */}
      {!inline && renderFooter({ compact: false })}
    </div>
  );
});

/**
 * "·" between eyebrow segments.
 *
 * The eyebrow is a flat list of two facts (decision kind, task key), not a
 * hierarchy, so a middle dot reads more honestly than the "/" this started as —
 * a slash implies containment that the two segments do not have.
 */
function EyebrowSeparator() {
  return (
    <span className="text-xs text-muted-foreground" aria-hidden>
      ·
    </span>
  );
}

type CompactDecisionAction = "accept" | "approve" | "reject" | "request_revision";

function compactDecisionAction(item: AttentionItem, verbId: string): CompactDecisionAction | null {
  if (item.sourceKind === "approval" && (verbId === "approve" || verbId === "reject" || verbId === "request_revision")) {
    return verbId;
  }
  if (item.sourceKind === "join_request" && (verbId === "approve" || verbId === "reject")) {
    return verbId;
  }
  if (
    item.sourceKind === "issue_thread_interaction"
    && item.subject.metadata?.kind === "request_confirmation"
    && (verbId === "accept" || verbId === "reject")
  ) {
    return verbId;
  }
  return null;
}

/**
 * Weight used to order a decision's verbs. The affirmative verb always lands
 * rightmost — the same place in every row, collapsed or expanded — so the
 * operator's aim never has to move with the verb list.
 */
const VERB_ORDER: Record<"outline" | "destructive" | "default", number> = {
  outline: 0,
  destructive: 1,
  default: 2,
};

interface CompactAction {
  action: CompactDecisionAction;
  label: string;
  id: string;
  description: string;
}

/** The compact accept/reject verbs a collapsed row can resolve in place. */
function collectCompactActions(item: AttentionItem): CompactAction[] {
  return item.decisionVerbs
    .slice(0, 3)
    .flatMap((verb) => {
      const action = compactDecisionAction(item, verb.id);
      return action ? [{ action, label: verb.label, id: verb.id, description: verb.description ?? "" }] : [];
    })
    .sort((a, b) => VERB_ORDER[decisionVerbVariant(a)] - VERB_ORDER[decisionVerbVariant(b)]);
}

function CompactDecisionActions({
  item,
  companyId,
  audience,
  onOpen,
}: {
  item: AttentionItem;
  companyId: string;
  /** Effective resolver audience, so a denial can name who *can* respond. */
  audience: InteractionAudienceDescription | null;
  onOpen: () => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const actions = collectCompactActions(item);

  const decision = useMutation<unknown, Error, CompactDecisionAction>({
    mutationFn: (action: CompactDecisionAction) => {
      if (item.sourceKind === "approval") {
        if (action === "approve") return approvalsApi.approve(item.subject.id);
        if (action === "reject") return approvalsApi.reject(item.subject.id);
        return approvalsApi.requestRevision(item.subject.id);
      }
      if (item.sourceKind === "join_request") {
        return action === "approve"
          ? accessApi.approveJoinRequest(companyId, item.subject.id)
          : accessApi.rejectJoinRequest(companyId, item.subject.id);
      }
      if (item.sourceKind === "issue_thread_interaction") {
        const issueId = item.subject.metadata?.issueId;
        if (typeof issueId !== "string") throw new Error("Missing issue reference for this decision.");
        if (action === "accept") return issuesApi.acceptInteraction(issueId, item.subject.id);
        return issuesApi.rejectInteraction(issueId, item.subject.id);
      }
      throw new Error("This decision must be completed from its detail view.");
    },
    onSuccess: (_result, action) => {
      // Task detail, chat and the approval page show the same record.
      invalidateAttentionRecordViews(queryClient, companyId, item);
      pushToast({
        title: compactDecisionSuccessLabel(item.sourceKind, action),
        tone: "success",
      });
    },
    onError: (error, action) => {
      // A policy denial is permanent, so it keeps the server's reason and names
      // the real responder instead of asking for a retry that will fail again.
      pushToast({
        title: `Could not ${decisionLabel(action)}`,
        body: interactionResolutionErrorMessage(error, audience),
        tone: "error",
      });
    },
  });

  if (actions.length === 0) return null;

  return (
    <div className="flex w-full flex-wrap items-center gap-2 @xl:w-auto @xl:justify-end @xl:gap-1" aria-label="Decision actions">
      {actions.map(({ action, id, label, description }) => (
        <Button
          key={id}
          type="button"
          variant={decisionVerbVariant({ id, label, description })}
          size="xs"
          className={cn(ACTION_BTN, "min-w-0 flex-1 @xl:flex-none")}
          disabled={decision.isPending}
          onClick={(event) => {
            event.stopPropagation();
            if (item.sourceKind === "issue_thread_interaction" && action === "reject") {
              onOpen();
              return;
            }
            decision.mutate(action);
          }}
        >
          {decision.isPending && decision.variables === action && <Loader2 className="h-3 w-3 animate-spin" />}
          {label}
        </Button>
      ))}
    </div>
  );
}

function decisionLabel(action: CompactDecisionAction): string {
  if (action === "request_revision") return "sent for revision";
  if (action === "accept" || action === "approve") return "approved";
  return "rejected";
}

function compactDecisionSuccessLabel(sourceKind: AttentionItem["sourceKind"], action: CompactDecisionAction): string {
  if (sourceKind === "approval") return `Approval ${decisionLabel(action)}`;
  if (sourceKind === "join_request") return `Join request ${decisionLabel(action)}`;
  return action === "accept" ? "Confirmation accepted" : "Confirmation declined";
}

function decisionVerbVariant(verb: AttentionItem["decisionVerbs"][number]): "default" | "outline" | "destructive" {
  const text = `${verb.label} ${verb.description ?? ""}`.toLowerCase();
  if (/\b(reject|decline|deny|delete|remove)\b/.test(text)) return "destructive";
  if (/\b(accept|approve|confirm|apply)\b/.test(text)) return "default";
  return "outline";
}

/** Square screenshot thumbnails at the right of the description (plan §10). */
function ThumbnailStack({ images }: { images: AttentionDetailImage[] }) {
  const visible = images.slice(0, 3);
  const extra = images.length - visible.length;
  return (
    <div className="flex shrink-0 items-center">
      <div className="flex -space-x-3">
        {visible.map((img, index) => (
          <img
            key={`${img.assetId}-${index}`}
            src={attentionImageUrl(img.assetId)}
            alt={img.alt ?? ""}
            loading="lazy"
            style={{ zIndex: visible.length - index }}
            className="h-11 w-11 rounded-md border border-border bg-muted object-cover shadow-sm"
          />
        ))}
      </div>
      {extra > 0 && (
        <span className="ml-1 inline-flex h-6 items-center rounded-md border border-border bg-muted px-1.5 text-(length:--text-nano) font-medium text-muted-foreground">
          +{extra}
        </span>
      )}
    </div>
  );
}

/**
 * Larger image gallery shown when a row is expanded (PAP-13544). Shows the
 * first three screenshots at a readable size; if more exist, an "n more" tile
 * links through to the issue where the full set lives.
 */
function ExpandedImages({ images, issueHref }: { images: AttentionDetailImage[]; issueHref: string | null }) {
  const visible = images.slice(0, 3);
  const extra = images.length - visible.length;
  return (
    <div className="flex flex-wrap items-stretch gap-2" data-attention-expanded-images="true">
      {visible.map((img, index) => {
        const src = attentionImageUrl(img.assetId);
        const key = `${img.assetId}-${index}`;
        const image = (
          <img
            src={src}
            alt={img.alt ?? ""}
            loading="lazy"
            className="h-32 w-44 rounded-md border border-border bg-muted object-cover shadow-sm"
          />
        );
        return issueHref ? (
          <Link
            key={key}
            to={issueHref}
            // No task quicklook on evidence. `Link` upgrades any /issues/ href
            // into a hover preview, which here pops a text card over the very
            // screenshot being examined — and because expanding a row mounts
            // this gallery directly under a stationary pointer, the preview
            // opens unbidden and can outlive the pointer that never entered it.
            disableIssueQuicklook
            className="block rounded-md focus-visible:ring-ring focus-visible:ring-(length:--rad-3) focus-visible:outline-none"
            onClick={(e) => e.stopPropagation()}
          >
            {image}
          </Link>
        ) : (
          <span key={key} className="block">
            {image}
          </span>
        );
      })}
      {extra > 0 && (issueHref ? (
        <Link
          to={issueHref}
          // Same gallery, same pointer trap — see the thumbnail note above.
          disableIssueQuicklook
          onClick={(e) => e.stopPropagation()}
          className="flex h-32 w-24 flex-col items-center justify-center rounded-md border border-dashed border-border bg-muted/40 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-ring focus-visible:ring-(length:--rad-3) focus-visible:outline-none"
        >
          <span className="text-base font-semibold">{extra} more</span>
          <span className="mt-0.5 inline-flex items-center gap-1 text-(length:--text-nano)">
            View issue
            <ExternalLink className="h-3 w-3" />
          </span>
        </Link>
      ) : (
        <span className="flex h-32 w-24 items-center justify-center rounded-md border border-dashed border-border bg-muted/40 text-sm font-semibold text-muted-foreground">
          {extra} more
        </span>
      ))}
    </div>
  );
}

/**
 * Who set this row's decide-by deadline, for the card's provenance line
 * ("· set by Prioritizer"). Returns null when unattributed so the chip shows
 * the deadline alone rather than a hollow "set by".
 */
function decideByProvenance(item: AttentionItem): string | null {
  const attribution = item.decideByAttribution;
  if (!attribution) return null;
  if (attribution.type === "agent") return attribution.agentName ?? "an agent";
  return "you";
}

/**
 * Expanded-row content. Resolvers that own their decision verbs also render the
 * row's footer, so the disclosure toggle (`toggle`) sits on the same line as the
 * buttons. The issue-thread interaction card keeps its verbs internally — it is
 * shared with the issue thread surface — so there the toggle gets its own row.
 */
function InlineResolver({
  item,
  companyId,
  agentMap,
  currentUserId,
  userLabelMap,
  toggle,
}: {
  item: AttentionItem;
  companyId: string;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
  toggle: ReactNode;
}) {
  if (item.sourceKind === "decision") {
    return (
      <DecisionResolver
        companyId={companyId}
        decisionId={item.subject.id}
        originIssue={item.relatedIssue}
        agentMap={agentMap}
      />
    );
  }

  if (item.sourceKind === "issue_thread_interaction") {
    const issueId = (item.subject.metadata?.issueId as string | undefined) ?? item.relatedIssue?.id;
    if (!issueId) {
      return <p className="text-xs text-muted-foreground">Missing issue reference for this decision.</p>;
    }
    return (
      <>
        <AttentionInteractionResolver
          companyId={companyId}
          issueId={issueId}
          interactionId={item.subject.id}
          agentMap={agentMap}
          currentUserId={currentUserId}
          userLabelMap={userLabelMap}
        />
        {toggle && <div className="flex items-center">{toggle}</div>}
      </>
    );
  }

  if (item.sourceKind === "approval") {
    return <ApprovalResolver item={item} companyId={companyId} toggle={toggle} />;
  }

  if (item.sourceKind === "join_request") {
    return <JoinRequestResolver item={item} companyId={companyId} toggle={toggle} />;
  }

  if (item.sourceKind === "failed_run") {
    return <FailedRunActions item={item} companyId={companyId} leading={toggle} />;
  }

  if (item.sourceKind === "budget_alert") {
    return <BudgetAlertActions item={item} companyId={companyId} leading={toggle} />;
  }

  if (item.sourceKind === "review") {
    // Inline only for stalled reviews (server sets inlineResolvable then); the
    // subject IS the issue, so its id is the decision target.
    return (
      <StalledReviewActions
        issueId={item.subject.id}
        companyId={companyId}
        footerSlot={toggle}
        reviewPolicy={readIssueReviewPolicyMetadata(item.subject.metadata)}
      />
    );
  }

  return null;
}

/** Footer shared by the resolvers that own their verbs: toggle left, verbs right. */
function ResolverFooter({ toggle, children }: { toggle: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2" data-attention-actions="true">
      {toggle ?? <span />}
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

/** Approve, reject or send back an approval in place (PAP-775, UX1: also on coordinator Needs You). */
export function ApprovalResolver({ item, companyId, toggle, onResolved, shareDraft = false, presentation = "panel", artifactRow, onViewDetails, footerContext }: {
  item: AttentionItem;
  companyId: string;
  toggle: ReactNode;
  onResolved?: () => void;
  /** Another view shows this same approval (PAP-775): share the decision note
   * and the in-flight action with it, so typing mirrors and nothing sends twice. */
  shareDraft?: boolean;
  /**
   * "card": the Needs You card — what is being approved in an inset panel, then
   * View details · Reject · Approve, no note. "panel" (default): the full
   * resolver with the decision note and Request revision, as in the side panel.
   */
  presentation?: "card" | "panel";
  /** Card only: a row for the artifact the card opens, shown as the panel instead of the payload summary. */
  artifactRow?: ReactNode;
  /** Supporting request context stays above the card's action footer. */
  footerContext?: ReactNode;
  /** Card only: opens the full request (the side panel). No button without it. */
  onViewDetails?: () => void;
}) {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const onError = (error: unknown) => setActionError(error instanceof Error ? error.message : "The decision could not be saved.");
  // Keyed by the request's last (re)submission: a revised request starts clean.
  const draftKey = shareDraft ? reviseDraftKey(`approval:${item.subject.id}`, item.updatedAt) : null;
  const [sharedDraft, updateSharedDraft] = useReviseDraft(draftKey);
  const [localNote, setLocalNote] = useState("");
  const note = draftKey ? sharedDraft.reason : localNote;
  const setNote = (next: string) => draftKey ? updateSharedDraft({ reason: next }) : setLocalNote(next);
  const invalidate = () => { if (draftKey) clearReviseDraft(draftKey); invalidateAttentionRecordViews(queryClient, companyId, item); onResolved?.(); };
  const send = (work: ReviseDraftWork, request: (note?: string) => Promise<unknown>) => async () => {
    // The other view is already sending this approval: never send it twice.
    if (draftKey && !claimReviseDraftWork(draftKey, work)) throw new Error("This approval is already being sent.");
    try {
      return await request(note.trim() || undefined);
    } finally {
      if (draftKey) releaseReviseDraftWork(draftKey);
    }
  };
  const approve = useMutation({
    mutationFn: send("accept", (decisionNote) => approvalsApi.approve(item.subject.id, decisionNote)),
    onSuccess: invalidate,
    onMutate: () => setActionError(null),
    onError,
  });
  const reject = useMutation({
    mutationFn: send("reject", (decisionNote) => approvalsApi.reject(item.subject.id, decisionNote)),
    onSuccess: invalidate,
    onMutate: () => setActionError(null),
    onError,
  });
  const revise = useMutation({
    mutationFn: send("revise", (decisionNote) => approvalsApi.requestRevision(item.subject.id, decisionNote)),
    onSuccess: invalidate,
    onMutate: () => setActionError(null),
    onError,
  });
  // Either view sending disables both.
  const working = approve.isPending ? "accept" : reject.isPending ? "reject" : revise.isPending ? "revise" : sharedDraft.working;
  const pending = working !== null;

  if (presentation === "card") {
    const hire = item.subject.metadata?.type === "hire_agent";
    return <>
      <ApprovalCardPanel item={item} companyId={companyId} artifactRow={artifactRow} onViewDetails={onViewDetails} />
      {footerContext}
      {actionError ? <p role="alert" className="text-sm text-destructive">{actionError}</p> : null}
      <DecisionCardFooter leading={toggle}>
        {onViewDetails ? <Button size="sm" variant="ghost" onClick={onViewDetails}>{hire ? "View configuration" : "View details"}</Button> : null}
        <Button size="sm" variant="outline" onClick={() => reject.mutate()} disabled={pending}>
          {working === "reject" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Reject
        </Button>
        <Button size="sm" onClick={() => approve.mutate()} disabled={pending}>
          {working === "accept" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {hire ? "Approve hire" : "Approve"}
        </Button>
      </DecisionCardFooter>
    </>;
  }

  // Verb order matches the collapsed row exactly (revise → reject → approve),
  // so expanding never moves the button the operator was already aiming at.
  return (
    <>
      {actionError ? <p role="alert" className="text-sm text-destructive">{actionError}</p> : null}
      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional decision note…"
        className="min-h-16 text-sm"
        disabled={pending}
      />
      <ResolverFooter toggle={toggle}>
        <Button size="sm" variant="outline" onClick={() => revise.mutate()} disabled={pending}>
          {working === "revise" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Request revision
        </Button>
        <Button size="sm" variant="destructive" onClick={() => reject.mutate()} disabled={pending}>
          {working === "reject" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Reject
        </Button>
        <Button size="sm" onClick={() => approve.mutate()} disabled={pending}>
          {working === "accept" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Approve
        </Button>
      </ResolverFooter>
    </>
  );
}

/** Approve or reject a join request in place (PAP-775, UX1). */
export function JoinRequestResolver({ item, companyId, toggle, onResolved, presentation = "panel" }: {
  item: AttentionItem;
  companyId: string;
  toggle: ReactNode;
  onResolved?: () => void;
  /** "card": the Needs You card (who is asking, then Decline · Approve access); "panel" (default): Reject · Approve. */
  presentation?: "card" | "panel";
}) {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const onError = (error: unknown) => setActionError(error instanceof Error ? error.message : "The join request could not be saved.");
  const invalidate = () => { invalidateAttentionRecordViews(queryClient, companyId, item); onResolved?.(); };
  const approve = useMutation({
    mutationFn: () => accessApi.approveJoinRequest(companyId, item.subject.id),
    onSuccess: invalidate,
    onMutate: () => setActionError(null),
    onError,
  });
  const reject = useMutation({
    mutationFn: () => accessApi.rejectJoinRequest(companyId, item.subject.id),
    onSuccess: invalidate,
    onMutate: () => setActionError(null),
    onError,
  });
  const pending = approve.isPending || reject.isPending;

  if (presentation === "card") {
    const agent = item.subject.metadata?.requestType === "agent";
    const adapter = typeof item.subject.metadata?.adapterType === "string" ? item.subject.metadata.adapterType : null;
    return <>
      <NeedsYouPanel>
        <NeedsYouPanelRow icon={agent ? <Bot /> : <UserRound />} title={item.subject.title ?? "Join request"}
          meta={agent ? ["Agent access", adapter ? getAdapterLabel(adapter) : null].filter(Boolean).join(" · ") : "Member access"} />
        <NeedsYouPanelNote>{agent ? "Approval adds this agent to the company." : "Approval adds them to the company as a member."}</NeedsYouPanelNote>
      </NeedsYouPanel>
      {actionError ? <p role="alert" className="text-sm text-destructive">{actionError}</p> : null}
      <DecisionCardFooter leading={toggle}>
        <Button size="sm" variant="ghost" onClick={() => reject.mutate()} disabled={pending}>
          {reject.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Decline
        </Button>
        <Button size="sm" onClick={() => approve.mutate()} disabled={pending}>
          {approve.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Approve access
        </Button>
      </DecisionCardFooter>
    </>;
  }

  return (
    <>
    {actionError ? <p role="alert" className="text-sm text-destructive">{actionError}</p> : null}
    <ResolverFooter toggle={toggle}>
      <Button size="sm" variant="destructive" onClick={() => reject.mutate()} disabled={pending}>
        {reject.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Reject
      </Button>
      <Button size="sm" onClick={() => approve.mutate()} disabled={pending}>
        {approve.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Approve
      </Button>
    </ResolverFooter>
    </>
  );
}
