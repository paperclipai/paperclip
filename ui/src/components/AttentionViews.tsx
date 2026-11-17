import { ArrowRight, ArrowUpRight, Hand, Mail, UserRound, X } from "lucide-react";
import {
  type AttentionItem,
  type AttentionPersonalView,
  type AttentionReceipt,
  type AttentionViewCounts,
} from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ATTENTION_VIEW_LABELS,
  ATTENTION_NO_CLAIM_TEXT,
  attentionClaimAlternative,
  attentionReceiptLine,
  attentionResponderText,
  attentionUnownedAudienceText,
  attentionViewsFor,
  describeAttentionAudience,
  unassignedBannerText,
} from "@/lib/attention-views";
import { Link } from "@/lib/router";
import { timeAgo } from "@/lib/timeAgo";
import { cn } from "@/lib/utils";

/**
 * For you / Unassigned / Company / Archived (PAP-749 plan §1, Rule 3), plus
 * Everyone for a board member (PAP-768). The "For you" count is the shared
 * badge; the other counts stay on their own tabs.
 */
export function AttentionViewSwitch({
  value,
  counts,
  onChange,
  everyone = false,
  className,
}: {
  value: AttentionPersonalView;
  counts: AttentionViewCounts;
  onChange: (view: AttentionPersonalView) => void;
  /** Show Everyone: the viewer is a board member. */
  everyone?: boolean;
  className?: string;
}) {
  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as AttentionPersonalView)} className={className}>
      <TabsList variant="line" aria-label="Decision views" className="p-0">
        {attentionViewsFor(everyone).map((view) => (
          <TabsTrigger key={view} value={view} data-attention-view={view}>
            {ATTENTION_VIEW_LABELS[view]}
            {view === "mine" ? (
              counts.mine > 0 ? <Badge data-attention-view-count={view}>{counts.mine > 99 ? "99+" : counts.mine}</Badge> : null
            ) : (
              <span data-attention-view-count={view} className="text-xs tabular-nums text-muted-foreground">{counts[view]}</span>
            )}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

/** Shown in "For you" while ownerless cards wait (recommendation e). Not in the badge. */
export function AttentionUnassignedBanner({ count, onOpen }: { count: number; onOpen: () => void }) {
  if (count <= 0) return null;
  return (
    <div
      role="status"
      data-attention-unassigned-banner
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm"
    >
      <span className="inline-flex items-center gap-2 text-foreground">
        <Hand className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        {unassignedBannerText(count)}
      </span>
      <Button type="button" variant="ghost" size="xs" onClick={onOpen}>
        Open Unassigned
        <ArrowRight className="h-3 w-3" />
      </Button>
    </div>
  );
}

/**
 * The card's audience (PAP-749 plan §1, Rule 4): "Why me?" on your own cards,
 * "For @name" on a different person's card, and why you can answer plus Claim
 * on an ownerless card. Presentation only; the server re-checks every action.
 */
export function AttentionAudienceLine({
  item,
  currentUserId,
  userLabelMap,
  onClaim,
  claiming = false,
  className,
}: {
  item: AttentionItem;
  currentUserId: string | null | undefined;
  userLabelMap?: ReadonlyMap<string, string> | null;
  onClaim?: (item: AttentionItem) => void;
  claiming?: boolean;
  className?: string;
}) {
  // Without the viewer there is no honest answer to "Why me?".
  const description = currentUserId ? describeAttentionAudience(item, currentUserId) : null;
  if (!description) return null;
  const base = cn("flex flex-wrap items-center gap-2 text-xs leading-5 text-muted-foreground", className);
  // Who may answer, in the same statement as why the card is here (PAP-767).
  const responders = attentionResponderText(item, description, userLabelMap);
  if (description.kind === "mine") {
    return (
      <p className={base} data-attention-audience="mine">
        <span className="font-medium text-foreground">Why me?</span>
        <span data-attention-transferred-by={description.transferredByUserId}>
          {description.transferredByUserId
            ? `${description.text} @${userLabelMap?.get(description.transferredByUserId) ?? "someone"}`
            : description.text}
          {responders ? <span data-attention-responders>. {responders}</span> : null}
        </span>
      </p>
    );
  }
  if (description.kind === "other") {
    const name = userLabelMap?.get(description.userId) ?? "another person";
    return (
      <div className={base} data-attention-audience="other">
        <Badge variant="outline" data-attention-for-user={description.userId}>
          <UserRound aria-hidden="true" />
          For @{name}
        </Badge>
        {responders ? <span data-attention-responders>{responders}</span> : null}
      </div>
    );
  }
  // Claim stores an owner only on a request; other ownerless cards point to
  // their task, where a person can be assigned (PAP-767).
  const alternative = onClaim ? attentionClaimAlternative(item) : null;
  return (
    <div className={base} data-attention-audience={description.kind}>
      <span>{attentionUnownedAudienceText(item, description, userLabelMap)}</span>
      {alternative?.kind === "none" ? <span data-attention-no-claim>{ATTENTION_NO_CLAIM_TEXT}</span> : null}
      {alternative?.kind === "assign" ? (
        <Button asChild variant="outline" size="xs">
          <Link to={alternative.href} disableIssueQuicklook data-attention-open-to-assign onClick={(event) => event.stopPropagation()}>
            <UserRound className="h-3 w-3" />
            Open to assign
          </Link>
        </Button>
      ) : null}
      {description.claimable && onClaim ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={claiming}
          onClick={(event) => {
            event.stopPropagation();
            onClaim(item);
          }}
        >
          <Hand className="h-3 w-3" />
          {claiming ? "Claiming…" : "Claim"}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Receipts at the top of For you (PAP-749 plan §6, Rule 12): what a different
 * person did with a card that was for you. A receipt is not a card: it is not
 * in the badge, has no Close… menu, and leaves after 7 days or when you
 * dismiss it.
 */
export function AttentionReceiptList({
  receipts,
  userLabelMap,
  onDismiss,
  onOpen,
  dismissingId,
  className,
}: {
  receipts: readonly AttentionReceipt[];
  userLabelMap?: ReadonlyMap<string, string> | null;
  onDismiss: (receipt: AttentionReceipt) => void;
  onOpen?: (href: string) => void;
  dismissingId?: string | null;
  className?: string;
}) {
  if (receipts.length === 0) return null;
  return (
    <section aria-label="Receipts" data-attention-receipts className={cn("space-y-2", className)}>
      {receipts.map((receipt) => {
        const href = receipt.href ?? receipt.issue?.href ?? null;
        return (
          <div
            key={receipt.id}
            role="status"
            data-attention-receipt={receipt.outcome}
            className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm"
          >
            <Mail className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="font-medium text-foreground">{attentionReceiptLine(receipt, userLabelMap)}</p>
              {receipt.title ? <p className="truncate text-muted-foreground">{receipt.title}</p> : null}
              {receipt.reason ? <p className="text-muted-foreground">Reason: {receipt.reason}</p> : null}
              <p className="text-xs text-muted-foreground">
                {receipt.issue?.identifier ? `${receipt.issue.identifier} · ` : null}
                <time dateTime={receipt.createdAt}>{timeAgo(receipt.createdAt)}</time>
              </p>
            </div>
            {href && onOpen ? (
              <Button type="button" variant="ghost" size="xs" onClick={() => onOpen(href)}>
                Open
                <ArrowUpRight className="h-3 w-3" />
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss receipt"
              disabled={dismissingId === receipt.id}
              onClick={() => onDismiss(receipt)}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        );
      })}
    </section>
  );
}
