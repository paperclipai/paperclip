import { describe, expect, it } from "vitest";

import { DeterministicHarnessDriver } from "../mock-core/deterministic-harness-driver.js";
import {
  loadHarnessDriverConformanceFixture,
  runHarnessDriverConformance,
} from "./harness-driver.js";

describe("harness-driver conformance V1", () => {
  it("ships a deterministic fixture covering the complete Evals hook set", async () => {
    const fixture = await loadHarnessDriverConformanceFixture();
    expect(fixture.requiredCapabilities).toContain("dynamicTools");
    expect(fixture.unsupportedFeatures).toContain("steering");

    const report = await runHarnessDriverConformance({
      driver: new DeterministicHarnessDriver(),
      fixture,
    });
    expect(report).toMatchObject({
      schema: "paperclip-runner/harness-driver-conformance-report/v1",
      contractVersion: 1,
      eventCount: 7,
      semanticToolCallCount: 1,
      checks: {
        capabilityDescription: true,
        configValidation: true,
        sessionLifecycle: true,
        sessionRecovery: true,
        semanticTools: true,
        eventValidation: true,
        interruptAndCancel: true,
        usage: true,
        transcriptCompleteness: true,
        unsupportedFeatures: true,
      },
    });
  });

  it("settles an actively recovered turn when event consumption resumes", async () => {
    const driver = new DeterministicHarnessDriver();
    const session = await driver.openSession({
      runId: "run_active_recovery",
      normalizedSessionId: "session_active_recovery",
      workingDirectory: "/deterministic/conformance",
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "[conformance:interrupt]" },
    });
    const snapshot = await session.snapshot();
    expect(snapshot).toMatchObject({ activeTurnId: turnId, lastSourceSequence: 2 });

    const firstRecovery = await driver.recoverSession(snapshot);
    expect(firstRecovery.recovered).toBe(true);
    expect(firstRecovery.session).toBeDefined();
    const repeatedSnapshot = await firstRecovery.session!.snapshot();
    expect(repeatedSnapshot).toMatchObject({
      activeTurnId: turnId,
      lastSourceSequence: 2,
    });
    const recovery = await driver.recoverSession(repeatedSnapshot);
    expect(recovery.recovered).toBe(true);
    expect(recovery.session).toBeDefined();
    const recovered = recovery.session!;
    const recoveredEventsPromise = (async () => {
      const events = [];
      for await (const event of recovered.events()) events.push(event);
      return events;
    })();

    const events = await recoveredEventsPromise;
    expect(events.map((event) => [event.sourceSeq, event.eventType])).toEqual([
      [3, "run.result.proposed"],
      [4, "turn.interrupted"],
      [5, "run.terminal"],
    ]);
    await expect(recovered.snapshot()).resolves.toMatchObject({
      activeTurnId: null,
      semanticResult: {
        result: { reportedWorkDisposition: "yielded" },
        turnId,
      },
      lastSourceSequence: 5,
    });
    expect(events[1]?.payload).toEqual({
      reason: "deterministic_active_turn_recovered_without_live_producer",
    });
    await expect(recovered.transcript?.()).resolves.toMatchObject({
      schema: "paperclip-runner/harness-transcript/v1",
      complete: false,
      eventCount: 3,
      events: events.map((event) => expect.objectContaining({
        sourceSeq: event.sourceSeq,
        eventType: event.eventType,
      })),
      omissionReason: "pre_recovery_events_not_reconstructed",
    });
    await recovered.close({ reason: "recovered_complete" });
    await firstRecovery.session!.close({ reason: "first_recovery_complete" });
    await session.close({ reason: "original_complete", force: true });
  });

  it("interrupts a recovered turn deterministically before event consumption", async () => {
    const driver = new DeterministicHarnessDriver();
    const session = await driver.openSession({
      runId: "run_recovery_interrupt",
      normalizedSessionId: "session_recovery_interrupt",
      workingDirectory: "/deterministic/conformance",
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "[conformance:interrupt]" },
    });
    const recovery = await driver.recoverSession(await session.snapshot());
    const recovered = recovery.session!;

    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(recovered.interrupt?.({
      turnId,
      reason: "cancel_before_consumption",
    })).resolves.toBeUndefined();
    const events = [];
    for await (const event of recovered.events()) events.push(event);
    expect(events.map((event) => [event.sourceSeq, event.eventType])).toEqual([
      [3, "run.result.proposed"],
      [4, "turn.interrupted"],
      [5, "run.terminal"],
    ]);
    await expect(recovered.snapshot()).resolves.toMatchObject({
      activeTurnId: null,
      semanticResult: {
        result: { reportedWorkDisposition: "yielded" },
        turnId,
      },
      lastSourceSequence: 5,
    });

    await recovered.close({ reason: "recovered_complete" });
    await session.close({ reason: "original_complete", force: true });
  });

  it("acknowledges interruption after recovered event settlement starts", async () => {
    const driver = new DeterministicHarnessDriver();
    const session = await driver.openSession({
      runId: "run_recovery_interrupt_race",
      normalizedSessionId: "session_recovery_interrupt_race",
      workingDirectory: "/deterministic/conformance",
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "[conformance:interrupt]" },
    });
    const recovery = await driver.recoverSession(await session.snapshot());
    const recovered = recovery.session!;
    const recoveredEvents = recovered.events()[Symbol.asyncIterator]();

    const first = await recoveredEvents.next();
    expect(first.value?.eventType).toBe("run.result.proposed");
    await expect(recovered.interrupt?.({
      turnId,
      reason: "cancel_after_event_settlement_started",
    })).resolves.toBeUndefined();

    const events = first.done || first.value === undefined ? [] : [first.value];
    for await (const event of { [Symbol.asyncIterator]: () => recoveredEvents }) {
      events.push(event);
    }
    expect(events.map((event) => event.eventType)).toEqual([
      "run.result.proposed",
      "turn.interrupted",
      "run.terminal",
    ]);
    expect(events.filter((event) => event.eventType === "run.terminal")).toHaveLength(1);

    await recovered.close({ reason: "recovered_complete" });
    await session.close({ reason: "original_complete", force: true });
  });

  it("preserves a completed result when its terminal checkpoint lagged", async () => {
    const driver = new DeterministicHarnessDriver();
    const session = await driver.openSession({
      runId: "run_result_first_recovery",
      normalizedSessionId: "session_result_first_recovery",
      workingDirectory: "/deterministic/conformance",
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Complete deterministically." },
    });
    const completedSnapshot = await session.snapshot();
    const recovery = await driver.recoverSession({
      ...completedSnapshot,
      activeTurnId: turnId,
      terminalTurns: [],
    });
    const recovered = recovery.session!;
    const events = [];
    for await (const event of recovered.events()) events.push(event);

    expect(events.map((event) => event.eventType)).toEqual([
      "run.result.proposed",
      "turn.completed",
      "run.terminal",
    ]);
    expect(events[0]?.payload).toMatchObject({ reportedWorkDisposition: "done" });
    expect(events[2]?.payload).toMatchObject({ runTerminalState: "succeeded" });
    await expect(recovered.snapshot()).resolves.toMatchObject({
      activeTurnId: null,
      semanticResult: completedSnapshot.semanticResult,
    });
    await recovered.close({ reason: "recovered_complete" });
    await session.close({ reason: "original_complete" });
  });

  it("does not let an interrupt overwrite a completed result-first recovery", async () => {
    const driver = new DeterministicHarnessDriver();
    const session = await driver.openSession({
      runId: "run_result_first_interrupt",
      normalizedSessionId: "session_result_first_interrupt",
      workingDirectory: "/deterministic/conformance",
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Complete deterministically." },
    });
    const completedSnapshot = await session.snapshot();
    const recovery = await driver.recoverSession({
      ...completedSnapshot,
      activeTurnId: turnId,
      terminalTurns: [],
    });
    const recovered = recovery.session!;

    await expect(recovered.interrupt?.({
      turnId,
      reason: "late cancellation",
    })).resolves.toBeUndefined();
    const events = [];
    for await (const event of recovered.events()) events.push(event);
    expect(events.map((event) => event.eventType)).toEqual([
      "run.result.proposed",
      "turn.completed",
      "run.terminal",
    ]);
    await expect(recovered.snapshot()).resolves.toMatchObject({
      activeTurnId: null,
      semanticResult: completedSnapshot.semanticResult,
    });
    await recovered.close({ reason: "recovered_complete" });
    await session.close({ reason: "original_complete" });
  });

  it("preserves an interrupted result when its terminal checkpoint lagged", async () => {
    const driver = new DeterministicHarnessDriver();
    const session = await driver.openSession({
      runId: "run_yielded_result_first_recovery",
      normalizedSessionId: "session_yielded_result_first_recovery",
      workingDirectory: "/deterministic/conformance",
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "[conformance:interrupt]" },
    });
    await session.interrupt?.({ turnId, reason: "checkpoint_after_result" });
    const interruptedSnapshot = await session.snapshot();
    const recovery = await driver.recoverSession({
      ...interruptedSnapshot,
      activeTurnId: turnId,
      terminalTurns: [],
    });
    const recovered = recovery.session!;
    const events = [];
    for await (const event of recovered.events()) events.push(event);

    expect(events.map((event) => event.eventType)).toEqual([
      "run.result.proposed",
      "turn.interrupted",
      "run.terminal",
    ]);
    expect(events[0]?.payload).toMatchObject({
      reportedWorkDisposition: "yielded",
      continuation: { kind: "same_agent" },
    });
    expect(events[2]?.payload).toMatchObject({
      turnTerminalState: "interrupted",
      runTerminalState: "cancelled",
      reportedWorkDisposition: "yielded",
    });
    await recovered.close({ reason: "recovered_complete" });
    await session.close({ reason: "original_complete" });
  });
});
