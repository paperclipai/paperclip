import type { BriefCard, BriefCardState, BriefSummaryStatus, BriefTaskRow } from "../contracts.js";

export type BriefSectionKey = "attention" | "live" | "settled";

export type BriefSection = {
  key: BriefSectionKey;
  label: string;
  cards: BriefCard[];
};

const ATTENTION_STATES: ReadonlyArray<BriefCardState> = ["error", "blocked", "waiting-user"];
const LIVE_STATES: ReadonlyArray<BriefCardState> = ["waiting-reviewer", "live"];
const SETTLED_STATES: ReadonlyArray<BriefCardState> = ["done", "stale"];

export function sectionForState(state: BriefCardState): BriefSectionKey {
  if (ATTENTION_STATES.includes(state)) return "attention";
  if (LIVE_STATES.includes(state)) return "live";
  return "settled";
}

export function groupCardsIntoSections(cards: BriefCard[]): BriefSection[] {
  const buckets: Record<BriefSectionKey, BriefCard[]> = {
    attention: [],
    live: [],
    settled: [],
  };
  for (const card of cards) {
    if (card.hidden) continue;
    buckets[sectionForState(card.state)].push(card);
  }
  for (const key of Object.keys(buckets) as BriefSectionKey[]) {
    buckets[key].sort(compareCards);
  }
  return [
    { key: "attention", label: "Needs your attention", cards: buckets.attention },
    { key: "live", label: "Live and in review", cards: buckets.live },
    { key: "settled", label: "Recently done & stale", cards: buckets.settled },
  ];
}

export function sortBriefCards(cards: BriefCard[]): BriefCard[] {
  return cards.filter((card) => !card.hidden).sort(compareCards);
}

function compareCards(a: BriefCard, b: BriefCard): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  const aT = Date.parse(a.lastMeaningfulEventAt) || 0;
  const bT = Date.parse(b.lastMeaningfulEventAt) || 0;
  return bT - aT;
}

export function countAttention(cards: BriefCard[]): number {
  let n = 0;
  for (const card of cards) {
    if (card.hidden) continue;
    if (ATTENTION_STATES.includes(card.state) || card.state === "waiting-reviewer") n += 1;
  }
  return n;
}

export const stateBadgeLabel: Record<BriefCardState, string> = {
  error: "Error",
  blocked: "Blocked",
  "waiting-user": "Waiting on you",
  "waiting-reviewer": "In review",
  live: "Live",
  done: "Recently done",
  stale: "Stale",
};

export const stateTone: Record<BriefCardState, "red" | "warning" | "violet" | "cyan" | "green" | "muted"> = {
  error: "red",
  blocked: "red",
  "waiting-user": "warning",
  "waiting-reviewer": "violet",
  live: "cyan",
  done: "green",
  stale: "muted",
};

export const summaryFallbackLabel = "Summary unavailable";

export function summaryStatusLabel(status: BriefSummaryStatus): string {
  switch (status) {
    case "ok":
      return "ready";
    case "pending":
      return "generating";
    case "fallback":
      return summaryFallbackLabel;
    default:
      return status;
  }
}

const RELATIVE_DIVISIONS: Array<{ amount: number; unit: Intl.RelativeTimeFormatUnit }> = [
  { amount: 60, unit: "second" },
  { amount: 60, unit: "minute" },
  { amount: 24, unit: "hour" },
  { amount: 7, unit: "day" },
  { amount: 4.34524, unit: "week" },
  { amount: 12, unit: "month" },
  { amount: Number.POSITIVE_INFINITY, unit: "year" },
];

export function formatRelative(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  let diff = (t - now.getTime()) / 1000;
  for (const division of RELATIVE_DIVISIONS) {
    if (Math.abs(diff) < division.amount) {
      const value = Math.round(diff);
      const abs = Math.abs(value);
      const unit = division.unit;
      if (value === 0) return "just now";
      return value < 0 ? `${abs}${shortUnit(unit)} ago` : `in ${abs}${shortUnit(unit)}`;
    }
    diff /= division.amount;
  }
  return "";
}

function shortUnit(unit: Intl.RelativeTimeFormatUnit): string {
  switch (unit) {
    case "second":
      return "s";
    case "minute":
      return "m";
    case "hour":
      return "h";
    case "day":
      return "d";
    case "week":
      return "w";
    case "month":
      return "mo";
    case "year":
      return "y";
    default:
      return "";
  }
}

export function shouldDimCard(card: BriefCard): boolean {
  return card.state === "stale" || card.state === "done";
}

export function rightTagForRow(row: BriefTaskRow): string {
  return row.rightTag.length > 18 ? `${row.rightTag.slice(0, 17)}…` : row.rightTag;
}

export function truncateTitle(title: string, max: number): string {
  if (title.length <= max) return title;
  return `${title.slice(0, max - 1)}…`;
}
