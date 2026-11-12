import { describe, expect, it } from "vitest";
import type { AiConnectionRouterRequest } from "@paperclipai/plugin-sdk";
import { BASE_COOLDOWN_MS, DEFAULT_RETRY_MS, MAX_COOLDOWN_MS, accountKey, limitApplies, namedReset, nextCooldown, routeAiConnection, type Cooldown } from "../src/policy.js";

type Candidate = AiConnectionRouterRequest["candidates"][number];
type Limit = NonNullable<Candidate["usage"]>["limits"][number];

const NOW = "2026-01-01T00:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();
const ids = ["member-a", "member-b", "member-c"];

function limit(usedPercent: number | null, extra: Partial<Limit> = {}): Limit {
  return { id: "window", label: "Window", scope: null, windowDurationSeconds: 18_000, resetsAt: null, usedPercent, remainingPercent: null, used: null, limit: null, remaining: null, unit: null, limitReached: null, allowed: null, ...extra };
}
function candidate(id: string, limits?: Limit[], model = "claude-sonnet-5", runtimeModel?: string): Candidate {
  const binding = { mode: "delegated" as const, provider: "anthropic" as const, method: "subscription" as const, connectionId: `conn-${id}`, grantId: `grant-${id}` };
  return {
    member: { id, binding, profile: { provider: "acpx", acpxAgent: "claude", model } } as Candidate["member"],
    runtimeConfig: runtimeModel ? { model: runtimeModel } : {}, notes: [],
    ...(limits ? { usage: { connectionId: binding.connectionId, grantId: binding.grantId, provider: "anthropic", method: "subscription", status: "ok", checkedAt: NOW, source: null, planType: null, limits, overage: null } } : {}),
  };
}
function request(candidates: Candidate[], extra: Partial<AiConnectionRouterRequest> = {}, mode: "round_robin" | "usage_aware" = "usage_aware"): AiConnectionRouterRequest {
  return {
    companyId: "company", agentId: "agent", taskKey: "task", lastMemberId: null, cursorVersion: 0, memberOrder: ids, now: NOW,
    pool: { id: "pool", companyId: "company", pluginKey: "router", revision: 1, name: "Pool", enabled: true, mode, thresholdPercent: 90, members: candidates.map(c => c.member) },
    candidates, ...extra,
  };
}
const cooling = (id: string, minutes: number): [string, Cooldown] => [accountKey(candidate(id).member.binding), { until: at(minutes), strikes: 1 }];

