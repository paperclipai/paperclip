import type {
  AiConnectionRouterRequest,
  AiConnectionRouterResult,
} from "@paperclipai/plugin-sdk";

const RESERVE_PERCENT = 10;
const NEAR_RESET_MS = 5 * 60 * 60 * 1000;
const RECHECK_MS = 60 * 1000;
const MAX_OBSERVATION_AGE_MS = 2 * 60 * 1000;

type Candidate = AiConnectionRouterRequest["candidates"][number];
type Assessment = {
  candidate: Candidate;
  tier: "normal" | "near_reset" | "wait";
  remaining: number;
  knownLow: boolean;
  retryAt: number;
  reason: string;
};

function futureReset(value: string | null, now: number): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > now ? parsed : null;
}

function remainingPercent(limit: { remainingPercent: number | null; usedPercent: number | null }): number | null {
  const remaining = limit.remainingPercent ?? (limit.usedPercent == null ? null : 100 - limit.usedPercent);
  return remaining != null && Number.isFinite(remaining) && remaining >= 0 && remaining <= 100
    ? remaining : null;
}

function isCodexLimit(limit: { id: string; scope: string | null }): boolean {
  return limit.scope === null &&
    (limit.id === "codex" || limit.id.startsWith("codex.") || limit.id.startsWith("codex_"));
}

function assess(candidate: Candidate, now: number, pinned = false): Assessment {
  const waiting = (reason: string, retryAt = now + RECHECK_MS, knownLow = false): Assessment => ({
    candidate, tier: "wait", remaining: 0, knownLow, retryAt, reason,
  });
  const usage = candidate.usage;
  if (candidate.member.binding.provider !== "openai" ||
      candidate.member.binding.method !== "subscription" ||
      candidate.member.profile.provider !== "codex") return waiting("Not a Codex subscription");
  if (!usage || usage.status !== "ok" || usage.provider !== "openai" || usage.method !== "subscription") {
    return waiting("Quota observation unavailable");
  }
  if (usage.connectionId !== candidate.member.binding.connectionId ||
      usage.grantId !== candidate.member.binding.grantId) return waiting("Quota observation mismatched");
  const checkedAt = Date.parse(usage.checkedAt);
  if (!Number.isFinite(checkedAt) || checkedAt > now + 30_000 ||
      now - checkedAt > MAX_OBSERVATION_AGE_MS) return waiting("Quota observation stale");

  const codex = usage.limits.filter(isCodexLimit);
  if (codex.length === 0) return waiting("Codex quota window missing");
  const windows = codex.map((limit) => ({ limit, remaining: remainingPercent(limit) }));
  if (windows.some((window) => window.remaining == null)) return waiting("Codex quota percentage unknown");
  const remaining = Math.min(...windows.map((window) => window.remaining!));
  const resetTimes = windows.map((window) => futureReset(window.limit.resetsAt, now));
  const earliestReset = Math.min(...resetTimes.filter((reset): reset is number => reset != null));
  const retryAt = Number.isFinite(earliestReset) ? earliestReset : now + RECHECK_MS;
  if (windows.some((window) => window.limit.allowed !== true)) {
    return waiting("Codex admission unknown or denied", now + RECHECK_MS, remaining <= RESERVE_PERCENT);
  }

  if (usage.limits.some((limit) =>
    (isCodexLimit(limit) || (limit.id === "spend_control" && limit.scope === null)) &&
    (limit.limitReached === true || limit.allowed === false))) {
    return waiting("Provider admission denied", retryAt, remaining <= RESERVE_PERCENT);
  }
  if (remaining > RESERVE_PERCENT) {
    return { candidate, tier: "normal", remaining, knownLow: false, retryAt, reason: "" };
  }
  const limiting = windows.filter((window) => window.remaining! <= RESERVE_PERCENT);
  const mayUseNearReset = limiting.every(({ limit, remaining: left }) => {
    const reset = futureReset(limit.resetsAt, now);
    return left! > 0 && limit.allowed === true && limit.limitReached === false &&
      reset !== null && reset - now < NEAR_RESET_MS;
  });
  if (mayUseNearReset) {
    if (pinned) {
      const reset = Math.max(...limiting.map(({ limit }) => futureReset(limit.resetsAt, now)!));
      return waiting("Pinned account at or below 10% reserve", reset, true);
    }
    return { candidate, tier: "near_reset", remaining, knownLow: true, retryAt, reason: "" };
  }
  const nextEligibility = limiting.map(({ limit, remaining: left }) => {
    const reset = futureReset(limit.resetsAt, now);
    if (reset === null) return now + RECHECK_MS;
    return !pinned && left! > 0 && reset - now >= NEAR_RESET_MS
      ? reset - NEAR_RESET_MS + 1_000 : reset;
  });
  return waiting("At or below 10% reserve",
    pinned && nextEligibility.every((time) => time > now + RECHECK_MS)
      ? Math.max(...nextEligibility) : Math.min(...nextEligibility), true);
}

