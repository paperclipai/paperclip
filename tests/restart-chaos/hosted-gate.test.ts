import { describe, expect, it } from "vitest";
import { hostedGate, hostedR1, releaseOutages } from "./hosted-gate.js";
import { runRow, type HostedRunRow } from "./hosted-readers.js";
import type { DetectedRelease } from "./hosted-release.js";
import type { HostedTaskRecord } from "./hosted-workload.js";
import type { SwapMetrics } from "./release-swap-grade.js";
import { roundsFor, stagingMixBudgetMs } from "./staging-mix.js";

const T0 = Date.parse("2026-11-21T10:00:00.000Z");
const MIN = 60_000;
const at = (minutes: number) => new Date(T0 + minutes * MIN).toISOString();
const task = { turnMinutes: 5, rounds: roundsFor(5), subtasks: 0, followUpAfterMs: null, arriveAtMs: 0, holdMs: 0 };
const BUDGET_MIN = stagingMixBudgetMs(task) / MIN;

function record(overrides: Partial<HostedTaskRecord> = {}): HostedTaskRecord {
  return { plan: { index: 0, adapter: "opencode", nonce: "abcd1234", task }, issueId: "i1", identifier: "GIT-1", createdAt: T0, createError: null,
    status: "done", lastLiveAt: null, followUp: null, retryClicks: [], retriedRuns: [], doneAt: null, ...overrides };
}

const run = (id: string, created: number, started: number | null, finished: number | null, extra: Record<string, unknown> = {}): HostedRunRow =>
  runRow({ id, agentId: "a1", issueId: "i1", status: finished === null ? "running" : "succeeded", createdAt: at(created), startedAt: started === null ? null : at(started),
    finishedAt: finished === null ? null : at(finished), invocationSource: "assignment", ...extra });

const agents = [{ id: "a1", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }];

function release(overrides: Partial<DetectedRelease> = {}): DetectedRelease {
  return { index: 1, from: { processStartedAt: "a", commit: "c1" }, to: { processStartedAt: "b", commit: "c2" }, commitChanged: true, lastOldOnlyAt: T0,
    firstNewAt: T0 + MIN, lastOldAt: T0 + 2 * MIN, overlapWindow: { from: T0 + MIN, to: T0 + 2 * MIN }, shape: "overlap", failedRequests: 0, slowRequests: 0,
    firstFailureAt: null, timeToFirstNewMs: MIN, settled: true, ...overrides };
}

