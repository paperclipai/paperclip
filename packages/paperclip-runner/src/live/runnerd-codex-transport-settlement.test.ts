// The retained-settlement maintenance suite below moved out of
// runnerd-codex-transport.test.ts. Vitest schedules whole files onto
// workers, so that single 8.9k-line file serialized ~400s of tests and was
// the wall-clock critical path of the PR "Verify Paperclip Runner (vitest)"
// lane; this family alone accounts for ~160s of it. Keeping it in its own
// file lets the worker pool and --shard run it alongside the rest of the
// transport suite instead of after it. Every case provisions its own
// mkdtemp state directory, so the file is safe to run in parallel with
// runnerd-codex-transport.test.ts.
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, it, vi } from "vitest";
import type { ControlPlanePort } from "../contracts/control-plane-port.js";
import type { NativeExecutionInputV1 } from "../contracts/native-execution.js";
import type {
  NativeSession,
  NativeSessionBackend,
} from "../contracts/native-session-backend.js";
import type { PrpEvent } from "../protocol/replay-contract.js";
import { completeRetainedNativeSessionCleanup, executeNativeSession } from "../native-session-runtime.js";
import { NativeSessionCloseUnrecoverableError } from "../contracts/native-session-backend.js";
import { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import * as durableControlPlane from "../control-plane/durable-prp-control-plane.js";

import {
  createCapabilityRunnerdCodexTransport,
  createCapabilityRunnerdProviderEnvironment,
  defaultCapabilityRunnerdBinary as qualifiedCapabilityRunnerdBinary,
  drainRetainedRunnerdMaintenanceOperations,
  runnerdRecoveryInternals,
  resolveRunnerdSessionIdentity,
  settleRetainedRunnerdSession,
  retainedRunnerdCleanupProofIsCurrent,
  retainedRunnerdMaintenanceIsIdle,
} from "./runnerd-codex-transport.js";

// Explicit private-artifact test lane; production/default dist is never changed.
const defaultCapabilityRunnerdBinary = () =>
  process.env.PAPERCLIP_ATTACH_TRANSITION_RUNNER ??
  qualifiedCapabilityRunnerdBinary();

function maintenanceFixtureBackendName(fixtureId: string): string {
  return `maintenance-test-${fixtureId}`;
}

function maintenanceReplaySnapshot(directory: string) {
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

it.each([
  { alreadyEnded: false, appendFailure: false },
  { alreadyEnded: true, appendFailure: false },
  { alreadyEnded: true, appendFailure: true },
  { alreadyEnded: true, appendFailure: false, bareCodex: true },
  { alreadyEnded: true, appendFailure: false, epochFailure: "launch_intent" },
  { alreadyEnded: true, appendFailure: false, epochFailure: "spawned" },
  { alreadyEnded: true, appendFailure: false, epochFailure: "retired" },
  { alreadyEnded: true, appendFailure: false, holdSpawned: true },
  { alreadyEnded: true, appendFailure: false, completedTerminalAck: "pending" },
  { alreadyEnded: true, appendFailure: false, completedTerminalAck: "completed" },
  { alreadyEnded: true, appendFailure: false, completedTerminalAck: "repeat" },
  { alreadyEnded: true, appendFailure: false, finalRetirementRevocation: "abort" },
  { alreadyEnded: true, appendFailure: false, finalRetirementRevocation: "revoked" },
  { alreadyEnded: true, appendFailure: false, finalRetirementRevocation: "during_authorize" },
  { alreadyEnded: true, appendFailure: false, homeScoped: true },
  { alreadyEnded: true, appendFailure: false, homeScoped: true, missingHome: true },
  { alreadyEnded: true, appendFailure: false, homeScoped: true, missingHome: true, unknownExit: true },
  { alreadyEnded: true, appendFailure: false, homeScoped: true, missingHome: true, startupFailureProof: true },
  {
    alreadyEnded: true,
    appendFailure: false,
    bareCodex: true,
    terminalReplay: true,
  },
])(
  "settles only retained control authority without starting another provider turn ($alreadyEnded/$appendFailure/$bareCodex/$epochFailure/$terminalReplay/$holdSpawned/$homeScoped/$missingHome/$unknownExit) startup-failure-proof=$startupFailureProof completed-ack=$completedTerminalAck retired-revocation=$finalRetirementRevocation",
  async ({
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
  }) => {
    const replaySpyRestorers: Array<() => void> = [];
    const replayRetirements: ReturnType<typeof maintenanceReplaySnapshot>[] = [];
    const withheldTerminalFrames: Array<{
      epoch: number;
      direction: "inbound" | "outbound";
      commandId: string;
      controllerSeq: number;
      count: number;
    }> = [];
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
      if (alreadyEnded) {
        const providerState = JSON.parse(
          await readFile(fakeState, "utf8"),
        );
        await writeFile(
          fakeState,
          JSON.stringify({ ...providerState, activeTurnId: null }),
        );
      }
      const builder = new DurablePrpControlPlane({
        stateDirectory: join(original, "control-plane"),
        identity,
        expectedRunnerVersion: "0.3.0",
        expectedRunnerDigest: `sha256:${createHash("sha256")
          .update(await readFile(fixtureRunner))
          .digest("hex")}`,
      });
      builder.queueCommand("turn.stop", {
        reason: "interrupted original close",
      });
      if (!missingHome) builder.queueCommand("runner.suspend", {});
      // Match the retained production split: runner-owned unacknowledged
      // output plus another full provider-owned prefix behind the old suspend.
      const runnerFile = join(original, "runner/runner-state.json");
      const runnerBefore = JSON.parse(await readFile(runnerFile, "utf8"));
      const template = builder.store.state.committedEvents[0]!.envelope.payload;
      for (let index = 0; index < 90; index++) {
        const sourceSeq = runnerBefore.nextSourceSeq++;
        const event = {
          ...template,
          sourceEventId: `maintenance-runner-${index}`,
          sourceSeq,
          eventType: "item.delta",
          priority: 2,
          payload: { provider: "codex", delta: `maintenance-runner-${index}` },
        };
        const envelope = {
          protocol: "paperclip.runner",
          version: 1,
          kind: "event",
          ...identity,
          payload: event,
        };
        runnerBefore.outbox.push({
          sourceSeq,
          priority: 2,
          eventType: "item.delta",
          envelope,
          byteSize: Buffer.byteLength(JSON.stringify(envelope)),
        });
      }
      runnerBefore.peakOutboxBytes = Math.max(
        runnerBefore.peakOutboxBytes,
        runnerBefore.outbox.reduce(
          (total: number, event: { byteSize: number }) =>
            total + event.byteSize,
          0,
        ),
      );
      await writeFile(runnerFile, JSON.stringify(runnerBefore));
      const providerFile = join(original, "runner/codex-provider-state.json");
      const providerBefore = JSON.parse(await readFile(providerFile, "utf8"));
      expect(providerBefore.pendingEvents).toEqual([]);
      expect(providerBefore.queuedEvents).toEqual([]);
      for (let index = 0; index < 128; index++) {
        providerBefore.pendingEvents.push({
          executorEventId: `codex_provider_${String(providerBefore.nextProviderEventSeq++).padStart(16, "0")}`,
          eventType: "item.delta",
          priority: "p2",
          payload: {
            provider: "codex",
            delta: `maintenance-provider-${index}`,
          },
        });
      }
      await writeFile(providerFile, JSON.stringify(providerBefore));
      await cp(original, copy, { recursive: true });
      const originalProviderHome = homeScoped ? await readFile(fakeState) : null;
      if (missingHome) await rm(join(copy, "codex-home/fake-codex-state.json"));
      const files = [
        "control-plane/control-plane-state.json",
        "runner/runner-state.json",
        "runner/codex-provider-state.json",
      ];
      const bytes = await Promise.all(
        files.map((file) => readFile(join(original, file))),
      );
      const sourceFingerprint = createHash("sha256")
        .update(
          JSON.stringify(
            bytes.map((value) =>
              createHash("sha256").update(value).digest("hex"),
            ),
          ),
        )
        .digest("hex");
      const appendEvent = vi.fn(async (_event: PrpEvent) => {});
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
          kind: "codex",
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
      const close = vi.fn(async () => {
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
        close,
        snapshot: async () => ({
          backendKind: "codex",
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
          releaseAuthorization();
          await drain;
          expect(drained).toBe(true);
          expect(retainedRunnerdMaintenanceIsIdle(copy)).toBe(true);
        } finally {
          releaseAuthorization();
          await drain;
          if (interruption === "timeout") vi.useRealTimers();
        }
      }
      if (missingHome) {
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
            expect(Object.keys(fact).sort()).toEqual([
              "schema", "launchId", "phase", "trigger", "attemptedProcessGeneration",
              "origin", "command", "configurationFingerprint", "requestedThreadId",
              "authenticatedThreadId", "processId", "processGroupId", "failedStage",
              "directChildExitObserved", "exitCode", "signal", "processTreeRetired",
            ].sort());
            expect(fact).toMatchObject({
              schema: "paperclip.provider_startup.v1",
              launchId: intent!.launchId,
              trigger: "restore",
              attemptedProcessGeneration: providerBefore.providerProcessGeneration + 1,
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
              requestedThreadId: thread.thread.id,
              authenticatedThreadId: null,
              processTreeRetired: false,
            });
          }
          expect(intent).toMatchObject({
            phase: "intent", processId: null, processGroupId: null,
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
        const providerBefore = await readFile(copyProvider);
        const controlBefore = JSON.parse(
          await readFile(
            join(copy, "control-plane/control-plane-state.json"), "utf8",
          ),
        );
        // Give the actual runner time to authenticate while its durable spawn
        // receipt is held. Authentication must not release even the old stop.
        await new Promise((resolveWait) => setTimeout(resolveWait, 500));
        expect(await readFile(calls, "utf8")).toBe(callsBefore);
        expect(await readFile(copyProvider)).toEqual(providerBefore);
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
        const originalAttach =
          DurablePrpControlPlane.prototype.attachWireConnection;
        const attachSpy = vi
          .spyOn(DurablePrpControlPlane.prototype, "attachWireConnection")
          .mockImplementation(function (this: DurablePrpControlPlane, wire) {
            const epoch = replayRetirements.length;
            const direction =
              completedTerminalAck === "completed" ? "outbound" : "inbound";
            const inject =
              this.store.path === join(copy, files[0]!) &&
              (epoch === 0 ||
                (completedTerminalAck === "repeat" && epoch === 1));
            let attachment: ReturnType<typeof originalAttach> | undefined;
            let withheld: (typeof withheldTerminalFrames)[number] | undefined;
            const shouldWithhold = (candidate: typeof direction): boolean => {
              if (
                !inject ||
                candidate !== direction ||
                !attachment?.isAuthenticated()
              )
                return false;
              if (withheld) {
                withheld.count += 1;
                return true;
              }
              const runner = JSON.parse(
                readFileSync(join(copy, files[1]!), "utf8"),
              );
              const terminal = runner.pendingTerminalDelivery;
              if (
                terminal?.commandType !== "runner.suspend" ||
                terminal.lifecycle !== "suspended"
              )
                return false;
              const result = runner.processedCommands[terminal.commandId];
              if (
                result?.status !== "completed" ||
                result.result?.status !== "completed" ||
                result.commandType !== terminal.commandType ||
                result.controllerSeq !== terminal.controllerSeq
              )
                return false;
              const control = JSON.parse(readFileSync(this.store.path, "utf8"));
              const command = control.commands.find(
                (entry: { commandId: string }) =>
                  entry.commandId === terminal.commandId,
              );
              if (
                command?.type !== terminal.commandType ||
                command.controllerSeq !== terminal.controllerSeq ||
                command.status !==
                  (direction === "inbound" ? "pending" : "completed")
              )
                return false;
              if (direction === "outbound")
                expect(command.result).toEqual(result);
              else expect(command.result ?? null).toBeNull();
              // Rust durably records this exact result before sending it.
              // Withhold transport delivery only after that handshake, not
              // after a guessed number of saves or an elapsed sleep. Pending
              // mode loses the result; completed mode loses its outbound ACK.
              // No retained journal/outbox bytes are removed or rewritten.
              withheld = {
                epoch,
                direction,
                commandId: terminal.commandId,
                controllerSeq: terminal.controllerSeq,
                count: 1,
              };
              withheldTerminalFrames.push(withheld);
              return true;
            };
            attachment = originalAttach.call(this, {
              sendJson(value) {
                if (!shouldWithhold("outbound")) wire.sendJson(value);
              },
              close: (code) => wire.close(code),
              onJson: (listener) =>
                wire.onJson((value) => {
                  if (!shouldWithhold("inbound")) listener(value);
                }),
              onClose: (listener) => wire.onClose(listener),
            });
            return attachment;
          });
        replaySpyRestorers.push(() => attachSpy.mockRestore());
        recordEpoch.mockImplementation(async (receipt) => {
          if (receipt.phase !== "retired") return;
          const snapshot = maintenanceReplaySnapshot(copy);
          expect(snapshot.fingerprint).toBe(receipt.finalFingerprint);
          replayRetirements.push(snapshot);
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
          requestedThreadId: thread.thread.id,
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
        failedStartupAttempt = {
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
        failedAttempt = { directory, bytes: legacyBytes };
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
        return;
      }
      const proof = await pendingProof.catch(
        async (error: unknown) => {
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
        },
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
  },
  40_000,
);

