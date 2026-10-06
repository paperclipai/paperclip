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
  ready: { color: "green", glyph: "●", get label() { return t("localizationAgentManagement.resourceStatus0"); }, get title() { return t("localizationAgentManagement.resourceStatus1"); } },
  needs_setup: { color: "amber", glyph: "⚠", get label() { return t("localizationAgentManagement.resourceStatus2"); }, get title() { return t("localizationAgentManagement.resourceStatus3"); } },
  missing: { color: "amber", glyph: "⚠", get label() { return t("localizationAgentManagement.resourceStatus4"); }, get title() { return t("localizationAgentManagement.resourceStatus5"); } },
  error: { color: "red", glyph: "✕", get label() { return t("localizationAgentManagement.resourceStatus6"); }, get title() { return t("localizationAgentManagement.resourceStatus7"); } },
  update_available: {
    color: "blue",
    glyph: "↑",
    get label() { return t("localizationAgentManagement.resourceStatus8"); },
    get title() { return t("localizationAgentManagement.resourceStatus9"); },
  },
  drifted: {
    color: "gray",
    glyph: "✎",
    get label() { return t("localizationAgentManagement.resourceStatus10"); },
    get title() { return t("localizationAgentManagement.resourceStatus11"); },
  },
  schedule_off: {
    color: "gray",
    glyph: "◌",
    get label() { return t("localizationAgentManagement.resourceStatus12"); },
    get title() { return t("localizationAgentManagement.resourceStatus13"); },
  },
  schedule_on: { color: "green", glyph: "●", get label() { return t("localizationAgentManagement.resourceStatus14"); }, get title() { return t("localizationAgentManagement.resourceStatus15"); } },
  pending_approval: {
    color: "amber",
    glyph: "⚠",
    get label() { return t("localizationAgentManagement.resourceStatus16"); },
    get title() { return t("localizationAgentManagement.resourceStatus17"); },
  },
  proposal_pending: {
    color: "blue",
    glyph: "↑",
    get label() { return t("localizationAgentManagement.resourceStatus18"); },
    get title() { return t("localizationAgentManagement.resourceStatus19"); },
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
  useTranslation();
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
