import {
  cp,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, vi, type Mock } from "vitest";
import type { PrpEvent } from "../../src/protocol/replay-contract.js";
import { DurablePrpControlPlane } from "../../src/control-plane/durable-prp-control-plane.js";
import * as durableControlPlane from "../../src/control-plane/durable-prp-control-plane.js";
import {
  createCapabilityRunnerdProviderEnvironment,
  drainRetainedRunnerdMaintenanceOperations,
  retainedRunnerdMaintenanceIsIdle,
  runnerdRecoveryInternals,
  settleRetainedRunnerdSession,
} from "../../src/live/runnerd-codex-transport.js";

export type MaintenanceReplaySnapshot = ReturnType<typeof maintenanceReplaySnapshot>;

export interface WithheldTerminalFrame {
  epoch: number;
  direction: "inbound" | "outbound";
  commandId: string;
  controllerSeq: number;
  count: number;
}

export function maintenanceReplaySnapshot(directory: string) {
  const bytes = [
    "control-plane/control-plane-state.json",
    "runner/runner-state.json",
    "runner/codex-provider-state.json",
  ].map((file) => readFileSync(join(directory, file)));
  return {
    control: JSON.parse(bytes[0]!.toString("utf8")),
    runner: JSON.parse(bytes[1]!.toString("utf8")),
    provider: JSON.parse(bytes[2]!.toString("utf8")),
    providerFingerprint: createHash("sha256").update(bytes[2]!).digest("hex"),
    fingerprint: createHash("sha256")
      .update(
        JSON.stringify(
          bytes.map((value) =>
            createHash("sha256").update(value).digest("hex"),
          ),
        ),
      )
      .digest("hex"),
  };
}

