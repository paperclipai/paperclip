import { isSettledRemoteWarmControlState } from "./remote-warm-session-recovery.js";
import { expect, it, vi } from "vitest";
import { canAdoptAttachedParkedRunner, isCompletedParkedSourceRecovery, retireBoundParkedRunner } from "./hosted-parked-runner.js";

const identity = { runnerInstanceId: "runner", environmentLeaseId: "logical-lease", runId: "completed-run",
  normalizedSessionId: "session", turnId: "turn", itemId: "item" };
const parkedClaim = { parkId: "park", claimId: "next-run" };
const control = { identity, commands: [], committedEvents: [{ eventType: "run.terminal", envelope: identity }] };
const resumeCheckpoint = { schema: "paperclip.runner.cold-checkpoint.v1" as const, sourceId: "source",
  sha256: `sha256:${"a".repeat(64)}`, runnerStateSha256: `sha256:${"b".repeat(64)}`, identity, providerSessionId: "thread" };
it.each(["bound", "unbound", "staged", "target-started", "transition", "outbox", "wrong-claim", "stop-uncertain", "source-drift", "retiring"])(
  "retires an undelivered claim only before successor work: %s", async mode => {
    const order: string[] = [];
    let stopping = false;
    let stopPolls = 0;
    const task = vi.fn(async (operation: any) => {
      order.push(operation.kind);
      if (operation.kind === "status") {
        if (stopping) stopPolls++;
        const retiring = stopping && mode === "retiring" && stopPolls === 1;
        return { kind: "status", taskId: "task", phase: "running", executionStopped: stopping && mode !== "stop-uncertain" && !retiring,
          retention: retiring ? { state: "retiring", parkId: parkedClaim.parkId } : { state: "claiming", ...parkedClaim,
            ...(mode === "wrong-claim" ? { claimId: "foreign" } : {}), ...(mode === "unbound" ? {} : { bootstrapBound: true }) } };
      }
      if (operation.kind === "read_state") return { kind: "state", taskId: "task", state: {
        schema: "paperclip.runner.durable.state.v1", ...identity, lifecycle: "ready", outbox: mode === "outbox" ? [{}] : [],
        ...(mode === "target-started" ? { runId: "next-run" } : {}), ...(mode === "transition" ? { warmTransition: {} } : {}),
      } };
      if (operation.kind === "stop") {
        expect(operation.ifParkedClaim).toEqual({ ...parkedClaim, resumeCheckpoint });
        if (mode === "source-drift") throw new Error("conditional source refused before any signal");
        stopping = true;
      }
      return operation.kind === "describe" ? { kind: "description", taskId: "replacement", runner: { version: "fixture", digest: `sha256:${"a".repeat(64)}` } }
        : { kind: "accepted", taskId: "task" };
    });
    const authorize = vi.fn(async () => { order.push("fence"); });
    const retired = retireBoundParkedRunner({ task, identity, resumeCheckpoint, targetRunId: "next-run", parkedClaim,
      control: { ...control, ...(mode === "staged" ? { stagedRunAttachment: {} } : {}) }, authorize });
    if (["wrong-claim", "stop-uncertain"].includes(mode)) await expect(retired).rejects.toThrow("ownership_unverified");
    else if (mode === "source-drift") await expect(retired).rejects.toThrow("refused before any signal");
    else await expect(retired).resolves.toBe(mode === "bound" || mode === "retiring");
    if (mode === "bound") {
      expect(order).toEqual(["status", "read_state", "fence", "stop", "status", "complete", "describe"]);
      expect(task).toHaveBeenCalledWith({ kind: "stop", ifParkedClaim: { ...parkedClaim, resumeCheckpoint } });
    }
    else if (mode === "retiring") expect(order).toEqual(["status", "read_state", "fence", "stop", "status", "status", "complete", "describe"]);
    else if (mode === "stop-uncertain") expect(order).toEqual(["status", "read_state", "fence", "stop", "status"]);
    else if (mode === "source-drift") { expect(order).toEqual(["status", "read_state", "fence", "stop"]); expect(stopping).toBe(false); }
    else { expect(order).not.toContain("stop"); expect(authorize).not.toHaveBeenCalled(); }
  },
);


