import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  RECOVERY_CHIP_DEFAULT_TONE,
  recoveryChipLabel,
  type ActiveRecoveryDisplayState,
} from "@/lib/recovery-display";
import {
  IssueRecoveryActionCard,
  type IssueRecoveryActionCardProps,
} from "./IssueRecoveryActionCard";

export interface RecoveryProgressLineProps
  extends Omit<IssueRecoveryActionCardProps, "forcedState" | "className"> {
  /** The recessed state this line represents (`in_progress` or `observe_only`). */
  state: Extract<ActiveRecoveryDisplayState, "in_progress" | "observe_only">;
  /** Display name of the live/queued recovery owner, e.g. "CTO". */
  ownerName?: string | null;
  /** Force the details open on first render (tests, deep links). */
  defaultOpen?: boolean;
  className?: string;
}

/**
 * Recovery presented as a recessed, expandable line — "Recovery in progress · CTO".
 *
 * Used wherever a recovery owner is already live or queued, or where a newer
 * source-owner run has folded the action down to observation. Nothing is hidden:
 * expanding reveals the same `IssueRecoveryActionCard` (kept in its recessed
 * tone via `forcedState`), so the evidence and resolve actions stay inspectable
 * without a second prominent recovery surface competing for attention.
 */
export function RecoveryProgressLine({
  state,
  ownerName,
  defaultOpen = false,
  className,
  ...cardProps
}: RecoveryProgressLineProps) {
  const [open, setOpen] = useState(defaultOpen);
  const detailsId = useId();
  const { action, agentMap } = cardProps;
  const resolvedOwnerName =
    ownerName ?? (action.ownerAgentId ? agentMap?.get(action.ownerAgentId)?.name ?? null : null);
  const label = recoveryChipLabel(state, action.kind, { ownerName: resolvedOwnerName });
  const Icon = RECOVERY_CHIP_DEFAULT_TONE[state].icon;

  return (
    <div
      data-testid="recovery-progress-line"
      data-recovery-state={state}
      data-recovery-kind={action.kind}
      className={cn("flex w-full min-w-0 flex-col", className)}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={detailsId}
        data-testid="recovery-progress-line-toggle"
        className={cn(
          // `text-recessed-foreground`, not `text-muted-foreground`: the resting
          // state is on paper (4.73:1) but the `hover:bg-muted/50` wash drops
          // `--muted-foreground` to 4.53:1 at 12px — a 0.03 margin. The recessed
          // token holds 6.54:1 resting and 6.40:1 hovered (PAP-17083).
          "flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-recessed-foreground",
          "hover:bg-muted/50 hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        )}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="truncate font-medium">{label}</span>
        {/* Inherits the button's `text-recessed-foreground`; the hint must NOT be
            diluted (`text-muted-foreground/70` measured 2.71:1 light / 4.20:1
            dark and failed WCAG AA — PAP-17070). Weight, not contrast, is what
            keeps this subordinate to the label. */}
        <span data-testid="recovery-progress-line-hint" className="hidden shrink-0 font-normal sm:inline">
          · {open ? "Hide details" : "Details"}
        </span>
        <ChevronDown
          className={cn(
            "ml-auto h-3.5 w-3.5 shrink-0 transition-transform duration-150",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>
      {open ? (
        <div id={detailsId} data-testid="recovery-progress-line-details" className="mt-1.5">
          <IssueRecoveryActionCard {...cardProps} forcedState={state} />
        </div>
      ) : null}
    </div>
  );
}

export default RecoveryProgressLine;