describe("hosted R1", () => {
  it("passes a task done inside the staging-mix budget and fails one done after it with no fair queue wait", () => {
    const fast = hostedR1({ record: record(), view: { status: "done", completedAt: at(10) }, runs: [run("r1", 0, 0, 10)], agents, companyRuns: [run("r1", 0, 0, 10)], outages: [] });
    expect(fast.verdict).toBe("pass");
    const late = BUDGET_MIN + 5;
    const slow = hostedR1({ record: record(), view: { status: "done", completedAt: at(late) }, runs: [run("r1", 0, 0, late)], agents,
      companyRuns: [run("r1", 0, 0, late)], outages: [] });
    expect(slow).toMatchObject({ verdict: "fail" });
    expect(slow.detail).toMatch(/^done_too_late/);
  });

  it("credits the first run's queue wait when the agent's only slot was busy the whole time", () => {
    const wait = 30;
    const done = wait + BUDGET_MIN - 5;
    const busy = run("other", -1, -1, wait, { issueId: "i0" });
    const mine = run("r1", 0, wait, done);
    const graded = hostedR1({ record: record(), view: { status: "done", completedAt: at(done) }, runs: [mine], agents, companyRuns: [busy, mine], outages: [] });
    expect(graded.verdict).toBe("pass");
    expect(graded.detail).toContain("fair queue wait");
  });

  it("fails an unfair wait: a newer assignment run of the same agent started ahead of the task's run", () => {
    const wait = 30;
    const done = wait + BUDGET_MIN - 5;
    const overtaker = run("newer", 1, 2, wait, { issueId: "i0" });
    const mine = run("r1", 0, wait, done);
    const graded = hostedR1({ record: record(), view: { status: "done", completedAt: at(done) }, runs: [mine], agents, companyRuns: [overtaker, mine], outages: [] });
    expect(graded.verdict).toBe("fail");
    expect(graded.detail).toMatch(/^unfair_queue_wait/);
  });

  it("credits outage time only for a release whose health probes failed before the new build answered", () => {
    expect(releaseOutages([release()])).toEqual([]);
    const outage = releaseOutages([release({ shape: "stop_then_start", firstFailureAt: T0 + 10 * MIN, firstNewAt: T0 + 20 * MIN })]);
    expect(outage).toHaveLength(1);
    expect(outage[0]).toMatchObject({ startedAt: T0 + 10 * MIN, readyAt: T0 + 20 * MIN });
    const done = BUDGET_MIN + 5;
    const graded = hostedR1({ record: record(), view: { status: "done", completedAt: at(done) }, runs: [run("r1", 0, 0, done)], agents,
      companyRuns: [run("r1", 0, 0, done)], outages: outage });
    expect(graded.verdict).toBe("pass");
  });

  it("marks a task that needed Retry n/a for R1 and fails one that did not rest done", () => {
    const retried = hostedR1({ record: record({ retryClicks: [{ at: T0, accepted: true, via: "grader" }] }), view: { status: "done", completedAt: at(10) },
      runs: [], agents, companyRuns: [], outages: [] });
    expect(retried.verdict).toBe("n/a");
    const open = hostedR1({ record: record(), view: { status: "in_progress" }, runs: [run("r1", 0, 0, null)], agents, companyRuns: [], outages: [] });
    expect(open.detail).toMatch(/^rested_not_done/);
  });
});

describe("gate D verdict", () => {
  const metric = (index: number, survivors: number): SwapMetrics => ({ index, failedRuns: [], lostWhileOldAlive: [],
    survivors: Array.from({ length: survivors }, (_, n) => ({ runId: `r${n}`, nextEventAfterMs: 1_000 })), nextEventP50Ms: 1_000, nextEventMaxMs: 1_000, survivorsWithoutEvent: 0 });
  const clean = { handsOffPass: true, r1: [{ identifier: "GIT-1", result: { verdict: "pass" as const, detail: "done" } }], bannersShown: 0,
    health: { requests: 100, failures: 0, slow: 0, longestGapMs: 2_000, longestGap: null },
    duplicates: { overlappingRuns: [], duplicateComments: [], duplicateChildren: [] }, releases: [release()], metrics: [metric(1, 3)] };

  it("passes only when every criterion holds", () => {
    const gate = hostedGate(clean);
    expect(gate.pass).toBe(true);
    expect(gate.lines[0]).toBe("Gate D: PASS");
  });

  it.each([
    ["a banner", { bannersShown: 1 }, "Retry banners"],
    ["a failed health probe", { health: { ...clean.health, failures: 1 } }, "health probes"],
    ["a duplicated comment", { duplicates: { ...clean.duplicates, duplicateComments: [{ issueId: "i1", count: 2 }] } }, "duplicates"],
    ["a stop-then-start release", { releases: [release({ shape: "stop_then_start" })] }, "swap shape"],
    ["a release with no live run", { metrics: [metric(1, 0)] }, "releases under load"],
    ["no release", { releases: [], metrics: [] }, "releases under load"],
    ["an R1 failure", { r1: [{ identifier: "GIT-2", result: { verdict: "fail" as const, detail: "done_too_late 9s > 1s" } }] }, "R1"],
    ["a task that was not hands-off", { handsOffPass: false }, "hands-off"],
  ])("fails on %s", (_name, change, check) => {
    const gate = hostedGate({ ...clean, ...change });
    expect(gate.pass).toBe(false);
    expect(gate.lines.find(line => line.includes(`FAIL ${check}`))).toBeDefined();
  });
});
