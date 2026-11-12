import type { AiConnectionRouterRequest, AiConnectionRouterResult } from "@paperclipai/plugin-sdk";

type Candidate = AiConnectionRouterRequest["candidates"][number];
type Usage = NonNullable<Candidate["usage"]>;
type Limit = Usage["limits"][number];

export const DEFAULT_RETRY_MS = 15 * 60_000;
export const BASE_COOLDOWN_MS = 60 * 60_000;
export const MAX_COOLDOWN_MS = 7 * 24 * 60 * 60_000;

/** A learned cool-down for one account (connection plus grant). */
export interface Cooldown { until: string; strikes: number; lastRunId?: string }

export function accountKey(binding: { connectionId: string; grantId: string }): string {
  return `${binding.connectionId}:${binding.grantId}`;
}

/** Account-wide limits (null scope) and limits scoped to the member's model count; other models and features do not. */
export function limitApplies(scope: string | null, model: string): boolean {
  if (scope === null) return true;
  const target = model.toLowerCase();
  return scope.split("·").map(token => token.trim().toLowerCase()).some((token) => {
    const id = token.startsWith("model:") ? token.slice("model:".length) : token.includes(":") ? "" : token;
    return id.length > 0 && target.includes(id);
  });
}

function usedPercent(limit: Limit): number | null {
  if (typeof limit.usedPercent === "number") return limit.usedPercent;
  if (typeof limit.remainingPercent === "number") return 100 - limit.remainingPercent;
  return null;
}

interface Assessment { hard: boolean; above: boolean; known: boolean; readyAt: number | null }

/** The latest reset among the blocking limits; null when any of them has no known reset. */
function readyAt(blocking: Limit[]): number | null {
  let latest = 0;
  for (const limit of blocking) {
    const at = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN;
    if (!Number.isFinite(at)) return null;
    latest = Math.max(latest, at);
  }
  return latest;
}

export function assessUsage(usage: Usage | undefined, model: string, thresholdPercent: number | null): Assessment {
  if (!usage || usage.status !== "ok") return { hard: false, above: false, known: false, readyAt: null };
  const limits = usage.limits.filter(limit => limitApplies(limit.scope, model));
  const hard = limits.filter(limit => limit.limitReached === true || limit.allowed === false || (usedPercent(limit) ?? 0) >= 100);
  if (hard.length) return { hard: true, above: true, known: true, readyAt: readyAt(hard) };
  const percents = limits.map(usedPercent);
  const known = percents.some(percent => percent !== null);
  const above = thresholdPercent === null ? [] : limits.filter((limit, index) => (percents[index] ?? -1) >= thresholdPercent);
  return { hard: false, above: above.length > 0, known, readyAt: above.length ? readyAt(above) : null };
}

/** Members in rotation order, starting after `lastMemberId`. */
export function rotation(memberOrder: string[], lastMemberId: string | null): string[] {
  const start = lastMemberId === null ? 0 : memberOrder.indexOf(lastMemberId) + 1;
  return [...memberOrder.slice(start), ...memberOrder.slice(0, start)];
}

/** The model the run will execute: the host-resolved runtime model (it includes compatible overrides), else the member profile. */
export function effectiveModel(candidate: Candidate): string {
  const model = candidate.runtimeConfig?.model;
  return typeof model === "string" && model.trim().length > 0 ? model : candidate.member.profile.model;
}

function exhausted(skipped: Record<string, string>, readyTimes: Array<number | null>, now: number): AiConnectionRouterResult {
  const known = readyTimes.filter((at): at is number => at !== null && at > now);
  return { kind: "exhausted", retryAt: new Date(known.length ? Math.min(...known) : now + DEFAULT_RETRY_MS).toISOString(), skipped };
}

/**
 * Chooses among the members the host already authorized and offered.
 * `cooldowns` maps an account key to its learned cool-down; pass an empty map when state is unreadable.
 */
