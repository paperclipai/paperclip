import type { StatusCardRefreshPolicy, StatusCardUpdate } from "@paperclipai/shared";

/** "1.1k tok" / "940 tok" — compact token count for footers and chips. */
export function formatTokens(tokens: number | null | undefined): string | null {
  if (tokens === null || tokens === undefined) return null;
  if (tokens < 1000) return `${tokens} tok`;
  return `${(tokens / 1000).toFixed(1)}k tok`;
}

/**
 * Dollar cost from integer cents. Uses more precision for sub-cent amounts so a
 * $0.006 incremental update does not collapse to $0.01.
 */
export function formatCents(cents: number | null | undefined): string | null {
  if (cents === null || cents === undefined) return null;
  const dollars = cents / 100;
  if (dollars === 0) return "$0.00";
  if (dollars < 0.1) return `$${dollars.toFixed(3)}`;
  return `$${dollars.toFixed(2)}`;
}

export interface StatusCardRollup {
  updateCount: number;
  totalTokens: number;
  totalCostCents: number;
}

// `compile` rows are cheap query (re)compiles, not summary updates. They still
// cost tokens (so they count toward token/cost totals), but they must not be
// counted as "updates" in the ledger's update count.
function accumulate(updates: StatusCardUpdate[]): StatusCardRollup {
  return updates.reduce(
    (acc, update) => ({
      updateCount: acc.updateCount + (update.kind === "compile" ? 0 : 1),
      totalTokens: acc.totalTokens + update.inputTokens + update.outputTokens,
      totalCostCents: acc.totalCostCents + update.costCents,
    }),
    { updateCount: 0, totalTokens: 0, totalCostCents: 0 },
  );
}

/**
 * Lifetime rollup across the whole update ledger — used for the archived-row
 * "lifetime" cost label.
 */
export function rollupUpdates(updates: StatusCardUpdate[]): StatusCardRollup {
  return accumulate(updates);
}

/**
 * Today-scoped rollup — only updates started since the start of the local
 * calendar day. Used for the drawer "Today" footer so it does not silently
 * report the lifetime total on any day after the card's first activity.
 */
export function rollupUpdatesToday(updates: StatusCardUpdate[]): StatusCardRollup {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const startMs = startOfDay.getTime();
  return accumulate(updates.filter((update) => new Date(update.startedAt).getTime() >= startMs));
}

// Rough per-update estimates for the create/settings cost preview. These anchor
// on observed ledger data (a full rebuild ≈ 4.5k tokens ≈ 3¢; an incremental
// re-reads only the changed issues and runs cheaper). The preview is an
// upper-bound guide only — real cost is recorded per update in the ledger.
const EST_FULL_TOKENS = 4_500;
const EST_FULL_CENTS = 3;
const EST_INCREMENTAL_TOKENS = 2_000;
const EST_INCREMENTAL_CENTS = 1;

/** Minutes per day the card may auto-update, honouring the active-hours window. */
function activeWindowMinutes(policy: StatusCardRefreshPolicy): number {
  const hours = policy.activeHours;
  if (!hours) return 24 * 60;
  const [startH, startM] = hours.start.split(":").map(Number);
  const [endH, endM] = hours.end.split(":").map(Number);
  const start = startH * 60 + startM;
  const end = endH * 60 + endM;
  const span = end > start ? end - start : 24 * 60 - (start - end);
  return span > 0 ? span : 24 * 60;
}

export interface StatusCardCostEstimate {
  /** Bare cost, e.g. "$0.48 · 96.0k tok" — shown to the right of the "=" sign. */
  cost: string;
  /** Headline cost line, e.g. "Up to ~48 updates/day ≈ $0.48 · 96.0k tok". */
  primary: string;
  /** Secondary qualifier (cap / no-op-check / manual-only), or null. */
  note: string | null;
}

/**
 * Derive a per-day / per-update token + cost preview from the chosen refresh
 * policy. Reacts to mode (manual / interval / reactive), interval, active
 * hours, and the daily token cap.
 */
export function estimateStatusCardCost(policy: StatusCardRefreshPolicy): StatusCardCostEstimate {
  if (policy.mode === "manual") {
    const cost = `${formatCents(EST_FULL_CENTS)} · ${formatTokens(EST_FULL_TOKENS)}`;
    return {
      cost,
      primary: `~1 rebuild per refresh ≈ ${cost}`,
      note: "Manual cards only cost tokens when you press Refresh.",
    };
  }

  const windowMinutes = activeWindowMinutes(policy);
  let maxPerDay: number;
  let cadence: string;
  if (policy.mode === "interval") {
    const interval = policy.intervalMinutes ?? 15;
    maxPerDay = Math.floor(windowMinutes / interval);
    cadence = `every ${interval} min`;
  } else {
    const perHour = policy.maxUpdatesPerHour ?? 6;
    maxPerDay = Math.round((windowMinutes / 60) * perHour);
    cadence = `up to ${perHour}/hour`;
  }

  const cap = policy.dailyTokenCap ?? null;
  const maxByCap = cap !== null ? Math.floor(cap / EST_INCREMENTAL_TOKENS) : Infinity;
  const effective = Math.max(0, Math.min(maxPerDay, maxByCap));
  const cappedByTokenCap = cap !== null && maxByCap < maxPerDay;

  const tokens = effective * EST_INCREMENTAL_TOKENS;
  const cents = effective * EST_INCREMENTAL_CENTS;
  const withinHours = policy.activeHours ? " during active hours" : "";
  const cost = `${formatCents(cents)} · ${formatTokens(tokens)}`;

  return {
    cost,
    primary: `Up to ~${effective} updates/day (${cadence}${withinHours}) ≈ ${cost}`,
    note: cappedByTokenCap
      ? `Capped by your ${formatTokens(cap!)} daily token cap — the card pauses when it's hit.`
      : "Only runs when something changed; a cheap no-op check otherwise.",
  };
}

/** "0.4k in / 0.2k out" — the per-update token split shown in history rows. */
export function formatTokenSplit(inputTokens: number, outputTokens: number): string {
  const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);
  return `${fmt(inputTokens)} in / ${fmt(outputTokens)} out`;
}

/** Human label for an update's kind. */
export function updateKindLabel(kind: StatusCardUpdate["kind"]): string {
  switch (kind) {
    case "compile":
      return "compile";
    case "full":
      return "full rebuild";
    case "incremental":
      return "incremental";
    default:
      return kind;
  }
}