describe("routeAiConnection", () => {
  const all = () => ids.map(id => candidate(id));
  it.each([
    { name: "starts at the first member without a cursor", last: null, expected: "member-a" },
    { name: "rotates after lastMemberId", last: "member-a", expected: "member-b" },
    { name: "wraps around memberOrder", last: "member-c", expected: "member-a" },
    { name: "restarts when lastMemberId was removed", last: "removed", expected: "member-a" },
  ])("round robin $name", ({ last, expected }) => {
    expect(routeAiConnection(request(all(), { lastMemberId: last }, "round_robin"), new Map())).toEqual({ kind: "selected", memberId: expected });
  });

  it.each([
    { name: "skips a member at the threshold", usage: [[limit(90)], [limit(10)]], expected: "member-b", skip: "Usage at or above 90%" },
    { name: "skips a member reporting limitReached", usage: [[limit(5, { limitReached: true })], [limit(10)]], expected: "member-b", skip: "At a provider usage limit" },
    { name: "skips a member reporting allowed: false", usage: [[limit(5, { allowed: false })], [limit(10)]], expected: "member-b", skip: "At a provider usage limit" },
    { name: "skips a same-model limit", usage: [[limit(10), limit(100, { scope: "model:sonnet" })], [limit(10)]], expected: "member-b", skip: "At a provider usage limit" },
    { name: "ignores another model's limit", usage: [[limit(10), limit(100, { scope: "model:opus" })], [limit(10)]], expected: "member-a", skip: undefined },
    { name: "ignores a feature-scoped limit", usage: [[limit(10), limit(100, { scope: "surface:chat" })], [limit(10)]], expected: "member-a", skip: undefined },
    { name: "derives usage from remainingPercent", usage: [[limit(null, { remainingPercent: 5 })], [limit(10)]], expected: "member-b", skip: "Usage at or above 90%" },
  ])("usage_aware $name", ({ usage, expected, skip }) => {
    const result = routeAiConnection(request([candidate("member-a", usage[0]), candidate("member-b", usage[1])], { memberOrder: ids.slice(0, 2) }), new Map());
    expect(result).toMatchObject({ kind: "selected", memberId: expected });
    expect(result.skipped?.["member-a"]).toBe(skip);
  });

  it("orders unknown usage after known headroom but never treats it as exhausted or as 0 %", () => {
    const unknownFirst = [candidate("member-a"), candidate("member-b", [limit(50)])];
    expect(routeAiConnection(request(unknownFirst, { memberOrder: ids.slice(0, 2) }), new Map())).toEqual({ kind: "selected", memberId: "member-b" });
    const failedProbe = { ...candidate("member-a", []), usage: { ...candidate("member-a", [])!.usage!, status: "error" as const } };
    expect(routeAiConnection(request([failedProbe, candidate("member-b", [limit(95)])], { memberOrder: ids.slice(0, 2) }), new Map())).toMatchObject({ kind: "selected", memberId: "member-a" });
  });

  it("applies hard limits in round_robin mode but not the threshold", () => {
    const result = routeAiConnection(request([candidate("member-a", [limit(100)]), candidate("member-b", [limit(95)])], { memberOrder: ids.slice(0, 2) }, "round_robin"), new Map());
    expect(result).toEqual({ kind: "selected", memberId: "member-b", skipped: { "member-a": "At a provider usage limit" } });
  });

  it("skips a member during its learned cool-down and selects it once the cool-down has passed", () => {
    expect(routeAiConnection(request(all()), new Map([cooling("member-a", 30)]))).toMatchObject({ kind: "selected", memberId: "member-b" });
    expect(routeAiConnection(request(all()), new Map([cooling("member-a", -1)]))).toEqual({ kind: "selected", memberId: "member-a" });
  });

  it("names members the host did not offer and returns unavailable when none is offered", () => {
    expect(routeAiConnection(request([candidate("member-b")]), new Map())).toEqual({ kind: "selected", memberId: "member-b", skipped: { "member-a": "Not available for this agent", "member-c": "Not available for this agent" } });
    expect(routeAiConnection(request([]), new Map())).toMatchObject({ kind: "unavailable" });
  });

  it("returns exhausted with the earliest known reset when every member is blocked", () => {
    const result = routeAiConnection(request([
      candidate("member-a", [limit(100, { resetsAt: at(90) })]),
      candidate("member-b", [limit(95, { resetsAt: at(45) })]),
      candidate("member-c"),
    ]), new Map([cooling("member-c", 60)]));
    expect(result).toMatchObject({ kind: "exhausted", retryAt: at(45) });
    expect(Object.keys(result.kind === "exhausted" ? result.skipped : {})).toEqual(ids);
  });

  it("waits until both the usage reset and the cool-down have passed, or 15 minutes when no reset is known", () => {
    const both = routeAiConnection(request([candidate("member-a", [limit(100, { resetsAt: at(20) })])], { memberOrder: ["member-a"] }), new Map([cooling("member-a", 50)]));
    expect(both).toMatchObject({ kind: "exhausted", retryAt: at(50) });
    const unknownReset = routeAiConnection(request([candidate("member-a", [limit(100)]), candidate("member-b", [limit(99)])], { memberOrder: ids.slice(0, 2) }), new Map());
    expect(unknownReset).toMatchObject({ kind: "exhausted", retryAt: at(DEFAULT_RETRY_MS / 60_000) });
  });

  it.each([
    { name: "keeps a pin above the threshold", limits: [limit(95)], cooldown: false, expected: { kind: "selected", memberId: "member-a" } },
    { name: "keeps a pin with unknown usage", limits: undefined, cooldown: false, expected: { kind: "selected", memberId: "member-a" } },
    { name: "waits on a pin at a hard limit", limits: [limit(100, { resetsAt: at(30) })], cooldown: false, expected: { kind: "exhausted", retryAt: at(30), skipped: { "member-a": "At a provider usage limit" } } },
    { name: "waits on a pin during its cool-down", limits: undefined, cooldown: true, expected: { kind: "exhausted", retryAt: at(40) } },
  ])("pinned task $name and never moves the pin", ({ limits, cooldown, expected }) => {
    const result = routeAiConnection(request([candidate("member-a", limits)], { pinnedMemberId: "member-a" }), new Map(cooldown ? [cooling("member-a", 40)] : []));
    expect(result).toMatchObject(expected);
  });

  const opusLimit = (used: number) => [limit(used, { scope: "model:opus", resetsAt: at(30) })];
  it.each([
    { name: "a Sonnet profile overridden to Opus meets an Opus hard limit", profile: "claude-sonnet-5", runtime: "claude-opus-5-5", used: 100, pinned: false, expected: { kind: "exhausted", retryAt: at(30) } },
    { name: "an Opus profile overridden to Sonnet ignores an Opus hard limit", profile: "claude-opus-5-5", runtime: "claude-sonnet-5", used: 100, pinned: false, expected: { kind: "selected", memberId: "member-a" } },
    { name: "a Sonnet profile overridden to Opus meets an Opus threshold", profile: "claude-sonnet-5", runtime: "claude-opus-5-5", used: 95, pinned: false, expected: { kind: "exhausted", retryAt: at(30) } },
    { name: "an Opus profile overridden to Sonnet ignores an Opus threshold", profile: "claude-opus-5-5", runtime: "claude-sonnet-5", used: 95, pinned: false, expected: { kind: "selected", memberId: "member-a" } },
    { name: "a pin overridden to Opus waits at an Opus hard limit", profile: "claude-sonnet-5", runtime: "claude-opus-5-5", used: 100, pinned: true, expected: { kind: "exhausted", retryAt: at(30) } },
    { name: "a pin overridden to Sonnet is kept despite an Opus hard limit", profile: "claude-opus-5-5", runtime: "claude-sonnet-5", used: 100, pinned: true, expected: { kind: "selected", memberId: "member-a" } },
  ])("assesses the effective model: $name", ({ profile, runtime, used, pinned, expected }) => {
    const result = routeAiConnection(request([candidate("member-a", opusLimit(used), profile, runtime)], { memberOrder: ["member-a"], ...(pinned ? { pinnedMemberId: "member-a" } : {}) }), new Map());
    expect(result).toMatchObject(expected);
  });

  it("reports an unoffered pin as unavailable instead of moving it", () => {
    expect(routeAiConnection(request([candidate("member-b")], { pinnedMemberId: "member-a" }), new Map())).toMatchObject({ kind: "unavailable" });
  });
});

