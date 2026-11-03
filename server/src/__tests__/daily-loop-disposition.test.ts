import { describe, expect, it } from "vitest";
import { decideLegacyContinuation, legacyDispositionEpisode } from "../services/recovery/legacy-continuation.js";
import { buildContinuationSummaryMarkdown, continuationSummaryParksExecutor } from "../services/issue-continuation-summary.js";

const run = { id: "run", companyId: "company", agentId: "agent", status: "succeeded", runtimeMode: "legacy", error: null };
const issue = { id: "issue", companyId: "company", assigneeAgentId: "agent", status: "todo", identifier: "TEST-1", title: "Daily sweep", description: null, priority: "medium" };
const agent = { id: "agent", companyId: "company", status: "idle", name: "Worker", adapterType: "codex_local" };
const gates = { stopped: false, paused: false, budgetBlocked: false, pendingWait: false, activeExecution: false, ownedLifecycle: false, conversation: false, agentInvokable: true };
const input = { run, issue, agent, gates, episode: legacyDispositionEpisode(run) };
const oldSummary = "## Next Action\n\n- Wait for reviewer feedback or approval before continuing executor work.";

describe("daily loop disposition", () => {
  it("PASS obsolete review wait removed", () => {
    const body = buildContinuationSummaryMarkdown({ issue, run, agent, previousSummaryBody: oldSummary, hasCurrentWaitTarget: false });
    expect(continuationSummaryParksExecutor(body)).toBe(false);
  });
});

describe("registered recurring disposition", () => {
  it("PASS completed registered loop stays todo", () => {
    expect(decideLegacyContinuation({ ...input, recurringLoop: { routineId: "routine", triggerId: "trigger", companyId: issue.companyId, issueId: issue.id, agentId: agent.id, nextRunAt: new Date("2099-01-01") } })).toEqual({ kind: "skip", reason: "registered_recurring_loop" });
    expect(issue.status).toBe("todo");
  });
});

const loop = { routineId: "routine", triggerId: "trigger", companyId: issue.companyId, issueId: issue.id, agentId: agent.id, nextRunAt: new Date("2099-01-01") };
describe("daily loop guards", () => {
  it("PASS repeated unchanged evidence creates no duplicate repair", () => {
    const registered = { ...input, recurringLoop: loop };
    expect(decideLegacyContinuation(registered).kind).toBe("skip");
    expect(decideLegacyContinuation(structuredClone(registered)).kind).toBe("skip");
  });
  it("PASS ordinary abandoned todo recovers", () => {
    expect(decideLegacyContinuation(input)).toMatchObject({ kind: "enqueue", nextAttempt: 1 });
  });
  it("PASS abandoned in_progress recovers", () => {
    expect(decideLegacyContinuation({ ...input, issue: { ...issue, status: "in_progress" } })).toMatchObject({ kind: "enqueue", nextAttempt: 1 });
  });
  it("PASS retry attempts 1 and 2 then exhaustion", () => {
    for (const attempt of [0, 1]) expect(decideLegacyContinuation({ ...input, episode: { ...input.episode, attempt } })).toMatchObject({ kind: "enqueue", nextAttempt: attempt + 1 });
    expect(decideLegacyContinuation({ ...input, episode: { ...input.episode, attempt: 2 } }).kind).toBe("exhausted");
  });
  it("PASS real blocker", () => {
    expect(decideLegacyContinuation({ ...input, issue: { ...issue, status: "blocked" }, recurringLoop: loop })).toEqual({ kind: "skip", reason: "recorded_disposition" });
  });
  it.each([["Stop", "stopped", "stopped"], ["pause", "paused", "paused"], ["budget gate", "budgetBlocked", "budget_blocked"], ["current question", "pendingWait", "durable_wait"], ["current approval", "pendingWait", "durable_wait"]])("PASS %s", (_name, gate, reason) => {
    expect(decideLegacyContinuation({ ...input, recurringLoop: loop, gates: { ...gates, [gate]: true } })).toEqual({ kind: "skip", reason });
  });
  it("PASS stable repair identity", () => {
    expect(decideLegacyContinuation(structuredClone(input))).toEqual(decideLegacyContinuation(input));
  });
  it("PASS current review wait preserved", () => {
    for (const hasCurrentWaitTarget of [true, undefined]) {
      const body = buildContinuationSummaryMarkdown({ issue, run, agent, previousSummaryBody: oldSummary, hasCurrentWaitTarget });
      expect(continuationSummaryParksExecutor(body)).toBe(true);
    }
  });
  it("rejects recurrence for another task, company, or owner", () => {
    for (const mismatch of [{ issueId: "other" }, { companyId: "other" }, { agentId: "other" }]) {
      expect(decideLegacyContinuation({ ...input, recurringLoop: { ...loop, ...mismatch } }).kind).toBe("enqueue");
    }
    expect(decideLegacyContinuation({ ...input, issue: { ...issue, status: "in_progress" }, recurringLoop: loop }).kind).toBe("enqueue");
  });
});

it("does not park dispatch on a saved wait with no current target", () => {
  expect(continuationSummaryParksExecutor(oldSummary, false)).toBe(false);
  expect(continuationSummaryParksExecutor(oldSummary, true)).toBe(true);
});
