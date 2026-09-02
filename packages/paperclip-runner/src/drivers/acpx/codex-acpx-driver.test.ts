import { describe, expect, it, vi } from "vitest";

import type { AcpRuntimeEvent } from "acpx/runtime";

import {
  PRP_BLOCK_TOOL_NAME,
  PRP_COMPLETION_TOOL_NAME,
} from "../../contracts/completion-result.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";
import { validatePrpEvent } from "../../protocol/replay-contract.js";
import {
  CodexAcpxDriver,
  type CodexAcpxDriverDependencies,
  type CodexAcpxDriverOptions,
} from "./codex-acpx-driver.js";
import type {
  AcpxRuntimeTurnInput,
  AcpxRuntimeTurn,
  OpenAcpxRuntimeHostOptions,
} from "./runtime-host.js";
import type { AcpxRecoveryWorkspaceLease } from "./runtime-sandbox.js";

describe("Codex ACPX harness driver", () => {
  it("rejects a pre-aborted open before starting host admission", async () => {
    const fixture = driverFixture();
    const controller = new AbortController();
    const cancellation = new Error("session open cancelled");
    controller.abort(cancellation);

    await expect(
      fixture.driver.openSession({
        runId: "run-pre-abort",
        normalizedSessionId: "session-1",
        workingDirectory: "/workspace",
        signal: controller.signal,
      }),
    ).rejects.toBe(cancellation);

    expect(fixture.openHost).not.toHaveBeenCalled();
  });

  it("forwards the exact open signal to host admission", async () => {
    const fixture = driverFixture();
    const controller = new AbortController();
    const session = await fixture.driver.openSession({
      runId: "run-open-signal",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
      signal: controller.signal,
    });

    expect(fixture.hostOptions?.signal).toBe(controller.signal);
    await session.close({ reason: "signal forwarding verified" });
  });

  it("closes and quarantines a host that resolves after open is aborted", async () => {
    const hostAdmission = deferred<ReturnType<typeof fakeHost>>();
    const fixture = driverFixture(
      {},
      {
        openHost: () => hostAdmission.promise,
        closeSettlementTimeoutMs: 5,
      },
    );
    fixture.host.close.mockRejectedValueOnce(
      new Error("late host close failed once"),
    );
    const controller = new AbortController();
    const cancellation = new Error("host admission cancelled");
    const opening = fixture.driver.openSession({
      runId: "run-late-host",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(fixture.openHost).toHaveBeenCalledOnce());

    controller.abort(cancellation);
    await expect(opening).rejects.toBe(cancellation);
    hostAdmission.resolve(fixture.host);

    await vi.waitFor(() => expect(fixture.host.close).toHaveBeenCalledTimes(2));
    expect(fixture.host.close).toHaveBeenNthCalledWith(1, {
      reason: "Codex ACPX host resolved after admission was aborted",
    });
    expect(fixture.host.close).toHaveBeenNthCalledWith(2, {
      reason: expect.stringContaining("quarantined cleanup recovery"),
    });
  });

  it("quarantines failed cleanup after session construction fails", async () => {
    const quarantineRecovery = deferred<void>();
    const fixture = driverFixture({}, { closeSettlementTimeoutMs: 1 });
    const identity = fixture.host.identity();
    fixture.host.identity = vi
      .fn()
      .mockReturnValueOnce({
        ...identity,
        normalizedSessionId: "different-session",
      })
      .mockReturnValue(identity);
    fixture.host.close
      .mockRejectedValueOnce(new Error("initial cleanup failed"))
      .mockImplementationOnce(() => quarantineRecovery.promise)
      .mockResolvedValue(undefined);

    await expect(
      fixture.driver.openSession({
        runId: "run-construction-failure",
        normalizedSessionId: "session-1",
        workingDirectory: "/workspace",
      }),
    ).rejects.toThrow("Codex ACPX host returned a different session identity");
    await vi.waitFor(() => expect(fixture.host.close).toHaveBeenCalledTimes(2));

    const nextAdmission = fixture.driver.openSession({
      runId: "run-after-construction-failure",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    await Promise.resolve();
    expect(fixture.openHost).toHaveBeenCalledOnce();

    quarantineRecovery.resolve();
    const session = await nextAdmission;
    expect(fixture.openHost).toHaveBeenCalledTimes(2);
    expect(fixture.host.close).toHaveBeenNthCalledWith(2, {
      reason: expect.stringContaining("quarantined cleanup recovery"),
    });
    await session.close({ reason: "construction cleanup recovered" });
  });

  it("binds validation to the configured qualified agent", async () => {
    const fixture = driverFixture();
    const descriptor = await fixture.driver.descriptor();

    expect(descriptor).toMatchObject({
      kind: "acpx_runtime",
      displayName: "Codex via ACPX",
      capabilities: {
        resume: true,
        interruption: true,
        dynamicTools: true,
        runtimeRequestResolution: true,
        runtimeRequestHandoff: true,
      },
      runtimeContextCapabilities: {
        instructions: "native",
        skills: "unsupported",
        mcp: "native",
      },
    });
    await expect(
      fixture.driver.validateConfig({
        agent: "claude",
        model: "claude-sonnet-5",
        permissionMode: "approve-reads",
      }),
    ).resolves.toMatchObject({
      ok: false,
      issues: [{ code: "unsupported_agent" }],
    });
  });

  it("opens the qualified Claude profile through the shared driver", async () => {
    const fixture = driverFixture({
      agent: "claude",
      model: "claude-sonnet-5",
    });

    await expect(fixture.driver.descriptor()).resolves.toMatchObject({
      displayName: "Claude via ACPX",
    });
    await expect(
      fixture.driver.validateConfig({
        agent: "claude",
        model: "claude-sonnet-5",
        permissionMode: "approve-reads",
      }),
    ).resolves.toMatchObject({ ok: true });

    const session = await fixture.driver.openSession({
      runId: "run-claude",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    expect(fixture.hostOptions).toMatchObject({
      agent: "claude",
      model: "claude-sonnet-5",
    });
    expect(
      fixture.hostOptions?.managedCodexCredentialSourcePath,
    ).toBeUndefined();
    await session.close({ reason: "qualified Claude driver verified" });
  });

  it("maps one turn, dispatches tools, and commits one semantic result", async () => {
    const dynamicToolHandler = vi.fn(async () => ({ title: "Document" }));
    const fixture = driverFixture({ dynamicToolHandler });
    const session = await fixture.driver.openSession({
      runId: "run-1",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const terminalEvents = collectUntil(session.events(), "turn.completed");

    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Complete the task." },
    });
    const bridgeHandler = fixture.hostOptions!.semanticTools!.handler;
    await expect(
      bridgeHandler({
        tool: "documents.read",
        callId: "tool-1",
        arguments: { id: "doc-1" },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ title: "Document" });
    expect(dynamicToolHandler).toHaveBeenCalledWith({
      tool: "documents.read",
      callId: "tool-1",
      providerSessionId: "agent-1",
      turnId,
      arguments: { id: "doc-1" },
      signal: expect.any(AbortSignal),
    });

    await expect(
      bridgeHandler({
        tool: PRP_COMPLETION_TOOL_NAME,
        callId: "finish-1",
        arguments: completedResult(),
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ accepted: true });
    fixture.finishTurn({ status: "completed", stopReason: "end_turn" });

    const events = await terminalEvents;
    expect(events.every((event) => validatePrpEvent(event).ok)).toBe(true);
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "turn.submitted",
        "turn.accepted",
        "turn.started",
        "item.delta",
        "tool.execution.started",
        "run.result.proposed",
        "item.completed",
        "turn.completed",
      ]),
    );
    expect(
      events.findIndex((event) => event.eventType === "run.result.proposed"),
    ).toBeLessThan(
      events.findIndex((event) => event.eventType === "turn.completed"),
    );
    await expect(session.snapshot()).resolves.toMatchObject({
      driverKind: "acpx_runtime",
      activeTurnId: null,
      providerIdentity: {
        kind: "acpx",
        agentSessionId: "agent-1",
      },
      semanticResult: {
        callId: "finish-1",
        turnId,
        result: { reportedWorkDisposition: "done" },
      },
    });
    await session.close({ reason: "complete" });
    await session.close({ reason: "idempotent close" });
    expect(fixture.host.close).toHaveBeenCalledOnce();
  });

  it("rejects terminal disposition drift and bounds interruption", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-2",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Complete the task." },
    });
    const bridgeHandler = fixture.hostOptions!.semanticTools!.handler;

    await expect(
      bridgeHandler({
        tool: PRP_BLOCK_TOOL_NAME,
        callId: "block-1",
        arguments: completedResult(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("does not match");
    await session.interrupt({ turnId, reason: "user cancelled" });
    expect(fixture.host.interruptActiveTurn).toHaveBeenCalledWith(
      "user cancelled",
    );
    await expect(session.interrupt({ turnId: "stale-turn" })).rejects.toThrow(
      "is not the active turn",
    );
    await session.close({ reason: "cancelled" });
  });

  it("emits an interrupted terminal before closing an active stream", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-close",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const terminalEvents = collectUntil(session.events(), "turn.interrupted");
    await session.startTurn({
      message: { role: "user", text: "Complete the task." },
    });

    await Promise.all([
      session.close({ reason: "operator shutdown" }),
      session.close({ reason: "duplicate shutdown" }),
    ]);

    await expect(terminalEvents).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "turn.interrupted" }),
      ]),
    );
    await expect(session.snapshot()).resolves.toMatchObject({
      activeTurnId: null,
      terminalTurns: [expect.objectContaining({ turnId: expect.any(String) })],
    });
    expect(fixture.host.close).toHaveBeenCalledOnce();
  });

  it("classifies a pump rejection during close as interrupted", async () => {
    const runtimeEventFailure = deferred<never>();
    const fixture = driverFixture(
      {},
      { runtimeEventFailure: runtimeEventFailure.promise },
    );
    const session = await fixture.driver.openSession({
      runId: "run-close-pump-failure",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const terminalEvents = collectUntil(session.events(), "turn.interrupted");
    await session.startTurn({
      message: { role: "user", text: "Complete the task." },
    });

    const closing = session.close({ reason: "operator shutdown" });
    runtimeEventFailure.reject(
      new Error("provider stream closed during shutdown"),
    );
    await expect(closing).resolves.toBeUndefined();

    const emitted = await terminalEvents;
    expect(
      emitted.filter((event) => event.eventType === "turn.interrupted"),
    ).toHaveLength(1);
    expect(emitted.some((event) => event.eventType === "turn.failed")).toBe(
      false,
    );
  });

  it("reports a host close timeout while retaining the exact cleanup", async () => {
    const fixture = driverFixture({}, { closeSettlementTimeoutMs: 1 });
    const hostClose = deferred<void>();
    fixture.host.close.mockImplementation(() => hostClose.promise);
    const session = await fixture.driver.openSession({
      runId: "run-close-timeout",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const terminalEvents = collectUntil(session.events(), "turn.interrupted");
    await session.startTurn({
      message: { role: "user", text: "Complete the task." },
    });

    await expect(
      session.close({ reason: "runtime close stalled" }),
    ).rejects.toThrow("host cleanup exceeded its shutdown timeout");
    expect(fixture.host.close).toHaveBeenCalledOnce();
    await expect(terminalEvents).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "turn.interrupted" }),
      ]),
    );
    await expect(session.snapshot()).resolves.toMatchObject({
      activeTurnId: null,
      terminalTurns: [expect.objectContaining({ turnId: expect.any(String) })],
    });

    fixture.finishTurn({ status: "cancelled", stopReason: "session_closed" });
    hostClose.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(fixture.host.close).toHaveBeenCalledOnce();
  });

  it("reconciles the retained close when it settles after the wait bound", async () => {
    const fixture = driverFixture({}, { closeSettlementTimeoutMs: 1 });
    const retainedClose = deferred<void>();
    fixture.host.close.mockImplementation(() => retainedClose.promise);
    const session = await fixture.driver.openSession({
      runId: "run-close-recovery",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });

    await expect(
      session.close({ reason: "runtime close stalled" }),
    ).rejects.toThrow("host cleanup exceeded its shutdown timeout");
    retainedClose.resolve();
    await expect(
      session.close({ reason: "observe retained completion" }),
    ).resolves.toBeUndefined();
    expect(fixture.host.close).toHaveBeenCalledOnce();
  });

  it("does not spin while the exact host cleanup remains pending", async () => {
    const fixture = driverFixture({}, { closeSettlementTimeoutMs: 1 });
    const stalledClose = deferred<void>();
    fixture.host.close.mockImplementation(() => stalledClose.promise);
    const session = await fixture.driver.openSession({
      runId: "run-close-stalled-recovery",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });

    await expect(
      session.close({ reason: "runtime close never settles" }),
    ).rejects.toThrow("host cleanup exceeded its shutdown timeout");
    expect(fixture.host.close).toHaveBeenCalledOnce();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(fixture.host.close).toHaveBeenCalledOnce();
  });

  it("blocks admission while the first retained host close is still pending", async () => {
    vi.useFakeTimers();
    try {
      const fixture = driverFixture({}, { closeSettlementTimeoutMs: 1 });
      const stalledClose = deferred<void>();
      fixture.host.close.mockImplementation(() => stalledClose.promise);
      const session = await fixture.driver.openSession({
        runId: "run-close-pending-admission",
        normalizedSessionId: "session-1",
        workingDirectory: "/workspace",
      });

      const closing = expect(
        session.close({ reason: "runtime close remains pending" }),
      ).rejects.toThrow("host cleanup exceeded its shutdown timeout");
      await vi.advanceTimersByTimeAsync(1);
      await closing;
      const admission = fixture.driver.openSession({
        runId: "run-before-pending-close-settles",
        normalizedSessionId: "session-1",
        workingDirectory: "/workspace",
      });
      const blocked = expect(admission).rejects.toThrow(
        "exceeded the admission grace",
      );
      // Drive the implementation's complete admission grace instead of
      // duplicating its derived shutdown bound in this test. Later transport
      // layers may add another bounded cleanup phase without weakening the
      // invariant exercised here: no replacement host opens while the exact
      // retained close is still pending.
      await vi.runAllTimersAsync();
      await blocked;
      expect(fixture.openHost).toHaveBeenCalledOnce();
      stalledClose.resolve();
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains autonomous host cleanup recovery through repeated failure", async () => {
    const fixture = driverFixture(
      {},
      {
        closeSettlementTimeoutMs: 1,
      },
    );
    fixture.host.close
      .mockRejectedValueOnce(new Error("transient cleanup failure"))
      .mockRejectedValueOnce(new Error("second cleanup failure"))
      .mockResolvedValueOnce(undefined);
    const session = await fixture.driver.openSession({
      runId: "run-close-permanent-failure",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const diagnosticEvents = collectUntil(
      session.events(),
      "harness.diagnostic",
    );

    await expect(
      session.close({ reason: "runtime close initially failed" }),
    ).rejects.toThrow("transient cleanup failure");
    await expect(diagnosticEvents).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "harness.diagnostic",
          payload: expect.objectContaining({
            code: "acpx_host_cleanup_deferred",
          }),
        }),
      ]),
    );
    await vi.waitFor(() => expect(fixture.host.close).toHaveBeenCalledTimes(3));
    expect(fixture.host.close).toHaveBeenLastCalledWith({
      reason: "runtime close initially failed (automatic cleanup recovery 2)",
    });
    await expect(
      session.close({ reason: "observe recovered cleanup" }),
    ).resolves.toBeUndefined();
    expect(fixture.host.close).toHaveBeenCalledTimes(3);
  });

  it("keeps quarantined cleanup scheduled and lets admission await its exact owner", async () => {
    vi.useFakeTimers();
    try {
      const fixture = driverFixture({}, { closeSettlementTimeoutMs: 1 });
      fixture.host.close.mockRejectedValue(
        new Error("persistent cleanup failure"),
      );
      const session = await fixture.driver.openSession({
        runId: "run-close-retry-bound",
        normalizedSessionId: "session-1",
        workingDirectory: "/workspace",
      });

      const closing = expect(
        session.close({ reason: "runtime close persistently failed" }),
      ).rejects.toThrow("persistent cleanup failure");
      await vi.advanceTimersByTimeAsync(1);
      await closing;
      await vi.advanceTimersByTimeAsync(10);
      expect(fixture.host.close).toHaveBeenCalledTimes(7);
      await vi.advanceTimersByTimeAsync(59_000);
      expect(fixture.host.close).toHaveBeenCalledTimes(7);

      fixture.host.close.mockImplementation(({ reason }) =>
        reason.includes("scheduled quarantined cleanup recovery")
          ? // Exercise the complete production host bound: active-turn
            // cancellation plus bounded protocol, TERM, and guardian-group KILL.
            new Promise<void>((resolve) => setTimeout(resolve, 9_500))
          : Promise.resolve(),
      );
      await vi.advanceTimersToNextTimerAsync();
      let admissionSettled = false;
      const admission = fixture.driver.openSession({
        runId: "run-after-recovery",
        normalizedSessionId: "session-1",
        workingDirectory: "/workspace",
      });
      void admission.then(
        () => {
          admissionSettled = true;
        },
        () => {
          admissionSettled = true;
        },
      );
      expect(fixture.host.close).toHaveBeenCalledTimes(8);
      expect(fixture.host.close).toHaveBeenLastCalledWith({
        reason:
          "runtime close persistently failed (scheduled quarantined cleanup recovery)",
      });
      await vi.advanceTimersByTimeAsync(9_499);
      expect(admissionSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(admission).resolves.toBeDefined();
      expect(fixture.host.close).toHaveBeenCalledTimes(8);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs a full admission batch after an inherited scheduled attempt fails", async () => {
    vi.useFakeTimers();
    try {
      const fixture = driverFixture({}, { closeSettlementTimeoutMs: 1 });
      fixture.host.close.mockRejectedValue(
        new Error("persistent cleanup failure"),
      );
      const session = await fixture.driver.openSession({
        runId: "run-scheduled-owner-failure",
        normalizedSessionId: "session-1",
        workingDirectory: "/workspace",
      });

      const closing = expect(
        session.close({ reason: "exhaust cleanup before scheduled recovery" }),
      ).rejects.toThrow("persistent cleanup failure");
      await vi.advanceTimersByTimeAsync(1);
      await closing;
      await vi.advanceTimersByTimeAsync(10);

      let scheduledAttempt = 0;
      let admissionAttempt = 0;
      fixture.host.close.mockImplementation(({ reason }) => {
        if (reason.includes("scheduled quarantined cleanup recovery")) {
          scheduledAttempt += 1;
          return new Promise<void>((_resolve, reject) => {
            setTimeout(
              () => reject(new Error("scheduled cleanup failed")),
              8_000,
            );
          });
        }
        if (reason.includes("quarantined cleanup admission recovery")) {
          admissionAttempt += 1;
          const attempt = admissionAttempt;
          return new Promise<void>((resolve, reject) => {
            setTimeout(() => {
              if (attempt < 3) reject(new Error("admission cleanup failed"));
              else resolve();
            }, 8_000);
          });
        }
        return Promise.reject(new Error("unexpected cleanup reason"));
      });

      await vi.advanceTimersToNextTimerAsync();
      const admission = fixture.driver.openSession({
        runId: "run-after-scheduled-owner-failure",
        normalizedSessionId: "session-1",
        workingDirectory: "/workspace",
      });
      let admissionSettled = false;
      void admission
        .finally(() => {
          admissionSettled = true;
        })
        .catch(() => undefined);
      // The inherited attempt plus the replacement three-attempt batch takes
      // just over 32 seconds with this fixture. The production grace must cover
      // that complete bounded owner chain rather than expiring at 27 seconds.
      await vi.advanceTimersByTimeAsync(32_001);
      expect(admissionSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const admitted = await admission;

      expect(scheduledAttempt).toBe(1);
      expect(admissionAttempt).toBe(3);
      expect(fixture.openHost).toHaveBeenCalledTimes(2);
      fixture.host.close.mockResolvedValue(undefined);
      await admitted.close({
        reason: "complete after scheduled owner recovery",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets admission observe a complete bounded multi-attempt recovery", async () => {
    vi.useFakeTimers();
    try {
      const fixture = driverFixture({}, { closeSettlementTimeoutMs: 1 });
      let quarantineAttempt = 0;
      fixture.host.close.mockImplementation(({ reason }) => {
        if (!reason.includes("quarantined cleanup recovery")) {
          return Promise.reject(new Error("persistent cleanup failure"));
        }
        quarantineAttempt += 1;
        const attempt = quarantineAttempt;
        return new Promise<void>((resolve, reject) => {
          setTimeout(() => {
            if (attempt < 3) reject(new Error("transient quarantine failure"));
            else resolve();
          }, 9_000);
        });
      });
      const session = await fixture.driver.openSession({
        runId: "run-multi-attempt-recovery",
        normalizedSessionId: "session-1",
        workingDirectory: "/workspace",
      });

      const closing = expect(
        session.close({ reason: "runtime close persistently failed" }),
      ).rejects.toThrow("persistent cleanup failure");
      await vi.advanceTimersByTimeAsync(1);
      await closing;
      await vi.advanceTimersByTimeAsync(4);
      expect(fixture.host.close).toHaveBeenCalledTimes(5);

      let admissionSettled = false;
      const admission = fixture.driver.openSession({
        runId: "run-after-multi-attempt-recovery",
        normalizedSessionId: "session-1",
        workingDirectory: "/workspace",
      });
      void admission.then(
        () => {
          admissionSettled = true;
        },
        () => {
          admissionSettled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(26_000);
      expect(admissionSettled).toBe(false);
      expect(fixture.host.close).toHaveBeenCalledTimes(7);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(admission).resolves.toBeDefined();
      expect(quarantineAttempt).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("awaits quarantine recovery installed by an exhausted retained owner", async () => {
    vi.useFakeTimers();
    try {
      const fixture = driverFixture({}, { closeSettlementTimeoutMs: 1 });
      fixture.host.close.mockImplementation(({ reason }) => {
        if (reason.includes("quarantined cleanup recovery")) {
          return new Promise<void>((resolve) => setTimeout(resolve, 2));
        }
        return Promise.reject(new Error("bounded host recovery failed"));
      });
      const session = await fixture.driver.openSession({
        runId: "run-replacement-cleanup-owner",
        normalizedSessionId: "session-1",
        workingDirectory: "/workspace",
      });
      const closing = expect(
        session.close({ reason: "host cleanup must be replaced" }),
      ).rejects.toThrow("bounded host recovery failed");
      await vi.advanceTimersByTimeAsync(1);
      await closing;

      const admission = fixture.driver.openSession({
        runId: "run-after-replacement-cleanup",
        normalizedSessionId: "session-1",
        workingDirectory: "/workspace",
      });
      await vi.advanceTimersByTimeAsync(10);
      const admitted = await admission;
      expect(fixture.openHost).toHaveBeenCalledTimes(2);
      fixture.host.close.mockResolvedValue(undefined);
      await admitted.close({ reason: "complete after replacement cleanup" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives replacement quarantine recovery a fresh admission grace", async () => {
    vi.useFakeTimers();
    try {
      const fixture = driverFixture({}, { closeSettlementTimeoutMs: 1 });
      fixture.host.close.mockImplementation(
        ({ reason }) =>
          new Promise<void>((resolve, reject) => {
            setTimeout(() => {
              if (reason.includes("quarantined cleanup recovery")) resolve();
              else reject(new Error("bounded autonomous cleanup failed"));
            }, 8_000);
          }),
      );
      const session = await fixture.driver.openSession({
        runId: "run-owner-phase-grace",
        normalizedSessionId: "session-1",
        workingDirectory: "/workspace",
      });

      const closing = expect(
        session.close({ reason: "exhaust cleanup near admission deadline" }),
      ).rejects.toThrow("host cleanup exceeded its shutdown timeout");
      await vi.advanceTimersByTimeAsync(1);
      await closing;

      let admissionSettled = false;
      const admission = fixture.driver.openSession({
        runId: "run-after-owner-phase-grace",
        normalizedSessionId: "session-1",
        workingDirectory: "/workspace",
      });
      void admission
        .finally(() => {
          admissionSettled = true;
        })
        .catch(() => undefined);

      // The inherited autonomous owner consumes about 32 seconds before it
      // installs a distinct bounded quarantine recovery. That replacement
      // owner must not inherit the nearly exhausted admission deadline.
      await vi.advanceTimersByTimeAsync(35_001);
      expect(admissionSettled).toBe(false);
      expect(fixture.openHost).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(5_002);
      const admitted = await admission;
      expect(fixture.openHost).toHaveBeenCalledTimes(2);
      fixture.host.close.mockResolvedValue(undefined);
      await admitted.close({ reason: "complete after replacement owner" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reschedules host cleanup after an admission batch is exhausted", async () => {
    vi.useFakeTimers();
    try {
      const fixture = driverFixture({}, { closeSettlementTimeoutMs: 1 });
      fixture.host.close.mockRejectedValue(
        new Error("persistent cleanup failure"),
      );
      const session = await fixture.driver.openSession({
        runId: "run-transient-admission-cleanup",
        normalizedSessionId: "session-1",
        workingDirectory: "/workspace",
      });

      const closing = expect(
        session.close({ reason: "exhaust cleanup before admission" }),
      ).rejects.toThrow("persistent cleanup failure");
      await vi.advanceTimersByTimeAsync(1);
      await closing;
      await vi.advanceTimersByTimeAsync(10);

      let admissionAttempt = 0;
      let scheduledAttempt = 0;
      fixture.host.close.mockImplementation(({ reason }) => {
        if (reason.includes("quarantined cleanup admission recovery")) {
          admissionAttempt += 1;
          return Promise.reject(new Error("admission cleanup failed"));
        }
        if (reason.includes("scheduled quarantined cleanup recovery")) {
          scheduledAttempt += 1;
          return Promise.resolve();
        }
        return Promise.reject(new Error("unexpected cleanup reason"));
      });

      const admission = expect(
        fixture.driver.openSession({
          runId: "run-after-transient-admission-cleanup",
          normalizedSessionId: "session-1",
          workingDirectory: "/workspace",
        }),
      ).rejects.toThrow("quarantined host cleanup remains incomplete");
      await vi.advanceTimersByTimeAsync(3);
      await admission;

      expect(admissionAttempt).toBe(3);
      expect(scheduledAttempt).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(scheduledAttempt).toBe(1);

      const admitted = await fixture.driver.openSession({
        runId: "run-after-autonomous-cleanup",
        normalizedSessionId: "session-1",
        workingDirectory: "/workspace",
      });
      expect(fixture.openHost).toHaveBeenCalledTimes(2);
      fixture.host.close.mockResolvedValue(undefined);
      await admitted.close({ reason: "complete after admission retry" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores another host's retry timer when admission recovery times out", async () => {
    vi.useFakeTimers();
    try {
      const fixture = driverFixture({}, { closeSettlementTimeoutMs: 1 });
      const hostA = {
        ...fixture.host,
        close: vi.fn(async () => {
          throw new Error("host A cleanup failed");
        }),
      };
      const hostB = {
        ...fixture.host,
        close: vi.fn(async () => {
          throw new Error("host B cleanup failed");
        }),
      };
      fixture.openHost
        .mockReset()
        .mockResolvedValueOnce(hostB)
        .mockResolvedValueOnce(hostA)
        .mockResolvedValue(fixture.host);

      const sessionB = await fixture.driver.openSession({
        runId: "run-quarantined-host-b",
        normalizedSessionId: "session-1",
        workingDirectory: "/workspace",
      });
      const sessionA = await fixture.driver.openSession({
        runId: "run-quarantined-host-a",
        normalizedSessionId: "session-1",
        workingDirectory: "/workspace",
      });

      const closingB = expect(
        sessionB.close({ reason: "quarantine host B" }),
      ).rejects.toThrow("host B cleanup failed");
      await vi.advanceTimersByTimeAsync(1);
      await closingB;
      await vi.advanceTimersByTimeAsync(10);
      expect(hostB.close).toHaveBeenCalledTimes(7);

      // Offset the autonomous retry timers so host B can own an inherited
      // scheduled attempt while host A still has a dormant retry timer.
      await vi.advanceTimersByTimeAsync(100);
      const closingA = expect(
        sessionA.close({ reason: "quarantine host A" }),
      ).rejects.toThrow("host A cleanup failed");
      await vi.advanceTimersByTimeAsync(1);
      await closingA;
      await vi.advanceTimersByTimeAsync(10);
      expect(hostA.close).toHaveBeenCalledTimes(7);

      let hostAAdmissionAttempts = 0;
      let hostAScheduledAttempts = 0;
      hostA.close.mockImplementation(({ reason }) => {
        if (reason.includes("quarantined cleanup admission recovery")) {
          hostAAdmissionAttempts += 1;
          return Promise.reject(new Error("host A admission cleanup failed"));
        }
        if (reason.includes("scheduled quarantined cleanup recovery")) {
          hostAScheduledAttempts += 1;
          return Promise.resolve();
        }
        return Promise.reject(new Error("unexpected host A cleanup reason"));
      });
      let hostBAdmissionAttempts = 0;
      hostB.close.mockImplementation(({ reason }) => {
        if (reason.includes("scheduled quarantined cleanup recovery")) {
          return new Promise<void>((_resolve, reject) => {
            setTimeout(
              () => reject(new Error("host B scheduled cleanup failed")),
              1,
            );
          });
        }
        if (reason.includes("quarantined cleanup admission recovery")) {
          hostBAdmissionAttempts += 1;
          return new Promise<void>(() => undefined);
        }
        return Promise.reject(new Error("unexpected host B cleanup reason"));
      });

      await vi.advanceTimersToNextTimerAsync();
      expect(hostB.close).toHaveBeenLastCalledWith({
        reason: expect.stringContaining(
          "scheduled quarantined cleanup recovery",
        ),
      });
      expect(hostAScheduledAttempts).toBe(0);

      const admission = expect(
        fixture.driver.openSession({
          runId: "run-after-multi-host-quarantine",
          normalizedSessionId: "session-1",
          workingDirectory: "/workspace",
        }),
      ).rejects.toThrow("exceeded the admission grace");
      await vi.advanceTimersByTimeAsync(40_000);
      await admission;

      expect(hostAAdmissionAttempts).toBe(3);
      expect(hostBAdmissionAttempts).toBe(1);
      expect(hostAScheduledAttempts).toBe(0);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(hostAScheduledAttempts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails admission within a finite grace when quarantined cleanup never settles", async () => {
    vi.useFakeTimers();
    try {
      const fixture = driverFixture({}, { closeSettlementTimeoutMs: 1 });
      fixture.host.close.mockRejectedValue(
        new Error("persistent cleanup failure"),
      );
      const session = await fixture.driver.openSession({
        runId: "run-close-never-settles",
        normalizedSessionId: "session-1",
        workingDirectory: "/workspace",
      });

      const closing = expect(
        session.close({ reason: "runtime close persistently failed" }),
      ).rejects.toThrow("persistent cleanup failure");
      await vi.advanceTimersByTimeAsync(1);
      await closing;
      await vi.advanceTimersByTimeAsync(10);
      expect(fixture.host.close).toHaveBeenCalledTimes(7);

      fixture.host.close.mockImplementation(() => new Promise<void>(() => {}));
      let admissionSettled = false;
      const admission = fixture.driver.openSession({
        runId: "run-after-stalled-quarantine",
        normalizedSessionId: "session-1",
        workingDirectory: "/workspace",
      });
      void admission
        .finally(() => {
          admissionSettled = true;
        })
        .catch(() => undefined);
      await vi.advanceTimersByTimeAsync(38_999);
      expect(admissionSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await expect(admission).rejects.toThrow("exceeded the admission grace");
      expect(fixture.host.close).toHaveBeenCalledTimes(8);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds lagging streams without introducing source sequence gaps", async () => {
    const fixture = driverFixture(
      {},
      {
        runtimeEvents: Array.from({ length: 1_100 }, (_, index) => ({
          type: "text_delta" as const,
          text: `chunk-${index}`,
          stream: "output" as const,
        })),
      },
    );
    const session = await fixture.driver.openSession({
      runId: "run-bounds",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    await session.startTurn({
      message: { role: "user", text: "Produce many events." },
    });
    fixture.finishTurn({ status: "completed", stopReason: "end_turn" });

    await vi.waitFor(async () => {
      const snapshot = await session.snapshot();
      expect(snapshot.terminalTurns).toHaveLength(1);
    });
    await vi.waitFor(async () => {
      const snapshot = await session.snapshot();
      expect(snapshot.terminalTurns).toHaveLength(1);
      const transcript = await session.transcript!();
      expect(transcript.eventCount).toBeGreaterThan(1_024);
      expect(transcript.complete).toBe(false);
      expect(transcript.events.length).toBeLessThanOrEqual(1_024);
      expect(transcript.omissionReason).toBe("retention_limit");
    });
    await expect(
      session.startTurn({
        message: {
          role: "user",
          text: "Do not overtake the lagging consumer.",
        },
      }),
    ).rejects.toThrow("event consumer must drain");

    await session.close({ reason: "bounds verified" });
    const iterator = session.events()[Symbol.asyncIterator]();
    const retained: PrpEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      retained.push(next.value);
    }
    expect(retained.length).toBeLessThanOrEqual(512);
    expect(retained).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "harness.diagnostic",
          payload: expect.objectContaining({
            code: "event_stream_retention_limit",
          }),
        }),
      ]),
    );
    expect(
      retained.filter((event) => event.eventType === "turn.completed"),
    ).toHaveLength(1);
    expect(retained.map((event) => event.sourceSeq)).toEqual(
      Array.from({ length: retained.length }, (_, index) => index + 1),
    );
  });

  it("retains a committed semantic proposal under terminal queue pressure", async () => {
    const fixture = driverFixture({}, { maxBufferedEvents: 6 });
    const session = await fixture.driver.openSession({
      runId: "run-semantic-bounds",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Complete the task." },
    });
    await expect(
      fixture.hostOptions!.semanticTools!.handler({
        tool: PRP_COMPLETION_TOOL_NAME,
        callId: "finish-bounded",
        arguments: completedResult(),
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ accepted: true });
    fixture.finishTurn({ status: "completed", stopReason: "end_turn" });

    await vi.waitFor(async () => {
      await expect(session.snapshot()).resolves.toMatchObject({
        terminalTurns: [expect.objectContaining({ turnId })],
      });
    });
    await session.close({ reason: "bounded result verified" });
    const retained: PrpEvent[] = [];
    for await (const event of session.events()) retained.push(event);

    const proposalIndex = retained.findIndex(
      (event) => event.eventType === "run.result.proposed",
    );
    const terminalIndex = retained.findIndex(
      (event) => event.eventType === "turn.completed",
    );
    expect(proposalIndex).toBeGreaterThanOrEqual(0);
    expect(terminalIndex).toBeGreaterThan(proposalIndex);
    expect(retained).toHaveLength(6);
  });

  it("keeps a full-queue terminal pending until it can be streamed", async () => {
    const dynamicToolHandler = vi.fn(async () => ({ title: "late result" }));
    const fixture = driverFixture(
      { dynamicToolHandler },
      {
        closeSettlementTimeoutMs: 1,
        maxBufferedEvents: 6,
        terminalEventReserve: 0,
        runtimeEvents: Array.from({ length: 8 }, (_, index) => ({
          type: "text_delta" as const,
          text: `pressure-${index}`,
          stream: "output" as const,
        })),
      },
    );
    const session = await fixture.driver.openSession({
      runId: "run-terminal-capacity-failure",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Fill the complete event queue." },
    });
    fixture.finishTurn({ status: "completed", stopReason: "end_turn" });

    await vi.waitFor(async () => {
      await expect(session.snapshot()).resolves.toMatchObject({
        activeTurnId: turnId,
        terminalTurns: [],
      });
      const transcript = await session.transcript!();
      expect(transcript.complete).toBe(false);
      expect(transcript.eventCount).toBe(14);
    });

    const bridgeHandler = fixture.hostOptions!.semanticTools!.handler;
    await expect(
      bridgeHandler({
        tool: PRP_COMPLETION_TOOL_NAME,
        callId: "late-completion",
        arguments: completedResult(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("awaiting canonical terminal-event retention");
    await expect(
      bridgeHandler({
        tool: "documents.read",
        callId: "late-dynamic-tool",
        arguments: { id: "doc-after-terminal" },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("awaiting canonical terminal-event retention");
    expect(dynamicToolHandler).not.toHaveBeenCalled();
    await expect(
      session.interrupt({ turnId, reason: "too late" }),
    ).rejects.toThrow("awaiting canonical terminal-event retention");
    expect(fixture.host.interruptActiveTurn).not.toHaveBeenCalled();
    await expect(session.snapshot()).resolves.toMatchObject({
      activeTurnId: turnId,
      semanticResult: null,
      terminalTurns: [],
    });
    fixture.host.close
      .mockRejectedValueOnce(new Error("initial host cleanup failed"))
      .mockResolvedValueOnce(undefined);
    await expect(
      session.close({ reason: "queue is still full" }),
    ).rejects.toThrow("before its turn.completed event is retained");
    await expect(session.snapshot()).resolves.toMatchObject({
      activeTurnId: turnId,
      semanticResult: null,
      terminalTurns: [],
    });
    await vi.waitFor(() => expect(fixture.host.close).toHaveBeenCalledTimes(2));
    expect(fixture.host.close).toHaveBeenLastCalledWith({
      reason: "queue is still full (automatic cleanup recovery 1)",
    });

    const iterator = session.events()[Symbol.asyncIterator]();
    const pressureEvents: PrpEvent[] = [];
    for (let index = 0; index < 6; index += 1) {
      const next = await iterator.next();
      expect(next.done).toBe(false);
      if (!next.done) pressureEvents.push(next.value);
    }
    expect(pressureEvents).toHaveLength(6);
    expect(isCanonicalTurnTerminal(pressureEvents, turnId)).toHaveLength(0);

    await session.close({ reason: "capacity became available" });
    const settlementEvents: PrpEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      settlementEvents.push(next.value);
    }
    expect(isCanonicalTurnTerminal(settlementEvents, turnId)).toEqual([
      expect.objectContaining({
        eventType: "turn.completed",
        turnId,
      }),
    ]);
    await expect(session.snapshot()).resolves.toMatchObject({
      activeTurnId: null,
      terminalTurns: [expect.objectContaining({ turnId })],
    });
  });

  it("rejects turn admission when only terminal reserve capacity remains", async () => {
    const fixture = driverFixture({}, { maxBufferedEvents: 6 });
    const session = await fixture.driver.openSession({
      runId: "run-admission-bounds",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    await session.startTurn({
      message: { role: "user", text: "Fill the regular event capacity." },
    });
    fixture.finishTurn({ status: "completed", stopReason: "end_turn" });
    await vi.waitFor(async () => {
      await expect(session.snapshot()).resolves.toMatchObject({
        terminalTurns: [
          expect.objectContaining({ turnId: expect.any(String) }),
        ],
      });
    });
    const iterator = session.events()[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();

    await expect(
      session.startTurn({
        message: { role: "user", text: "Must wait for the remaining events." },
      }),
    ).rejects.toThrow("event consumer must drain");
    expect(fixture.host.startTurn).toHaveBeenCalledOnce();
    await session.close({ reason: "admission bound verified" });
  });

  it("redacts a complete Authorization credential from events and transcripts", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-redaction",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    fixture.host.startTurn.mockImplementationOnce(() => {
      throw new Error(
        "Authorization: Bearer first-secret second-secret, code=denied",
      );
    });
    const terminalEvents = collectUntil(session.events(), "turn.failed");

    await expect(
      session.startTurn({
        message: { role: "user", text: "Do not expose provider credentials." },
      }),
    ).rejects.toThrow("Authorization");

    const serializedEvents = JSON.stringify(await terminalEvents);
    const serializedTranscript = JSON.stringify(await session.transcript!());
    for (const serialized of [serializedEvents, serializedTranscript]) {
      expect(serialized).toContain("[REDACTED]");
      expect(serialized).not.toContain("Bearer");
      expect(serialized).not.toContain("first-secret");
      expect(serialized).not.toContain("second-secret");
    }
    await session.close({ reason: "redaction verified" });
  });

  it("preserves every terminal when the bounded consumer keeps draining", async () => {
    const fixture = driverFixture({}, { maxBufferedEvents: 6 });
    const session = await fixture.driver.openSession({
      runId: "run-critical-bounds",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const terminalTurnIds: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const terminalEvents = collectUntil(session.events(), "turn.completed");
      const { turnId } = await session.startTurn({
        message: { role: "user", text: `Complete turn ${index}.` },
      });
      terminalTurnIds.push(turnId);
      fixture.finishTurn({ status: "completed", stopReason: "end_turn" });
      const emitted = await terminalEvents;
      expect(emitted.at(-1)).toMatchObject({
        eventType: "turn.completed",
        turnId,
      });
    }
    await expect(
      session.startTurn({
        message: { role: "user", text: "Exceed the bounded turn limit." },
      }),
    ).rejects.toThrow("bounded session turn limit");

    await session.close({ reason: "critical bounds verified" });
    await expect(session.snapshot()).resolves.toMatchObject({
      terminalTurns: terminalTurnIds.map((turnId) =>
        expect.objectContaining({ turnId }),
      ),
    });
  });

  it("round-trips a provider-neutral ACP form through the runtime request boundary", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-question",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const createdEvent = collectUntil(
      session.events(),
      "runtime_request.created",
    );
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Choose a region." },
    });
    const onElicitation =
      fixture.host.startTurn.mock.calls[0]![0].onElicitation!;
    const controller = new AbortController();
    const providerResponse = onElicitation(
      {
        mode: "form",
        message: "Choose deployment settings.",
        requestedSchema: {
          type: "object",
          title: "Deployment",
          required: ["region"],
          properties: {
            region: {
              type: "string",
              title: "Region",
              enum: ["us-east-1", "eu-west-1"],
            },
          },
        },
      },
      { requestId: "rpc-question-1", signal: controller.signal },
    );
    const events = await createdEvent;
    const request = session.pendingRuntimeRequests!()[0]!;

    expect(events.at(-1)).toMatchObject({
      eventType: "runtime_request.created",
      turnId,
      payload: {
        request: {
          schema: "paperclip.runtime_request.v2",
          requestKind: "runtime",
          type: "input",
          status: "pending",
          input: { schema: "paperclip.question_set.v1" },
          origin: { adapter: "acpx-runtime", provider: "codex" },
        },
      },
    });
    const question = request.input!.questions[0]!;
    const resolvedEvent = collectUntil(
      session.events(),
      "runtime_request.resolved",
    );
    await session.resolveRuntimeRequest!({
      requestId: request.requestId,
      turnId,
      resolution: {
        action: "submit",
        response: {
          schema: "paperclip.question_response.v1",
          answers: {
            [question.id]: {
              selectedOptionIds: [question.options![1]!.id],
            },
          },
        },
      },
    });

    await expect(providerResponse).resolves.toEqual({
      action: "accept",
      content: { region: "eu-west-1" },
    });
    await expect(resolvedEvent).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "runtime_request.resolved" }),
      ]),
    );
    expect(session.pendingRuntimeRequests!()).toEqual([]);
    fixture.finishTurn({ status: "completed", stopReason: "end_turn" });
    await collectUntil(session.events(), "turn.completed");
    await session.close({ reason: "question verified" });
  });

  it("rejects provider input when queue pressure omits its creation event", async () => {
    const fixture = driverFixture(
      {},
      { maxBufferedEvents: 6, runtimeEvents: [] },
    );
    const session = await fixture.driver.openSession({
      runId: "run-question-created-pressure",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    await session.startTurn({
      message: { role: "user", text: "Fill the event queue." },
    });
    const onElicitation =
      fixture.host.startTurn.mock.calls[0]![0].onElicitation!;

    await expect(
      onElicitation(
        {
          mode: "form",
          requestedSchema: {
            type: "object",
            properties: { value: { type: "string" } },
          },
        },
        {
          requestId: "rpc-question-created-pressure",
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toEqual({ action: "cancel" });
    expect(session.pendingRuntimeRequests!()).toEqual([]);

    await session.close({ reason: "creation pressure verified" });
  });

  it("cancels a pending ACP form when its owning provider request aborts", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-question-abort",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const createdEvent = collectUntil(
      session.events(),
      "runtime_request.created",
    );
    await session.startTurn({
      message: { role: "user", text: "Ask and abort." },
    });
    const onElicitation =
      fixture.host.startTurn.mock.calls[0]![0].onElicitation!;
    const controller = new AbortController();
    const providerResponse = onElicitation(
      {
        mode: "form",
        requestedSchema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
      { requestId: "rpc-question-abort", signal: controller.signal },
    );
    await createdEvent;
    const cancelledEvent = collectUntil(
      session.events(),
      "runtime_request.cancelled",
    );

    controller.abort();

    await expect(providerResponse).resolves.toEqual({ action: "cancel" });
    await expect(cancelledEvent).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "runtime_request.cancelled" }),
      ]),
    );
    expect(session.pendingRuntimeRequests!()).toEqual([]);
    fixture.finishTurn({ status: "cancelled", stopReason: "aborted" });
    await collectUntil(session.events(), "turn.interrupted");
    await session.close({ reason: "abort verified" });
  });

  it("cancels a pending ACP form when the provider event stream fails", async () => {
    const eventStreamFailure = deferred<void>();
    const fixture = driverFixture(
      {},
      { eventStreamFailure: eventStreamFailure.promise },
    );
    const session = await fixture.driver.openSession({
      runId: "run-question-stream-failure",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const failedEvent = collectUntil(session.events(), "turn.failed");
    await session.startTurn({
      message: { role: "user", text: "Ask before the stream fails." },
    });
    const onElicitation =
      fixture.host.startTurn.mock.calls[0]![0].onElicitation!;
    const providerResponse = onElicitation(
      {
        mode: "form",
        requestedSchema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
      {
        requestId: "rpc-question-stream-failure",
        signal: new AbortController().signal,
      },
    );
    await vi.waitFor(() => {
      expect(session.pendingRuntimeRequests!()).toHaveLength(1);
    });

    eventStreamFailure.resolve();

    await expect(providerResponse).resolves.toEqual({ action: "cancel" });
    await expect(failedEvent).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "runtime_request.cancelled" }),
        expect.objectContaining({ eventType: "turn.failed" }),
      ]),
    );
    expect(session.pendingRuntimeRequests!()).toEqual([]);
    await session.close({ reason: "stream failure verified" });
  });

  it("expires an ACP form before a durable wait without accepting late answers", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-question-handoff",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const createdEvent = collectUntil(
      session.events(),
      "runtime_request.created",
    );
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Ask for input." },
    });
    const onElicitation =
      fixture.host.startTurn.mock.calls[0]![0].onElicitation!;
    const providerResponse = onElicitation(
      {
        mode: "form",
        requestedSchema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
      {
        requestId: "rpc-question-handoff",
        signal: new AbortController().signal,
      },
    );
    await createdEvent;
    const [request] = session.pendingRuntimeRequests!();

    const ownership = new AbortController();
    ownership.abort();
    const abortedHandoff = session.handoffRuntimeRequest!({
      requestId: request!.requestId,
      turnId,
      reason: "durable_handoff",
      signal: ownership.signal,
    });
    expect(abortedHandoff.result).toBe("already_settled");
    await expect(abortedHandoff.cleanup).resolves.toBeUndefined();
    expect(session.pendingRuntimeRequests!()).toHaveLength(1);
    expect(fixture.host.interruptActiveTurn).not.toHaveBeenCalled();

    const handoff = session.handoffRuntimeRequest!({
      requestId: request!.requestId,
      turnId,
      reason: "durable_handoff",
      signal: new AbortController().signal,
    });
    expect(handoff.result).toBe("handed_off");
    await expect(handoff.cleanup).resolves.toBeUndefined();
    await expect(providerResponse).resolves.toEqual({ action: "cancel" });
    expect(fixture.host.interruptActiveTurn).toHaveBeenCalledWith(
      "Paperclip parked the ACPX input on a durable wait.",
    );
    await expect(
      session.resolveRuntimeRequest!({
        requestId: request!.requestId,
        turnId,
        resolution: { action: "cancel" },
      }),
    ).rejects.toThrow("no longer pending");
    fixture.finishTurn({ status: "cancelled", stopReason: "durable_wait" });
    await collectUntil(session.events(), "turn.interrupted");
    await session.close({ reason: "handoff verified" });
  });

  it("preserves a pending ACP form when queue pressure blocks durable handoff", async () => {
    const fixture = driverFixture(
      {},
      { maxBufferedEvents: 7, runtimeEvents: [] },
    );
    const session = await fixture.driver.openSession({
      runId: "run-question-handoff-pressure",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Fill the handoff lane." },
    });
    const onElicitation =
      fixture.host.startTurn.mock.calls[0]![0].onElicitation!;
    const providerResponse = onElicitation(
      {
        mode: "form",
        requestedSchema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
      {
        requestId: "rpc-question-handoff-pressure",
        signal: new AbortController().signal,
      },
    );
    await vi.waitFor(() => {
      expect(session.pendingRuntimeRequests!()).toHaveLength(1);
    });
    const [request] = session.pendingRuntimeRequests!();

    expect(() =>
      session.handoffRuntimeRequest!({
        requestId: request!.requestId,
        turnId,
        reason: "durable_handoff",
        signal: new AbortController().signal,
      }),
    ).toThrow("event consumer must drain provider events");
    expect(session.pendingRuntimeRequests!()).toEqual([request]);
    expect(fixture.host.interruptActiveTurn).not.toHaveBeenCalled();

    await session.close({ reason: "handoff pressure verified" });
    await expect(providerResponse).resolves.toEqual({ action: "cancel" });
  });

  it("recovers a settled session with the exact persisted identity", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-recovery",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const terminalEvents = collectUntil(session.events(), "turn.completed");
    await session.startTurn({
      message: { role: "user", text: "Complete the task." },
    });
    await fixture.hostOptions!.semanticTools!.handler({
      tool: PRP_COMPLETION_TOOL_NAME,
      callId: "finish-recovery",
      arguments: completedResult(),
      signal: new AbortController().signal,
    });
    fixture.finishTurn({ status: "completed", stopReason: "end_turn" });
    await terminalEvents;
    const snapshot = await session.snapshot();
    expect(snapshot.terminalTurns?.at(-1)?.turnId).toBe(
      snapshot.semanticResult?.turnId,
    );
    await session.close({ reason: "simulate restart" });

    const recovery = await fixture.driver.recoverSession!(snapshot);

    expect(recovery).toMatchObject({ recovered: true });
    expect(fixture.readRecoveryWorkspace).toHaveBeenCalledWith({
      runtimeDirectory: "/runtime",
      normalizedSessionId: "session-1",
      signal: expect.any(AbortSignal),
    });
    expect(fixture.hostOptions?.expectedIdentity).toEqual(
      snapshot.providerIdentity,
    );
    const workspaceLease = (await fixture.readRecoveryWorkspace.mock
      .results[0]!.value) as AcpxRecoveryWorkspaceLease;
    expect(fixture.hostOptions?.assertWorkspaceHeld).toBe(
      workspaceLease.assertHeld,
    );
    expect(workspaceLease.close).toHaveBeenCalledOnce();
    await expect(recovery.session!.snapshot()).resolves.toMatchObject({
      driverSessionId: snapshot.driverSessionId,
      providerSessionId: snapshot.providerSessionId,
      providerRecoveryPolicy: "same_session_only",
      lastSourceSequence: snapshot.lastSourceSequence,
      semanticResult: snapshot.semanticResult,
      activeTurnId: null,
    });
    await recovery.session!.close({ reason: "recovery verified" });
  });

  it("rejects a pre-aborted recovery before reading its workspace", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-recovery-pre-abort",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const snapshot = await session.snapshot();
    await session.close({ reason: "prepare pre-aborted recovery" });
    const controller = new AbortController();
    const cancellation = new Error("recovery cancelled before start");
    controller.abort(cancellation);

    await expect(
      fixture.driver.recoverSession!(snapshot, {
        signal: controller.signal,
      }),
    ).resolves.toEqual({
      recovered: false,
      reason: cancellation.message,
    });

    expect(fixture.readRecoveryWorkspace).not.toHaveBeenCalled();
    expect(fixture.openHost).toHaveBeenCalledOnce();
  });

  it("aborts a blocked recovery workspace read without opening a host", async () => {
    const workspaceRead = deferred<AcpxRecoveryWorkspaceLease>();
    const lateWorkspaceLease = recoveryWorkspaceLease();
    const fixture = driverFixture({}, {
      readRecoveryWorkspace: () => workspaceRead.promise,
    });
    const session = await fixture.driver.openSession({
      runId: "run-recovery-read-abort",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const snapshot = await session.snapshot();
    await session.close({ reason: "prepare blocked workspace recovery" });
    const controller = new AbortController();
    const cancellation = new Error("recovery workspace read cancelled");
    const recovery = fixture.driver.recoverSession!(snapshot, {
      signal: controller.signal,
    });
    await vi.waitFor(() =>
      expect(fixture.readRecoveryWorkspace).toHaveBeenCalledOnce(),
    );
    expect(fixture.readRecoveryWorkspace).toHaveBeenCalledWith({
      runtimeDirectory: "/runtime",
      normalizedSessionId: "session-1",
      signal: controller.signal,
    });

    controller.abort(cancellation);
    await expect(recovery).resolves.toEqual({
      recovered: false,
      reason: cancellation.message,
    });
    workspaceRead.resolve(lateWorkspaceLease);
    await vi.waitFor(() =>
      expect(lateWorkspaceLease.close).toHaveBeenCalledOnce(),
    );

    expect(fixture.openHost).toHaveBeenCalledOnce();
  });

  it("closes and quarantines a recovered host that resolves after abort", async () => {
    const fixture = driverFixture({}, { closeSettlementTimeoutMs: 5 });
    const session = await fixture.driver.openSession({
      runId: "run-recovery-late-host",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const snapshot = await session.snapshot();
    await session.close({ reason: "prepare late recovered host" });
    fixture.host.close.mockClear();
    fixture.host.close.mockRejectedValueOnce(
      new Error("late recovered host close failed once"),
    );
    const hostAdmission = deferred<ReturnType<typeof fakeHost>>();
    let recoveryHostOptions: OpenAcpxRuntimeHostOptions | undefined;
    fixture.openHost.mockImplementationOnce((options) => {
      recoveryHostOptions = options;
      return hostAdmission.promise;
    });
    const controller = new AbortController();
    const cancellation = new Error("recovered host admission cancelled");
    const recovery = fixture.driver.recoverSession!(snapshot, {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(fixture.openHost).toHaveBeenCalledTimes(2));
    expect(recoveryHostOptions?.signal).toBe(controller.signal);

    controller.abort(cancellation);
    await expect(recovery).resolves.toEqual({
      recovered: false,
      reason: cancellation.message,
    });
    hostAdmission.resolve(fixture.host);

    await vi.waitFor(() => expect(fixture.host.close).toHaveBeenCalledTimes(2));
    expect(fixture.host.close).toHaveBeenNthCalledWith(1, {
      reason: "Codex ACPX host resolved after admission was aborted",
    });
    expect(fixture.host.close).toHaveBeenNthCalledWith(2, {
      reason: expect.stringContaining("quarantined cleanup recovery"),
    });
  });

  it.each([
    [
      "failed",
      "turn.failed",
      {
        status: "failed",
        error: {
          code: "provider_failure",
          message: "The follow-up failed",
          retryable: false,
        },
      },
    ],
    [
      "cancelled",
      "turn.interrupted",
      { status: "cancelled", stopReason: "operator_cancelled" },
    ],
  ] as const)(
    "rejects an earlier semantic settlement after a later %s turn",
    async (_status, terminalType, terminalResult) => {
      const fixture = driverFixture();
      const session = await fixture.driver.openSession({
        runId: "run-later-unsuccessful-turn",
        normalizedSessionId: "session-1",
        workingDirectory: "/workspace",
      });

      const semanticTerminal = collectUntil(session.events(), "turn.completed");
      const semanticTurn = await session.startTurn({
        message: { role: "user", text: "Complete the task." },
      });
      await fixture.hostOptions!.semanticTools!.handler({
        tool: PRP_COMPLETION_TOOL_NAME,
        callId: "finish-before-follow-up",
        arguments: completedResult(),
        signal: new AbortController().signal,
      });
      fixture.finishTurn({ status: "completed", stopReason: "end_turn" });
      await semanticTerminal;

      const laterTerminal = collectUntil(session.events(), terminalType);
      const laterTurn = await session.startTurn({
        message: { role: "user", text: "Attempt a follow-up." },
      });
      fixture.finishTurn(terminalResult);
      await laterTerminal;

      const snapshot = await session.snapshot();
      expect(snapshot).toMatchObject({
        activeTurnId: null,
        semanticResult: { turnId: semanticTurn.turnId },
      });
      expect(snapshot.terminalTurns?.at(-1)?.turnId).toBe(laterTurn.turnId);
      await session.close({
        reason: "simulate unsuccessful follow-up recovery",
      });

      await expect(fixture.driver.recoverSession!(snapshot)).resolves.toEqual({
        recovered: false,
        reason:
          "persisted Codex ACPX semantic result is not the latest terminal settlement",
      });
      expect(fixture.readRecoveryWorkspace).not.toHaveBeenCalled();
    },
  );

  it("transfers an identical semantic retry from a failed turn to its successful turn", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-semantic-retry",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const bridgeHandler = fixture.hostOptions!.semanticTools!.handler;

    const firstTerminal = collectUntil(session.events(), "turn.failed");
    const first = await session.startTurn({
      message: { role: "user", text: "Attempt the task." },
    });
    await bridgeHandler({
      tool: PRP_COMPLETION_TOOL_NAME,
      callId: "finish-failed-attempt",
      arguments: completedResult(),
      signal: new AbortController().signal,
    });
    fixture.finishTurn({
      status: "failed",
      error: {
        code: "provider_retry",
        message: "Retry the turn",
        retryable: true,
      },
    });
    await firstTerminal;

    const secondTerminal = collectUntil(session.events(), "turn.completed");
    const second = await session.startTurn({
      message: { role: "user", text: "Record the successful retry." },
    });
    await bridgeHandler({
      tool: PRP_COMPLETION_TOOL_NAME,
      callId: "finish-successful-retry",
      arguments: completedResult(),
      signal: new AbortController().signal,
    });
    fixture.finishTurn({ status: "completed", stopReason: "end_turn" });
    await secondTerminal;

    const snapshot = await session.snapshot();
    expect(snapshot.semanticResult).toMatchObject({
      callId: "finish-successful-retry",
      turnId: second.turnId,
    });
    expect(snapshot.semanticResult?.turnId).not.toBe(first.turnId);
    expect(snapshot.terminalTurns?.at(-1)?.turnId).toBe(second.turnId);
    expect(snapshot.terminalTurns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ turnId: first.turnId }),
        expect.objectContaining({ turnId: second.turnId }),
      ]),
    );
    const successfulTerminal = snapshot.terminalTurns?.find(
      (terminal) => terminal.turnId === second.turnId,
    );
    expect(JSON.parse(successfulTerminal!.fingerprint)).toEqual({
      status: "completed",
      semanticResult: snapshot.semanticResult!.fingerprint,
    });
    await session.close({ reason: "simulate successful retry recovery" });

    await expect(
      fixture.driver.recoverSession!({
        ...snapshot,
        activeTurnId: first.turnId,
      }),
    ).resolves.toEqual({
      recovered: false,
      reason:
        "persisted Codex ACPX active turn is not the completed semantic settlement",
    });
    await expect(
      fixture.driver.recoverSession!(snapshot),
    ).resolves.toMatchObject({
      recovered: true,
    });
  });

  it("transfers an identical reaffirmed result to the latest successful turn", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-semantic-reaffirmation",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const bridgeHandler = fixture.hostOptions!.semanticTools!.handler;

    const firstTerminal = collectUntil(session.events(), "turn.completed");
    const first = await session.startTurn({
      message: { role: "user", text: "Complete the task." },
    });
    await bridgeHandler({
      tool: PRP_COMPLETION_TOOL_NAME,
      callId: "finish-first-success",
      arguments: completedResult(),
      signal: new AbortController().signal,
    });
    fixture.finishTurn({ status: "completed", stopReason: "end_turn" });
    await firstTerminal;

    const secondTerminal = collectUntil(session.events(), "turn.completed");
    const second = await session.startTurn({
      message: { role: "user", text: "Reaffirm the same disposition." },
    });
    await bridgeHandler({
      tool: PRP_COMPLETION_TOOL_NAME,
      callId: "finish-reaffirmed-success",
      arguments: completedResult(),
      signal: new AbortController().signal,
    });
    fixture.finishTurn({ status: "completed", stopReason: "end_turn" });
    const reaffirmedEvents = await secondTerminal;

    expect(
      reaffirmedEvents.filter(
        (event) => event.eventType === "run.result.proposed",
      ),
    ).toHaveLength(1);
    const snapshot = await session.snapshot();
    expect(snapshot.semanticResult).toMatchObject({
      callId: "finish-reaffirmed-success",
      turnId: second.turnId,
    });
    expect(snapshot.semanticResult?.turnId).not.toBe(first.turnId);
    expect(JSON.parse(snapshot.terminalTurns!.at(-1)!.fingerprint)).toEqual({
      status: "completed",
      semanticResult: snapshot.semanticResult!.fingerprint,
    });
    await session.close({ reason: "simulate reaffirmed result recovery" });

    await expect(
      fixture.driver.recoverSession!(snapshot),
    ).resolves.toMatchObject({
      recovered: true,
    });
  });

  it("rejects an earlier completed result after an identical retry fails", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-failed-semantic-reaffirmation",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const bridgeHandler = fixture.hostOptions!.semanticTools!.handler;

    const firstTerminal = collectUntil(session.events(), "turn.completed");
    const first = await session.startTurn({
      message: { role: "user", text: "Complete the task." },
    });
    await bridgeHandler({
      tool: PRP_COMPLETION_TOOL_NAME,
      callId: "finish-before-failed-reaffirmation",
      arguments: completedResult(),
      signal: new AbortController().signal,
    });
    fixture.finishTurn({ status: "completed", stopReason: "end_turn" });
    await firstTerminal;

    const failedTerminal = collectUntil(session.events(), "turn.failed");
    const second = await session.startTurn({
      message: { role: "user", text: "Reaffirm before a failed retry." },
    });
    await bridgeHandler({
      tool: PRP_COMPLETION_TOOL_NAME,
      callId: "finish-failed-reaffirmation",
      arguments: completedResult(),
      signal: new AbortController().signal,
    });
    fixture.finishTurn({
      status: "failed",
      error: {
        code: "provider_retry",
        message: "Retry failed after reaffirming",
        retryable: true,
      },
    });
    const failedEvents = await failedTerminal;
    expect(
      failedEvents.filter((event) => event.eventType === "run.result.proposed"),
    ).toHaveLength(1);

    const snapshot = await session.snapshot();
    expect(snapshot.semanticResult).toMatchObject({
      callId: "finish-before-failed-reaffirmation",
      turnId: first.turnId,
    });
    expect(snapshot.semanticResult?.turnId).not.toBe(second.turnId);
    expect(JSON.parse(snapshot.terminalTurns!.at(-1)!.fingerprint)).toEqual({
      status: "failed",
      reaffirmedSemanticResult: snapshot.semanticResult!.fingerprint,
    });
    await session.close({ reason: "simulate failed reaffirmation recovery" });

    await expect(fixture.driver.recoverSession!(snapshot)).resolves.toEqual({
      recovered: false,
      reason:
        "persisted Codex ACPX semantic result is not the latest terminal settlement",
    });
    expect(fixture.readRecoveryWorkspace).not.toHaveBeenCalled();
  });

  it("rejects an earlier completed result after close interrupts an identical retry", async () => {
    const fixture = driverFixture({}, { closeSettlementTimeoutMs: 1 });
    const session = await fixture.driver.openSession({
      runId: "run-close-interrupted-semantic-reaffirmation",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const bridgeHandler = fixture.hostOptions!.semanticTools!.handler;

    const firstTerminal = collectUntil(session.events(), "turn.completed");
    const first = await session.startTurn({
      message: { role: "user", text: "Complete the task." },
    });
    await bridgeHandler({
      tool: PRP_COMPLETION_TOOL_NAME,
      callId: "finish-before-close-reaffirmation",
      arguments: completedResult(),
      signal: new AbortController().signal,
    });
    fixture.finishTurn({ status: "completed", stopReason: "end_turn" });
    await firstTerminal;

    const interruptedTerminal = collectUntil(
      session.events(),
      "turn.interrupted",
    );
    const second = await session.startTurn({
      message: { role: "user", text: "Reaffirm while shutdown begins." },
    });
    await bridgeHandler({
      tool: PRP_COMPLETION_TOOL_NAME,
      callId: "finish-close-reaffirmation",
      arguments: completedResult(),
      signal: new AbortController().signal,
    });
    fixture.host.close.mockResolvedValue(undefined);
    await session.close({ reason: "close before provider result settles" });
    await interruptedTerminal;

    const snapshot = await session.snapshot();
    expect(snapshot.semanticResult).toMatchObject({
      callId: "finish-before-close-reaffirmation",
      turnId: first.turnId,
    });
    expect(snapshot.semanticResult?.turnId).not.toBe(second.turnId);
    expect(JSON.parse(snapshot.terminalTurns!.at(-1)!.fingerprint)).toEqual({
      status: "interrupted",
      reaffirmedSemanticResult: snapshot.semanticResult!.fingerprint,
    });

    fixture.finishTurn({ status: "cancelled", stopReason: "session_closed" });
    await expect(fixture.driver.recoverSession!(snapshot)).resolves.toEqual({
      recovered: false,
      reason:
        "persisted Codex ACPX semantic result is not the latest terminal settlement",
    });
    expect(fixture.readRecoveryWorkspace).not.toHaveBeenCalled();
  });

  it("does not transfer a failed turn's semantic result to an unrelated resultless turn", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-resultless-semantic-retry",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });

    const firstTerminal = collectUntil(session.events(), "turn.failed");
    const first = await session.startTurn({
      message: { role: "user", text: "Attempt the task." },
    });
    await fixture.hostOptions!.semanticTools!.handler({
      tool: PRP_COMPLETION_TOOL_NAME,
      callId: "finish-before-provider-retry",
      arguments: completedResult(),
      signal: new AbortController().signal,
    });
    fixture.finishTurn({
      status: "failed",
      error: {
        code: "provider_retry",
        message: "Retry the turn",
        retryable: true,
      },
    });
    await firstTerminal;

    const secondTerminal = collectUntil(session.events(), "turn.completed");
    const second = await session.startTurn({
      message: { role: "user", text: "Confirm the completed work." },
    });
    fixture.finishTurn({ status: "completed", stopReason: "end_turn" });
    await secondTerminal;

    const snapshot = await session.snapshot();
    expect(snapshot.semanticResult).toMatchObject({
      callId: "finish-before-provider-retry",
      turnId: first.turnId,
    });
    const successfulTerminal = snapshot.terminalTurns?.find(
      (terminal) => terminal.turnId === second.turnId,
    );
    expect(JSON.parse(successfulTerminal!.fingerprint)).toEqual({
      status: "completed",
      semanticResult: null,
    });
    await session.close({ reason: "simulate resultless retry recovery" });

    await expect(fixture.driver.recoverSession!(snapshot)).resolves.toEqual({
      recovered: false,
      reason:
        "persisted Codex ACPX semantic result has no completed terminal turn",
    });
  });

  it("clears a checkpoint race when the active turn is already terminal", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-terminal-race",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const terminalEvents = collectUntil(session.events(), "turn.completed");
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Complete the task." },
    });
    fixture.finishTurn({ status: "completed", stopReason: "end_turn" });
    await terminalEvents;
    const snapshot = await session.snapshot();
    snapshot.activeTurnId = turnId;
    await session.close({ reason: "simulate checkpoint race" });

    const recovery = await fixture.driver.recoverSession!(snapshot);

    expect(recovery).toMatchObject({ recovered: true });
    await expect(recovery.session!.snapshot()).resolves.toMatchObject({
      activeTurnId: null,
      terminalTurns: [expect.objectContaining({ turnId })],
    });
    await recovery.session!.close({ reason: "checkpoint race verified" });
  });

  it("fails closed when a checkpoint contains an unproved active turn", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-active-recovery",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    await session.startTurn({
      message: { role: "user", text: "Continue working." },
    });
    const snapshot = await session.snapshot();

    await expect(fixture.driver.recoverSession!(snapshot)).resolves.toEqual({
      recovered: false,
      reason: "active Codex ACPX turn continuity is unavailable",
    });
    expect(fixture.readRecoveryWorkspace).not.toHaveBeenCalled();
    expect(fixture.openHost).toHaveBeenCalledOnce();
    await session.close({ reason: "active recovery rejected" });
  });

  it("rejects a tampered recovery result before reopening the provider", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-tampered-recovery",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const snapshot = await session.snapshot();
    snapshot.semanticResult = {
      result: completedResult(),
      fingerprint: "tampered",
      turnId: "turn-settled",
    };

    await expect(fixture.driver.recoverSession!(snapshot)).resolves.toEqual({
      recovered: false,
      reason: "persisted Codex ACPX semantic result is invalid",
    });
    expect(fixture.readRecoveryWorkspace).not.toHaveBeenCalled();
    expect(fixture.openHost).toHaveBeenCalledOnce();
    await session.close({ reason: "tampered recovery rejected" });
  });

  it("rejects semantic results from failed terminal turns", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-failed-semantic-recovery",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const terminalEvents = collectUntil(session.events(), "turn.completed");
    await session.startTurn({
      message: { role: "user", text: "Complete the task." },
    });
    await fixture.hostOptions!.semanticTools!.handler({
      tool: PRP_COMPLETION_TOOL_NAME,
      callId: "finish-before-failure",
      arguments: completedResult(),
      signal: new AbortController().signal,
    });
    fixture.finishTurn({ status: "completed", stopReason: "end_turn" });
    await terminalEvents;
    const snapshot = await session.snapshot();
    snapshot.terminalTurns = snapshot.terminalTurns?.map((terminal) => ({
      ...terminal,
      fingerprint: JSON.stringify({ status: "failed" }),
    }));

    await expect(fixture.driver.recoverSession!(snapshot)).resolves.toEqual({
      recovered: false,
      reason:
        "persisted Codex ACPX semantic result has no completed terminal turn",
    });
    expect(fixture.readRecoveryWorkspace).not.toHaveBeenCalled();
    await session.close({ reason: "failed semantic recovery rejected" });
  });

  it("rejects failed resultless terminals as disposition settlements", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-failed-resultless-recovery",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const terminalEvents = collectUntil(session.events(), "turn.completed");
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Attempt the task." },
    });
    fixture.finishTurn({ status: "completed", stopReason: "end_turn" });
    await terminalEvents;
    const snapshot = await session.snapshot();
    snapshot.terminalTurns = snapshot.terminalTurns?.map((terminal) => ({
      ...terminal,
      fingerprint: JSON.stringify({ status: "failed" }),
    }));

    for (const activeTurnId of [turnId, null]) {
      await expect(
        fixture.driver.recoverSession!({
          ...snapshot,
          activeTurnId,
        }),
      ).resolves.toEqual({
        recovered: false,
        reason:
          "persisted Codex ACPX resultless recovery requires a completed terminal turn",
      });
    }
    expect(fixture.readRecoveryWorkspace).not.toHaveBeenCalled();
    await session.close({ reason: "failed resultless recovery rejected" });
  });

  it("rejects a stale completed active turn before a later resultless failure", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-stale-resultless-recovery",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const terminalEvents = collectUntil(session.events(), "turn.completed");
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Complete without a semantic result." },
    });
    fixture.finishTurn({ status: "completed", stopReason: "end_turn" });
    await terminalEvents;
    const snapshot = await session.snapshot();
    snapshot.activeTurnId = turnId;
    snapshot.terminalTurns?.push({
      turnId: "turn-later-failed",
      fingerprint: JSON.stringify({ status: "failed" }),
    });

    await expect(fixture.driver.recoverSession!(snapshot)).resolves.toEqual({
      recovered: false,
      reason:
        "persisted Codex ACPX resultless recovery requires a completed terminal turn",
    });
    expect(fixture.readRecoveryWorkspace).not.toHaveBeenCalled();
    await session.close({ reason: "stale resultless recovery rejected" });
  });

  it("rejects an unimplemented replacement policy before reopening", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-policy-recovery",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const snapshot = await session.snapshot();
    snapshot.providerRecoveryPolicy = "allow_replacement_after_resume_failure";

    await expect(fixture.driver.recoverSession!(snapshot)).resolves.toEqual({
      recovered: false,
      reason: "persisted Codex ACPX recovery policy is unsupported",
    });
    expect(fixture.readRecoveryWorkspace).not.toHaveBeenCalled();
    expect(fixture.openHost).toHaveBeenCalledOnce();
    await session.close({ reason: "replacement recovery rejected" });
  });

  it("rejects oversized terminal history before reopening", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-bounded-recovery",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const snapshot = await session.snapshot();
    snapshot.terminalTurns = Array.from({ length: 4_097 }, (_, index) => ({
      turnId: `turn-${index}`,
      fingerprint: "terminal",
    }));

    await expect(fixture.driver.recoverSession!(snapshot)).resolves.toEqual({
      recovered: false,
      reason: "persisted Codex ACPX terminal history exceeds its limit",
    });
    expect(fixture.readRecoveryWorkspace).not.toHaveBeenCalled();
    expect(fixture.openHost).toHaveBeenCalledOnce();
    await session.close({ reason: "bounded recovery rejected" });
  });
});

