import { AlertTriangle, Clock, Pause, User, Wrench } from "lucide-react";
import type { ComponentType } from "react";
import type { IssueBlockedInboxSeverity } from "@paperclipai/shared";
import { cn } from "../lib/utils";
import {
  blockedReasonVariant,
  blockedVariantLabel,
  type BlockedReasonVariant,
} from "../lib/blockedInbox";
import type { IssueBlockedInboxReason } from "@paperclipai/shared";

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
    "border-cyan-300/70 bg-cyan-50 text-cyan-800 dark:border-cyan-500/30 dark:bg-cyan-500/10 dark:text-cyan-300",
  stalled:
    "border-amber-400/70 bg-amber-100 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200",
  needs_attention:
    "border-amber-300/70 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300",
  external_wait:
    "border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-500/30 dark:bg-slate-500/15 dark:text-slate-300",
  owner_paused:
    "border-red-300/70 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300",
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
  critical: "bg-red-500",
  high: "bg-orange-500",
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
