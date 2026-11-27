import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, vi } from "vitest";
import type { ControlPlanePort } from "../../src/contracts/control-plane-port.js";
import type { NativeExecutionInputV1 } from "../../src/contracts/native-execution.js";
import type {
  NativeSession,
  NativeSessionBackend,
} from "../../src/contracts/native-session-backend.js";
import type { PrpEvent } from "../../src/protocol/replay-contract.js";
import { completeRetainedNativeSessionCleanup, executeNativeSession } from "../../src/native-session-runtime.js";
import { NativeSessionCloseUnrecoverableError } from "../../src/contracts/native-session-backend.js";
import * as durableControlPlane from "../../src/control-plane/durable-prp-control-plane.js";
import {
  createCapabilityRunnerdCodexTransport,
  defaultCapabilityRunnerdBinary as qualifiedCapabilityRunnerdBinary,
  drainRetainedRunnerdMaintenanceOperations,
  resolveRunnerdSessionIdentity,
  settleRetainedRunnerdSession,
  retainedRunnerdCleanupProofIsCurrent,
  retainedRunnerdMaintenanceIsIdle,
  waitForRetainedRunnerdMaintenanceIdle,
} from "../../src/live/runnerd-codex-transport.js";
import {
  formatSettlementFailure,
  maintenanceReplaySnapshot,
  setupTerminalReplayFixture,
  verifyCompletedTerminalAck,
  verifyMissingHomeFailure,
  verifyRepeatTerminalAck,
  type MaintenanceReplaySnapshot,
  type WithheldTerminalFrame,
} from "./runnerd-settlement-assertions.js";
import {
  attachWithheldTerminalAckSpy,
  RETAINED_STATE_FILES,
  seedRetainedOutboxAndProviderEvents,
} from "./runnerd-settlement-fixture.js";

export interface RetainedSettlementCase {
  alreadyEnded: boolean;
  appendFailure: boolean;
  bareCodex?: boolean;
  epochFailure?: "launch_intent" | "spawned" | "retired";
  terminalReplay?: boolean;
  holdSpawned?: boolean;
  completedTerminalAck?: "pending" | "completed" | "repeat";
  finalRetirementRevocation?: "abort" | "revoked" | "during_authorize";
  homeScoped?: boolean;
  missingHome?: boolean;
  unknownExit?: boolean;
  startupFailureProof?: boolean;
}

export const SETTLEMENT_TEST_TITLE =
  "settles only retained control authority without starting another provider turn ($alreadyEnded/$appendFailure/$bareCodex/$epochFailure/$terminalReplay/$holdSpawned/$homeScoped/$missingHome/$unknownExit) startup-failure-proof=$startupFailureProof completed-ack=$completedTerminalAck retired-revocation=$finalRetirementRevocation";

// Explicit private-artifact test lane; production/default dist is never changed.
const defaultCapabilityRunnerdBinary = () =>
  process.env.PAPERCLIP_ATTACH_TRANSITION_RUNNER ??
  qualifiedCapabilityRunnerdBinary();

function maintenanceFixtureBackendName(fixtureId: string): string {
  return `maintenance-test-${fixtureId}`;
}

