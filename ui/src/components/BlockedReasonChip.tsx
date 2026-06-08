import { AlertTriangle, Clock, Pause, User, Wrench } from "lucide-react";
import type { ComponentType } from "react";
import type { IssueBlockedInboxSeverity } from "@valadrien-os/shared";
import { cn } from "../lib/utils";
import {
  blockedReasonVariant,
  blockedVariantLabel,
  type BlockedReasonVariant,
} from "../lib/blockedInbox";
import type { IssueBlockedInboxReason } from "@valadrien-os/shared";

interface BlockedReasonChipProps {
  reason: IssueBlockedInboxReason;
  severity: IssueBlockedInboxSeverity;
  compact?: boolean;
  className?: string;
}

type IconComponent = ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;

const VARIANT_STYLES: Record<BlockedReasonVariant, string> = {
  needs_decision:
    "border-violet-300/70 bg-violet-50 text-violet-800 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300",
  recovery_required:
    "border-status-running/30 bg-status-running/12 text-status-running",
  stalled:
    "border-status-warning/30 bg-status-warning/12 text-status-warning",
  needs_attention:
    "border-status-warning/30 bg-status-warning/12 text-status-warning",
  external_wait:
    "border-border bg-muted/20 text-muted-foreground",
  owner_paused:
    "border-status-error/30 bg-status-error/12 text-status-error",
};

const VARIANT_ICONS: Record<BlockedReasonVariant, IconComponent> = {
  needs_decision: Clock,
  recovery_required: Wrench,
  stalled: AlertTriangle,
  needs_attention: AlertTriangle,
  external_wait: User,
  owner_paused: Pause,
};

const SEVERITY_DOT: Partial<Record<IssueBlockedInboxSeverity, string>> = {
  critical: "bg-status-error",
  high: "bg-status-warning",
};

export function BlockedReasonChip({
  reason,
  severity,
  compact = false,
  className,
}: BlockedReasonChipProps) {
  const variant = blockedReasonVariant(reason);
  const label = blockedVariantLabel(variant);
  const Icon = VARIANT_ICONS[variant];
  const dotClass = SEVERITY_DOT[severity];
  return (
    <span
      data-testid="blocked-reason-chip"
      data-variant={variant}
      data-severity={severity}
      aria-label={`Reason: ${label}, severity ${severity}`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium leading-tight sm:text-[11px]",
        VARIANT_STYLES[variant],
        className,
      )}
    >
      {dotClass ? (
        <span
          aria-hidden="true"
          className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", dotClass)}
        />
      ) : null}
      {compact ? null : <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />}
      <span className="truncate">{label}</span>
    </span>
  );
}