describe("cool-downs", () => {
  const now = Date.parse(NOW);
  it("starts at one hour, doubles per strike and caps at seven days", () => {
    let cooldown: Cooldown | null = null;
    const durations: number[] = [];
    for (let strike = 1; strike <= 10; strike++) {
      cooldown = nextCooldown(cooldown, `run-${strike}`, now, null);
      durations.push(Date.parse(cooldown.until) - now);
    }
    expect(durations.slice(0, 4)).toEqual([1, 2, 4, 8].map(hours => hours * BASE_COOLDOWN_MS));
    expect(durations.at(-1)).toBe(MAX_COOLDOWN_MS);
  });
  it("uses a named reset and ignores a redelivered run", () => {
    const first = nextCooldown(null, "run-1", now, Date.parse(at(17)));
    expect(first).toEqual({ until: at(17), strikes: 1, lastRunId: "run-1" });
    expect(nextCooldown(first, "run-1", now, null)).toBe(first);
  });
  it("keeps a named reset beyond seven days; only the fallback backoff is capped", () => {
    const tenDays = Date.parse("2026-01-11T00:00:00.000Z");
    expect(nextCooldown(null, "run-1", now, tenDays)).toEqual({ until: "2026-01-11T00:00:00.000Z", strikes: 1, lastRunId: "run-1" });
  });
  it("reads a named reset from structured fields or ISO-8601 error text, never from the past", () => {
    expect(namedReset({ retryNotBefore: at(5) }, now)).toBe(Date.parse(at(5)));
    expect(namedReset({ error: `Usage limit reached; resets at ${at(30)}` }, now)).toBe(Date.parse(at(30)));
    expect(namedReset({ error: `resets at ${at(-30)}` }, now)).toBeNull();
    expect(namedReset({ error: "You've hit your limit" }, now)).toBeNull();
  });
  it("matches model-scoped limits by model name", () => {
    expect(limitApplies(null, "any")).toBe(true);
    expect(limitApplies("model:sonnet · surface:code", "claude-sonnet-5")).toBe(true);
    expect(limitApplies("spark", "gpt-5.3-codex-spark")).toBe(true);
    expect(limitApplies("code_review", "gpt-5.6")).toBe(false);
  });
});
