import { describe, expect, it } from "vitest";

import {
  applyLocalRunnerLiveEvent,
  createLocalRunnerLiveSnapshot,
  localRunnerSnapshotsMatch,
  replayLocalRunnerEvents,
} from "../tracer/local-runner-live.js";
import {
  localRunnerInternals,
  localRunnerTraceAsFixture,
  runLocalRunnerScenario,
  startLocalRunnerScenario,
} from "./local-runner.js";

describe.sequential("Local runner and fake harness", () => {
  it("runs lifecycle, tool, file, structured-result, and process-exit events", async () => {
    const trace = await runLocalRunnerScenario({ scenario: "happy-path", delayMs: 1 });
    const eventTypes = trace.events.map((event) => event.eventType);

    expect(eventTypes).toContain("harness.ready");
    expect(eventTypes).toContain("item.completed");
    const sessionStartedIndex = eventTypes.indexOf("session.started");
    const executingIndex = trace.events.findIndex(
      (event) =>
        event.eventType === "runtime.phase.changed" &&
        (event.payload as Record<string, unknown>).phase === "executing",
    );
    expect(executingIndex).toBeGreaterThan(sessionStartedIndex);
    expect(executingIndex).toBeLessThan(eventTypes.indexOf("turn.started"));
    expect(trace.events.some((event) => event.itemId === "item_local_runner_file")).toBe(true);
    expect(trace.result?.reportedWorkDisposition).toBe("done");
    expect(trace.harnessProcessExit).toEqual({ exitCode: 0, success: true, signal: null });
    expect(eventTypes.indexOf("run.result.proposed")).toBeLessThan(
      eventTypes.indexOf("harness.exited"),
    );
    expect(eventTypes.indexOf("harness.exited")).toBeLessThan(
      eventTypes.indexOf("run.terminal"),
    );

    const exitEvent = trace.events.find((event) => event.eventType === "harness.exited");
    const logs = (exitEvent?.payload as Record<string, unknown>).logs as {
      lines: string[];
      droppedLines: number;
      retainedBytes: number;
    };
    expect(logs.lines).toHaveLength(3);
    expect(logs.droppedLines).toBe(2);
    expect(logs.retainedBytes).toBeLessThanOrEqual(256);
    expect(() => localRunnerTraceAsFixture(trace)).not.toThrow();
  });

  it("deduplicates an equivalent turn command before driver side effects", async () => {
    const trace = await runLocalRunnerScenario({
      scenario: "happy-path",
      delayMs: 5,
      duplicateTurnCommand: true,
    });

    expect(trace.commandReceipts.filter((receipt) => receipt.status === "duplicate"))
      .toHaveLength(1);
    expect(trace.events.filter((event) => event.eventType === "turn.started")).toHaveLength(1);
    expect(trace.events.filter((event) => event.eventType === "run.result.proposed"))
      .toHaveLength(1);
  });

  it("round-trips permission and input requests before completion", async () => {
    const trace = await runLocalRunnerScenario({
      scenario: "permission-input",
      delayMs: 1,
    });

    expect(trace.requests.map((request) => request.type)).toEqual(["permission", "input"]);
    expect(trace.events.filter((event) => event.eventType === "runtime_request.created"))
      .toHaveLength(2);
    expect(trace.events.filter((event) => event.eventType === "runtime_request.resolved"))
      .toHaveLength(2);
    expect(trace.result?.summary).toContain("permission and input");
  });

  it("interrupts one turn and still emits one structured result and terminal", async () => {
    const trace = await runLocalRunnerScenario({ scenario: "interrupted", delayMs: 1 });

    expect(trace.events.filter((event) => event.eventType === "turn.interrupted"))
      .toHaveLength(1);
    expect(trace.events.filter((event) => event.eventType === "run.result.proposed"))
      .toHaveLength(1);
    expect(trace.events.filter((event) => event.eventType === "run.terminal"))
      .toHaveLength(1);
    expect(trace.harnessProcessExit?.exitCode).toBe(130);
    expect(trace.result?.reportedWorkDisposition).toBe("yielded");
  });

  it("collapses duplicate terminal messages to one terminal event", async () => {
    const trace = await runLocalRunnerScenario({
      scenario: "duplicate-terminal",
      delayMs: 1,
    });

    expect(trace.events.filter((event) => event.eventType === "run.terminal"))
      .toHaveLength(1);
    expect(
      trace.events.some(
        (event) =>
          event.eventType === "harness.diagnostic" &&
          (event.payload as Record<string, unknown>).code ===
            "duplicate_terminal_ignored",
      ),
    ).toBe(true);
    expect(
      replayLocalRunnerEvents(trace, trace.events).timeline.find(
        (event) => event.eventType === "harness.diagnostic",
      )?.summary,
    ).toBe(
      "Duplicate terminal event ignored; the first terminal event remains authoritative.",
    );
  });

  it("keeps an error process exit distinct from its semantic result", async () => {
    const trace = await runLocalRunnerScenario({ scenario: "error", delayMs: 1 });

    expect(trace.harnessProcessExit).toEqual({ exitCode: 7, success: false, signal: null });
    expect(trace.result?.summary).toContain("scripted error");
    expect(
      trace.events.find((event) => event.eventType === "run.terminal")?.payload,
    ).toMatchObject({ runTerminalState: "failed" });
  });

  it("cleans up the harness process group when the controller closes", async () => {
    const handle = await startLocalRunnerScenario({
      scenario: "happy-path",
      delayMs: 1_000,
    });

    handle.stop();
    const trace = await handle.completion;

    expect(trace.runnerProcessExit).toEqual({ code: 0, signal: null });
    expect(trace.harnessProcessExit?.success).toBe(false);
    expect(trace.events.filter((event) => event.eventType === "harness.exited"))
      .toHaveLength(1);
    expect(trace.events.filter((event) => event.eventType === "run.terminal"))
      .toHaveLength(1);
  });

  it("rejects commands after completion with an operator-safe restart message", async () => {
    const handle = await startLocalRunnerScenario({
      scenario: "happy-path",
      delayMs: 1,
    });

    await handle.completion;

    await expect(
      handle.resolveRequest("request_after_completion", { text: "too late" }),
    ).rejects.toThrow(
      "This request expired because the local run already finished. Start a new run.",
    );
  });

  it("produces the same snapshot for validated live events and replay", async () => {
    const trace = await runLocalRunnerScenario({ scenario: "happy-path", delayMs: 1 });
    let live = createLocalRunnerLiveSnapshot(trace);
    for (const event of trace.events) {
      const next = applyLocalRunnerLiveEvent(live, event);
      expect(next.ok).toBe(true);
      if (next.ok) {
        live = next.snapshot;
      }
    }
    const replay = replayLocalRunnerEvents(trace, trace.events);

    expect(localRunnerSnapshotsMatch(live, replay)).toBe(true);
  });

  it("does not forward arbitrary parent credentials to runner processes", () => {
    const environment = localRunnerInternals.runnerEnvironment();
    expect(environment.PAPERCLIP_API_KEY).toBeUndefined();
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(environment.EMAIL_AGENTMAIL_GENERAL_API_KEY).toBeUndefined();
  });
});