function driverFixture(
  overrides: Partial<CodexAcpxDriverOptions> = {},
  fixtureOptions: {
    runtimeEvents?: readonly AcpRuntimeEvent[];
    runtimeEventFailure?: Promise<never>;
    closeSettlementTimeoutMs?: number;
    maxBufferedEvents?: number;
    terminalEventReserve?: number;
    openHost?: NonNullable<CodexAcpxDriverDependencies["openHost"]>;
    readRecoveryWorkspace?: NonNullable<
      CodexAcpxDriverDependencies["readRecoveryWorkspace"]
    >;
    eventStreamFailure?: Promise<void>;
  } = {},
): {
  driver: CodexAcpxDriver;
  host: ReturnType<typeof fakeHost>;
  openHost: ReturnType<typeof vi.fn>;
  readRecoveryWorkspace: ReturnType<typeof vi.fn>;
  hostOptions: OpenAcpxRuntimeHostOptions | null;
  finishTurn(result: Awaited<AcpxRuntimeTurn["result"]>): void;
} {
  let turnCount = 0;
  let activeResult: ReturnType<
    typeof deferred<Awaited<AcpxRuntimeTurn["result"]>>
  > | null = null;
  const createTurn = (): AcpxRuntimeTurn => {
    activeResult = deferred<Awaited<AcpxRuntimeTurn["result"]>>();
    return {
      requestId: `provider-turn-${++turnCount}`,
      promptStarted: Promise.resolve(),
      events: {
        async *[Symbol.asyncIterator]() {
          yield* fixtureOptions.runtimeEvents ?? [
            {
              type: "text_delta" as const,
              text: "Task complete.",
              stream: "output" as const,
            },
            {
              type: "tool_call" as const,
              toolCallId: "provider-tool-1",
              title: "Read",
              kind: "read" as const,
              status: "pending",
              tag: "tool_call",
              text: "Reading",
            },
          ];
          if (fixtureOptions.runtimeEventFailure) {
            await fixtureOptions.runtimeEventFailure;
          }
          if (fixtureOptions.eventStreamFailure) {
            await fixtureOptions.eventStreamFailure;
            throw new Error("provider event stream failed");
          }
        },
      },
      result: activeResult.promise,
      cancel: vi.fn(async () => undefined),
      closeStream: vi.fn(async () => undefined),
    };
  };
  const host = fakeHost(createTurn, () =>
    activeResult?.resolve({
      status: "cancelled",
      stopReason: "session_closed",
    }),
  );
  let hostOptions: OpenAcpxRuntimeHostOptions | null = null;
  const openHost = vi.fn(
    fixtureOptions.openHost ??
      (async (options: OpenAcpxRuntimeHostOptions) => {
        hostOptions = options;
        return host;
      }),
  );
  const readRecoveryWorkspace = vi.fn(
    fixtureOptions.readRecoveryWorkspace ??
      (async () => recoveryWorkspaceLease()),
  );
  const dependencies: CodexAcpxDriverDependencies = {
    openHost,
    readRecoveryWorkspace,
    closeSettlementTimeoutMs: fixtureOptions.closeSettlementTimeoutMs,
    maxBufferedEvents: fixtureOptions.maxBufferedEvents,
    terminalEventReserve: fixtureOptions.terminalEventReserve,
  };
  const driver = new CodexAcpxDriver(
    {
      runtimeDirectory: "/runtime",
      model: "gpt-5.6-sol",
      permissionMode: "approve-reads",
      dynamicTools: [
        {
          name: "documents.read",
          inputSchema: { type: "object" },
        },
      ],
      now: () => new Date("2026-08-27T12:00:00.000Z"),
      ...overrides,
    },
    dependencies,
  );
  return {
    driver,
    host,
    openHost,
    readRecoveryWorkspace,
    get hostOptions() {
      return hostOptions;
    },
    finishTurn(result) {
      if (!activeResult) throw new Error("No active fixture turn");
      activeResult.resolve(result);
    },
  };
}

