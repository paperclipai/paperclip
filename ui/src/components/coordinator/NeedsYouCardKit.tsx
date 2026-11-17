import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { attentionCardKind, attentionCardType, type AttentionCardType, type AttentionItem } from "@paperclipai/shared";
import { cn } from "@/lib/utils";

/**
 * The parts every Needs You card is built from (PAP-775, Paper "A · Compact
 * cards"): a type label that says what to do, an inset context panel, and a
 * footer with the task link on the left and the actions on the right. Each
 * card type fills the panel and the actions with its own content.
 */

const CARD_TYPE_LABELS: Record<AttentionCardType, string> = {
  answer_questions: "Answer questions",
  make_choice: "Make a choice",
  review_plan: "Review a plan",
  confirm: "Confirm or decline",
  suggested_tasks: "Accept suggested tasks",
  review_deliverable: "Review a deliverable",
  review_items: "Review items",
  board_approval: "Approve a request",
  join_request: "Review a join request",
  tool_access: "Approve tool or secret access",
  connect_service: "Connect a service",
  review_task: "Review a task",
  failed_run: "Fix a failed run",
  budget_stop: "Resolve a budget stop",
  blocked_task: "Unblock a task",
  recovery: "Recover a run",
};

const APPROVAL_LABELS: Record<string, string> = {
  hire_agent: "Approve an agent hire",
  approve_ceo_strategy: "Approve a strategy",
  budget_override_required: "Approve a budget override",
};

/** The card's type, said as what to do ("Review a plan"). */
export function needsYouCardLabel(item: AttentionItem): string {
  const type = attentionCardType(item);
  if (type === "board_approval") return APPROVAL_LABELS[String(item.subject.metadata?.type ?? "")] ?? CARD_TYPE_LABELS.board_approval;
  if (type === "failed_run" && item.sourceKind === "agent_error_alert") return "Fix an agent error";
  if (type === "budget_stop" && item.subject.metadata?.thresholdType === "soft") return "Review a budget warning";
  return CARD_TYPE_LABELS[type];
}

export type NeedsYouSection = "decisions" | "problems" | "updates";

export const NEEDS_YOU_SECTIONS: Record<NeedsYouSection, { title: string }> = {
  decisions: { title: "Decisions" },
  problems: { title: "Problems" },
  updates: { title: "Updates" },
};

export function needsYouSection(item: AttentionItem): NeedsYouSection {
  return attentionCardKind(item) === "problem" ? "problems" : "decisions";
}

/** The inset panel under the ask: what the decision is about. */
export function NeedsYouPanel({ children, className }: { children: ReactNode; className?: string }) {
  return <div data-needs-you-panel className={cn("flex min-w-0 flex-col gap-2 rounded-md bg-background p-3", className)}>{children}</div>;
}

/**
 * One line in the panel: an icon, a title and a meta line, with ↗ when it opens
 * something (a document in the side panel, a run, a person).
 */
export function NeedsYouPanelRow({ icon, title, meta, onOpen, href, label }: {
  icon?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  onOpen?: () => void;
  href?: string;
  /** Accessible name for the open control; defaults to the title text. */
  label?: string;
}) {
  const body = <>
    {icon ? <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">{icon}</span> : null}
    <span className="flex min-w-0 grow basis-0 flex-col gap-0.5">
      <span className="truncate text-(length:--text-compact) font-medium leading-5 text-foreground">{title}</span>
      {meta ? <span className="truncate text-xs leading-4.5 text-muted-foreground">{meta}</span> : null}
    </span>
    {onOpen || href ? <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
  </>;
  const className = "flex w-full min-w-0 items-center gap-2.5 text-left";
  if (href) return <a href={href} aria-label={label} className={cn(className, "hover:[&_span]:text-foreground")}>{body}</a>;
  if (onOpen) return <button type="button" aria-label={label} onClick={onOpen} className={cn(className, "rounded-sm hover:[&_span]:text-foreground")}>{body}</button>;
  return <div className={className}>{body}</div>;
}

/** The small grey line at the bottom of a panel. */
export function NeedsYouPanelNote({ children }: { children: ReactNode }) {
  return <p data-needs-you-note className="text-xs leading-4.5 text-muted-foreground">{children}</p>;
}
