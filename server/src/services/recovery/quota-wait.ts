// Provider quota is a *wait*, not a terminal failure. A quota wall lasts hours
// or days, so the bounded continuation retries burn out in minutes and escalate
// a perfectly healthy issue to `blocked`, where nothing ever brings it back.
//
// This module owns the decision layer that releases those issues again. The
// rules below are deliberately evidence-first: an issue is released because the
// adapter family demonstrably produced successful runs after the quota failure,
// never because a provider-supplied reset timestamp has passed. Pinning recovery
// to a provider timestamp is the defect this platform already paid for once -
// the reset hint is far-future or plain wrong often enough that it must only
// ever *hold* work back, never release it.
//
// Quota state is tracked per adapter family (`agents.adapter_type`) rather than
// per company. Families are separate providers with separate walls: one can be
// serving normally while another is still hours from its reset, and a
// company-wide signal would release every issue into the wall that is still up.

/** Quota state of one adapter family, derived from its recent run history. */
export type AdapterFamilyQuotaState =
  /** Proven serving again: successes recorded after the newest quota failure. */
  | "green"
  /** Wall still up: newest quota failure outlives any success, or a reset hint is still in the future. */
  | "red"
  /** No evidence either way: the family has produced no terminal run since the quota failure. */
  | "dark";

/** Aggregated run history for one adapter family inside the analysis window. */
export type AdapterFamilyRunSummary = {
  family: string;
  lastSuccessAt: Date | null;
  lastQuotaFailureAt: Date | null;
  /** Newest terminal (succeeded or failed) run, used to detect a silent family. */
  lastTerminalAt: Date | null;
  /** Successful runs recorded strictly after `lastQuotaFailureAt`. */
  successesAfterQuotaFailure: number;
  /** Furthest future reset moment the provider reported, if any. */
  resetHintUntil: Date | null;
};

export type AdapterFamilyQuotaVerdict = {
  family: string;
  state: AdapterFamilyQuotaState;
  reason: string;
  /** Newest successful family run, the evidence a release is granted against. */
  newestSuccessAt: Date | null;
};

/** An issue held in `blocked` by an active provider-quota recovery action. */
export type QuotaBlockedCandidate = {
  issueId: string;
  identifier: string | null;
  recoveryActionId: string;
  returnOwnerAgentId: string | null;
  /**
   * Adapter family of the agent that continues the work once the issue is
   * released. Waking an issue into a family that is still walled only burns a
   * run and puts the issue straight back into `blocked`.
   */
  workFamily: string | null;
  /** When the quota run that stranded this issue failed. */
  failedAt: Date | null;
  /** When the recovery action was opened, used to release oldest-first. */
  strandedSince: Date;
  /** Newest earlier quota release for this issue, for the per-issue cooldown. */
  lastPromotedAt: Date | null;
};

export type QuotaWaitLimits = {
  /** Successful family runs after the quota failure required for `green`. */
  greenMinSuccesses: number;
  /** A `green` family's newest success must be at least this fresh. */
  greenFreshnessMs: number;
  /** A silent family is only probed once it has been quiet this long. */
  darkProbeAfterMs: number;
  /** Minimum gap between two canary releases for the same family. */
  darkProbeCooldownMs: number;
  /** Minimum gap between two releases of the same issue. */
  issueCooldownMs: number;
  /** Upper bound on releases per routine tick, so recovery never arrives as a wave. */
  maxReleasesPerTick: number;
};

// Calibrated against the live September quota incidents: two successes inside
// ninety minutes was the smallest signal that never produced a false release,
// and six releases per tick drains a large backlog over a few ticks without
// handing the provider a burst.
export const DEFAULT_QUOTA_WAIT_LIMITS: QuotaWaitLimits = {
  greenMinSuccesses: 2,
  greenFreshnessMs: 90 * 60 * 1000,
  darkProbeAfterMs: 90 * 60 * 1000,
  darkProbeCooldownMs: 6 * 60 * 60 * 1000,
  issueCooldownMs: 2 * 60 * 60 * 1000,
  maxReleasesPerTick: 6,
};

/** How long back the family run history is read. */
export const QUOTA_FAMILY_LOOKBACK_MS = 24 * 60 * 60 * 1000;

// Releases record themselves in the recovery action's resolution note. That
// note is the durable cooldown history: it is what stops the same issue, or the
// same silent family, from being released again on the very next tick.
export const QUOTA_WAIT_RESOLUTION_NOTE_PREFIX = "quota_family";
export const QUOTA_WAIT_GREEN_RESOLUTION_NOTE_PREFIX = `${QUOTA_WAIT_RESOLUTION_NOTE_PREFIX}_green`;
export const QUOTA_WAIT_CANARY_RESOLUTION_NOTE_PREFIX = `${QUOTA_WAIT_RESOLUTION_NOTE_PREFIX}_canary`;