export async function verifyMissingHomeFailure(ctx: {
  input: Parameters<typeof settleRetainedRunnerdSession>[0];
  copy: string;
  copyProvider: string;
  original: string;
  files: string[];
  bytes: Buffer[];
  fakeState: string;
  originalProviderHome: Buffer | null;
  calls: string;
  fixtureRunner: string;
  identity: {
    runnerInstanceId: string;
    environmentLeaseId: string;
    runId: string;
    normalizedSessionId: string;
    turnId: string;
    itemId: string;
  };
  threadId: string;
  providerPid: number;
  providerProcessGeneration: number;
  unknownExit?: boolean;
  startupFailureProof?: boolean;
  appendEvent: Mock<(event: PrpEvent) => Promise<void>>;
  authorize: Mock<() => Promise<void>>;
  recordEpoch: Mock<(receipt: Record<string, unknown>) => Promise<void>>;
  start: Mock<() => Promise<never>>;
  execute: () => Promise<unknown>;
  dead: (pid: number) => boolean;
  stopAndJoinReplayProcess: (
    handle: ReturnType<typeof durableControlPlane.spawnRunner>,
  ) => Promise<void>;
}) {
  const {
    input,
    copy,
    copyProvider,
    original,
    files,
    bytes,
    fakeState,
    originalProviderHome,
    calls,
    fixtureRunner,
    identity,
    threadId,
    providerPid,
    providerProcessGeneration,
    unknownExit,
    startupFailureProof,
    appendEvent,
    authorize,
    recordEpoch,
    start,
    execute,
    dead,
    stopAndJoinReplayProcess,
  } = ctx;
  const startupEvents = () => appendEvent.mock.calls
    .map(([event]) => event)
    .filter((event) => event.eventType === "harness.diagnostic" &&
      event.payload.code === "provider_startup_ownership");
  let startupPhasesBeforeFailure: unknown[] | null = null;
  const launch = durableControlPlane.spawnRunner;
  const completions: Promise<unknown>[] = [];
  let releaseExit!: () => void;
  const exitGate = new Promise<void>((resolveExit) => {
    releaseExit = resolveExit;
  });
  const launchSpy = vi
    .spyOn(durableControlPlane, "spawnRunner")
    .mockImplementation((options) => {
      const handle = launch(options);
      const completion = handle.completion.then(async (result) => {
        // Model delayed delivery of the exact child's exit notification;
        // dispatching a kill is not itself a durable retirement receipt.
        if (unknownExit) await exitGate;
        else
          await new Promise((resolveExit) => setTimeout(resolveExit, 750));
        return result;
      });
      completions.push(completion);
      return { ...handle, completion };
    });
  authorize.mockImplementation(async () => {
    const current = JSON.parse(
      await readFile(join(copy, files[0]!), "utf8"),
    );
    if (
      current.commands.some(
        (command: { status: string }) => command.status === "failed",
      )
    ) {
      if (startupFailureProof && startupPhasesBeforeFailure === null)
        startupPhasesBeforeFailure = startupEvents().map((event) =>
          (event.payload.startup as Record<string, unknown>).phase);
      throw new Error("native_cleanup_maintenance_unproven");
    }
  });
  try {
    await expect(settleRetainedRunnerdSession(input)).rejects.toThrow(
      "native_cleanup_maintenance_unproven",
    );
    if (unknownExit) {
      expect(
        recordEpoch.mock.calls.some(
          ([receipt]) => receipt.phase === "retired",
        ),
      ).toBe(false);
      expect(retainedRunnerdMaintenanceIsIdle(copy)).toBe(false);
    }
  } finally {
    launchSpy.mockRestore();
    releaseExit();
    await Promise.allSettled(completions);
    await drainRetainedRunnerdMaintenanceOperations();
  }
  const receipts = recordEpoch.mock.calls.map(([receipt]) => receipt);
  const launched = receipts.filter(
    (receipt) => receipt.phase === "spawned",
  );
  expect(launched.length).toBeGreaterThan(0);
  for (const spawned of launched) {
    const retired = receipts.find(
      (receipt) =>
        receipt.phase === "retired" &&
        receipt.launchId === spawned.launchId,
    );
    if (unknownExit) expect(retired).toBeUndefined();
    else
      expect(retired).toMatchObject({
        pid: spawned.pid,
        processGroupAbsent: true,
      });
    expect(dead(Number(spawned.pid))).toBe(true);
    expect(dead(-Number(spawned.pid))).toBe(true);
  }
  const failed = JSON.parse(await readFile(join(copy, files[0]!), "utf8"));
  expect(
    failed.commands.some(
      (command: {
        type: string;
        result?: { result?: { message?: string } };
      }) =>
        command.type === "turn.stop" &&
        command.result?.result?.message?.includes("no rollout found"),
    ),
  ).toBe(true);
  expect(failed.commands.find((command: { type: string }) => command.type === "turn.stop")?.result?.result?.providerFailure)
    .toMatchObject({ provider: "openai", phase: "startup", category: "unknown", message: "no rollout found for thread id" });
  expect(await readFile(fakeState)).toEqual(originalProviderHome);
  expect(
    await Promise.all(files.map((file) => readFile(join(original, file)))),
  ).toEqual(bytes);
  await expect(execute()).rejects.toMatchObject({
    code: "native_session_cleanup_quarantined",
  });
  expect(start).toHaveBeenCalledOnce();
  const methods = (await readFile(calls, "utf8")).trim().split("\n");
  expect(methods.filter((method) => method === "turn/start")).toHaveLength(
    1,
  );
  if (startupFailureProof) {
    expect(startupPhasesBeforeFailure).toEqual([
      "intent", "spawned", "initialization_failed",
    ]);
    const events = startupEvents();
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.sourceSeq)).toEqual(
      events.map((event) => event.sourceSeq).sort((left, right) => left - right),
    );
    expect(new Set(events.map((event) => event.sourceEventId)).size).toBe(3);
    const facts = events.map((event) => event.payload.startup as Record<string, unknown>);
    const [intent, spawned, initializationFailed] = facts;
    expect(intent!.launchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(intent!.configurationFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    const failedStop = failed.commands.find((command: { type: string; status: string }) =>
      command.type === "turn.stop" && command.status === "failed");
    for (const fact of facts) {
      // Only an intent that has not reached the spawn carries beforeSpawn.
      expect(Object.keys(fact).sort()).toEqual([
        "schema", "launchId", "phase", "trigger", "attemptedProcessGeneration",
        "origin", "command", "configurationFingerprint", "requestedThreadId",
        "authenticatedThreadId", "processId", "processGroupId", "failedStage",
        "directChildExitObserved", "exitCode", "signal", "processTreeRetired",
        ...(fact === intent ? ["beforeSpawn"] : []),
      ].sort());
      expect(fact).toMatchObject({
        schema: "paperclip.provider_startup.v1",
        launchId: intent!.launchId,
        trigger: "restore",
        attemptedProcessGeneration: providerProcessGeneration + 1,
        origin: {
          runnerInstanceId: identity.runnerInstanceId,
          runId: identity.runId,
          normalizedSessionId: identity.normalizedSessionId,
          turnId: identity.turnId,
          itemId: identity.itemId,
        },
        command: {
          commandId: failedStop.commandId,
          controllerSeq: failedStop.controllerSeq,
          commandType: "turn.stop",
        },
        configurationFingerprint: intent!.configurationFingerprint,
        requestedThreadId: threadId,
        authenticatedThreadId: null,
        processTreeRetired: false,
      });
    }
    expect(intent).toMatchObject({
      phase: "intent", beforeSpawn: true, processId: null, processGroupId: null,
      directChildExitObserved: false, failedStage: null, exitCode: null, signal: null,
    });
    expect(spawned!.processId).toBeGreaterThan(0);
    expect(spawned).toMatchObject({
      phase: "spawned", processGroupId: spawned!.processId,
      directChildExitObserved: false, failedStage: null, exitCode: null, signal: null,
    });
    expect(initializationFailed).toMatchObject({
      phase: "initialization_failed", failedStage: "thread_open",
      processId: spawned!.processId, processGroupId: spawned!.processId,
      directChildExitObserved: true,
    });
    expect(dead(Number(spawned!.processId))).toBe(true);
    expect(appendEvent.mock.calls.filter(([event]) =>
      ["session.started", "session.resumed"].includes(event.eventType) &&
      event.payload.processId !== providerPid)).toHaveLength(0);
    expect(failed.commands.some((command: {
      type: string; result?: { result?: { providerExitConfirmed?: boolean } };
    }) => command.type === "turn.stop" &&
      command.result?.result?.providerExitConfirmed === true)).toBe(false);
    const deltas = appendEvent.mock.calls.map(([event]) => event.payload.delta)
      .filter((delta) => typeof delta === "string" && delta.startsWith("maintenance-"));
    expect(deltas).toHaveLength(218);
    expect(new Set(deltas).size).toBe(218);
    const failedProviderState = JSON.parse(await readFile(copyProvider, "utf8"));
    expect(failedProviderState.startupAttempt).toMatchObject({
      launchId: intent!.launchId,
    });
    const observedMethods = await readFile(calls, "utf8");
    expect(observedMethods.trim().split("\n").filter((method) =>
      method === "process-start")).toHaveLength(2);
    const originalFailure = structuredClone(failedStop.result);
    // Exercise the producer fence directly in this isolated fixture.
    // This does not admit the failed copy through maintenance or alter
    // its source/receipt bytes to manufacture recovery eligibility.
    for (let restart = 0; restart < 2; restart++) {
      const replayCore = new DurablePrpControlPlane({
        stateDirectory: join(copy, "control-plane"),
        identity,
        expectedRunnerVersion: "0.3.0",
        expectedRunnerDigest: `sha256:${createHash("sha256")
          .update(await readFile(fixtureRunner)).digest("hex")}`,
        onCommittedEvent: appendEvent,
      });
      const snapshot = replayCore.queueCommand("session.snapshot", {});
      const stop = replayCore.queueCommand("turn.stop", {
        reason: "startup-fence regression only",
      });
      let replayHandle: ReturnType<typeof durableControlPlane.spawnRunner> | null = null;
      let replayAssertionFailed = false;
      try {
        await replayCore.start();
        const runnerState = JSON.parse(await readFile(join(copy, files[1]!), "utf8"));
        replayHandle = durableControlPlane.spawnRunner({
          connectUrl: replayCore.connectUrl,
          stateDirectory: join(copy, "runner"),
          identity,
          ticket: replayCore.issueBootstrapTicket(),
          maxOutboxBytes: runnerState.maxOutboxBytes,
          p0ReserveBytes: runnerState.p0ReserveBytes,
          maxRuntimeMs: 2_000,
          reconnectGraceMs: 1_000,
          runnerBinaryPath: fixtureRunner,
          runnerVersion: "0.3.0",
          runnerDigest: `sha256:${createHash("sha256")
            .update(await readFile(fixtureRunner)).digest("hex")}`,
          environment: createCapabilityRunnerdProviderEnvironment({
            provider: "codex",
            options: {},
            identity,
            codexHome: join(copy, "codex-home"),
            runtimeContextPath: join(copy, "runtime-context.json"),
            hasRuntimeContext: false,
          }),
        });
        await vi.waitFor(() => {
          for (const queued of [snapshot, stop]) {
            const command = replayCore.getCommand(queued.commandId);
            expect(command?.status).toBe("failed");
            expect(command?.result).toMatchObject({
              result: {
                message: expect.stringContaining(
                  "provider startup ownership remains unadmitted",
                ),
              },
            });
          }
        }, { timeout: 5_000 });
        await durableControlPlane.waitForProcess(replayHandle, 5_000);
        expect(await readFile(calls, "utf8")).toBe(observedMethods);
        expect((await readFile(calls, "utf8")).trim().split("\n")
          .filter((method) => method === "process-start")).toHaveLength(2);
        expect(replayCore.store.state.commands.find((command) =>
          command.commandId === failedStop.commandId)?.result).toEqual(originalFailure);
        expect(JSON.parse(await readFile(copyProvider, "utf8")).startupAttempt)
          .toEqual(failedProviderState.startupAttempt);
        expect(startupEvents()).toHaveLength(3);
      } catch (error) {
        replayAssertionFailed = true;
        throw error;
      } finally {
        try {
          if (replayHandle) await stopAndJoinReplayProcess(replayHandle);
        } catch (error) {
          // Keep the original assertion as the primary failure. Do not
          // delete evidence underneath an unjoined owned process.
          if (!replayAssertionFailed) throw error;
          console.error("startup-proof fixture cleanup unproven; directory retained");
        } finally {
          await replayCore.stop();
        }
      }
    }
    expect(await readFile(fakeState)).toEqual(originalProviderHome);
    expect(await Promise.all(files.map((file) => readFile(join(original, file)))))
      .toEqual(bytes);
  }
}

