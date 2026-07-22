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
    label: "Compiling",
    dotClassName: "bg-cyan-400 animate-pulse",
    description: "Just created; the agent is building the query and first summary.",
    dashedBorder: true,
    keepsLastSummary: false,
  },
  fresh: {
    label: "Fresh",
    dotClassName: "bg-emerald-400",
    description: "Summary reflects all known changes; nothing pending.",
    dashedBorder: false,
    keepsLastSummary: true,
  },
  stale: {
    label: "Stale",
    dotClassName: "bg-amber-400",
    description: "Changes are pending since the last update.",
    dashedBorder: false,
    keepsLastSummary: true,
  },
  updating: {
    // Blue (distinct from fresh-emerald and compiling-cyan) so an in-flight
    // update never reads as "fresh" on a glance-scan of the board.
    label: "Updating",
    dotClassName: "bg-blue-500 animate-pulse",
    description: "An update is streaming in now.",
    dashedBorder: false,
    keepsLastSummary: true,
  },
  error: {
    label: "Error",
    dotClassName: "bg-red-500",
    description: "The last run failed; the last good summary stays visible.",
    dashedBorder: false,
    keepsLastSummary: true,
  },
  paused_budget: {
    label: "Paused — budget",
    dotClassName: "bg-orange-400",
    description: "The daily token cap was hit; auto-updates are suspended.",
    dashedBorder: false,
    keepsLastSummary: true,
  },
  paused_hours: {
    label: "Paused — hours",
    dotClassName: "bg-orange-400",
    description: "Outside active hours; changes batch into one update at window open.",
    dashedBorder: false,
    keepsLastSummary: true,
  },
  archived: {
    label: "Archived",
    dotClassName: "bg-muted-foreground/50",
    description: "No auto-updates and no watches. Restore to start watching again.",
    dashedBorder: false,
    keepsLastSummary: true,
  },
};

/** Compact token count, e.g. `1.1k`, `950`, `12.4k`. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

/** US-dollar cost from integer cents, e.g. `$0.09`, `$1.20`. Sub-cent → `<$0.01`. */
export function formatUsdFromCents(cents: number): string {
  if (cents <= 0) return "$0.00";
  if (cents < 1) return "<$0.01";
  return `$${(cents / 100).toFixed(2)}`;
}

/** A one-line, human summary of a card's refresh policy for chips and footers. */
export function describeRefreshPolicy(policy: StatusCardRefreshPolicy): string {
  switch (policy.mode) {
    case "manual":
      return "manual";
    case "interval":
      return policy.intervalMinutes
        ? `every ${policy.intervalMinutes}m if changed`
        : "on a schedule if changed";
    case "reactive": {
      const debounce = policy.debounceSeconds ?? 60;
      return `on change (${debounce}s)`;
    }
    default:
      return "manual";
  }
}
