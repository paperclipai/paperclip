import { t, useTranslation } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { brandChipBadge, type BrandChipColor } from "@/lib/status-colors";

/**
 * The load-bearing visual grammar for the built-in bundle status panel
 * (Reflection Coach — [PAP-13099], ux-spec §4). Each variant double-encodes
 * state as glyph + word + color so it never relies on color alone
 * (WCAG 1.4.1). Colors route through the shared `brandChipBadge` families — no
 * bespoke tints are minted here (ux-spec §10).
 *
 * A single resource shows at most one readiness chip and at most one drift
 * chip; when both a readiness problem and a drift state coexist, the caller
 * suppresses the drift chip until readiness is `ready` (ux-spec §4).
 */
export type ResourceStatusVariant =
  | "ready"
  | "needs_setup"
  | "missing"
  | "error"
  | "update_available"
  | "drifted"
  | "schedule_off"
  | "schedule_on"
  | "pending_approval"
  | "proposal_pending";

interface VariantSpec {
  color: BrandChipColor;
  glyph: string;
  label: string;
  title: string;
}

const VARIANTS: Record<ResourceStatusVariant, VariantSpec> = {
  ready: { color: "green", glyph: "●", get label() { return t("task-components:ready_5fa7aac5"); }, get title() { return t("task-components:materializedAndMatchesTheShippedDefault_4dd6c838"); } },
  needs_setup: { color: "amber", glyph: "⚠", get label() { return t("task-components:needsSetup_b6df2441"); }, get title() { return t("task-components:presentButNotUsableYet_968a2059"); } },
  missing: { color: "amber", glyph: "⚠", get label() { return t("task-components:missing_6be36ca4"); }, get title() { return t("task-components:expectedResourceAbsentReconcileWillRecreateIt_f4936f59"); } },
  error: { color: "red", glyph: "✕", get label() { return t("task-components:error_54a0e8c1"); }, get title() { return t("task-components:failedToLoadOrReconcile_4e42ee64"); } },
  update_available: {
    color: "blue",
    glyph: "↑",
    get label() { return t("task-components:updateAvailable_ff8b555d"); },
    get title() { return t("task-components:uneditedANewerShippedDefaultCanBe_71a19f55"); },
  },
  drifted: {
    color: "gray",
    glyph: "✎",
    get label() { return t("task-components:drifted_bb85e268"); },
    get title() { return t("task-components:youVeEditedThisYourChangesAre_993846ba"); },
  },
  schedule_off: {
    color: "gray",
    glyph: "◌",
    get label() { return t("task-components:scheduleOff_e96f8077"); },
    get title() { return t("task-components:noBackgroundWorkRunsUntilYouEnable_ef9bdba7"); },
  },
  schedule_on: { color: "green", glyph: "●", get label() { return t("task-components:weekly_29751324"); }, get title() { return t("task-components:runsOnTheWeeklySchedule_47fd02dd"); } },
  pending_approval: {
    color: "amber",
    glyph: "⚠",
    get label() { return t("task-components:pendingApproval_bb33a7f4"); },
    get title() { return t("task-components:waitingOnBoardHireApprovalBeforeIt_96a74263"); },
  },
  proposal_pending: {
    color: "blue",
    glyph: "↑",
    get label() { return t("task-components:proposalPending_f8a713a2"); },
    get title() { return t("task-components:aProposedUpdateIsWaitingForYour_ae9d5086"); },
  },
};

export function ResourceStatusChip({
  variant,
  label,
  compact = false,
  className,
}: {
  variant: ResourceStatusVariant;
  /** Override the default label (e.g. "Weekly · Mon 09:00 UTC"). */
  label?: string;
  compact?: boolean;
  className?: string;
}) {
  useTranslation("task-components");
  const spec = VARIANTS[variant];
  return (
    <Badge
      variant="outline"
      className={cn(
        brandChipBadge[spec.color],
        "font-medium",
        compact && "px-1.5 py-0 text-(length:--text-nano)",
        className,
      )}
      title={spec.title}
    >
      <span aria-hidden="true">{spec.glyph}</span>
      {label ?? spec.label}
    </Badge>
  );
}
