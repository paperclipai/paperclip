import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { brandChipBadge } from "@/lib/status-colors";
import type { BuiltInAgentStatus } from "@/api/builtInAgents";

/**
 * Provenance label ("Built-in"). Constant for the life of a built-in agent —
 * this is NOT a lifecycle/status chip, so it never routes through
 * `StatusBadge`/`AgentStatusBadge` (ux-spec D2).
 */
export function BuiltInAgentBadge({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        brandChipBadge.blue,
        compact && "px-1.5 py-0 text-(length:--text-nano)",
        className,
      )}
      title="Ships with Paperclip"
    >
      Built-in
    </Badge>
  );
}

/**
 * Derived lifecycle chip. Rendered for the amber attention states
 * (`needs_setup`, `pending_approval`). Kept separate from the real agent status
 * (`idle/active/…`) per ux-spec D1.
 */
export function BuiltInLifecycleChip({
  status,
  compact = false,
  className,
}: {
  status: BuiltInAgentStatus;
  compact?: boolean;
  className?: string;
}) {
  if (status !== "needs_setup" && status !== "pending_approval") return null;
  const isPendingApproval = status === "pending_approval";
  return (
    <Badge
      variant="outline"
      className={cn(
        brandChipBadge.amber,
        compact && "px-1.5 py-0 text-(length:--text-nano)",
        className,
      )}
      title={
        isPendingApproval
          ? "Waiting on board hire approval before the feature can run"
          : "Needs adapter/model setup before the feature can run"
      }
    >
      {isPendingApproval ? (compact ? "Approval" : "Pending approval") : compact ? "Setup" : "Needs setup"}
    </Badge>
  );
}
