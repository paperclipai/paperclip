import { ArrowUpRight, Check } from "lucide-react";
import type { DecisionHistoryItem } from "@paperclipai/shared";

/** A recorded decision links to its context; it is not a second approval form. */
export function CoordinatorDecisionReceipt({ item, onOpen, userLabelMap }: {
  item: DecisionHistoryItem;
  onOpen: (href: string) => void;
  /** Names the person a different person answered for ("for @dotta"; PAP-749 plan §6). */
  userLabelMap?: ReadonlyMap<string, string> | null;
}) {
  const handledFor = item.handledForUserId ? userLabelMap?.get(item.handledForUserId) ?? "someone else" : null;
  return <button type="button" onClick={() => onOpen(item.href)} className="coordinator-decision-receipt flex w-full items-center gap-3 rounded-xl border border-border bg-card p-4 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
    <Check className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    <span className="min-w-0 flex-1 space-y-1">
      <span className="block text-sm font-medium">{item.label}{handledFor ? <span className="font-normal text-muted-foreground"> · for @{handledFor}</span> : null}</span>
      <span className="block truncate text-sm text-muted-foreground">{item.issueIdentifier} · {item.issueTitle}</span>
    </span>
    <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
  </button>;
}