export async function setupTerminalReplayFixture(ctx: {
  input: Parameters<typeof settleRetainedRunnerdSession>[0];
  original: string;
  copy: string;
  activated: string;
  files: string[];
  bytes: Buffer[];
  threadId: string;
  appendEvent: Mock<(event: PrpEvent) => Promise<void>>;
  recordEpoch: Mock<(receipt: Record<string, unknown>) => Promise<void>>;
}) {
  const {
    input,
    original,
    copy,
    activated,
    files,
    bytes,
    threadId,
    appendEvent,
    recordEpoch,
  } = ctx;
  // Forward failures now preserve a startup fence. Keep this genuinely
  // produced failed copy intact; it is NOT a legacy replay candidate.
  await expect(
    settleRetainedRunnerdSession({
      ...input,
      environment: undefined,
      sourceCodexHome: null,
    }),
  ).rejects.toThrow("native_cleanup_maintenance_unproven");
  const failedBytes = await Promise.all(
    files.map((file) => readFile(join(copy, file))),
  );
  expect(
    JSON.parse(failedBytes[2]!.toString("utf8")).startupAttempt,
  ).toMatchObject({
    schema: "paperclip.provider_startup.v1",
    phase: "initialization_failed",
    failedStage: "spawn",
    requestedThreadId: threadId,
    authenticatedThreadId: null,
    processId: null,
    directChildExitObserved: false,
    processTreeRetired: false,
  });
  expect(
    appendEvent.mock.calls
      .filter(
        ([event]) => event.payload.code === "provider_startup_ownership",
      )
      .map(
        ([event]) => (event.payload.startup as { phase: string }).phase,
      ),
  ).toEqual(["intent", "initialization_failed"]);
  expect(
    await Promise.all(
      files.map((file) => readFile(join(original, file))),
    ),
  ).toEqual(bytes);
  await expect(
    readFile(join(activated, files[1]!)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  const failedStartupDirectory = join(
    original,
    "..",
    "failed-startup-attempt",
  );
  await rename(copy, failedStartupDirectory);
  const failedStartupAttempt = {
    directory: failedStartupDirectory,
    bytes: failedBytes,
  };

  // Backward-compatibility fixture, synthesized ONLY from the pristine
  // original snapshots: old producers recorded terminal failure without
  // a startup-attempt field. Never delete a real generated fence above.
  const directory = join(original, "..", "legacy-failed-terminal");
  await cp(original, directory, { recursive: true });
  const legacyControl = JSON.parse(bytes[0]!.toString("utf8"));
  const legacyRunner = JSON.parse(bytes[1]!.toString("utf8"));
  expect(
    JSON.parse(bytes[2]!.toString("utf8")).startupAttempt ?? null,
  ).toBeNull();
  const legacyCommands = legacyControl.commands.slice(-2);
  expect(
    legacyCommands.map((command: { type: string }) => command.type),
  ).toEqual(["turn.stop", "runner.suspend"]);
  for (const command of legacyCommands) {
    const wire = {
      schema: command.schema,
      commandId: command.commandId,
      controllerSeq: command.controllerSeq,
      type: command.type,
      issuedAt: command.issuedAt,
      deadlineAt: null,
      precondition: null,
      payload: command.payload,
    };
    const result = {
      commandId: command.commandId,
      commandType: command.type,
      controllerSeq: command.controllerSeq,
      status: "failed",
      result: {
        code: "command_execution_failed",
        message: "legacy pre-start failure fixture",
      },
    };
    command.status = "failed";
    command.result = result;
    legacyRunner.processedCommands[command.commandId] = result;
    legacyRunner.processedCommandFingerprints[command.commandId] =
      createHash("sha256")
        .update(
          durableControlPlane.durableRecoveryInternals.canonicalJson(wire),
        )
        .digest("hex");
    legacyRunner.lastControllerCommandSeq = command.controllerSeq;
  }
  const terminal = legacyCommands[1]!;
  legacyRunner.lifecycle = "suspended";
  legacyRunner.pendingTerminalDelivery = {
    commandId: terminal.commandId,
    controllerSeq: terminal.controllerSeq,
    commandType: terminal.type,
    lifecycle: "suspended",
  };
  await writeFile(
    join(directory, files[0]!),
    JSON.stringify(legacyControl),
  );
  await writeFile(
    join(directory, files[1]!),
    JSON.stringify(legacyRunner),
  );
  const legacyBytes = await Promise.all(
    files.map((file) => readFile(join(directory, file))),
  );
  expect(legacyBytes[2]).toEqual(bytes[2]);
  expect(
    legacyControl.commands
      .slice(-2)
      .map((command: { status: string }) => command.status),
  ).toEqual(["failed", "failed"]);
  await cp(directory, copy, { recursive: true });
  const failedAttempt = { directory, bytes: legacyBytes };
  input.sourceFingerprint = createHash("sha256")
    .update(
      JSON.stringify(
        legacyBytes.map((value) =>
          createHash("sha256").update(value).digest("hex"),
        ),
      ),
    )
    .digest("hex");
  input.requestId = "maintenance-fixture-continuation";
  recordEpoch.mockClear();
  appendEvent.mockClear();
  return { failedAttempt, failedStartupAttempt };
}

export async function verifyRepeatTerminalAck(ctx: {
  pendingProof: ReturnType<typeof settleRetainedRunnerdSession>;
  replayRetirements: MaintenanceReplaySnapshot[];
  withheldTerminalFrames: WithheldTerminalFrame[];
  recordEpoch: Mock<(receipt: Record<string, unknown>) => Promise<void>>;
  activated: string;
  original: string;
  files: string[];
  bytes: Buffer[];
  calls: string;
  execute: () => Promise<unknown>;
}) {
  const {
    pendingProof,
    replayRetirements,
    withheldTerminalFrames,
    recordEpoch,
    activated,
    original,
    files,
    bytes,
    calls,
    execute,
  } = ctx;
  await expect(pendingProof).rejects.toThrow(
    "native_cleanup_maintenance_unproven",
  );
  expect(replayRetirements).toHaveLength(2);
  expect(
    withheldTerminalFrames.map(({ epoch, direction }) => ({
      epoch,
      direction,
    })),
  ).toEqual([
    { epoch: 0, direction: "inbound" },
    { epoch: 1, direction: "inbound" },
  ]);
  for (const [epoch, state] of replayRetirements.entries()) {
    expect(JSON.stringify(state.runner.diagnostics)).toContain(
      "terminal command result acknowledgement timed out",
    );
    expect(state.runner.pendingTerminalDelivery).toMatchObject({
      commandType: "runner.suspend",
      lifecycle: "suspended",
    });
    const withheld = withheldTerminalFrames[epoch]!;
    expect(withheld.count).toBeGreaterThan(0);
    expect(state.runner.pendingTerminalDelivery).toMatchObject({
      commandId: withheld.commandId,
      controllerSeq: withheld.controllerSeq,
    });
    expect(
      state.runner.processedCommands[withheld.commandId],
    ).toMatchObject({
      status: "completed",
      result: { status: "completed" },
    });
    expect(
      state.control.commands.find(
        (command: { commandId: string }) =>
          command.commandId === withheld.commandId,
      ),
    ).toMatchObject({ status: "pending" });
  }
  expect(replayRetirements[1]!.provider).toEqual(
    replayRetirements[0]!.provider,
  );
  expect(recordEpoch.mock.calls).toHaveLength(6);
  await expect(
    readFile(join(activated, "runner/runner-state.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(execute()).rejects.toMatchObject({
    code: "native_session_cleanup_quarantined",
  });
  expect(
    await Promise.all(
      files.map((file) => readFile(join(original, file))),
    ),
  ).toEqual(bytes);
  const methods = (await readFile(calls, "utf8")).trim().split("\n");
  expect(
    methods.filter((method) => method === "turn/start"),
  ).toHaveLength(1);
  // The first cleanup epoch restored the old provider solely to stop
  // it; the failed delivery-only replay did not restore it again.
  expect(
    methods.filter((method) => method === "thread/resume"),
  ).toHaveLength(1);
}

export async function formatSettlementFailure(ctx: {
  error: unknown;
  copy: string;
  appendEvent: Mock<(event: PrpEvent) => Promise<void>>;
  recordEpoch: Mock<(receipt: Record<string, unknown>) => Promise<void>>;
}): Promise<never> {
  const { error, copy, appendEvent, recordEpoch } = ctx;
  const runner = JSON.parse(
    await readFile(join(copy, "runner/runner-state.json"), "utf8"),
  );
  const provider = JSON.parse(
    await readFile(
      join(copy, "runner/codex-provider-state.json"),
      "utf8",
    ),
  );
  const control = JSON.parse(
    await readFile(
      join(copy, "control-plane/control-plane-state.json"),
      "utf8",
    ),
  );
  throw new Error(
    JSON.stringify({
      runner: {
        lifecycle: runner.lifecycle,
        outbox: runner.outbox.length,
        acked: runner.ackedSourceSeq,
        next: runner.nextSourceSeq,
        terminalAckTimedOut: JSON.stringify(
          runner.diagnostics,
        ).includes("terminal command result acknowledgement timed out"),
        pendingTerminalDelivery:
          runner.pendingTerminalDelivery ?? null,
        retainedIdentityTypes: runner.outbox
          .filter((row: { eventType: string }) =>
            [
              "session.started",
              "session.resumed",
              "harness.ready",
            ].includes(row.eventType),
          )
          .map((row: { sourceSeq: number; eventType: string }) => ({
            sourceSeq: row.sourceSeq,
            eventType: row.eventType,
          })),
      },
      provider: {
        lifecycle: provider.lifecycle,
        pending: provider.pendingEvents.length,
        queued: provider.queuedEvents.length,
        generation: provider.providerProcessGeneration,
      },
      commands: control.commands.map(
        (command: { type: string; status: string }) => ({
          type: command.type,
          status: command.status,
        }),
      ),
      committedCount: appendEvent.mock.calls.length,
      epochExits: recordEpoch.mock.calls
        .map(([receipt]) => receipt)
        .filter((receipt) => receipt.phase === "retired")
        .map((receipt) => ({
          epoch: receipt.epoch,
          exitCode: receipt.exitCode,
          exitSignal: receipt.exitSignal,
        })),
    }),
    { cause: error },
  );
}

export async function verifyCompletedTerminalAck(ctx: {
  input: Parameters<typeof settleRetainedRunnerdSession>[0];
  directory: string;
  files: string[];
  completedTerminalAck: "pending" | "completed" | "repeat";
  replayRetirements: MaintenanceReplaySnapshot[];
  withheldTerminalFrames: WithheldTerminalFrame[];
}) {
  const {
    input,
    directory,
    files,
    completedTerminalAck,
    replayRetirements,
    withheldTerminalFrames,
  } = ctx;
  const before = replayRetirements[0]!;
  const after = replayRetirements[1]!;
  expect(withheldTerminalFrames).toHaveLength(1);
  expect(withheldTerminalFrames[0]).toMatchObject({
    epoch: 0,
    direction:
      completedTerminalAck === "completed" ? "outbound" : "inbound",
  });
  expect(withheldTerminalFrames[0]!.count).toBeGreaterThan(0);
  expect(JSON.stringify(before.runner.diagnostics)).toContain(
    "terminal command result acknowledgement timed out",
  );
  const pending = before.runner.pendingTerminalDelivery;
  expect(pending).toMatchObject({
    commandType: "runner.suspend",
    lifecycle: "suspended",
    commandId: withheldTerminalFrames[0]!.commandId,
    controllerSeq: withheldTerminalFrames[0]!.controllerSeq,
  });
  expect(before.runner.processedCommands[pending.commandId].status).toBe(
    "completed",
  );
  expect(
    before.control.commands.find(
      (command: { commandId: string }) =>
        command.commandId === pending.commandId,
    ).status,
  ).toBe(completedTerminalAck);
  expect(
    runnerdRecoveryInternals.completedMaintenanceTerminalReceipt(before),
  ).not.toBeNull();
  expect(
    runnerdRecoveryInternals.completedMaintenanceTerminalReplayMatches(
      before,
      after,
    ),
  ).toBe(true);
  expect(after.provider).toEqual(before.provider);
  expect(after.runner.pendingProviderCleanup ?? null).toBeNull();
  // An actual completed receipt copied into an INITIAL invocation is
  // not this invocation's joined retirement and cannot enable replay.
  const initialTerminal = join(directory, "unproved-initial-terminal");
  await mkdir(join(initialTerminal, "runner"), { recursive: true });
  await mkdir(join(initialTerminal, "control-plane"));
  for (const [index, value] of [
    before.control,
    before.runner,
    before.provider,
  ].entries())
    await writeFile(
      join(initialTerminal, files[index]!),
      JSON.stringify(value),
    );
  const unproved = maintenanceReplaySnapshot(initialTerminal);
  const initialEpoch = vi.fn(async () => {});
  await expect(
    settleRetainedRunnerdSession({
      ...input,
      stateDirectory: initialTerminal,
      sourceFingerprint: unproved.fingerprint,
      recordEpoch: initialEpoch,
    }),
  ).rejects.toThrow("native_cleanup_maintenance_unproven");
  expect(initialEpoch).not.toHaveBeenCalled();
  const receiptCases: Array<[string, (state: typeof before) => void]> = [
    [
      "missing result",
      (state) => {
        delete state.runner.processedCommands[pending.commandId];
      },
    ],
    ...["pending", "failed", "rejected", "indeterminate"].map(
      (status): [string, (state: typeof before) => void] => [
        `outer ${status}`,
        (state) => {
          state.runner.processedCommands[pending.commandId].status = status;
        },
      ],
    ),
    ...["failed", "rejected", "indeterminate"].map(
      (status): [string, (state: typeof before) => void] => [
        `nested ${status}`,
        (state) => {
          state.runner.processedCommands[pending.commandId].result.status =
            status;
        },
      ],
    ),
    [
      "terminal sequence",
      (state) => {
        state.runner.pendingTerminalDelivery.controllerSeq++;
      },
    ],
    [
      "terminal type",
      (state) => {
        state.runner.pendingTerminalDelivery.commandType = "runner.shutdown";
      },
    ],
    [
      "wire fingerprint",
      (state) => {
        state.control.commands.find(
          (command: { commandId: string }) =>
            command.commandId === pending.commandId,
        ).payload = { changed: true };
      },
    ],
    [
      "completed controller result",
      (state) => {
        const command = state.control.commands.find(
          (entry: { commandId: string }) =>
            entry.commandId === pending.commandId,
        );
        command.status = "completed";
        command.result = { changed: true };
      },
    ],
    [
      "earlier pending command",
      (state) => {
        const command = state.control.commands.find(
          (entry: { commandId: string }) =>
            entry.commandId === pending.commandId,
        );
        command.status = "pending";
        delete command.result;
        state.control.commands[0].status = "pending";
      },
    ],
    [
      "active provider",
      (state) => {
        state.provider.activeProviderTurnId = "another-turn";
      },
    ],
    [
      "provider cleanup",
      (state) => {
        state.runner.pendingProviderCleanup = pending;
      },
    ],
  ];
  for (const [name, mutate] of receiptCases) {
    const changed = structuredClone(before);
    mutate(changed);
    expect(
      runnerdRecoveryInternals.completedMaintenanceTerminalReceipt(changed),
      name,
    ).toBeNull();
  }
  for (const [name, mutate] of [
    [
      "other command",
      (state: typeof after) => {
        state.control.commands[0].result = { changed: true };
      },
    ],
    [
      "provider bytes",
      (state: typeof after) => {
        state.providerFingerprint = "changed";
      },
    ],
    [
      "pending delivery",
      (state: typeof after) => {
        state.runner.pendingTerminalDelivery = pending;
      },
    ],
    [
      "processed receipt",
      (state: typeof after) => {
        state.runner.processedCommands[pending.commandId].result = {
          changed: true,
        };
      },
    ],
  ] as const) {
    const changed = structuredClone(after);
    mutate(changed);
    expect(
      runnerdRecoveryInternals.completedMaintenanceTerminalReplayMatches(
        before,
        changed,
      ),
      name,
    ).toBe(false);
  }
}
