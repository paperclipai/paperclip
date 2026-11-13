import { ArrowUpRight, Check, Hand, UserRound } from "lucide-react";
import { type Agent, type AttentionItem, type AttentionReceipt, type AttentionSubject } from "@paperclipai/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { deriveInitials } from "@/components/Identity";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { StatusIcon } from "@/components/StatusIcon";
import { Button } from "@/components/ui/button";
import {
  ATTENTION_NO_CLAIM_TEXT,
  attentionClaimAlternative,
  attentionReceiptLine,
  attentionResponderText,
  describeAttentionAudience,
} from "@/lib/attention-views";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/timeAgo";
import { DecisionCardFooter } from "@/components/DecisionCardFooter";
import { NeedsYouPanel, NeedsYouPanelRow, needsYouCardLabel } from "./NeedsYouCardKit";

/**
 * Who is asking (PAP-775, UI2): the requester's avatar and name, agent or
 * person. A system alert nobody asked for shows nothing.
 */
export function NeedsYouRequester({ item, agentMap, userLabelMap, currentUserId }: {
  item: AttentionItem;
  agentMap: ReadonlyMap<string, Agent>;
  userLabelMap?: ReadonlyMap<string, string> | null;
  currentUserId?: string | null;
}) {
  const requester = item.requester;
  const base = "inline-flex min-w-0 items-center gap-2 text-xs leading-4.5 text-muted-foreground";
  if (requester?.kind === "user") {
    if (requester.id === currentUserId) return null;
    const name = userLabelMap?.get(requester.id) ?? requester.name ?? "A teammate";
    return <span data-attention-requester="user" className={base} title={name}>
      <Avatar size="xs" aria-hidden="true"><AvatarFallback>{deriveInitials(name)}</AvatarFallback></Avatar><span className="truncate">from {name}</span>
    </span>;
  }
  const agent = requester?.kind === "agent" ? agentMap.get(requester.id) : undefined;
  const name = requester?.name ?? agent?.name ?? item.originAgentName;
  if (!name) return null;
  return <span data-attention-requester="agent" className={base} title={name}>
    <AgentAvatar agent={agent ?? { id: requester?.id, name }} name={name} size={20} />
    <span className="truncate">from {name}</span>
  </span>;
}

/**
 * The card's type, said as what to do (PAP-775, Paper "A · Compact cards").
 * A card for someone else puts their name first ("@Dotta Confirm or decline");
 * your own card doesn't name you. Why the card is yours stays in the tooltip.
 */
export function NeedsYouTypeLabel({ item, currentUserId, userLabelMap }: {
  item: AttentionItem;
  currentUserId: string | null | undefined;
  userLabelMap?: ReadonlyMap<string, string> | null;
}) {
  const description = currentUserId ? describeAttentionAudience(item, currentUserId) : null;
  const forUserId = description?.kind === "other" ? description.userId : null;
  const why = description?.kind === "mine" ? `Why me? ${description.text}${description.transferredByUserId ? ` @${userLabelMap?.get(description.transferredByUserId) ?? "someone"}` : ""}` : undefined;
  return <span data-attention-type-label className="min-w-0 truncate text-xs leading-4.5 text-muted-foreground" title={why}>
    {forUserId ? <span data-attention-for-user={forUserId} className="text-foreground">@{userLabelMap?.get(forUserId) ?? "someone"} </span> : null}
    {needsYouCardLabel(item)}
  </span>;
}

/**
 * An ownerless card's corner (PAP-775, A2): "No owner yet" with Claim, or a
 * link to assign it on its task. Your own and other people's cards say whose
 * they are in the type label instead. The server re-checks every action.
 */
export function NeedsYouAudience({ item, currentUserId, userLabelMap, onClaim, claiming = false }: {
  item: AttentionItem;
  currentUserId: string | null | undefined;
  userLabelMap?: ReadonlyMap<string, string> | null;
  onClaim?: (item: AttentionItem) => void;
  claiming?: boolean;
}) {
  const description = currentUserId ? describeAttentionAudience(item, currentUserId) : null;
  if (!description || description.kind === "mine" || description.kind === "other") return null;
  if (description.kind === "company" && !description.claimable) return null;
  const responders = attentionResponderText(item, description, userLabelMap);
  const alternative = onClaim ? attentionClaimAlternative(item) : null;
  return <div className="flex shrink-0 items-center gap-2 text-xs leading-4.5 text-muted-foreground" data-attention-audience={description.kind} title={responders ?? undefined}>
    {description.kind === "pool" ? <span className="inline-flex items-center gap-1"><UserRound className="size-3.5" aria-hidden="true" />No owner yet</span> : null}
    {description.claimable && onClaim ? <Button type="button" variant="outline" size="xs" disabled={claiming} onClick={(event) => { event.stopPropagation(); onClaim(item); }}>
      <Hand className="h-3 w-3" />{claiming ? "Claiming…" : "Claim"}
    </Button> : null}
    {alternative?.kind === "assign" ? <Button asChild variant="outline" size="xs">
      <Link to={alternative.href} disableIssueQuicklook data-attention-open-to-assign onClick={(event) => event.stopPropagation()}>Open to assign</Link>
    </Button> : null}
    {alternative?.kind === "none" ? <span data-attention-no-claim className="sr-only">{ATTENTION_NO_CLAIM_TEXT}</span> : null}
  </div>;
}

