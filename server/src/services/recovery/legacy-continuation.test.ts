import { describe, expect, it } from "vitest";
import { decideLegacyContinuation, legacyDispositionEpisode, type LegacyContinuationInput } from "./legacy-continuation.js";
const input: LegacyContinuationInput = {
  run: { id: "run", companyId: "company", agentId: "agent", status: "succeeded", runtimeMode: "legacy" },
  issue: { id: "issue", companyId: "company", status: "in_progress", assigneeAgentId: "agent" },
  agent: { id: "agent", companyId: "company", status: "idle" },
  episode: { id: "run", attempt: 0, maxAttempts: 2 },
  gates: { stopped: false, paused: false, budgetBlocked: false, pendingWait: false, activeExecution: false, ownedLifecycle: false, conversation: false, agentInvokable: true },
};
describe("legacy continuation authority", () => {
  it("requests agent repair for a successful process without a task disposition", () => {
    expect(decideLegacyContinuation(input)).toMatchObject({ kind: "enqueue", nextAttempt: 1 });
  });
  it.each(["done", "cancelled", "blocked", "in_review"])("respects persisted %s disposition", status => {
    expect(decideLegacyContinuation({ ...input, issue: { ...input.issue!, status } }).kind).toBe("skip");
  });
  it.each(["failed", "cancelled", "interrupted", "timed_out", "running"])("does not convert a %s process into repair", status => {
    expect(decideLegacyContinuation({ ...input, run: { ...input.run, status } }).kind).toBe("skip");
  });
  it.each(["stopped", "paused", "budgetBlocked", "pendingWait", "activeExecution", "ownedLifecycle", "conversation"] as const)("preserves %s", gate => {
    expect(decideLegacyContinuation({ ...input, gates: { ...input.gates, [gate]: true } }).kind).toBe("skip");
  });
  it.each(["paused", "terminated", "pending_approval"])("does not repair with a %s agent", status => {
    expect(decideLegacyContinuation({ ...input, agent: { ...input.agent!, status } }).kind).toBe("skip");
  });
  it("rejects foreign agent and reassigned issue", () => {
    expect(decideLegacyContinuation({ ...input, agent: { ...input.agent!, id: "other" } }).kind).toBe("skip");
    expect(decideLegacyContinuation({ ...input, issue: { ...input.issue!, assigneeAgentId: "other" } }).kind).toBe("skip");
  });
  it("preserves the episode through two attempts and exhaustion", () => {
    const first = decideLegacyContinuation(input);
    const second = decideLegacyContinuation({ ...input, episode: { ...input.episode, attempt: 1 } });
    expect(second).toMatchObject({ kind: "enqueue", nextAttempt: 2 });
    expect(second).not.toEqual(first);
    expect(decideLegacyContinuation({ ...input, episode: { ...input.episode, attempt: 2 } }).kind).toBe("exhausted");
  });
  it("does not resurrect an exhausted pre-upgrade liveness or handoff budget", () => {
    for (const run of [
      { id: "old", continuationAttempt: 2 },
      { id: "old", contextSnapshot: { dispositionRepairAttempt: 3, dispositionRepairMaxAttempts: 5, dispositionRepairFingerprint: "old-episode" } },
      { id: "old", contextSnapshot: { wakeReason: "finish_successful_run_handoff", handoffAttempt: 1 } },
      { id: "old", contextSnapshot: { source: "issue.productive_terminal_continuation_recovery" } },
    ]) expect(decideLegacyContinuation({ ...input, episode: legacyDispositionEpisode(run) }).kind).toBe("exhausted");
  });
  it("keeps replay identity stable while a genuinely new episode gets its own identity", () => {
    expect(decideLegacyContinuation(structuredClone(input))).toEqual(decideLegacyContinuation(input));
    expect(decideLegacyContinuation({ ...input, episode: { ...input.episode, id: "new-authorized-run" } })).not.toEqual(decideLegacyContinuation(input));
  });
  it("leaves native finalization to its own authority", () => {
    expect(decideLegacyContinuation({ ...input, run: { ...input.run, runtimeMode: "native" } }).kind).toBe("skip");
  });
});