export async function runRetainedSettlementCase({
  alreadyEnded,
  appendFailure,
  bareCodex,
  epochFailure,
  terminalReplay,
  holdSpawned,
  completedTerminalAck,
  finalRetirementRevocation,
  homeScoped,
  missingHome,
  unknownExit,
  startupFailureProof,
}: RetainedSettlementCase) {
  const replaySpyRestorers: Array<() => void> = [];
  const replayRetirements: MaintenanceReplaySnapshot[] = [];
  const withheldTerminalFrames: WithheldTerminalFrame[] = [];
  const fixtureId = randomUUID();
  const fixtureRunner = defaultCapabilityRunnerdBinary();
  const directory = await mkdtemp(join(tmpdir(), "runnerd-maintenance-"));
  const original = join(directory, "original");
  const copy = join(directory, "copy");
  const activated = join(directory, "activated");
  const home = join(directory, "source-home");
  await mkdir(home);
  const fakeCodex = resolve(
    import.meta.dirname,
    "../../runner/target/debug/fake-codex-app-server",
  );
  const bin = join(directory, "provider-bin");
  if (bareCodex) {
    await mkdir(bin);
    await symlink(fakeCodex, join(bin, "codex"));
    await writeFile(
      join(home, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "fixture-only-not-a-secret" }),
    );
  }
  const environment = bareCodex
    ? { PATH: bin, HOME: home, CODEX_HOME: home }
    : undefined;
  const calls = join(directory, "calls.log");
  const fakeState = homeScoped
    ? join(original, "codex-home/fake-codex-state.json")
    : join(directory, "fake.json");
  const identity = {
    runnerInstanceId: "runner-maintenance",
    environmentLeaseId: "lease-maintenance",
    runId: "run-maintenance",
    normalizedSessionId: "session-maintenance",
    turnId: "turn-maintenance",
    itemId: "item-maintenance",
  };
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: fixtureRunner,
    codexCommand: bareCodex ? "codex" : fakeCodex,
    environment,
    codexArgs: [
      ...(homeScoped
        ? ["--state-file-in-codex-home", "--require-existing-resume-state"]
        : ["--state-file", fakeState]),
      "--call-log",
      calls,
      ...(startupFailureProof ? ["--record-process-start"] : []),
      "--hold-turn",
    ],
    sourceCodexHome: home,
    stateDirectory: original,
    prpIdentity: identity,
  });
  const dead = (pid: number) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  };
  let runnerPid = 0;
  let providerPid = 0;
  let retainFixtureForUnprovenExit = false;
  const stopAndJoinReplayProcess = async (
    handle: ReturnType<typeof durableControlPlane.spawnRunner>,
  ) => {
    // This helper may time out immediately after dispatching SIGKILL. Its
    // return/rejection alone is not proof that this exact child has exited.
    await durableControlPlane.waitForProcess(handle, 250).catch(() => undefined);
    let deadline: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        handle.completion,
        new Promise<never>((_resolveJoin, rejectJoin) => {
          deadline = setTimeout(() => rejectJoin(new Error(
            "startup-proof fixture could not join its exact runner child",
          )), 5_000);
        }),
      ]);
      if (handle.processGroupId && !dead(-handle.processGroupId)) {
        try { process.kill(-handle.processGroupId, "SIGKILL"); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      await vi.waitFor(() => {
        expect(handle.child.pid && dead(handle.child.pid)).toBe(true);
        expect(handle.processGroupId && dead(-handle.processGroupId)).toBe(true);
      }, { timeout: 2_000 });
    } catch (error) {
      retainFixtureForUnprovenExit = true;
      throw error;
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
    }
  };
  try {
    const thread = (await bundle.transport.request("thread/start", {
      cwd: directory,
      dynamicTools: [],
    })) as { thread: { id: string } };
    await bundle.transport.request("turn/start", {
      threadId: thread.thread.id,
      input: [{ type: "text", text: "Keep the original turn only" }],
    });
    runnerPid = bundle.evidence().runnerPid!;
    providerPid = bundle.evidence().providerPid!;
    expect(runnerPid).toBeGreaterThan(0);
    expect(providerPid).toBeGreaterThan(0);
    await bundle.detachControllerForRestart();
    // The provider can exit when its runner dies. An already-gone process
    // group satisfies teardown; still fail on other signal errors and join below.
    for (const pid of [runnerPid, providerPid]) {
      try { process.kill(-pid, "SIGKILL"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await vi.waitFor(() => {
      expect(dead(runnerPid)).toBe(true);
      expect(dead(providerPid)).toBe(true);
    });
    const files = RETAINED_STATE_FILES;
    const {
      providerProcessGeneration,
      originalProviderHome,
      bytes,
      sourceFingerprint,
    } = await seedRetainedOutboxAndProviderEvents({
      original,
      copy,
      fakeState,
      fixtureRunner,
      identity,
      alreadyEnded,
      missingHome,
      homeScoped,
      completedTerminalAck,
    });
    const appendEvent = vi.fn(async (_event: PrpEvent) => {
      // Reproduce slow durable commits without extending the runtime ACK
      // deadline: all 218 retained events still have to commit exactly once.
      if (completedTerminalAck === "completed") {
        await new Promise((resolveCommit) => setTimeout(resolveCommit, 30));
      }
    });
    const maintenanceAbort = new AbortController();
    let finalAuthorityRevoked = false;
    const authorize = vi.fn(async () => {
      if (finalAuthorityRevoked) {
        if (finalRetirementRevocation === "during_authorize") {
          maintenanceAbort.abort(new Error("retirement_authority_revoked"));
          return;
        }
        throw new Error("retirement_authority_revoked");
      }
    });
    const recordEpoch = vi.fn(
      async (_receipt: Record<string, unknown>) => {},
    );
    const input = {
      requestId: "maintenance-fixture-request",
      binding: {
        companyId: "company-maintenance",
        issueId: "issue-maintenance",
        agentId: "agent-maintenance",
        runId: identity.runId,
        sessionId: identity.normalizedSessionId,
      },
      backend: {
        kind: "runner" as const,
        name: maintenanceFixtureBackendName(fixtureId),
      },
      identity,
      stateDirectory: copy,
      activationDirectory: activated,
      sourceFingerprint,
      providerSessionId: thread.thread.id,
      originalRunnerPid: runnerPid,
      originalProviderPid: providerPid,
      runnerBinary: fixtureRunner,
      sourceCodexHome: bareCodex ? undefined : home,
      environment,
      authorize,
      appendEvent,
      recordEpoch,
      signal: maintenanceAbort.signal,
    };
    const close = vi.fn(async (): Promise<void> => {
      throw new NativeSessionCloseUnrecoverableError();
    });
    const start = vi.fn(async () => {
      throw new Error("fixture admission reached");
    });
    const capabilities = {
      resume: true,
      typedEvents: true,
      steering: false,
      interruption: true,
      structuredResult: true,
    };
    const session: NativeSession = {
      identity: () => input.binding,
      capabilities: async () => capabilities,
      events: async function* () {},
      startTurn: start,
      result: async () => { throw new Error("fixture never produces a result"); },
      close,
      snapshot: async () => ({
        backendKind: "runner",
        sessionId: input.binding.sessionId,
        identity: input.binding,
        providerSessionId: thread.thread.id,
        cursor: null,
        activeTurnId: null,
        pendingRuntimeRequests: [],
        lineage: [],
      }),
    };
    const backend: NativeSessionBackend = {
      descriptor: async () => ({
        ...input.backend,
        version: "1",
        capabilities,
      }),
      openSession: async () => session,
    };
    const nativeInput: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1",
      binding: {
        companyId: input.binding.companyId,
        issueId: input.binding.issueId,
        agentId: input.binding.agentId,
        runId: input.binding.runId,
        executionWorkspaceId: "workspace-maintenance",
      },
      task: {
        identifier: "MAINT-1",
        title: "Fixture",
        description: null,
        prompt: "Fixture",
        workMode: "standard",
      },
      workspace: {
        cwd: directory,
        repoUrl: null,
        repoRef: null,
        branchName: null,
      },
      provider: { kind: "codex", model: null },
      session: {
        normalizedSessionId: input.binding.sessionId,
        driverKind: "codex_app_server",
        protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      },
      completionContract: {
        id: "contract-maintenance",
        sha256: "contract-maintenance-sha",
        schemaVersion: "paperclip.completion-contract.v1",
        contract: {
          revision: "1",
          objective: "Fixture",
          criteria: [{ id: "objective", requirement: "Fixture" }],
        },
      },
      interactionResponses: [],
      credentialBindings: [],
    };
    const port: ControlPlanePort = {
      openRun: async () => {},
      checkpointSession: async () => {},
      completeRun: async () => {},
      replayEvents: async () => ({
        events: [],
        highestContiguousSourceSeq: 0,
      }),
      appendEvent: async () => ({
        cursor: 1,
        highestContiguousSourceSeq: 1,
        disposition: "committed",
      }),
    };
    const execute = () =>
      executeNativeSession({
        input: nativeInput,
        backend,
        controlPlane: port,
        runnerInstanceId: identity.runnerInstanceId,
        controlPlaneInstanceId: "control-maintenance",
        requireSessionCloseBeforeReturn: true,
      });
    await expect(execute()).rejects.toThrow();
    await expect(execute()).rejects.toMatchObject({
      code: "native_session_cleanup_quarantined",
    });
    expect(start).toHaveBeenCalledOnce();
    if (holdSpawned) {
      // A preceding row can fail before its authenticated cleanup proof.
      // That sticky quarantine must remain, but must not contaminate the
      // next independent fixture's backend domain in the same worker.
      const independentStart = vi.fn(async () => {
        throw new Error("independent fixture admission reached");
      });
      const independentBackend: NativeSessionBackend = {
        descriptor: async () => ({
          ...(await backend.descriptor()),
          name: maintenanceFixtureBackendName(`${fixtureId}-following`),
        }),
        openSession: async () => ({
          ...session,
          startTurn: independentStart,
          close: async () => {},
        }),
      };
      await expect(executeNativeSession({
        input: nativeInput,
        backend: independentBackend,
        controlPlane: port,
        runnerInstanceId: identity.runnerInstanceId,
        controlPlaneInstanceId: "independent-control-maintenance",
        requireSessionCloseBeforeReturn: true,
      })).rejects.toThrow("independent fixture admission reached");
      expect(independentStart).toHaveBeenCalledOnce();
      await expect(execute()).rejects.toMatchObject({
        code: "native_session_cleanup_quarantined",
      });
      expect(start).toHaveBeenCalledOnce();
    }
    await expect(
      settleRetainedRunnerdSession({
        ...input,
        originalProviderPid: process.pid,
      }),
    ).rejects.toThrow("native_cleanup_maintenance_unproven");
    expect(authorize).not.toHaveBeenCalled();
    const copyProvider = join(copy, "runner/codex-provider-state.json");
    const retainedProviderBytes = await readFile(copyProvider);
    for (const eventType of [
      "semantic_tool.input",
      "runtime_request.created",
      "session.resumed",
    ]) {
      const mutated = JSON.parse(retainedProviderBytes.toString("utf8"));
      mutated.pendingEvents[0] = {
        ...mutated.pendingEvents[0],
        eventType,
        payload: {
          providerSessionId: thread.thread.id,
          processId: process.pid,
        },
      };
      await writeFile(copyProvider, JSON.stringify(mutated));
      const candidateBytes = await Promise.all(
        files.map((file) => readFile(join(copy, file))),
      );
      const candidateFingerprint = createHash("sha256")
        .update(
          JSON.stringify(
            candidateBytes.map((value) =>
              createHash("sha256").update(value).digest("hex"),
            ),
          ),
        )
        .digest("hex");
      await expect(
        settleRetainedRunnerdSession({
          ...input,
          sourceFingerprint: candidateFingerprint,
        }),
      ).rejects.toThrow("native_cleanup_maintenance_unproven");
      expect(authorize).not.toHaveBeenCalled();
    }
    await writeFile(copyProvider, retainedProviderBytes);
    for (const interruption of ["abort", "timeout"] as const) {
      const abort = new AbortController();
      let releaseAuthorization!: () => void;
      const stuckAuthorization = new Promise<void>((release) => {
        releaseAuthorization = release;
      });
      let drain: Promise<void> | undefined;
      if (interruption === "timeout")
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const blocked = settleRetainedRunnerdSession({
          ...input,
          signal: abort.signal,
          authorize: () => stuckAuthorization,
        });
        const observed = blocked.catch((error: unknown) => error);
        let idle = false;
        const idleWait = waitForRetainedRunnerdMaintenanceIdle(copy).then(() => { idle = true; });

        await waitForRetainedRunnerdMaintenanceIdle(join(copy, "unrelated"));
        expect(idle).toBe(false);
        if (interruption === "abort") abort.abort();
        else await vi.advanceTimersByTimeAsync(30_000);
        expect(await observed).toMatchObject({
          message: "native_cleanup_maintenance_unproven",
        });
        expect(retainedRunnerdMaintenanceIsIdle(copy)).toBe(false);
        await expect(settleRetainedRunnerdSession(input)).rejects.toThrow(
          "native_cleanup_maintenance_unproven",
        );
        let drained = false;
        drain = drainRetainedRunnerdMaintenanceOperations().then(() => {
          drained = true;
        });
        await Promise.resolve();
        await Promise.resolve();
        // The bounded wrapper has already failed, but its original callback
        // remains owned until it actually settles. No retry/proof is granted.
        expect(drained).toBe(false);
        expect(idle).toBe(false);
        releaseAuthorization();
        await Promise.all([drain, idleWait]);
        expect(drained).toBe(true);
        expect(idle).toBe(true);
        expect(retainedRunnerdMaintenanceIsIdle(copy)).toBe(true);
      } finally {
        releaseAuthorization();
        await drain;
        if (interruption === "timeout") vi.useRealTimers();
      }
    }
    if (missingHome) {
      await verifyMissingHomeFailure({
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
        threadId: thread.thread.id,
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
      });
      return;
    }
    if (appendFailure) {
      const failure = new Error(
        "injected maintenance event persistence failure",
      );
      let renewedProviderPid: number | null = null;
      appendEvent.mockImplementation(async (event) => {
        if (event.eventType !== "session.resumed") return;
        const resumed = resolveRunnerdSessionIdentity(event.payload);
        if (resumed.processId === providerPid) return;
        renewedProviderPid = resumed.processId;
        throw failure;
      });
      await expect(settleRetainedRunnerdSession(input)).rejects.toBe(failure);
      expect(renewedProviderPid).not.toBeNull();
      expect(dead(renewedProviderPid!)).toBe(true);
      expect(dead(-renewedProviderPid!)).toBe(true);
      expect(
        await Promise.all(
          files.map((file) => readFile(join(original, file))),
        ),
      ).toEqual(bytes);
      await expect(
        readFile(join(activated, "runner/runner-state.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(execute()).rejects.toMatchObject({
        code: "native_session_cleanup_quarantined",
      });
      expect(start).toHaveBeenCalledOnce();
      const methods = (await readFile(calls, "utf8")).trim().split("\n");
      expect(
        methods.filter((method) => method === "turn/start"),
      ).toHaveLength(1);
      expect(
        methods.filter((method) => method === "thread/resume"),
      ).toHaveLength(1);
      return;
    }
    const assertNoProviderBeforeSpawnedReceipt = async () => {
      const callsBefore = await readFile(calls, "utf8");
      const providerBeforeBytes = await readFile(copyProvider);
      const controlBefore = JSON.parse(
        await readFile(
          join(copy, "control-plane/control-plane-state.json"), "utf8",
        ),
      );
      // Give the actual runner time to authenticate while its durable spawn
      // receipt is held. Authentication must not release even the old stop.
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      expect(await readFile(calls, "utf8")).toBe(callsBefore);
      expect(await readFile(copyProvider)).toEqual(providerBeforeBytes);
      const controlAfter = JSON.parse(
        await readFile(
          join(copy, "control-plane/control-plane-state.json"), "utf8",
        ),
      );
      expect(controlAfter.connectionCount).toBe(
        controlBefore.connectionCount,
      );
      expect(controlAfter.commandDeliveryCounts).toEqual(
        controlBefore.commandDeliveryCounts,
      );
      expect(controlAfter.commands).toEqual(controlBefore.commands);
    };
    if (holdSpawned) {
      recordEpoch.mockImplementation(async (receipt) => {
        if (receipt.phase === "spawned")
          await assertNoProviderBeforeSpawnedReceipt();
      });
    }
    if (completedTerminalAck) {
      attachWithheldTerminalAckSpy({
        copy,
        files,
        completedTerminalAck,
        replayRetirements,
        withheldTerminalFrames,
        recordEpoch,
        replaySpyRestorers,
      });
    }
    if (epochFailure) {
      const failure = new Error("injected epoch receipt persistence failure");
      const callsBefore = await readFile(calls, "utf8");
      recordEpoch.mockImplementation(async (receipt) => {
        if (receipt.phase === "spawned" && epochFailure === "spawned")
          await assertNoProviderBeforeSpawnedReceipt();
        if (receipt.phase === epochFailure) throw failure;
      });
      await expect(settleRetainedRunnerdSession(input)).rejects.toBe(failure);
      for (const [receipt] of recordEpoch.mock.calls) {
        if (receipt.phase !== "spawned") continue;
        expect(dead(Number(receipt.pid))).toBe(true);
        expect(dead(-Number(receipt.pid))).toBe(true);
      }
      if (epochFailure === "spawned") {
        expect(await readFile(calls, "utf8")).toBe(callsBefore);
      }
      if (epochFailure === "launch_intent") {
        expect(await readFile(calls, "utf8")).toBe(callsBefore);
        expect(
          recordEpoch.mock.calls.map(([receipt]) => receipt.phase),
        ).toEqual(["launch_intent"]);
      }
      expect(
        await Promise.all(
          files.map((file) => readFile(join(original, file))),
        ),
      ).toEqual(bytes);
      await expect(
        readFile(join(activated, "runner/runner-state.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(execute()).rejects.toMatchObject({
        code: "native_session_cleanup_quarantined",
      });
      expect(start).toHaveBeenCalledOnce();
      return;
    }
    if (finalRetirementRevocation) {
      recordEpoch.mockImplementation(async (receipt) => {
        if (receipt.phase !== "retired") return;
        const state = maintenanceReplaySnapshot(copy);
        if (
          state.runner.pendingTerminalDelivery != null ||
          state.runner.pendingProviderCleanup != null ||
          state.runner.outbox.length !== 0 ||
          state.provider.pendingEvents.length !== 0 ||
          state.provider.queuedEvents.length !== 0 ||
          state.control.commands.some(
            (command: { status: string }) => command.status === "pending",
          )
        )
          return;
        expect(state.provider.lifecycle).toBe("prepared");
        expect(state.fingerprint).toBe(receipt.finalFingerprint);
        finalAuthorityRevoked = true;
        if (finalRetirementRevocation === "abort")
          maintenanceAbort.abort(new Error("retirement_authority_revoked"));
      });
    }
    let failedAttempt: { directory: string; bytes: Buffer[] } | null = null;
    let failedStartupAttempt: {
      directory: string;
      bytes: Buffer[];
    } | null = null;
    if (terminalReplay) {
      const replay = await setupTerminalReplayFixture({
        input,
        original,
        copy,
        activated,
        files,
        bytes,
        threadId: thread.thread.id,
        appendEvent,
        recordEpoch,
      });
      failedAttempt = replay.failedAttempt;
      failedStartupAttempt = replay.failedStartupAttempt;
    }
    const pendingProof = settleRetainedRunnerdSession(input);
    if (finalRetirementRevocation) {
      await expect(pendingProof).rejects.toThrow(
        finalRetirementRevocation === "abort"
          ? "native_cleanup_maintenance_unproven"
          : "retirement_authority_revoked",
      );
      expect(finalAuthorityRevoked).toBe(true);
      await expect(
        readFile(join(activated, "runner/runner-state.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(execute()).rejects.toMatchObject({
        code: "native_session_cleanup_quarantined",
      });
      expect(
        await Promise.all(files.map((file) => readFile(join(original, file)))),
      ).toEqual(bytes);
      const methods = (await readFile(calls, "utf8")).trim().split("\n");
      expect(methods.filter((method) => method === "turn/start")).toHaveLength(1);
      return;
    }
    if (completedTerminalAck === "repeat") {
      await verifyRepeatTerminalAck({
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
      });
      return;
    }
    const proof = await pendingProof.catch((error: unknown) =>
      formatSettlementFailure({ error, copy, appendEvent, recordEpoch }),
    );
    if (failedAttempt) {
      expect(
        await Promise.all(
          files.map((file) =>
            readFile(join(failedStartupAttempt!.directory, file)),
          ),
        ),
      ).toEqual(failedStartupAttempt!.bytes);
      expect(
        await Promise.all(
          files.map((file) => readFile(join(failedAttempt!.directory, file))),
        ),
      ).toEqual(failedAttempt.bytes);
      const finalControl = JSON.parse(
        await readFile(join(copy, files[0]!), "utf8"),
      );
      const failedControl = JSON.parse(
        failedAttempt.bytes[0]!.toString("utf8"),
      );
      expect(
        finalControl.commands.slice(0, failedControl.commands.length),
      ).toEqual(failedControl.commands);
      expect(
        finalControl.commands
          .slice(failedControl.commands.length)
          .some(
            (command: {
              type: string;
              status: string;
              result: { result?: { providerExitConfirmed?: boolean } };
            }) =>
              command.type === "turn.stop" &&
              command.status === "completed" &&
              command.result.result?.providerExitConfirmed === true,
          ),
      ).toBe(true);
    }
    const epochReceipts = recordEpoch.mock.calls.map(([receipt]) => receipt);
    if (completedTerminalAck) {
      await verifyCompletedTerminalAck({
        input,
        directory,
        files,
        completedTerminalAck,
        replayRetirements,
        withheldTerminalFrames,
      });
    }
    expect(epochReceipts.length).toBeGreaterThanOrEqual(3);
    for (let index = 0; index < epochReceipts.length; index += 3) {
      const [intent, spawned, retired] = epochReceipts.slice(
        index,
        index + 3,
      );
      expect(intent).toMatchObject({
        phase: "launch_intent",
        requestId: input.requestId,
        stateDirectory: copy,
      });
      expect(spawned).toMatchObject({
        phase: "spawned",
        launchId: intent!.launchId,
      });
      expect(retired).toMatchObject({
        phase: "retired",
        launchId: intent!.launchId,
        pid: spawned!.pid,
        processGroupAbsent: true,
      });
      expect(dead(Number(retired!.pid))).toBe(true);
      expect(dead(-Number(retired!.pid))).toBe(true);
    }
    if (bareCodex) {
      expect(await readFile(join(copy, "codex-home/auth.json"), "utf8")).toBe(
        await readFile(join(home, "auth.json"), "utf8"),
      );
    }
    expect(retainedRunnerdCleanupProofIsCurrent(proof)).toBe(false);
    await rename(copy, activated);
    expect(retainedRunnerdCleanupProofIsCurrent(proof)).toBe(true);
    expect(retainedRunnerdCleanupProofIsCurrent({ ...proof })).toBe(false);
    expect(() =>
      completeRetainedNativeSessionCleanup({ ...proof }),
    ).toThrow();
    expect(completeRetainedNativeSessionCleanup(proof)).toBe(1);
    expect(completeRetainedNativeSessionCleanup(proof)).toBe(0);
    close.mockImplementation(async () => {});
    await expect(execute()).rejects.toThrow("fixture admission reached");
    expect(start).toHaveBeenCalledTimes(2);
    expect(
      await Promise.all(files.map((file) => readFile(join(original, file)))),
    ).toEqual(bytes);
    const methods = (await readFile(calls, "utf8")).trim().split("\n");
    expect(methods.filter((method) => method === "turn/start")).toHaveLength(
      1,
    );
    expect(
      methods.filter((method) => method === "thread/start"),
    ).toHaveLength(1);
    expect(
      methods.filter((method) => method === "thread/resume"),
    ).toHaveLength(1);
    const finalState = JSON.parse(
      await readFile(join(activated, "runner/runner-state.json"), "utf8"),
    );
    expect(finalState).toMatchObject({
      ...identity,
      lifecycle: "suspended",
      outbox: [],
    });
    const provider = JSON.parse(
      await readFile(
        join(activated, "runner/codex-provider-state.json"),
        "utf8",
      ),
    );
    expect(provider).toMatchObject({
      threadId: thread.thread.id,
      activeProviderTurnId: null,
      pendingEvents: [],
      queuedEvents: [],
    });
    expect(
      appendEvent.mock.calls.every(
        ([event]) => event.runId === identity.runId,
      ),
    ).toBe(true);
    const deltas = appendEvent.mock.calls
      .map(([event]) => event.payload.delta)
      .filter(
        (delta) =>
          typeof delta === "string" && delta.startsWith("maintenance-"),
      );
    expect(deltas).toHaveLength(218);
    expect(new Set(deltas).size).toBe(218);
    await writeFile(
      join(activated, "runner/runner-state.json"),
      JSON.stringify({ ...finalState, lifecycle: "ready" }),
    );
    expect(retainedRunnerdCleanupProofIsCurrent(proof)).toBe(false);
  } finally {
    for (const restore of replaySpyRestorers.reverse()) restore();
    await bundle.transport.close().catch(() => undefined);
    for (const pid of [runnerPid, providerPid]) {
      if (pid > 0 && !dead(pid)) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
      }
    }
    if (!retainFixtureForUnprovenExit)
      await rm(directory, { recursive: true, force: true });
  }
}