function recoveryWorkspaceLease(
  path = "/workspace",
): AcpxRecoveryWorkspaceLease & {
  assertHeld: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    path,
    assertHeld: vi.fn(),
    close: vi.fn(async () => undefined),
  };
}

function fakeHost(createTurn: () => AcpxRuntimeTurn, onClose: () => void) {
  return {
    identity: () => ({
      schema: "paperclip.runner.acpx-identity.v1" as const,
      normalizedSessionId: "session-1",
      acpxRecordId: "record-1",
      backendSessionId: "backend-1",
      agentSessionId: "agent-1",
      profileDigest: `sha256:${"a".repeat(64)}`,
      workspaceDigest: `sha256:${"b".repeat(64)}`,
      requestedModel: "gpt-5.6-sol",
      effectiveModel: "gpt-5.6-sol",
      permissionMode: "approve-reads" as const,
    }),
    binding: () => ({
      normalizedSessionId: "session-1",
      workspacePath: "/workspace",
      workspaceDigest: `sha256:${"b".repeat(64)}`,
      runtimeRoot: "/runtime/acpx/session-1",
      profileDigest: `sha256:${"a".repeat(64)}`,
      requestedModel: "gpt-5.6-sol",
      effectiveModel: "gpt-5.6-sol",
      permissionMode: "approve-reads" as const,
      profileSessionKey: "paperclip-session",
    }),
    status: vi.fn(async () => ({
      agentSessionId: "agent-1",
      models: {
        currentModelId: "gpt-5.6-sol",
        availableModelIds: ["gpt-5.6-sol"],
      },
    })),
    startTurn: vi.fn((_input: AcpxRuntimeTurnInput) => createTurn()),
    interruptActiveTurn: vi.fn(async () => undefined),
    close: vi.fn(async () => {
      onClose();
    }),
  };
}

async function collectUntil(
  events: AsyncIterable<PrpEvent>,
  terminalType: PrpEvent["eventType"],
): Promise<PrpEvent[]> {
  const collected: PrpEvent[] = [];
  for await (const event of events) {
    collected.push(event);
    if (event.eventType === terminalType) return collected;
  }
  throw new Error(`Event stream closed before ${terminalType}`);
}

function completedResult() {
  return {
    schema: "paperclip.run_result.v1" as const,
    reportedWorkDisposition: "done" as const,
    summary: "The task is complete.",
    completionClaim: {
      contractRevision: "codex-acpx-test-v1",
      objectiveSatisfied: true,
      criteria: [],
      remainingWork: [],
    },
    evidence: [],
    verification: [
      { commandOrCheck: "Codex ACPX driver test", status: "passed" as const },
    ],
    attentionRequests: [],
    artifacts: [],
  };
}

function isCanonicalTurnTerminal(events: PrpEvent[], turnId: string) {
  return events.filter(
    (event) =>
      event.turnId === turnId &&
      (event.eventType === "turn.completed" ||
        event.eventType === "turn.failed" ||
        event.eventType === "turn.interrupted"),
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, reject, resolve };
}
