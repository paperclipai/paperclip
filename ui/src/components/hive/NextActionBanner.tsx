import type { ComponentType } from "react";
import {
  CheckCircle2,
  Clock,
  Eye,
  Link as LinkIcon,
  MessageCircleQuestion,
  Wrench,
} from "lucide-react";
import type { IssueBlockedInboxAttention } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import {
  ATTENTION_VERB_LABEL,
  attentionVerb,
  formatStoppedAge,
  primaryAttentionAction,
  type AttentionVerb,
} from "../../lib/blockedInbox";
import { createIssueDetailPath } from "../../lib/issueDetailBreadcrumb";

interface NextActionBannerProps {
  attention: IssueBlockedInboxAttention;
  currentIssueId: string;
  onApprove?: (approvalId: string) => void;
  onReject?: (approvalId: string) => void;
  onAccept?: (issueId: string) => void;
  acting?: boolean;
}

type IconComponent = ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;

const VERB_ICON: Record<AttentionVerb, IconComponent> = {
  answer: MessageCircleQuestion,
  approve: CheckCircle2,
  review: Eye,
  unblock: LinkIcon,
  recover: Wrench,
  waiting: Clock,
};

// Accent per verb — color is paired with the verb word + icon, never the only signal.
const VERB_ACCENT: Record<AttentionVerb, string> = {
  answer: "border-violet-300/70 bg-violet-50 dark:border-violet-500/30 dark:bg-violet-500/10",
  approve: "border-violet-300/70 bg-violet-50 dark:border-violet-500/30 dark:bg-violet-500/10",
  review: "border-amber-300/70 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-500/10",
  unblock: "border-amber-300/70 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-500/10",
  recover: "border-cyan-300/70 bg-cyan-50 dark:border-cyan-500/30 dark:bg-cyan-500/10",
  waiting: "border-slate-300 bg-slate-50 dark:border-slate-500/30 dark:bg-slate-500/15",
};

function ownerLabel(attention: IssueBlockedInboxAttention): string {
  const { owner } = attention;
  if (owner.type === "user" || owner.type === "board") return "owned by you";
  if (owner.label) return `owned by ${owner.label}`;
  if (owner.type === "external") return "owned externally";
  return "owner unresolved";
}

// The operator's one-line "what needs you" banner for a blocked issue. Reads the
// already-computed attention (owner + action + resolving ids) and renders the
// single verb + primary action that moves the task forward.
export function NextActionBanner({
  attention,
  currentIssueId,
  onApprove,
  onReject,
  onAccept,
  acting = false,
}: NextActionBannerProps) {
  const verb = attentionVerb(attention.reason);
  const action = primaryAttentionAction(attention);
  const Icon = VERB_ICON[verb];
  const dotClass =
    attention.severity === "critical"
      ? "bg-red-500"
      : attention.severity === "high"
        ? "bg-orange-500"
        : null;

  const target = action.targetIssueRef;
  const targetPathId = target?.identifier ?? target?.id ?? null;
  const targetLabel = target?.identifier ?? "the blocker";

  return (
    <div
      data-testid="next-action-banner"
      data-verb={verb}
      data-kind={action.kind}
      className={`rounded-md border p-3 ${VERB_ACCENT[verb]}`}
    >
      <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold">
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="uppercase tracking-wide">{ATTENTION_VERB_LABEL[verb]}</span>
        <span className="font-normal text-muted-foreground">· {ownerLabel(attention)}</span>
        {dotClass ? (
          <span aria-hidden="true" className={`ml-1 inline-block h-1.5 w-1.5 rounded-full ${dotClass}`} />
        ) : null}
        <span className="ml-auto font-normal text-muted-foreground">
          {formatStoppedAge(attention.stoppedSinceAt)}
        </span>
      </div>

      <p className="mb-2.5 text-sm leading-snug">
        {action.label}
        {action.detail ? <span className="text-muted-foreground"> — {action.detail}</span> : null}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {action.kind === "approval" && action.approvalId ? (
          <>
            <Button
              size="sm"
              disabled={acting}
              onClick={() => onApprove?.(action.approvalId!)}
              aria-label="Approve and unblock"
            >
              <CheckCircle2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={acting}
              onClick={() => onReject?.(action.approvalId!)}
              aria-label="Reject"
            >
              Reject
            </Button>
          </>
        ) : null}

        {action.kind === "reviewAccept" ? (
          <>
            <Button
              size="sm"
              disabled={acting}
              onClick={() => onAccept?.(target?.id ?? currentIssueId)}
              aria-label={`Accept ${targetLabel} and mark it done`}
            >
              <CheckCircle2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              Accept{target ? ` ${targetLabel}` : ""} → Done
            </Button>
            {targetPathId && target?.id !== currentIssueId ? (
              <Link
                to={createIssueDetailPath(targetPathId)}
                className="text-xs font-medium text-muted-foreground underline-offset-2 hover:underline"
              >
                Open {targetLabel} to request changes
              </Link>
            ) : null}
          </>
        ) : null}

        {action.kind === "navigate" && targetPathId ? (
          <Button size="sm" variant="outline" asChild>
            <Link to={createIssueDetailPath(targetPathId)} aria-label={`Go to ${targetLabel}`}>
              <LinkIcon className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              Go to {targetLabel}
            </Link>
          </Button>
        ) : null}

        {action.kind === "answer" ? (
          targetPathId ? (
            <Button size="sm" variant="outline" asChild>
              <Link to={createIssueDetailPath(targetPathId)} aria-label={`Answer on ${targetLabel}`}>
                <MessageCircleQuestion className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                Answer
              </Link>
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">Respond in the thread below.</span>
          )
        ) : null}
      </div>
    </div>
  );
}
