import { ArrowRight, Hand, UserRound } from "lucide-react";
import {
  ATTENTION_PERSONAL_VIEWS,
  type AttentionItem,
  type AttentionPersonalView,
  type AttentionViewCounts,
} from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ATTENTION_VIEW_LABELS,
  describeAttentionAudience,
  unassignedBannerText,
} from "@/lib/attention-views";
import { cn } from "@/lib/utils";

/**
 * For you / Unassigned / Company (PAP-749 plan §1, Rule 3). The "For you"
 * count is the shared badge; the other two counts stay on their own tabs.
 */
export function AttentionViewSwitch({
  value,
  counts,
  onChange,
  className,
}: {
  value: AttentionPersonalView;
  counts: AttentionViewCounts;
  onChange: (view: AttentionPersonalView) => void;
  className?: string;
}) {
  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as AttentionPersonalView)} className={className}>
      <TabsList variant="line" aria-label="Decision views" className="p-0">
        {ATTENTION_PERSONAL_VIEWS.map((view) => (
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
  if (description.kind === "mine") {
    return (
      <p className={base} data-attention-audience="mine">
        <span className="font-medium text-foreground">Why me?</span>
        <span>{description.text}</span>
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
      </div>
    );
  }
  return (
    <div className={base} data-attention-audience={description.kind}>
      <span>{description.text}</span>
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