/** The task a card belongs to, whichever field the feed put it in. */
export function needsYouTaskRef(item: AttentionItem): AttentionSubject | null {
  return item.relatedIssue ?? (item.subject.kind === "issue" ? item.subject : null);
}

/**
 * The footer's task link (PAP-775, UI4, UI5): the task's standard status icon,
 * then its ID, then (when there is room) its title. Opens the exact spot in
 * the task (IA5).
 */
export function NeedsYouTaskLink({ task, short = false, onOpen }: {
  task: AttentionSubject | null;
  short?: boolean;
  onOpen: (href: string) => void;
}) {
  if (!task?.href) return null;
  const href = task.href;
  return <button type="button" data-attention-task-link title={task.title ?? undefined} onClick={() => onOpen(href)}
    className={cn("flex min-w-0 items-center gap-1.5 text-left text-(length:--text-compact) leading-5 text-muted-foreground hover:text-foreground", short ? "shrink-0" : "max-w-full")}>
    {task.status ? <StatusIcon status={task.status} size="sm" /> : null}
    <span className="min-w-0 truncate">{task.identifier ?? "Open task"}{short || !task.title ? null : ` · ${task.title}`}</span>
    <ArrowUpRight className="size-4 shrink-0" />
  </button>;
}

/**
 * What someone else did with your request (PAP-775, Paper card 15; PAP-749
 * plan §6): an Updates card. It isn't in the badge and has no ⋯ menu; Dismiss
 * hides it for you, and it leaves on its own after 7 days.
 */
export function NeedsYouReceiptCard({ receipt, userLabelMap, onDismiss, onOpen, dismissing = false }: {
  receipt: AttentionReceipt;
  userLabelMap?: ReadonlyMap<string, string> | null;
  onDismiss: (receipt: AttentionReceipt) => void;
  onOpen: (href: string) => void;
  dismissing?: boolean;
}) {
  const actor = userLabelMap?.get(receipt.actorUserId) ?? "Someone";
  const href = receipt.href ?? receipt.issue?.href ?? null;
  const negative = receipt.outcome === "rejected" || receipt.outcome === "withdrawn";
  return <article className="coordinator-decision-card space-y-3" data-attention-receipt={receipt.outcome} aria-label={attentionReceiptLine(receipt, userLabelMap)}>
    <div className="flex items-center justify-between gap-4">
      <span className="text-xs leading-4.5 text-muted-foreground">View a request update</span>
      <div className="flex shrink-0 items-center gap-3 text-xs leading-4.5 text-muted-foreground">
        <span className="inline-flex items-center gap-1"><Avatar size="xs" aria-hidden="true"><AvatarFallback>{deriveInitials(actor)}</AvatarFallback></Avatar>from {actor}</span>
        <time dateTime={receipt.createdAt} title={new Date(receipt.createdAt).toLocaleString()}>{timeAgo(receipt.createdAt)}</time>
      </div>
    </div>
    <div className="space-y-1.5">
      <h2>{receipt.title ?? "Your request"}</h2>
      {receipt.reason ? <p className="text-sm text-muted-foreground">{receipt.reason}</p> : null}
    </div>
    <NeedsYouPanel>
      <NeedsYouPanelRow icon={negative ? <StatusIcon status="cancelled" /> : <Check className="text-(--status-task-icon-done)" />}
        title={attentionReceiptLine(receipt, userLabelMap).replace(/@/g, "")} />
    </NeedsYouPanel>
    <DecisionCardFooter leading={receipt.issue?.href ? <NeedsYouTaskLink task={{ kind: "issue", id: receipt.issue.id, companyId: "", title: receipt.issue.title, identifier: receipt.issue.identifier, status: null, href: receipt.issue.href, metadata: {} }} onOpen={onOpen} /> : null}>
      <Button type="button" variant="ghost" disabled={dismissing} onClick={() => onDismiss(receipt)}>Dismiss</Button>
      {href ? <Button type="button" variant="outline" onClick={() => onOpen(href)}>View request</Button> : null}
    </DecisionCardFooter>
  </article>;
}
