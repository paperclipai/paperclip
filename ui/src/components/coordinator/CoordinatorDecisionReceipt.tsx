import { ArrowUpRight, Check } from "lucide-react";
import type { DecisionHistoryItem } from "@paperclipai/shared";
import { decisionHistoryContext, decisionHistoryHeadline } from "@/lib/coordinator-attention";

/** A recorded decision links to its context; it is not a second approval form. */
export function CoordinatorDecisionReceipt({ item, onOpen, userLabelMap }: {
  item: DecisionHistoryItem;
  onOpen: (href: string) => void;
  /** Names the person a different person answered for ("for @dotta"; PAP-749 plan §6). */
  userLabelMap?: ReadonlyMap<string, string> | null;
}) {
  const handledFor = item.handledForUserId ? userLabelMap?.get(item.handledForUserId) ?? "someone else" : null;
  return <button type="button" onClick={() => onOpen(item.href)} data-decision-history-item={item.id} className="coordinator-decision-receipt flex w-full items-center gap-3 rounded-xl border border-border bg-card p-4 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
    <Check className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    <span className="min-w-0 flex-1 space-y-1">
      <span className="block text-sm font-medium">{decisionHistoryHeadline(item, userLabelMap)}{handledFor ? <span className="font-normal text-muted-foreground"> · for @{handledFor}</span> : null}</span>
      <span className="block truncate text-sm text-muted-foreground">{decisionHistoryContext(item)}</span>
      {/* Who withdrew it is in the headline; the reason they gave is here (PAP-749 plan §3). */}
      {item.reason ? <span className="block text-sm text-muted-foreground" data-decision-history-reason>Reason: {item.reason}</span> : null}
    </span>
    <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
  </button>;
}
