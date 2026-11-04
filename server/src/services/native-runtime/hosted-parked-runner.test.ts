import { expect, it, vi } from "vitest";
import { isCompletedParkedSourceRecovery, retireBoundParkedRunner } from "./hosted-parked-runner.js";

const identity = { runnerInstanceId: "runner", environmentLeaseId: "logical-lease", runId: "completed-run",
  normalizedSessionId: "session", turnId: "turn", itemId: "item" };
const parkedClaim = { parkId: "park", claimId: "next-run" };
const control = { identity, commands: [], committedEvents: [{ eventType: "run.terminal", envelope: identity }] };
it.each(["bound", "unbound", "staged", "target-started", "transition", "outbox", "wrong-claim", "stop-uncertain"])(
  "retires an undelivered claim only before successor work: %s", async mode => {
    const order: string[] = [];
    let stopping = false;
    const task = vi.fn(async (operation: any) => {
      order.push(operation.kind);
      if (operation.kind === "status") return { kind: "status", taskId: "task", phase: "running",
        executionStopped: stopping && mode !== "stop-uncertain", retention: { state: "claiming", ...parkedClaim,
          ...(mode === "wrong-claim" ? { claimId: "foreign" } : {}), ...(mode === "unbound" ? {} : { bootstrapBound: true }) } };
      if (operation.kind === "read_state") return { kind: "state", taskId: "task", state: {
        schema: "paperclip.runner.durable.state.v1", ...identity, lifecycle: "ready", outbox: mode === "outbox" ? [{}] : [],
        ...(mode === "target-started" ? { runId: "next-run" } : {}), ...(mode === "transition" ? { warmTransition: {} } : {}),
      } };
      if (operation.kind === "stop") stopping = true;
      return operation.kind === "describe" ? { kind: "description", taskId: "replacement", runner: { version: "fixture", digest: `sha256:${"a".repeat(64)}` } }
        : { kind: "accepted", taskId: "task" };
    });
    const authorize = vi.fn(async () => { order.push("fence"); });
    const retired = retireBoundParkedRunner({ task, identity, targetRunId: "next-run", parkedClaim,
      control: { ...control, ...(mode === "staged" ? { stagedRunAttachment: {} } : {}) }, authorize });
    if (["wrong-claim", "stop-uncertain"].includes(mode)) await expect(retired).rejects.toThrow("ownership_unverified");
    else await expect(retired).resolves.toBe(mode === "bound");
    if (mode === "bound") expect(order).toEqual(["status", "read_state", "fence", "stop", "status", "complete", "describe"]);
    else if (mode === "stop-uncertain") expect(order).toEqual(["status", "read_state", "fence", "stop", "status"]);
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
