import { t, i18n } from "@/i18n";
import type { StatusCard, StatusCardRefreshPolicy } from "@paperclipai/shared";

/**
 * The lifecycle states a status card renders as on the board (plan §7,
 * wireframe `07-card-states.svg`). Derived from the stored `status_cards` row:
 * the persisted `state` enum plus `archivedAt`, `generatingIssueId` and
 * `pendingChangeCount`. Kept in one place so the board tile, detail drawer and
 * tests agree on the mapping.
 */
export type StatusCardLifecycle =
  | "compiling"
  | "fresh"
  | "stale"
  | "updating"
  | "error"
  | "paused_budget"
  | "paused_hours"
  | "archived";

/**
 * Map a card row to its display lifecycle. Precedence, highest first:
 * archived → compiling → error → paused → updating (a run is in flight) →
 * stale (pending changes) → fresh.
 */
export function deriveStatusCardLifecycle(
  card: Pick<StatusCard, "state" | "archivedAt" | "generatingIssueId" | "pendingChangeCount">,
): StatusCardLifecycle {
  if (card.archivedAt) return "archived";
  if (card.state === "compiling") return "compiling";
  if (card.state === "error") return "error";
  if (card.state === "paused_budget") return "paused_budget";
  if (card.state === "paused_hours") return "paused_hours";
  if (card.generatingIssueId) return "updating";
  if (card.pendingChangeCount > 0) return "stale";
  return "fresh";
}

export interface StatusCardLifecyclePresentation {
  label: string;
  /** Tailwind classes for the leading state dot. */
  dotClassName: string;
  /** Short human description used in the states reference and empty affordances. */
  description: string;
  /** Whether the tile should render a dashed "building" border. */
  dashedBorder: boolean;
  /** Whether the last-good summary should stay visible under a banner. */
  keepsLastSummary: boolean;
}

export const STATUS_CARD_LIFECYCLE_PRESENTATION: Record<
  StatusCardLifecycle,
  StatusCardLifecyclePresentation
> = {
  compiling: {
    get label() { return t("localizationStatusCards.settingUp200"); },
    dotClassName: "bg-cyan-400 animate-pulse",
    get description() { return t("localizationStatusCards.justCreatedSettingUpAndGeneratingTheFirstSummary201"); },
    dashedBorder: true,
    keepsLastSummary: false,
  },
  fresh: {
    get label() { return t("localizationStatusCards.fresh202"); },
    dotClassName: "bg-emerald-400",
    get description() { return t("localizationStatusCards.summaryReflectsAllKnownChangesNothingPending203"); },
    dashedBorder: false,
    keepsLastSummary: true,
  },
  stale: {
    get label() { return t("status.stale"); },
    dotClassName: "bg-amber-400",
    get description() { return t("localizationStatusCards.changesArePendingSinceTheLastUpdate205"); },
    dashedBorder: false,
    keepsLastSummary: true,
  },
  updating: {
    // Blue (distinct from fresh-emerald and compiling-cyan) so an in-flight
    // update never reads as "fresh" on a glance-scan of the board.
    get label() { return t("localizationStatusCards.updating206"); },
    dotClassName: "bg-blue-500 animate-pulse",
    get description() { return t("localizationStatusCards.anUpdateIsStreamingInNow207"); },
    dashedBorder: false,
    keepsLastSummary: true,
  },
  error: {
    get label() { return t("status.error"); },
    dotClassName: "bg-red-500",
    get description() { return t("localizationStatusCards.theLastRunFailedTheLastGoodSummaryStaysVisible209"); },
    dashedBorder: false,
    keepsLastSummary: true,
  },
  paused_budget: {
    get label() { return t("localizationStatusCards.pausedBudget210"); },
    dotClassName: "bg-orange-400",
    get description() { return t("localizationStatusCards.theDailyTokenCapWasHitAutoUpdatesAreSuspended211"); },
    dashedBorder: false,
    keepsLastSummary: true,
  },
  paused_hours: {
    get label() { return t("localizationStatusCards.pausedHours212"); },
    dotClassName: "bg-orange-400",
    get description() { return t("localizationStatusCards.outsideActiveHoursChangesBatchIntoOneUpdateAtWindowOpen213"); },
    dashedBorder: false,
    keepsLastSummary: true,
  },
  archived: {
    get label() { return t("status.archived"); },
    dotClassName: "bg-muted-foreground/50",
    get description() { return t("localizationStatusCards.noAutoUpdatesAndNoWatchesRestoreToStartWatchingAgain215"); },
    dashedBorder: false,
    keepsLastSummary: true,
  },
};

/** Compact token count, e.g. `1.1k`, `950`, `12.4k`. */
export function formatTokens(tokens: number): string {
  const number = new Intl.NumberFormat(i18n.resolvedLanguage, { useGrouping: false, maximumFractionDigits: 1 }).format(tokens < 1000 ? tokens : tokens / 1000);
  return tokens < 1000 ? number : t("localizationStatusCards.thousands", { number });
}

/** US-dollar cost from integer cents, e.g. `$0.09`, `$1.20`. Sub-cent → `<$0.01`. */
export function formatUsdFromCents(cents: number): string {
  const format = (value: number) => new Intl.NumberFormat(i18n.resolvedLanguage, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  if (cents <= 0) return format(0);
  if (cents < 1) return `<${format(0.01)}`;
  return format(cents / 100);
}

/** A one-line, human summary of a card's refresh policy for chips and footers. */
export function describeRefreshPolicy(policy: StatusCardRefreshPolicy): string {
  switch (policy.mode) {
    case "manual":
      return t("localizationStatusCards.manualPolicy");
    case "interval":
      return policy.intervalMinutes
        ? t("localizationStatusCards.scheduledChange", { count: policy.intervalMinutes })
        : t("localizationStatusCards.onAScheduleIfChanged219");
    case "reactive": {
      const debounce = policy.debounceSeconds ?? 60;
      return t("localizationStatusCards.reactiveChange", { count: debounce });
    }
    default:
      return t("localizationStatusCards.manualPolicy");
  }
}
