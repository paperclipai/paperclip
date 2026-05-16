import { Link } from "@/lib/router";
import { cn } from "../lib/utils";
import type { IssueNeedsBoardReason } from "@paperclipai/shared";

function needsBoardReasonToneClass(kind: IssueNeedsBoardReason["kind"]): string {
  switch (kind) {
    case "pending_approval":
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "pending_request_confirmation":
      return "border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300";
    case "board_assignee_in_review":
      return "border-violet-500/35 bg-violet-500/10 text-violet-700 dark:text-violet-300";
    case "board_execution_stage":
      return "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    default:
      return "border-border bg-muted/40 text-foreground";
  }
}

export function needsBoardReasonShortLabel(reason: IssueNeedsBoardReason): string {
  switch (reason.kind) {
    case "pending_approval":
      return "Approval";
    case "pending_request_confirmation":
      return "Confirmation";
    case "board_assignee_in_review":
      return "Board review";
    case "board_execution_stage":
      if (reason.stageType === "approval") return "Approval stage";
      if (reason.stageType === "review") return "Review stage";
      return "Execution stage";
    default:
      return reason.label;
  }
}

export function needsBoardIssueActionLabel(reason: IssueNeedsBoardReason): string {
  switch (reason.action.type) {
    case "approval":
      return "Open approval";
    case "interaction":
      return "Open confirmation";
    case "issue":
      if (reason.kind === "board_execution_stage") return "Open stage";
      if (reason.kind === "board_assignee_in_review") return "Open review";
      return "Open issue";
    default:
      return "Open action";
  }
}

type NeedsBoardReasonPillProps = {
  reason: IssueNeedsBoardReason;
  className?: string;
  href?: string;
  onClick?: () => void;
};

export function NeedsBoardReasonPill({
  reason,
  className,
  href,
  onClick,
}: NeedsBoardReasonPillProps) {
  const pillClassName = cn(
    "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors",
    needsBoardReasonToneClass(reason.kind),
    href || onClick ? "hover:brightness-[0.96] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring" : null,
    className,
  );
  const label = needsBoardReasonShortLabel(reason);

  if (onClick) {
    return (
      <button
        type="button"
        className={pillClassName}
        title={reason.label}
        aria-label={`${label}. ${reason.label}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onClick();
        }}
      >
        {label}
      </button>
    );
  }

  if (href) {
    return (
      <Link
        to={href}
        className={pillClassName}
        title={reason.label}
        aria-label={`${label}. ${reason.label}`}
      >
        {label}
      </Link>
    );
  }

  return (
    <span className={pillClassName} title={reason.label} aria-label={`${label}. ${reason.label}`}>
      {label}
    </span>
  );
}
