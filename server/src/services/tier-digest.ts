// ROCAA-25 Slice 2: tier-digest builder — pure function that turns the
// observability store contents into a daily ops summary + Slack body. No
// side effects (no fetch, no logger, no clock); the caller passes `now`
// and the store handle. This keeps it trivially unit-testable and lets
// Slice 3 (scheduler + webhook) wrap it cleanly.

import type { ObservabilityStore, TierMixRow } from "./observability-store.js";

/** Threshold for the Tier 1 saturation alert (24h share, fractional). */
export const TIER1_SATURATION_THRESHOLD = 0.2;

/** Tier label table used in summary text. */
const TIER_LABELS: Record<number, string> = {
  0: "Tier 0 (subscription)",
  1: "Tier 1 (API)",
  2: "Tier 2 (Codex)",
  3: "Tier 3 (provisioned)",
  4: "Tier 4 (fallback)",
};

function tierLabel(tier: number): string {
  return TIER_LABELS[tier] ?? `Tier ${tier}`;
}

/** ISO timestamp 24 hours before `now`. */
export function rolling24hStart(now: Date): string {
  return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
}

/** ISO timestamp for the start of `now`'s month in UTC. */
export function monthStartUtc(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0))
    .toISOString();
}

export interface TierDigestRow {
  tier: number;
  count: number;
  share: number; // fraction, 0..1
  label: string;
}

export interface TierDigest {
  /** Inclusive window start in ISO8601 UTC. */
  windowStart: string;
  /** Window end (= `now`) in ISO8601 UTC. */
  windowEnd: string;
  /** Total invocations in the 24h window. */
  totalInvocations: number;
  /** Per-tier breakdown, sorted ascending by tier. */
  byTier: TierDigestRow[];
  /** Sum of `cost_estimate_usd` for Tier 1 invocations since the start of
   *  the current calendar month (UTC). */
  tier1CostMtdUsd: number;
  /** True when Tier 1 share in the last 24h strictly exceeds the threshold. */
  tier1SaturationAlert: boolean;
  /** Fractional Tier 1 share in the last 24h. */
  tier1Share24h: number;
}

export interface BuildTierDigestParams {
  store: ObservabilityStore;
  now: Date;
  /** Override the alert threshold (defaults to {@link TIER1_SATURATION_THRESHOLD}). */
  alertThreshold?: number;
}

/**
 * Pure: queries the store and assembles a digest. Returns a "zero" digest
 * if the store is disabled.
 */
export function buildTierDigest(params: BuildTierDigestParams): TierDigest {
  const { store, now } = params;
  const threshold = params.alertThreshold ?? TIER1_SATURATION_THRESHOLD;
  const windowEnd = now.toISOString();
  const windowStart = rolling24hStart(now);
  if (!store.enabled) {
    return {
      windowStart,
      windowEnd,
      totalInvocations: 0,
      byTier: [],
      tier1CostMtdUsd: 0,
      tier1SaturationAlert: false,
      tier1Share24h: 0,
    };
  }
  const rows = store.queryTierMix(windowStart);
  const total = rows.reduce((acc, r) => acc + r.count, 0);
  const byTier = rows
    .slice()
    .sort((a, b) => a.tier - b.tier)
    .map((r: TierMixRow) => ({
      tier: r.tier,
      count: r.count,
      share: total > 0 ? r.count / total : 0,
      label: tierLabel(r.tier),
    }));
  const tier1Row = byTier.find((r) => r.tier === 1);
  const tier1Share24h = tier1Row?.share ?? 0;
  const tier1CostMtdUsd = store.queryTier1CostSince(monthStartUtc(now));
  return {
    windowStart,
    windowEnd,
    totalInvocations: total,
    byTier,
    tier1CostMtdUsd,
    tier1SaturationAlert: tier1Share24h > threshold,
    tier1Share24h,
  };
}

function formatPercent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

function formatUsd(amount: number): string {
  // Match standard ops-channel money formatting: $X.YZ with two decimals.
  return `$${amount.toFixed(2)}`;
}

/**
 * Render the digest as a multi-line plain-text summary suitable for the
 * `text` field of a Slack webhook body.
 */
export function renderTierDigestSummary(digest: TierDigest): string {
  const lines: string[] = [];
  lines.push(":bar_chart: Paperclip — Tier mix digest (last 24h)");
  lines.push("");
  if (digest.totalInvocations === 0) {
    lines.push("No agent invocations recorded in the last 24h.");
  } else {
    lines.push("Invocations by tier:");
    for (const row of digest.byTier) {
      lines.push(`  • ${row.label}: ${row.count} (${formatPercent(row.share)})`);
    }
  }
  lines.push("");
  lines.push(`Tier 1 cost MTD: ${formatUsd(digest.tier1CostMtdUsd)}`);
  if (digest.tier1SaturationAlert) {
    lines.unshift(
      `:rotating_light: Tier 1 saturation alert — 24h share = ${formatPercent(digest.tier1Share24h)} (threshold ${formatPercent(TIER1_SATURATION_THRESHOLD)}). Recommend bumping subscription seats or provisioning Tier 3.`,
    );
    lines.unshift("");
  }
  return lines.join("\n").trim();
}

/**
 * Build a Slack-shaped webhook body. Mirrors the shape used by
 * `auth-drift-webhook.buildSlackWebhookBody` so downstream OPS-channel
 * consumers can route on the same conventions.
 */
export function buildTierDigestSlackBody(digest: TierDigest): {
  text: string;
  attachments: Array<Record<string, unknown>>;
  paperclip: {
    eventType: "tier.digest";
    windowStart: string;
    windowEnd: string;
    totalInvocations: number;
    byTier: TierDigestRow[];
    tier1CostMtdUsd: number;
    tier1Share24h: number;
    tier1SaturationAlert: boolean;
  };
} {
  const text = renderTierDigestSummary(digest);
  const tierField = digest.byTier
    .map((r) => `${r.label}: ${r.count} (${formatPercent(r.share)})`)
    .join("\n");
  return {
    text,
    attachments: [
      {
        color: digest.tier1SaturationAlert ? "danger" : "good",
        fields: [
          {
            title: "Window",
            value: `${digest.windowStart} → ${digest.windowEnd}`,
            short: false,
          },
          {
            title: "Total invocations (24h)",
            value: String(digest.totalInvocations),
            short: true,
          },
          {
            title: "Tier 1 share (24h)",
            value: formatPercent(digest.tier1Share24h),
            short: true,
          },
          {
            title: "Tier 1 cost MTD",
            value: formatUsd(digest.tier1CostMtdUsd),
            short: true,
          },
          {
            title: "Tier mix",
            value: tierField || "(no invocations)",
            short: false,
          },
        ],
      },
    ],
    paperclip: {
      eventType: "tier.digest",
      windowStart: digest.windowStart,
      windowEnd: digest.windowEnd,
      totalInvocations: digest.totalInvocations,
      byTier: digest.byTier,
      tier1CostMtdUsd: digest.tier1CostMtdUsd,
      tier1Share24h: digest.tier1Share24h,
      tier1SaturationAlert: digest.tier1SaturationAlert,
    },
  };
}