export function routeAiConnection(request: AiConnectionRouterRequest, cooldowns: ReadonlyMap<string, Cooldown>): AiConnectionRouterResult {
  const now = Date.parse(request.now);
  const offered = new Map(request.candidates.map(candidate => [candidate.member.id, candidate]));
  const threshold = request.pool.mode === "usage_aware" ? request.pool.thresholdPercent : null;
  const skipped: Record<string, string> = {};
  const readyTimes: Array<number | null> = [];

  const evaluate = (candidate: Candidate, applyThreshold: boolean): Assessment | null => {
    const usage = assessUsage(candidate.usage, effectiveModel(candidate), applyThreshold ? threshold : null);
    const cooldown = cooldowns.get(accountKey(candidate.member.binding));
    const coolingUntil = cooldown ? Date.parse(cooldown.until) : NaN;
    const cooling = Number.isFinite(coolingUntil) && coolingUntil > now;
    const id = candidate.member.id;
    if (usage.hard) skipped[id] = "At a provider usage limit";
    else if (cooling) skipped[id] = `Cooling down after a provider quota failure until ${new Date(coolingUntil).toISOString()}`;
    else if (usage.above) skipped[id] = `Usage at or above ${threshold}%`;
    else return usage;
    // Ready when every blocking condition has cleared; unknown when any of them has no known end.
    const ends = [...(usage.hard || usage.above ? [usage.readyAt] : []), ...(cooling ? [coolingUntil] : [])];
    readyTimes.push(ends.includes(null) ? null : Math.max(...(ends as number[])));
    return null;
  };

  if (request.pinnedMemberId) {
    const pinned = offered.get(request.pinnedMemberId);
    if (!pinned) return { kind: "unavailable", skipped: { [request.pinnedMemberId]: "Pinned member is not available for this agent" } };
    // Thresholds govern new allocations only; a pin waits only at a hard limit or during a cool-down.
    return evaluate(pinned, false) ? { kind: "selected", memberId: pinned.member.id } : exhausted(skipped, readyTimes, now);
  }

  const withHeadroom: string[] = [];
  const unknown: string[] = [];
  for (const id of rotation(request.memberOrder, request.lastMemberId)) {
    const candidate = offered.get(id);
    if (!candidate) { skipped[id] = "Not available for this agent"; continue; }
    const usage = evaluate(candidate, true);
    if (usage) (usage.known || threshold === null ? withHeadroom : unknown).push(id);
  }
  const memberId = withHeadroom[0] ?? unknown[0];
  if (memberId) return { kind: "selected", memberId, ...(Object.keys(skipped).length ? { skipped } : {}) };
  if (!request.candidates.length) return { kind: "unavailable", skipped };
  return exhausted(skipped, readyTimes, now);
}

/** The next cool-down after a quota failure: the named reset when known (never shortened), else 1 h doubling per strike up to 7 days. */
export function nextCooldown(previous: Cooldown | null, runId: string, now: number, namedReset: number | null): Cooldown {
  if (previous?.lastRunId === runId) return previous;
  const strikes = (previous?.strikes ?? 0) + 1;
  const until = namedReset !== null && namedReset > now ? namedReset : now + Math.min(BASE_COOLDOWN_MS * 2 ** (strikes - 1), MAX_COOLDOWN_MS);
  return { until: new Date(until).toISOString(), strikes, lastRunId: runId };
}

const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/;

/** A reset named by the failure: a structured field when present, else an ISO-8601 timestamp in the error text. */
export function namedReset(payload: Record<string, unknown>, now: number): number | null {
  for (const value of [payload.retryNotBefore, payload.resetsAt, typeof payload.error === "string" ? payload.error.match(ISO_TIMESTAMP)?.[0] : undefined]) {
    const at = typeof value === "string" ? Date.parse(value) : NaN;
    if (Number.isFinite(at) && at > now) return at;
  }
  return null;
}