export type QuotaReleaseKind = "green" | "canary";

export type QuotaRelease = {
  candidate: QuotaBlockedCandidate;
  kind: QuotaReleaseKind;
  reason: string;
};

export type QuotaHold = {
  candidate: QuotaBlockedCandidate;
  reason: string;
};

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

// "... try again at Sep 22nd, 2026 12:34 AM" - an absolute far-future date.
const ABSOLUTE_RESET_HINT_RE =
  /try again at\s+([A-Za-z]{3})[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i;
// "You've hit your session limit - resets 6:10am (UTC)" - a wall clock time.
const WALL_CLOCK_RESET_HINT_RE =
  /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(UTC\)/i;

function toTwentyFourHour(rawHour: number, meridiem: string) {
  const hour = rawHour % 12;
  return meridiem.toLowerCase() === "pm" ? hour + 12 : hour;
}

/**
 * The absolute UTC moment the provider claims the quota returns, or null.
 *
 * Only ever used to *hold* a canary back. Releases require positive evidence,
 * because these hints are routinely far-future or simply wrong.
 */
export function parseProviderQuotaResetHint(
  text: string | null | undefined,
  now: Date,
): Date | null {
  if (!text) return null;

  const absolute = text.match(ABSOLUTE_RESET_HINT_RE);
  if (absolute) {
    const month = MONTHS.indexOf((absolute[1] ?? "").toLowerCase());
    const day = Number.parseInt(absolute[2] ?? "", 10);
    const year = Number.parseInt(absolute[3] ?? "", 10);
    const hour = toTwentyFourHour(
      Number.parseInt(absolute[4] ?? "", 10),
      absolute[6] ?? "",
    );
    const minute = Number.parseInt(absolute[5] ?? "", 10);
    if (month >= 0 && Number.isInteger(day) && Number.isInteger(year)) {
      const parsed = new Date(Date.UTC(year, month, day, hour, minute));
      // Date.UTC rolls an impossible day over into the next month. Reject that
      // instead of holding work against a date the provider never sent.
      if (!Number.isNaN(parsed.getTime()) && parsed.getUTCDate() === day) {
        return parsed;
      }
    }
  }

  const wallClock = text.match(WALL_CLOCK_RESET_HINT_RE);
  if (wallClock) {
    const hour = toTwentyFourHour(
      Number.parseInt(wallClock[1] ?? "", 10),
      wallClock[3] ?? "",
    );
    const minute = Number.parseInt(wallClock[2] ?? "0", 10);
    const parsed = new Date(now.getTime());
    parsed.setUTCHours(hour, minute, 0, 0);
    // A wall clock time carries no date. Anything at or before now refers to
    // the next occurrence of that time.
    if (parsed.getTime() <= now.getTime()) {
      parsed.setUTCDate(parsed.getUTCDate() + 1);
    }
    return parsed;
  }

  return null;
}

export function classifyAdapterFamilyQuotaState(
  summary: AdapterFamilyRunSummary,
  now: Date,
  limits: QuotaWaitLimits = DEFAULT_QUOTA_WAIT_LIMITS,
): AdapterFamilyQuotaVerdict {
  const verdict = (state: AdapterFamilyQuotaState, reason: string) => ({
    family: summary.family,
    state,
    reason,
    newestSuccessAt: summary.lastSuccessAt,
  });
  const isFresh = (at: Date) =>
    now.getTime() - at.getTime() <= limits.greenFreshnessMs;

  const failedAt = summary.lastQuotaFailureAt;
  if (!failedAt) {
    if (summary.lastSuccessAt && isFresh(summary.lastSuccessAt)) {
      return verdict("green", "no quota failure in window, successes are fresh");
    }
    return verdict("dark", "no quota failure and no fresh success in window");
  }

  if (summary.lastSuccessAt && summary.lastSuccessAt > failedAt) {
    if (
      summary.successesAfterQuotaFailure >= limits.greenMinSuccesses &&
      isFresh(summary.lastSuccessAt)
    ) {
      return verdict(
        "green",
        `${summary.successesAfterQuotaFailure} successful runs after the newest quota failure at ${failedAt.toISOString()}`,
      );
    }
    return verdict(
      "red",
      `only ${summary.successesAfterQuotaFailure} success(es) after the newest quota failure, or the newest success is stale`,
    );
  }

  // Nothing succeeded after the wall went up.
  if (summary.resetHintUntil && summary.resetHintUntil > now) {
    return verdict(
      "red",
      `provider reported a quota reset at ${summary.resetHintUntil.toISOString()}`,
    );
  }

  const isSilent =
    !summary.lastTerminalAt || summary.lastTerminalAt <= failedAt;
  if (
    isSilent &&
    now.getTime() - failedAt.getTime() >= limits.darkProbeAfterMs
  ) {
    return verdict(
      "dark",
      `no terminal run since the quota failure at ${failedAt.toISOString()}, so no evidence can appear on its own`,
    );
  }

  return verdict(
    "red",
    `the newest quota failure at ${failedAt.toISOString()} outlives every success`,
  );
}

/**
 * Decide which quota-blocked issues to release this tick.
 *
 * `green` families release up to the per-tick limit. A `dark` family is a
 * deadlock - it cannot produce evidence while every issue that would produce it
 * is held - so exactly one issue per family is released as a canary, and only
 * once per cooldown. `red` families are never touched.
 */
export function decideQuotaBlockedReleases(input: {
  candidates: QuotaBlockedCandidate[];
  families: Map<string, AdapterFamilyQuotaVerdict>;
  /** Newest canary release per family, for the family probe cooldown. */
  lastCanaryByFamily: Map<string, Date>;
  now: Date;
  limits?: QuotaWaitLimits;
}): { releases: QuotaRelease[]; holds: QuotaHold[] } {
  const limits = input.limits ?? DEFAULT_QUOTA_WAIT_LIMITS;
  const releases: QuotaRelease[] = [];
  const holds: QuotaHold[] = [];
  const canaryUsedThisTick = new Set<string>();

  // Oldest strand first: an issue that has been waiting since August should not
  // keep losing its slot to one stranded ten minutes ago.
  const ordered = [...input.candidates].sort(
    (a, b) => a.strandedSince.getTime() - b.strandedSince.getTime(),
  );

  for (const candidate of ordered) {
    if (releases.length >= limits.maxReleasesPerTick) {
      holds.push({
        candidate,
        reason: "per-tick release limit reached, retrying next tick",
      });
      continue;
    }

    if (
      candidate.lastPromotedAt &&
      input.now.getTime() - candidate.lastPromotedAt.getTime() <
        limits.issueCooldownMs
    ) {
      holds.push({
        candidate,
        reason: `issue cooldown: already released at ${candidate.lastPromotedAt.toISOString()}`,
      });
      continue;
    }

    // Without a return owner the release would wake the recovery owner rather
    // than the agent that actually continues the work.
    if (!candidate.returnOwnerAgentId) {
      holds.push({
        candidate,
        reason: "recovery action has no return owner to hand the work back to",
      });
      continue;
    }

    // `workFamily` is the caller's family key, which the caller also keys
    // `families` and `lastCanaryByFamily` by. The verdict's own `family` field
    // is only the human-readable adapter type and must not be used to look
    // either of them up.
    const familyKey = candidate.workFamily;
    const family = familyKey ? input.families.get(familyKey) : undefined;
    if (!familyKey || !family) {
      holds.push({
        candidate,
        reason: `no run history for adapter family ${candidate.workFamily ?? "(unknown)"} in the window`,
      });
      continue;
    }

    if (family.state === "green") {
      // The family's recovery must be newer than *this* issue's own failure.
      // A success that predates the failure proves nothing about it.
      if (
        candidate.failedAt &&
        family.newestSuccessAt &&
        family.newestSuccessAt <= candidate.failedAt
      ) {
        holds.push({
          candidate,
          reason: "family recovery evidence predates this issue's quota failure",
        });
        continue;
      }
      releases.push({
        candidate,
        kind: "green",
        reason: `adapter family ${family.family} is green: ${family.reason}`,
      });
      continue;
    }

    if (family.state === "dark") {
      if (canaryUsedThisTick.has(familyKey)) {
        holds.push({
          candidate,
          reason: `a canary for adapter family ${family.family} was already released this tick`,
        });
        continue;
      }
      const lastCanary = input.lastCanaryByFamily.get(familyKey);
      if (
        lastCanary &&
        input.now.getTime() - lastCanary.getTime() < limits.darkProbeCooldownMs
      ) {
        holds.push({
          candidate,
          reason: `canary cooldown for adapter family ${family.family} until ${new Date(
            lastCanary.getTime() + limits.darkProbeCooldownMs,
          ).toISOString()}`,
        });
        continue;
      }
      canaryUsedThisTick.add(familyKey);
      releases.push({
        candidate,
        kind: "canary",
        reason: `adapter family ${family.family} is dark: ${family.reason}`,
      });
      continue;
    }

    holds.push({
      candidate,
      reason: `adapter family ${family.family} is red: ${family.reason}`,
    });
  }

  return { releases, holds };
}