function inRotationOrder(request: AiConnectionRouterRequest, entries: Assessment[]): Assessment[] {
  const order = request.memberOrder;
  const after = request.lastMemberId ? order.indexOf(request.lastMemberId) + 1 : 0;
  const rotation = [...order.slice(after), ...order.slice(0, after)];
  return entries.filter((entry) => rotation.includes(entry.candidate.member.id))
    .sort((a, b) => rotation.indexOf(a.candidate.member.id) - rotation.indexOf(b.candidate.member.id));
}

/** Proposes only host-authorized members. The host owns task pins and durable retry scheduling. */
export function routeCodexConnection(request: AiConnectionRouterRequest): AiConnectionRouterResult {
  if (request.pool.mode !== "usage_aware" || request.pool.thresholdPercent !== 90) {
    return { kind: "unavailable", skipped: {} };
  }
  const now = Date.parse(request.now);
  if (!Number.isFinite(now)) return { kind: "unavailable", skipped: {} };
  const candidates = request.pinnedMemberId
    ? request.candidates.filter((entry) => entry.member.id === request.pinnedMemberId)
    : request.candidates;
  if (candidates.length === 0) return { kind: "unavailable", skipped: {} };

  const assessed = candidates.map((candidate) => assess(candidate, now, Boolean(request.pinnedMemberId)));
  // A task pin can outlive a member's removal from the current pool config.
  // The host still authorizes that member, but memberOrder no longer lists it.
  const pinned = request.pinnedMemberId ? assessed[0] : undefined;
  if (pinned?.tier === "normal") {
    return { kind: "selected", memberId: pinned.candidate.member.id };
  }
  const normal = inRotationOrder(request, assessed.filter((entry) => entry.tier === "normal"));
  if (normal[0]) return { kind: "selected", memberId: normal[0].candidate.member.id };
  const nearReset = inRotationOrder(request, assessed.filter((entry) => entry.tier === "near_reset"))
    .sort((a, b) => b.remaining - a.remaining);
  // The exception applies only after every configured account is observed at
  // or below the threshold. A stale or unauthorized peer cannot prove that.
  if (!request.pinnedMemberId && nearReset[0] &&
      assessed.length === request.memberOrder.length && assessed.every((entry) => entry.knownLow)) {
    return { kind: "selected", memberId: nearReset[0].candidate.member.id };
  }

  const skipped = Object.fromEntries(assessed.map((entry) => [
    entry.candidate.member.id,
    entry.tier === "near_reset" ? "Cannot verify every pool account is at or below 10%" : entry.reason,
  ]));
  const next = Math.min(...assessed.map((entry) => entry.retryAt));
  return { kind: "exhausted", retryAt: new Date(Math.max(now + 1_000, next)).toISOString(), skipped };
}
