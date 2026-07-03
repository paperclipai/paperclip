/**
 * Smart Claude auth-switch decision engine (TWX-1117 / TWX-1121, "C3").
 *
 * Pure, side-effect-free policy over the multi-account usage snapshots captured by
 * C1 (`claude-account-usage.ts`). Given every profile's current usage plus the
 * currently active profile and the last-switch time, it decides which profile the
 * host SHOULD be logged into next — honoring the account-tier policy from the
 * ticket:
 *
 *  - OURS accounts (j-tuechler-twb-digital, thomas): usable freely; the fallback
 *    when no wameling allowance is about to expire.
 *  - WAMELING accounts (ild-claude*, steven-...): a weekly (7-day) allowance we
 *    only want to "burn" when it is CLOSE TO RESET and NOT yet at cap — otherwise
 *    the about-to-expire allowance is wasted. Far from reset, we save it and stay
 *    on an OURS account.
 *
 * Switching the host login affects ALL claude_local agents at once, so the engine
 * applies hysteresis (min-dwell) and a "materially better" margin to avoid
 * thrashing. Executing the switch, clearing the failover cooldown, and recording
 * the audit trail live in the server-side service; this module only decides.
 */

import type { ClaudeAccountTier, ClaudeAccountUsageSnapshot } from "./claude-account-usage.js";

export interface ClaudeSwitchPolicyConfig {
  /** Headroom (100 - binding pct) below which an account is "capped" and is not a
   *  routing target. */
  minHeadroomPct: number;
  /** A wameling account whose 7-day window resets within this many hours is
   *  "near reset" → eligible to be burned. */
  wamelingNearResetHours: number;
  /** When the target is in the same preference bucket as the active account, it
   *  must beat the active account's headroom by at least this margin to justify a
   *  switch (anti-flap). */
  materialMarginPct: number;
  /** Minimum time between executed switches. A capped active account overrides
   *  this (emergency switch). */
  minDwellMs: number;
}

export const DEFAULT_CLAUDE_SWITCH_POLICY: ClaudeSwitchPolicyConfig = {
  minHeadroomPct: 5,
  wamelingNearResetHours: 24,
  materialMarginPct: 15,
  minDwellMs: 45 * 60_000,
};

/** Preference buckets (lower = preferred as the target). */
export const CLAUDE_SWITCH_PRIORITY = {
  /** wameling account near its reset with headroom → burn it before it resets. */
  wamelingBurn: 1,
  /** our own account with headroom → free, safe fallback. */
  ours: 2,
  /** wameling account far from reset → save it; only use if nothing better. */
  wamelingSave: 3,
  /** unknown-tier account with headroom → last resort. */
  unknown: 4,
  /** ineligible (capped / unprobeable). */
  ineligible: 99,
} as const;

export interface ClaudeSwitchCandidate {
  profile: string;
  tier: ClaudeAccountTier;
  /** max(fiveHour.pct, sevenDay.pct) — the window that binds usage right now. */
  bindingPct: number;
  /** 100 - bindingPct. */
  headroomPct: number;
  /** Hours until the 7-day window resets (null if unknown/absent). */
  sevenDayResetsInHours: number | null;
  nearReset: boolean;
  eligible: boolean;
  priority: number;
  active: boolean;
  note: string;
}

export type ClaudeSwitchAction = "switch" | "hold";

export interface ClaudeSwitchDecisionInput {
  accounts: ClaudeAccountUsageSnapshot[];
  /** The profile currently active on the host (from `auth-profiles/active`), if known. */
  activeProfile: string | null;
  /** ISO timestamp of the last executed switch, for min-dwell. */
  lastSwitchAt: string | null;
  /** ISO "now". */
  now: string;
  policy?: Partial<ClaudeSwitchPolicyConfig>;
}

export interface ClaudeSwitchDecision {
  action: ClaudeSwitchAction;
  /** Chosen target profile to switch to (null when holding). */
  targetProfile: string | null;
  fromProfile: string | null;
  targetTier: ClaudeAccountTier | null;
  /** Human-readable rationale (goes into the audit row + issue/log). */
  reason: string;
  /** Ranked candidates at decision time (for the audit snapshot). */
  candidates: ClaudeSwitchCandidate[];
}

