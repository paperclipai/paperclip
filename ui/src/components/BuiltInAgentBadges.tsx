import { useTranslation } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { brandChipBadge } from "@/lib/status-colors";
import type { BuiltInAgentStatus } from "@/api/builtInAgents";

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
  const { t } = useTranslation("agent-config");
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
          ? t("agent-config:waitingOnBoardHireApprovalBeforeTheFeature_2181b67")
          : t("agent-config:needsAdapterModelSetupBeforeTheFeatureCan_19070f6")
      }
    >
      {isPendingApproval ? (compact ? t("agent-config:approval_8cc047a") : t("agent-config:pendingApproval_25d1b4b")) : compact ? t("agent-config:setup_cdd7bb2") : t("agent-config:needsSetup_522ebae")}
    </Badge>
  );
}
