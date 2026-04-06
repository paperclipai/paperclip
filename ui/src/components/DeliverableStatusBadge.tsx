import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const STATUS_CONFIG: Record<string, { label: string; dotColor: string; className: string }> = {
  draft: {
    label: "Draft",
    dotColor: "bg-muted-foreground",
    className: "bg-muted/50 text-muted-foreground border-border",
  },
  in_review: {
    label: "In Review",
    dotColor: "bg-[var(--primary)] animate-pulse",
    className: "bg-[var(--primary)]/10 text-[var(--primary)] border-[var(--primary)]/25",
  },
  changes_requested: {
    label: "Changes Requested",
    dotColor: "bg-[var(--status-warning)]",
    className: "bg-[var(--status-warning)]/10 text-[var(--status-warning)] border-[var(--status-warning)]/25",
  },
  approved: {
    label: "Approved",
    dotColor: "bg-[var(--status-active)]",
    className: "bg-[var(--status-active)]/10 text-[var(--status-active)] border-[var(--status-active)]/25",
  },
  rejected: {
    label: "Rejected",
    dotColor: "bg-[var(--status-error)]",
    className: "bg-[var(--status-error)]/10 text-[var(--status-error)] border-[var(--status-error)]/25",
  },
  reopened: {
    label: "Reopened",
    dotColor: "bg-[var(--primary)]",
    className: "bg-[var(--primary)]/10 text-[var(--primary)] border-[var(--primary)]/25",
  },
};

const PRIORITY_CONFIG: Record<string, { label: string; icon: string; className: string }> = {
  critical: {
    label: "Critical",
    icon: "🔴",
    className: "bg-[var(--status-error)]/10 text-[var(--status-error)] border-[var(--status-error)]/25",
  },
  high: {
    label: "High",
    icon: "🟠",
    className: "bg-[var(--status-warning)]/10 text-[var(--status-warning)] border-[var(--status-warning)]/25",
  },
  medium: {
    label: "Medium",
    icon: "🟡",
    className: "bg-[var(--status-warning)]/10 text-[var(--status-warning)] border-[var(--status-warning)]/25",
  },
  low: {
    label: "Low",
    icon: "⚪",
    className: "bg-muted/50 text-muted-foreground border-border",
  },
};

export function DeliverableStatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status] ?? {
    label: status,
    dotColor: "bg-muted-foreground",
    className: "bg-muted/50 text-muted-foreground border-border",
  };
  return (
    <Badge variant="outline" className={cn("rounded-[2px] text-[9px] font-[var(--font-mono)] font-medium uppercase gap-1.5 pl-1.5", config.className)}>
      <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", config.dotColor)} />
      {config.label}
    </Badge>
  );
}

export function DeliverablePriorityBadge({ priority }: { priority: string }) {
  const config = PRIORITY_CONFIG[priority] ?? {
    label: priority,
    icon: "⚪",
    className: "bg-muted/50 text-muted-foreground border-border",
  };
  return (
    <Badge variant="outline" className={cn("rounded-[2px] text-[9px] font-[var(--font-mono)] font-medium uppercase gap-1", config.className)}>
      <span className="text-[8px] leading-none">{config.icon}</span>
      {config.label}
    </Badge>
  );
}