function pctOrZero(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function buildCandidate(
  a: ClaudeAccountUsageSnapshot,
  cfg: ClaudeSwitchPolicyConfig,
  nowMs: number,
): ClaudeSwitchCandidate {
  const fiveHour = pctOrZero(a.fiveHour?.pct);
  const sevenDay = pctOrZero(a.sevenDay?.pct);
  const bindingPct = Math.max(fiveHour, sevenDay);
  const headroomPct = 100 - bindingPct;

  const resetIso = a.sevenDay?.resetsAt ?? null;
  let sevenDayResetsInHours: number | null = null;
  if (resetIso) {
    const t = Date.parse(resetIso);
    if (Number.isFinite(t)) sevenDayResetsInHours = (t - nowMs) / 3_600_000;
  }

  // An account that errored on its last probe (no usable token) is never a target.
  const probeFailed = a.source === "error";
  const eligible = !probeFailed && headroomPct >= cfg.minHeadroomPct;

  const nearReset =
    a.tier === "wameling" &&
    sevenDayResetsInHours != null &&
    sevenDayResetsInHours >= 0 &&
    sevenDayResetsInHours <= cfg.wamelingNearResetHours;

  let priority: number;
  let note: string;
  if (!eligible) {
    priority = CLAUDE_SWITCH_PRIORITY.ineligible;
    note = probeFailed ? "probe failed" : `capped (${bindingPct}% used)`;
  } else if (a.tier === "wameling" && nearReset) {
    priority = CLAUDE_SWITCH_PRIORITY.wamelingBurn;
    note = `wameling near reset (${sevenDayResetsInHours?.toFixed(1)}h) — burn ${headroomPct}% before it resets`;
  } else if (a.tier === "ours") {
    priority = CLAUDE_SWITCH_PRIORITY.ours;
    note = `ours — ${headroomPct}% headroom`;
  } else if (a.tier === "wameling") {
    priority = CLAUDE_SWITCH_PRIORITY.wamelingSave;
    note =
      sevenDayResetsInHours == null
        ? "wameling — reset time unknown; saved"
        : `wameling — resets in ${sevenDayResetsInHours.toFixed(0)}h; save it`;
  } else {
    priority = CLAUDE_SWITCH_PRIORITY.unknown;
    note = `unknown tier — ${headroomPct}% headroom`;
  }

  return {
    profile: a.profile,
    tier: a.tier,
    bindingPct,
    headroomPct,
    sevenDayResetsInHours,
    nearReset,
    eligible,
    priority,
    active: a.active,
    note,
  };
}

/** Rank comparator: eligible & lower-priority first, then tie-break within bucket. */
function compareCandidates(a: ClaudeSwitchCandidate, b: ClaudeSwitchCandidate): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  // Within the wameling-burn bucket, prefer the account resetting SOONEST (most
  // urgent to burn) — with a usable amount of headroom as the secondary key.
  if (a.priority === CLAUDE_SWITCH_PRIORITY.wamelingBurn) {
    const ar = a.sevenDayResetsInHours ?? Number.POSITIVE_INFINITY;
    const br = b.sevenDayResetsInHours ?? Number.POSITIVE_INFINITY;
    if (ar !== br) return ar - br;
  }
  // Everywhere else: more headroom first.
  if (a.headroomPct !== b.headroomPct) return b.headroomPct - a.headroomPct;
  return a.profile.localeCompare(b.profile);
}

/**
 * Decide the target profile the host should be logged into next.
 *
 * Pure: no I/O, no clocks beyond the supplied `now`. Deterministic given inputs.
 */
export function decideClaudeAuthSwitch(input: ClaudeSwitchDecisionInput): ClaudeSwitchDecision {
  const cfg: ClaudeSwitchPolicyConfig = { ...DEFAULT_CLAUDE_SWITCH_POLICY, ...(input.policy ?? {}) };
  const nowMs = Date.parse(input.now);
  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.parse(new Date().toISOString());

  const candidates = input.accounts
    .map((a) => buildCandidate(a, cfg, safeNowMs))
    .sort(compareCandidates);

  const fromProfile = input.activeProfile;
  const activeCandidate =
    fromProfile != null ? candidates.find((c) => c.profile === fromProfile) ?? null : null;

  const best = candidates.find((c) => c.eligible) ?? null;

  const hold = (reason: string): ClaudeSwitchDecision => ({
    action: "hold",
    targetProfile: null,
    fromProfile,
    targetTier: null,
    reason,
    candidates,
  });

  if (!best) return hold("no eligible account with headroom");
  if (best.profile === fromProfile) {
    return hold(`active account '${fromProfile}' is already the best target (${best.note})`);
  }

  const activeCapped = activeCandidate == null || !activeCandidate.eligible;

  // Emergency: active account is capped / unknown / unprobeable — switch now,
  // bypassing dwell and the material-margin gate.
  if (activeCapped) {
    const why =
      activeCandidate == null
        ? fromProfile == null
          ? "no active profile recorded"
          : `active profile '${fromProfile}' not in snapshot`
        : `active account '${fromProfile}' is ${activeCandidate.note}`;
    return {
      action: "switch",
      targetProfile: best.profile,
      fromProfile,
      targetTier: best.tier,
      reason: `${why} → switch to ${best.profile} (${best.note})`,
      candidates,
    };
  }

  // Min-dwell: don't switch a healthy active account more often than the dwell.
  if (input.lastSwitchAt) {
    const lastMs = Date.parse(input.lastSwitchAt);
    if (Number.isFinite(lastMs) && safeNowMs - lastMs < cfg.minDwellMs) {
      const mins = Math.round((safeNowMs - lastMs) / 60_000);
      return hold(
        `min-dwell: last switch ${mins}m ago (< ${Math.round(cfg.minDwellMs / 60_000)}m); active '${fromProfile}' still has ${activeCandidate.headroomPct}% headroom`,
      );
    }
  }

  // Moving to a strictly-preferred bucket (e.g. a wameling allowance about to
  // reset while we sit on an OURS account) bypasses the headroom margin — the
  // point is to burn the expiring allowance, which by design has less headroom.
  if (best.priority < activeCandidate.priority) {
    return {
      action: "switch",
      targetProfile: best.profile,
      fromProfile,
      targetTier: best.tier,
      reason: `${best.note}; better bucket than active '${fromProfile}' (${activeCandidate.note})`,
      candidates,
    };
  }

  // Same bucket: require a material headroom improvement to avoid flapping.
  const improvement = best.headroomPct - activeCandidate.headroomPct;
  if (improvement >= cfg.materialMarginPct) {
    return {
      action: "switch",
      targetProfile: best.profile,
      fromProfile,
      targetTier: best.tier,
      reason: `${best.profile} has ${improvement}% more headroom than active '${fromProfile}' (>= ${cfg.materialMarginPct}% margin)`,
      candidates,
    };
  }

  return hold(
    `active '${fromProfile}' (${activeCandidate.headroomPct}% headroom) not materially worse than best '${best.profile}' (${best.headroomPct}%); +${improvement}% < ${cfg.materialMarginPct}% margin`,
  );
}