it.each(["source-only", "current-checkpoint", "target-identity", "queued-attachment", "warm-transition", "pending-command", "new-work", "foreign-claim", "missing-identity"])(
  "reconstructs an interrupted between-turn claim without replaying target work: %s", mode => {
    const source = { ...identity, ...(mode === "target-identity" ? { runId: "next-run" } : {}) };
    const saved = { ...control, identity: source,
      ...(mode === "queued-attachment" ? { stagedRunAttachment: {} } : {}),
      ...(mode === "warm-transition" ? { warmTransition: {} } : {}),
      ...(mode === "pending-command" ? { commands: [{ status: "pending" }] } : {}),
      ...(mode === "new-work" ? { committedEvents: [...control.committedEvents, { eventType: "turn.started", envelope: source }] } : {}) };
    expect(isCompletedParkedSourceRecovery({ currentRunId: "next-run", claimId: mode === "foreign-claim" ? "other" : "next-run",
      hasCurrentCheckpoint: mode === "current-checkpoint", identity: mode === "missing-identity" ? {} : source, control: saved })).toBe(mode === "source-only");
  },
);


it.each(["tool.execution.completed", "semantic_tool.result", "usage.updated", "session.goal.snapshot", "provider.notice.recorded"])(
  "retains historical post-terminal state for adoption instead of rolling it back: %s", async type => {
    const inert = type === "session.goal.snapshot" || type === "provider.notice.recorded";
    const payload = type === "session.goal.snapshot" ? { schema: "paperclip.session_goal.snapshot.v1", goal: null, workingNow: false }
      : type === "provider.notice.recorded" ? { schema: "paperclip.provider.notice.v1", recoverable: true, severity: "info" }
      : { completed: true };
    const event = { eventType: type, envelope: { ...identity, payload: { schema: "paperclip.prp.event.v1", eventType: type,
      sourceInstanceId: identity.runnerInstanceId, sourceKind: "runner", runId: identity.runId,
      normalizedSessionId: identity.normalizedSessionId, payload } } };
    const source = { ...control, committedEvents: [...control.committedEvents, event] };
    expect(isSettledRemoteWarmControlState(source, identity)).toBe(true);
    expect(isCompletedParkedSourceRecovery({ currentRunId: "next-run", claimId: "next-run", hasCurrentCheckpoint: false,
      identity, control: source })).toBe(inert);
    let stopped = false;
    const task = vi.fn(async (operation: any) => {
      if (operation.kind === "status") return { kind: "status", taskId: "task", phase: "running", executionStopped: stopped,
        retention: { state: "claiming", ...parkedClaim, bootstrapBound: true } };
      if (operation.kind === "read_state") return { kind: "state", taskId: "task", state: {
        schema: "paperclip.runner.durable.state.v1", ...identity, lifecycle: "ready", outbox: [] } };
      if (operation.kind === "stop") stopped = true;
      return { kind: "accepted", taskId: "task" };
    });
    const authorize = vi.fn(async () => {});
    await expect(retireBoundParkedRunner({ task, identity, resumeCheckpoint, targetRunId: "next-run", parkedClaim, control: source, authorize })).resolves.toBe(inert);
    expect(stopped).toBe(inert);
    if (!inert) { expect(authorize).not.toHaveBeenCalled(); expect(task).toHaveBeenCalledExactlyOnceWith({ kind: "status" }); }
  },
);


it.each(["attached", "running-turn", "source-authority", "foreign-claim", "foreign-lease", "foreign-session", "retiring", "stopped"])(
  "uses recorded target authority for non-destructive adoption: %s", async mode => {
    const target = { ...identity, runId: "next-run", turnId: "next-turn", itemId: "next-item" };
    const task = vi.fn(async (operation: any) => operation.kind === "status"
      ? { kind: "status", taskId: "task", phase: "running", executionStopped: mode === "stopped",
          ...(mode === "retiring" ? { retention: { state: "retiring", parkId: "park" } } : {}) }
      : { kind: "state", taskId: "task", state: { schema: "paperclip.runner.durable.state.v1", lifecycle: "ready", ...target,
          ...(mode === "foreign-lease" ? { environmentLeaseId: "foreign" } : {}),
          ...(mode === "foreign-session" ? { normalizedSessionId: "foreign" } : {}),
          ...(mode === "running-turn" ? { activeTurnId: "in-progress-provider-turn" } : {}) } });
    await expect(canAdoptAttachedParkedRunner({ task, identity: mode === "source-authority" ? identity : target,
      targetRunId: "next-run", parkedClaim: { parkId: "park", claimId: mode === "foreign-claim" ? "foreign-run" : "next-run" } }))
      .resolves.toBe(mode === "attached" || mode === "running-turn");
    expect(task.mock.calls.every(([operation]) => ["status", "read_state"].includes(operation.kind))).toBe(true);
  },
);
