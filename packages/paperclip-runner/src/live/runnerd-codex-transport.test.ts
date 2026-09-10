import {
  cp,
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it, vi } from "vitest";
import type { ControlPlanePort } from "../contracts/control-plane-port.js";
import type { NativeExecutionInputV1 } from "../contracts/native-execution.js";
import type {
  NativeSession,
  NativeSessionBackend,
} from "../contracts/native-session-backend.js";
import type {
  PrpEvent,
  PrpStructuredRunResult,
  PrpTerminalState,
} from "../protocol/replay-contract.js";
import { completeRetainedNativeSessionCleanup, executeNativeSession } from "../native-session-runtime.js";
import { NativeSessionCloseUnrecoverableError } from "../contracts/native-session-backend.js";
import { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import * as durableControlPlane from "../control-plane/durable-prp-control-plane.js";

import {
  NATIVE_RUNTIME_ASSET_SCHEMA,
  PAPERCLIP_EXECUTION_PROMPT,
  PAPERCLIP_EXECUTION_PROMPT_REVISION,
  canonicalNativeRuntimeContextDigest,
  nativeRuntimePromptDigest,
  type NativeRuntimeContextSnapshot,
} from "../contracts/runtime-context.js";
import {
  CODEX_SKILLLESS_BASE_INSTRUCTIONS,
  createCodexTaskEnvelope,
} from "../contracts/codex.js";
import {
  CodexAppServerDriver,
  codexSemanticToolSpecs,
} from "../drivers/codex/codex-app-server-driver.js";
import { releaseMaterializedNativeRuntimeSkills } from "../drivers/runtime-context-materializer.js";
import { RUNNERD_CANONICAL_ITEM } from "../drivers/codex/codex-driver-values.js";

import {
  authorizedToolSetForProvider,
  createCapabilityRunnerdCodexTransport,
  createCapabilityRunnerdProviderEnvironment,
  createRunnerdCodexAppServerArgs,
  defaultCapabilityRunnerdBinary as qualifiedCapabilityRunnerdBinary,
  readRunnerdArtifactBinding,
  drainRetainedRunnerdMaintenanceOperations,
  expandRunnerdCanonicalNotifications,
  latestRunnerdSessionReadiness,
  rehydrateRunnerdGoalNotification,
  rehydrateRunnerdItemNotification,
  rehydrateRunnerdDeltaNotification,
  rehydrateRunnerdPlanNotification,
  rehydrateRunnerdResultNotification,
  rehydrateRunnerdThreadTokenUsage,
  rehydrateRunnerdTurnNotification,
  rehydrateRunnerdUsageNotification,
  rehydrateRunnerdWorkspaceChangeNotification,
  runnerdCanonicalNotificationMethod,
  runnerdLaunchProfileInternals,
  runnerdRecoveryInternals,
  resolveRunnerdAcpxPermissionMode,
  resolveRunnerdSessionIdentity,
  resolveSourceCodexHome,
  settleRetainedRunnerdSession,
  retainedRunnerdCleanupProofIsCurrent,
  retainedRunnerdMaintenanceIsIdle,
  trustedRuntimeReadOnlyRoots,
  unseenRunnerdCommittedEvents,
  unwrapRunnerdProviderNotification,
  unwrapRunnerdProviderNotifications,
  withCodexCollaborationRuntimeInstructions,
} from "./runnerd-codex-transport.js";

// Explicit private-artifact test lane; production/default dist is never changed.
const defaultCapabilityRunnerdBinary = () =>
  process.env.PAPERCLIP_ATTACH_TRANSITION_RUNNER ??
  qualifiedCapabilityRunnerdBinary();

async function expectTurnStarted(
  notifications: AsyncIterator<{ method: string }>,
) {
  for (let index = 0; index < 32; index += 1) {
    const next = await notifications.next();
    expect(next.done).not.toBe(true);
    if (next.value.method === "turn/started") return;
    // Startup ownership and capability facts can precede the active turn.
    expect(next.value.method).toBe("paperclip/canonicalProviderEvent");
  }
  throw new Error(
    "provider turn did not start within the bounded notification prefix",
  );
}

it("replaces an owned v1 runner with fresh v2 authorization before warm attachment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runnerd-v1-v2-replacement-"));
  const handles: durableControlPlane.RunnerProcessHandle[] = [];
  let legacySelection = true;
  let firstExited = false;
  let core!: DurablePrpControlPlane;
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(directory),
    stateDirectory: directory,
    lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
    runnerReconnectGraceMs: 10_000,
    controlPlaneRegistration: async (authority) => {
      if (!core) {
        core = authority;
        const attach = authority.attachWireConnection.bind(authority);
        vi.spyOn(authority, "attachWireConnection").mockImplementation((wire) =>
          attach({
            sendJson: (value) => wire.sendJson(value),
            close: (code) => wire.close(code),
            onClose: (listener) => wire.onClose(listener),
            onJson: (listener) =>
              wire.onJson((value) => {
                // Model the old controller's v1-only selection. The actual runner
                // still verifies the signed selected version and encrypted frames.
                const envelope = value as {
                  kind?: string;
                  payload?: Record<string, unknown>;
                };
                if (legacySelection && envelope.kind === "auth_hello") {
                  listener({
                    ...envelope,
                    payload: { ...envelope.payload, protocolMax: 1 },
                  });
                } else listener(value);
              }),
          }),
        );
        await authority.start();
      }
      return { release: () => undefined };
    },
    runnerProcessLauncher: (spec) => {
      if (handles.length > 0) expect(firstExited).toBe(true);
      const child = spawn(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: spec.environment,
        stdio: "ignore",
      });
      const index = handles.length;
      const completion = new Promise<durableControlPlane.RunnerProcessResult>(
        (resolveExit, rejectExit) => {
          child.once("error", rejectExit);
          child.once("exit", (code, signal) => {
            if (index === 0) firstExited = true;
            resolveExit({ code, signal, stdout: "", stderr: "" });
          });
        },
      );
      const handle = { child, completion };
      handles.push(handle);
      return handle;
    },
  });
  const runnerPath = join(directory, "runner", "runner-state.json");
  const runnerState = async () =>
    JSON.parse(await readFile(runnerPath, "utf8"));
  try {
    await bundle.transport.request("thread/start", { cwd: directory });
    const oldIdentity = structuredClone(core.store.state.identity);
    await vi.waitFor(async () => {
      const state = await runnerState();
      expect(state.lastConnectionProtocolVersion).toBe(1);
      expect(state.outbox).toEqual([]);
      expect(Object.keys(state.v2ReplayEvents)).toHaveLength(2);
    });
    expect(
      core.store.state.committedEvents.some(
        (event) => event.eventType === "session.goal.snapshot",
      ),
    ).toBe(false);
    const oldProvider = bundle.evidence().codexPid!;
    expect(oldProvider).toBeGreaterThan(0);
    // Retire only the exact fixture provider first; process recovery cannot
    // launch a replacement while an old provider still owns this session.
    process.kill(oldProvider, "SIGTERM");
    await vi.waitFor(
      () => {
        expect(() => process.kill(oldProvider, 0)).toThrow();
      },
      { timeout: 5_000 },
    );
    legacySelection = false;
    handles[0]!.child.kill("SIGKILL");
    await handles[0]!.completion;
    await vi.waitFor(
      async () => {
        expect(handles).toHaveLength(2);
        const state = await runnerState();
        expect(state.lastConnectionProtocolVersion).toBe(2);
        expect(state.v2ReplayEvents).toEqual({});
        expect(state.outbox).toEqual([]);
        expect(core.activeRunnerConnectionCount()).toBe(1);
      },
      { timeout: 10_000 },
    );
    expect(core.store.state.identity).toEqual(oldIdentity);
    const native = core.store.state.committedEvents.filter((event) =>
      ["session.capabilities.updated", "session.goal.snapshot"].includes(
        event.eventType,
      ),
    );
    expect(native.map((event) => event.eventType)).toEqual([
      "session.capabilities.updated",
      "session.goal.snapshot",
    ]);
    expect(
      native.every((event) => event.envelope.runId === oldIdentity.runId),
    ).toBe(true);
    expect(
      core.store.state.commands.some(
        (command) => command.type === "turn.start",
      ),
    ).toBe(false);
    await bundle.transport.attachRun!({
      runId: "run-v2-replacement",
      turnId: "turn-v2-replacement",
      itemId: "item-v2-replacement",
    });
    expect(core.store.state.identity.runId).toBe("run-v2-replacement");
    expect(core.store.state.warmTransition).toBeUndefined();
    expect(
      core.store.state.commands.some(
        (command) => command.type === "turn.start",
      ),
    ).toBe(false);
  } finally {
    legacySelection = false;
    await bundle.transport.close().catch(() => undefined);
    for (const handle of handles) {
      if (handle.child.exitCode === null && handle.child.signalCode == null)
        handle.child.kill("SIGKILL");
      await handle.completion.catch(() => undefined);
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it.each([
  { alreadyEnded: false, appendFailure: false },
  { alreadyEnded: true, appendFailure: false },
  { alreadyEnded: true, appendFailure: true },
  { alreadyEnded: true, appendFailure: false, bareCodex: true },
  { alreadyEnded: true, appendFailure: false, epochFailure: "launch_intent" },
  { alreadyEnded: true, appendFailure: false, epochFailure: "spawned" },
  { alreadyEnded: true, appendFailure: false, epochFailure: "retired" },
  { alreadyEnded: true, appendFailure: false, holdSpawned: true },
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
  "settles only retained control authority without starting another provider turn ($alreadyEnded/$appendFailure/$bareCodex/$epochFailure/$terminalReplay/$holdSpawned/$homeScoped/$missingHome/$unknownExit) startup-failure-proof=$startupFailureProof",
  async ({
    alreadyEnded,
    appendFailure,
    bareCodex,
    epochFailure,
    terminalReplay,
    holdSpawned,
    homeScoped,
    missingHome,
    unknownExit,
    startupFailureProof,
  }) => {
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
      process.kill(-runnerPid, "SIGKILL");
      process.kill(-providerPid, "SIGKILL");
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
      const authorize = vi.fn(async () => {});
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
          name: missingHome
            ? `maintenance-test-missing-home-${Boolean(unknownExit)}${startupFailureProof ? "-startup-proof" : ""}`
            : epochFailure
            ? `maintenance-test-${epochFailure}`
            : appendFailure
              ? "maintenance-test-failure"
              : "maintenance-test",
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
      const proof = await settleRetainedRunnerdSession(input).catch(
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

it.each(["alive", "pending_liveness", "pending_registration"] as const)(
  "bounds adopted runner authentication at its exact deadline with %s evidence",
  async (mode) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T00:00:00.000Z"));
    try {
      const never = new Promise<never>(() => undefined);
      let settled = false;
      const result = runnerdRecoveryInternals
        .awaitAdoptedRunnerAuthentication({
          activeConnectionCount: () => 0,
          isAlive: () => (mode === "pending_liveness" ? never : true),
          throwIfFailed: () => undefined,
          failure: never,
          ...(mode === "pending_registration" ? { ready: () => never } : {}),
          timeoutMs: 100,
        })
        .then(
          () => {
            settled = true;
            return null;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );
      await vi.advanceTimersByTimeAsync(99);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toMatchObject({
        message: expect.stringContaining(
          "native_adopted_runner_authentication_timeout",
        ),
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  },
);

it.each([99, 100])(
  "requires adopted runner authentication strictly before the deadline (%sms)",
  async (authenticatedAtMs) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T00:00:00.000Z"));
    try {
      let connections = 0;
      let resolveLiveness!: (alive: boolean) => void;
      const liveness = new Promise<boolean>((resolveAlive) => {
        resolveLiveness = resolveAlive;
      });
      const result = runnerdRecoveryInternals
        .awaitAdoptedRunnerAuthentication({
          activeConnectionCount: () => connections,
          isAlive: () => liveness,
          throwIfFailed: () => undefined,
          failure: new Promise<never>(() => undefined),
          timeoutMs: 100,
        })
        .then(
          () => "authenticated",
          (error: Error) => error.message,
        );
      await vi.advanceTimersByTimeAsync(authenticatedAtMs);
      connections = 1;
      resolveLiveness(true);
      if (authenticatedAtMs < 100) {
        expect(await result).toBe("authenticated");
      } else {
        expect(await result).toContain(
          "native_adopted_runner_authentication_timeout",
        );
      }
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  },
);

it("launches runnerd with its production durable outbox limits", () => {
  expect(runnerdLaunchProfileInternals.maxOutboxBytes).toBe(16 * 1024 * 1024);
  expect(runnerdLaunchProfileInternals.p0ReserveBytes).toBe(1024 * 1024);
});

it("requires an explicit retained state directory before adopting a runner", () => {
  const launch = vi.fn();
  const signal = vi.fn();
  expect(() =>
    createCapabilityRunnerdCodexTransport({
      runnerProcessLauncher: launch,
      adoptExistingRunner: {
        pid: 123,
        processGroupId: 123,
        startedAt: new Date().toISOString(),
        isAlive: () => true,
        signal,
      },
    }),
  ).toThrow("native_adopted_runner_state_directory_required");
  expect(launch).not.toHaveBeenCalled();
  expect(signal).not.toHaveBeenCalled();
});

it("carries the provider attachment seed across consecutive authority rotations", () => {
  const baseIdentity = {
    runnerInstanceId: "runner-warm-seed",
    environmentLeaseId: "lease-warm-seed",
    runId: "run-warm-one",
    normalizedSessionId: "session-warm-seed",
    turnId: "turn-warm-one",
    itemId: "item-warm-one",
  };
  const secondIdentity = {
    ...baseIdentity,
    runId: "run-warm-two",
    turnId: "turn-warm-two",
    itemId: "item-warm-two",
  };
  const thirdIdentity = {
    ...baseIdentity,
    runId: "run-warm-three",
    turnId: "turn-warm-three",
    itemId: "item-warm-three",
  };
  const secondTemplate = runnerdRecoveryInternals.rotatedRunAttachPayload(
    {
      commands: [
        {
          type: "run.prepare",
          payload: {
            provider: {
              kind: "acpx",
              runId: baseIdentity.runId,
              normalizedSessionId: baseIdentity.normalizedSessionId,
            },
            workspace: { cwd: "/workspace" },
          },
        },
      ],
    },
    secondIdentity,
    null,
    undefined,
  );
  const thirdTemplate = runnerdRecoveryInternals.rotatedRunAttachPayload(
    { commands: [], runAttachTemplate: secondTemplate },
    thirdIdentity,
    null,
    undefined,
  );

  expect(secondTemplate).toMatchObject({
    provider: {
      runId: secondIdentity.runId,
      normalizedSessionId: secondIdentity.normalizedSessionId,
    },
    workspace: { cwd: "/workspace" },
  });
  expect(thirdTemplate).toMatchObject({
    provider: {
      runId: thirdIdentity.runId,
      normalizedSessionId: thirdIdentity.normalizedSessionId,
    },
    workspace: { cwd: "/workspace" },
  });
});

it("replays the durable run attachment outcome and latest provider identity", () => {
  expect(
    runnerdRecoveryInternals.recoveredRunAttachment({
      commands: [
        { commandId: "prepare", type: "run.prepare", status: "completed" },
        { commandId: "attach", type: "run.attach", status: "failed" },
      ],
      committedEvents: [{ eventType: "session.started" }],
    }),
  ).toEqual({
    commandId: "attach",
    status: "failed",
    providerIdentityEventIndex: -1,
  });

  expect(
    runnerdRecoveryInternals.recoveredRunAttachment({
      commands: [
        { commandId: "attach", type: "run.attach", status: "completed" },
      ],
      committedEvents: [
        { eventType: "runner.reconciled" },
        { eventType: "session.started" },
        { eventType: "runner.diagnostic" },
        { eventType: "session.resumed" },
      ],
    }),
  ).toEqual({
    commandId: "attach",
    status: "completed",
    providerIdentityEventIndex: 3,
  });
});

it("identifies an active provider turn that must stop before suspension", () => {
  expect(
    runnerdRecoveryInternals.providerDrainStateFromSnapshot({
      activeProviderTurnId: "provider-turn-1",
      pendingEvents: [{ eventType: "item.started" }],
      queuedEvents: [{ eventType: "item.completed" }],
    }),
  ).toEqual({
    pendingEventCount: 2,
    activeProviderTurnId: "provider-turn-1",
    providerSettled: false,
  });

  expect(
    runnerdRecoveryInternals.providerDrainStateFromSnapshot({
      activeTurnId: "acpx-turn-1",
      pendingEvents: [],
    }),
  ).toEqual({
    pendingEventCount: 0,
    activeProviderTurnId: "acpx-turn-1",
    providerSettled: false,
  });

  expect(
    runnerdRecoveryInternals.providerDrainStateFromSnapshot({
      activeProviderTurnId: null,
      ambiguousTurnStartPending: false,
      pendingEvents: [],
      queuedEvents: [],
    }),
  ).toEqual({
    pendingEventCount: 0,
    activeProviderTurnId: null,
    providerSettled: true,
  });
});

it.each([
  {},
  { pendingEvents: null },
  { pendingEvents: {}, queuedEvents: [] },
  { pendingEvents: [], queuedEvents: false },
  { pendingEvents: [], activeProviderTurnId: 1 },
  { pendingEvents: [], activeTurnId: "" },
  { pendingEvents: [], ambiguousTurnStartPending: "false" },
])(
  "does not treat a malformed provider snapshot as drained (%j)",
  (snapshot) => {
    expect(() =>
      runnerdRecoveryInternals.providerDrainStateFromSnapshot(snapshot),
    ).toThrow();
  },
);

it.each([undefined, null, "true", 1, {}, false, true])(
  "requires a literal runner drain receipt even without a local provider reader (%j)",
  async (proof) => {
    const commands: { commandId: string; status: string; result?: unknown }[] =
      [];
    const queue = vi.fn((commandId: string) => {
      commands.push({
        commandId,
        status: "completed",
        result: { result: { retainedEventsDrained: proof } },
      });
    });
    const drained = await runnerdRecoveryInternals.awaitProviderDrainBarrier({
      readProviderState: () => null,
      semanticResultsSettled: () => true,
      commands: () => commands,
      queueDrain: queue,
      pump: () => undefined,
      deadline: Date.now() + 25,
      pollIntervalMs: 1,
    });
    expect(drained).toBe(proof === true);
    expect(queue).toHaveBeenCalled();
  },
);

it.each(["pending", "unreadable", "active", "expired", "failed"] as const)(
  "does not certify provider drain from a quiet outbox with %s suffix evidence",
  async (mode) => {
    const commands: { commandId: string; status: string; result?: unknown }[] =
      [];
    let reads = 0;
    const drained = await runnerdRecoveryInternals.awaitProviderDrainBarrier({
      readProviderState: () => {
        reads += 1;
        if (mode === "unreadable") return "unreadable";
        return {
          pendingEventCount: mode === "pending" ? 1 : 0,
          activeProviderTurnId: mode === "active" ? "active-turn" : null,
          providerSettled: mode !== "active",
        };
      },
      semanticResultsSettled: () => true,
      commands: () => commands,
      queueDrain: (commandId) => {
        commands.push({
          commandId,
          status: mode === "failed" ? "failed" : "completed",
          result: { result: { retainedEventsDrained: true } },
        });
      },
      pump: () => undefined,
      deadline: Date.now() + (mode === "expired" ? 0 : 25),
      pollIntervalMs: 1,
    });
    expect(drained).toBe(false);
    if (mode === "unreadable" || mode === "expired")
      expect(commands).toEqual([]);
    else expect(reads).toBeGreaterThan(0);
  },
);

it("waits for a fresh empty provider suffix after a confirmed drain receipt", async () => {
  const commands: { commandId: string; status: string; result?: unknown }[] =
    [];
  let suffix = 3;
  const drained = await runnerdRecoveryInternals.awaitProviderDrainBarrier({
    readProviderState: () => ({
      pendingEventCount: suffix,
      activeProviderTurnId: null,
      providerSettled: true,
    }),
    semanticResultsSettled: () => true,
    commands: () => commands,
    queueDrain: (commandId) => {
      commands.push({ commandId, status: "pending" });
    },
    pump: () => {
      const last = commands.at(-1);
      if (!last) return;
      last.status = "completed";
      last.result = { result: { retainedEventsDrained: suffix === 0 } };
      suffix = 0;
    },
    deadline: Date.now() + 100,
  });
  expect(drained).toBe(true);
  expect(commands).toHaveLength(2);
});

it("refuses a reusable close checkpoint when the local provider snapshot is unreadable", async () => {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "runnerd-close-unreadable-"),
  );
  const checkpoint = vi.fn();
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory),
    stateDirectory,
    closeGraceMs: 3_000,
    controlPlaneRegistration: async (authority) => {
      await authority.start();
      return { checkpoint, release: () => undefined };
    },
  });
  try {
    await bundle.transport.request("thread/start", { cwd: tmpdir() });
    const providerPath = join(
      stateDirectory,
      "runner",
      "codex-provider-state.json",
    );
    // A persistently unreadable store, not a transient partial read that the
    // still-running provider may legitimately replace with valid atomic state.
    await rename(providerPath, `${providerPath}.preserved`);
    await mkdir(providerPath);
    await expect(bundle.transport.close()).rejects.toBeInstanceOf(
      NativeSessionCloseUnrecoverableError,
    );
    expect(checkpoint).toHaveBeenCalledWith("unsettled");
    expect(checkpoint).not.toHaveBeenCalledWith("settled");
    expect((await stat(stateDirectory)).isDirectory()).toBe(true);
  } finally {
    await bundle.transport.close().catch(() => undefined);
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 15_000);

it.each(["after_budget", "within_budget", "persistence_failure"] as const)(
  "fences reusable suspension against late semantic completion (%s)",
  async (mode) => {
    const stateDirectory = await mkdtemp(
      join(tmpdir(), "runnerd-late-semantic-close-"),
    );
    const checkpoint = vi.fn();
    let core!: DurablePrpControlPlane;
    let entered!: () => void;
    let release!: () => void;
    const handlerEntered = new Promise<void>((resolveEntered) => {
      entered = resolveEntered;
    });
    const handlerRelease = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    const bundle = createCapabilityRunnerdCodexTransport({
      runnerBinary: defaultCapabilityRunnerdBinary(),
      codexCommand: fakeCodex,
      codexArgs: fakeCodexArgs(stateDirectory, "--split-event-burst"),
      stateDirectory,
      closeGraceMs: 2_000,
      controlPlaneRegistration: async (authority) => {
        core = authority;
        await authority.start();
        return { checkpoint, release: () => undefined };
      },
    });
    bundle.transport.setServerRequestHandler(async () => {
      entered();
      await handlerRelease;
      return { success: true, contentItems: [] };
    });
    try {
      await bundle.transport.request("thread/start", {
        cwd: tmpdir(),
        dynamicTools: [
          {
            name: "get_task_context",
            description: "Read the task.",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ],
      });
      await bundle.transport.request("turn/start", {
        input: [{ type: "text", text: "Read the task." }],
      });
      await Promise.race([
        handlerEntered,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () =>
              reject(new Error("synthetic semantic handler was not invoked")),
            5_000,
          );
          timer.unref();
        }),
      ]);
      expect(core.semanticToolResultsSettled()).toBe(false);
      if (mode === "persistence_failure") {
        const queue = core.queueCommand.bind(core);
        vi.spyOn(core, "queueCommand").mockImplementation((type, ...args) => {
          if (type === "semantic_tool.result")
            throw new Error("synthetic result journal refused persistence");
          return queue(type, ...args);
        });
      }
      const closing = bundle.transport.close().then(
        () => null,
        (error: unknown) => error,
      );
      if (mode !== "after_budget") {
        // close() synchronously marks the transport closed before its first
        // await; only now may the already-entered handler finish.
        release();
      }
      const closeFailure = await closing;
      if (mode !== "within_budget") {
        const artifact = readRunnerdArtifactBinding(
          defaultCapabilityRunnerdBinary(),
        );
        const reopened = new DurablePrpControlPlane({
          stateDirectory: join(stateDirectory, "control-plane"),
          identity: core.store.state.identity,
          expectedRunnerVersion: artifact.version,
          expectedRunnerDigest: artifact.digest,
        });
        expect(reopened.semanticToolResultsSettled()).toBe(false);
        await reopened.stop();
      }
      release();
      if (mode === "persistence_failure") {
        expect(core.semanticToolResultsSettled()).toBe(false);
        expect(
          core.store.state.commands.filter(
            (command) => command.type === "semantic_tool.result",
          ),
        ).toEqual([]);
      } else {
        await vi.waitFor(async () => {
          const control = JSON.parse(
            await readFile(
              join(stateDirectory, "control-plane", "control-plane-state.json"),
              "utf8",
            ),
          );
          const late = control.commands.filter(
            (command: { type: string }) =>
              command.type === "semantic_tool.result",
          );
          expect(late).toHaveLength(1);
          expect(late[0].payload.correlation.runId).toBe(
            control.identity.runId,
          );
          expect(late[0].status).toBe(
            mode === "within_budget" ? "completed" : "pending",
          );
          if (mode === "within_budget") {
            const results = control.committedEvents.filter(
              (event: { eventType: string }) =>
                event.eventType === "semantic_tool.result",
            );
            expect(results).toHaveLength(1);
            expect(results[0].envelope.runId).toBe(control.identity.runId);
          }
        });
      }
      if (mode === "within_budget") {
        expect(closeFailure).toBeNull();
        expect(core.semanticToolResultsSettled()).toBe(true);
        expect(checkpoint).toHaveBeenCalledWith("settled");
      } else {
        expect(closeFailure).toBeInstanceOf(
          NativeSessionCloseUnrecoverableError,
        );
        expect(checkpoint).toHaveBeenCalledWith("unsettled");
        expect(checkpoint).not.toHaveBeenCalledWith("settled");
      }
    } finally {
      release();
      await bundle.transport.close().catch(() => undefined);
      await rm(stateDirectory, { recursive: true, force: true });
    }
  },
  15_000,
);

it("infers a remote provider turn until its own terminal event is durable", () => {
  expect(
    runnerdRecoveryInternals.providerTurnIsActiveFromCommittedEvents([
      { eventType: "turn.started" },
      { eventType: "run.result.proposed" },
      { eventType: "run.terminal" },
    ]),
  ).toBe(true);
  expect(
    runnerdRecoveryInternals.providerTurnIsActiveFromCommittedEvents([
      { eventType: "turn.started" },
      { eventType: "run.terminal" },
      { eventType: "turn.interrupted" },
    ]),
  ).toBe(false);
});

it("accepts only the observed provider start correlated by the command result", () => {
  const requestedTurnId = "turn_lab_0123456789abcdef0123456789abcdef";
  expect(
    runnerdRecoveryInternals.turnStartResponseReady({
      responseEpoch: 2,
      observedEpoch: 2,
      expectedProviderTurnId: requestedTurnId,
      boundTurnId: requestedTurnId,
    }),
  ).toBe(true);
  expect(
    runnerdRecoveryInternals.turnStartResponseReady({
      responseEpoch: 2,
      observedEpoch: 2,
      expectedProviderTurnId: requestedTurnId,
      boundTurnId: "provider-turn-different",
    }),
  ).toBe(false);
  const providerAssignedTurnId = "provider-turn-assigned-for-this-command";
  expect(
    runnerdRecoveryInternals.turnStartResponseReady({
      responseEpoch: 2,
      observedEpoch: 2,
      expectedProviderTurnId: providerAssignedTurnId,
      boundTurnId: providerAssignedTurnId,
    }),
  ).toBe(true);
  expect(
    runnerdRecoveryInternals.turnStartResponseReady({
      responseEpoch: 2,
      observedEpoch: 1,
      expectedProviderTurnId: requestedTurnId,
      boundTurnId: requestedTurnId,
    }),
  ).toBe(false);
});

it("defers turn starts until their command result and rejects stale identities", () => {
  expect(
    runnerdRecoveryInternals.turnStartNotificationDisposition({
      responsePending: true,
      expectedProviderTurnId: null,
      observedProviderTurnId: "provider-turn-early",
    }),
  ).toBe("defer");
  expect(
    runnerdRecoveryInternals.turnStartNotificationDisposition({
      responsePending: true,
      expectedProviderTurnId: "provider-turn-current",
      observedProviderTurnId: "provider-turn-stale",
    }),
  ).toBe("reject");
  expect(
    runnerdRecoveryInternals.turnStartNotificationDisposition({
      responsePending: true,
      expectedProviderTurnId: "provider-turn-current",
      observedProviderTurnId: "",
    }),
  ).toBe("reject");
  expect(
    runnerdRecoveryInternals.turnStartNotificationDisposition({
      responsePending: true,
      expectedProviderTurnId: "provider-turn-current",
      observedProviderTurnId: "provider-turn-current",
    }),
  ).toBe("accept");
});

it("requires ACPX command results to preserve the requested turn identity", () => {
  expect(
    runnerdRecoveryInternals.turnStartCommandResultValid({
      requestedTurnId: "turn-requested",
      providerTurnId: "turn-requested",
      requireRequestedIdentity: true,
    }),
  ).toBe(true);
  expect(
    runnerdRecoveryInternals.turnStartCommandResultValid({
      requestedTurnId: "turn-requested",
      providerTurnId: "turn-different",
      requireRequestedIdentity: true,
    }),
  ).toBe(false);
  expect(
    runnerdRecoveryInternals.turnStartCommandResultValid({
      requestedTurnId: "turn-requested",
      providerTurnId: "provider-assigned-turn",
      requireRequestedIdentity: false,
    }),
  ).toBe(true);
});

it.each(["before", "after"] as const)(
  "retries external authority rotation after crashing %s the remote archive",
  async (crashPoint) => {
    const root = await mkdtemp(join(tmpdir(), "runner-external-rotation-"));
    const priorIdentity = {
      runnerInstanceId: "runner-external-rotation",
      environmentLeaseId: "lease-external-rotation",
      runId: "run-external-prior",
      normalizedSessionId: "session-external-rotation",
      turnId: "turn-external-prior",
      itemId: "item-external-prior",
    };
    const desiredIdentity = {
      ...priorIdentity,
      runId: "run-external-next",
      turnId: "turn-external-next",
      itemId: "item-external-next",
    };
    const controlPlaneState = {
      schema: "paperclip.runner.durable.control-plane-state.v1",
      identity: priorIdentity,
    };
    let activeRunnerState: Record<string, unknown> | null = {
      schema: "paperclip.runner.durable.state.v1",
      ...priorIdentity,
      lifecycle: "suspended",
    };
    let archivedRunnerState: Record<string, unknown> | null = null;
    let readCount = 0;
    let archiveCount = 0;
    const readRunnerState = async () => {
      readCount += 1;
      if (activeRunnerState === null) throw new Error("runner state moved");
      return activeRunnerState;
    };
    const archiveRunnerState = async () => {
      archiveCount += 1;
      if (archiveCount === 1) {
        if (crashPoint === "after") {
          archivedRunnerState = activeRunnerState;
          activeRunnerState = null;
        }
        throw new Error(`crashed ${crashPoint} remote archive`);
      }
      if (activeRunnerState !== null) {
        archivedRunnerState = activeRunnerState;
        activeRunnerState = null;
      }
      if (archivedRunnerState === null) {
        throw new Error("archived runner state unavailable");
      }
      return archivedRunnerState;
    };
    try {
      await mkdir(join(root, "control-plane"), { recursive: true });
      await writeFile(
        join(root, "control-plane", "control-plane-state.json"),
        JSON.stringify(controlPlaneState),
      );
      await expect(
        runnerdRecoveryInternals.rotateExternalAuthorityEpoch(
          root,
          controlPlaneState,
          desiredIdentity,
          readRunnerState,
          archiveRunnerState,
        ),
      ).rejects.toThrow(`crashed ${crashPoint} remote archive`);
      await expect(stat(join(root, "control-plane"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      await expect(
        runnerdRecoveryInternals.rotateExternalAuthorityEpoch(
          root,
          controlPlaneState,
          desiredIdentity,
          readRunnerState,
          archiveRunnerState,
        ),
      ).resolves.toEqual(controlPlaneState);
      expect(readCount).toBe(1);
      expect(archiveCount).toBe(2);
      expect(activeRunnerState).toBeNull();
      expect(archivedRunnerState).toEqual(
        expect.objectContaining(priorIdentity),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("quiesces the control route before checkpoint and containment regardless of process completion", async () => {
  const settledSteps: string[] = [];
  await runnerdRecoveryInternals.releaseRunnerProcessOwnership({
    runnerSettled: true,
    checkpoint: async (settlement) => {
      expect(settlement).toBe("settled");
      settledSteps.push("checkpoint");
    },
    forceKill: () => {
      settledSteps.push("kill");
    },
    release: async () => {
      settledSteps.push("release");
    },
  });
  expect(settledSteps).toEqual(["release", "checkpoint", "kill"]);

  const unsettledSteps: string[] = [];
  await runnerdRecoveryInternals.releaseRunnerProcessOwnership({
    runnerSettled: false,
    checkpoint: async (settlement) => {
      expect(settlement).toBe("unsettled");
      unsettledSteps.push("checkpoint");
    },
    forceKill: () => {
      unsettledSteps.push("kill");
    },
    release: async () => {
      unsettledSteps.push("release");
    },
  });
  expect(unsettledSteps).toEqual(["release", "checkpoint", "kill"]);

  const failedCheckpointSteps: string[] = [];
  await expect(
    runnerdRecoveryInternals.releaseRunnerProcessOwnership({
      runnerSettled: true,
      checkpoint: async () => {
        failedCheckpointSteps.push("checkpoint");
        throw new Error("runner_remote_checkpoint_incomplete");
      },
      forceKill: () => {
        failedCheckpointSteps.push("kill");
      },
      release: async () => {
        failedCheckpointSteps.push("release");
      },
    }),
  ).rejects.toThrow("runner_remote_checkpoint_incomplete");
  expect(failedCheckpointSteps).toEqual(["release", "checkpoint", "kill"]);
});

it("waits for the exact durable suspension command behind prior close work", async () => {
  const commands = [
    {
      commandId: "command_close_drain",
      type: "runner.drain",
      status: "pending",
    },
  ];
  let lifecycle = "ready";
  let pumpCount = 0;

  await expect(
    runnerdRecoveryInternals.awaitRunnerSuspensionBarrier({
      commands: () => commands,
      queueSuspend: (commandId) => {
        commands.push({
          commandId,
          type: "runner.suspend",
          status: "pending",
        });
      },
      readRunnerState: async () => ({ lifecycle }),
      runnerHasExited: async () => true,
      pump: () => {
        pumpCount += 1;
        if (pumpCount === 1) commands[0]!.status = "completed";
        if (pumpCount === 2) {
          commands[1]!.status = "completed";
          lifecycle = "suspended";
        }
      },
      deadline: Date.now() + 1_000,
      pollIntervalMs: 0,
    }),
  ).resolves.toBe(true);
  expect(commands.map((command) => command.type)).toEqual([
    "runner.drain",
    "runner.suspend",
  ]);
  expect(pumpCount).toBeGreaterThanOrEqual(2);
});

it("does not accept process exit without durable suspension", async () => {
  const commands: Array<{
    commandId: string;
    type: string;
    status: string;
  }> = [];

  await expect(
    runnerdRecoveryInternals.awaitRunnerSuspensionBarrier({
      commands: () => commands,
      queueSuspend: (commandId) => {
        commands.push({
          commandId,
          type: "runner.suspend",
          status: "pending",
        });
      },
      readRunnerState: async () => ({ lifecycle: "ready" }),
      runnerHasExited: async () => true,
      pump: () => undefined,
      deadline: Date.now() + 5,
      pollIntervalMs: 0,
    }),
  ).resolves.toBe(false);
});

it("reserves a bounded suspension window after close preparation", () => {
  expect(runnerdRecoveryInternals.runnerCloseDeadlines(1_000, 10_000)).toEqual({
    preparationDeadline: 8_500,
    closeDeadline: 11_000,
  });
  expect(runnerdRecoveryInternals.runnerCloseDeadlines(1_000, 400)).toEqual({
    preparationDeadline: 1_200,
    closeDeadline: 1_400,
  });
});

it("joins an already-completed suspension without queuing a command to an exited runner", async () => {
  const commands = [
    { commandId: "exact-suspend", type: "runner.suspend", status: "completed" },
  ];
  const queueSuspend = vi.fn();
  await expect(
    runnerdRecoveryInternals.awaitRunnerSuspensionBarrier({
      commands: () => commands,
      queueSuspend,
      readRunnerState: async () => ({ lifecycle: "suspended" }),
      runnerHasExited: async () => true,
      pump: () => undefined,
      deadline: Date.now() + 1_000,
    }),
  ).resolves.toBe(true);
  expect(queueSuspend).not.toHaveBeenCalled();
});

it("queues a fresh suspension when a completed old command belongs to a resumed ready runner", async () => {
  const commands = [
    { commandId: "old-suspend", type: "runner.suspend", status: "completed" },
  ];
  let lifecycle = "ready";
  const queueSuspend = vi.fn((commandId: string) => {
    commands.push({ commandId, type: "runner.suspend", status: "pending" });
  });
  await expect(
    runnerdRecoveryInternals.awaitRunnerSuspensionBarrier({
      commands: () => commands,
      queueSuspend,
      readRunnerState: async () => ({ lifecycle }),
      runnerHasExited: async () => false,
      pump: () => {
        if (commands.length === 2) {
          commands[1]!.status = "completed";
          lifecycle = "suspended";
        }
      },
      deadline: Date.now() + 1_000,
    }),
  ).resolves.toBe(true);
  expect(queueSuspend).toHaveBeenCalledOnce();
  expect(commands[1]!.commandId).not.toBe("old-suspend");
});

it("keeps ACPX terminal tools under the reserved runner-owned catalog", () => {
  const tools = [
    {
      name: "get_task_context",
      description: "Read the task context.",
      inputSchema: { type: "object" },
    },
    ...codexSemanticToolSpecs(),
  ];

  expect(authorizedToolSetForProvider("acpx", tools)).toMatchObject({
    operations: [{ operationId: "get_task_context" }],
  });
  expect(authorizedToolSetForProvider("codex", tools)).toMatchObject({
    operations: [
      { operationId: "get_task_context" },
      { operationId: "paperclip_block" },
      { operationId: "paperclip_finish" },
    ],
  });
});

it("preserves answer and internal wait descriptions in the serialized native tool catalog", () => {
  const catalog = JSON.parse(
    JSON.stringify(authorizedToolSetForProvider("codex", codexSemanticToolSpecs())),
  );
  const finish = catalog.operations.find(
    (operation: { operationId: string }) =>
      operation.operationId === "paperclip_finish",
  );
  expect(finish.inputSchema.properties.summary.description).toContain(
    "complete user-facing answer",
  );
  expect(finish.inputSchema.properties.summary.description).toContain(
    "genuine actionable failure, limitation, or required user action",
  );
  expect(
    finish.inputSchema.properties.continuation.properties.summary.description,
  ).toContain("not in the top-level user-facing summary");
});

it("defaults runnerd ACPX permissions to approve reads", () => {
  expect(resolveRunnerdAcpxPermissionMode(undefined)).toBe("approve-reads");
  expect(resolveRunnerdAcpxPermissionMode("deny-all")).toBe("deny-all");
});

it("rejects caller-selected local ACPX artifacts even when they are self-hashed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paperclip-acpx-authority-"));
  const command = join(directory, "node");
  const sidecar = join(directory, "sidecar.js");
  await writeFile(command, "caller-selected command", { mode: 0o700 });
  await writeFile(sidecar, "caller-selected sidecar", { mode: 0o600 });
  const digest = (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`;
  try {
    expect(() =>
      runnerdLaunchProfileInternals.acpxRunnerLaunchProfile(
        {
          providerNodeCommand: command,
          providerNodeCommandSha256: digest("caller-selected command"),
          acpxSidecarPath: sidecar,
          acpxSidecarSha256: digest("caller-selected sidecar"),
        },
        command,
        sidecar,
      ),
    ).toThrow("ACPX local launch must use build-owned artifacts");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["acpx-runtime-sidecar.cjs", "opencode-app-server-proxy.cjs"] as const)(
  "resolves the %s local provider artifact from verified build-owned output",
  async (artifact) => {
    const directory = await mkdtemp(
      join(tmpdir(), "paperclip-provider-artifact-"),
    );
    const sourceAdjacent = join(directory, "src", "cli", artifact);
    const buildOwned = join(directory, "dist", "cli", artifact);
    await mkdir(join(directory, "dist", "cli"), { recursive: true });
    await writeFile(buildOwned, "build-owned provider artifact", {
      mode: 0o600,
    });
    try {
      expect(
        runnerdLaunchProfileInternals.resolveBuildOwnedCliArtifact(artifact, [
          sourceAdjacent,
          buildOwned,
        ]),
      ).toBe(buildOwned);
      await rm(buildOwned);
      expect(() =>
        runnerdLaunchProfileInternals.resolveBuildOwnedCliArtifact(artifact, [
          sourceAdjacent,
          buildOwned,
        ]),
      ).toThrow(`runner_local_provider_artifact_missing: ${artifact}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("derives the ACPX package authority only from the verified dist/cli layout", () => {
  const runnerPackageRoot = fileURLToPath(new URL("../..", import.meta.url));
  expect(
    runnerdLaunchProfileInternals.acpxProviderPackageAuthority(
      resolve(runnerPackageRoot, "dist/cli/acpx-runtime-sidecar.cjs"),
    ),
  ).toEqual({
    root: resolve(runnerPackageRoot, "../.."),
    manifest: resolve(runnerPackageRoot, "package.json"),
  });
  expect(
    runnerdLaunchProfileInternals.acpxProviderPackageAuthority(
      "/provider-pack/dist/cli/acpx-runtime-sidecar.cjs",
    ),
  ).toEqual({
    root: "/provider-pack",
    manifest: "/provider-pack/package.json",
  });
  expect(() =>
    runnerdLaunchProfileInternals.acpxProviderPackageAuthority(
      "/unverified/acpx-runtime-sidecar.cjs",
    ),
  ).toThrow("ACPX sidecar must use the provider package dist/cli layout");
});

it("keeps a self-rooted pnpm deployment inside its dependency authority", async () => {
  const deploymentRoot = await mkdtemp(
    join(tmpdir(), "paperclip-deployed-provider-root-"),
  );
  const deployedPackageRoot = deploymentRoot;
  await mkdir(join(deployedPackageRoot, "dist", "cli"), { recursive: true });
  await mkdir(join(deploymentRoot, "node_modules", ".pnpm"), {
    recursive: true,
  });
  try {
    expect(
      runnerdLaunchProfileInternals.acpxProviderPackageAuthority(
        join(
          deployedPackageRoot,
          "dist",
          "cli",
          "acpx-runtime-sidecar.cjs",
        ),
        deployedPackageRoot,
      ),
    ).toEqual({
      root: deploymentRoot,
      manifest: join(deployedPackageRoot, "package.json"),
    });
  } finally {
    await rm(deploymentRoot, { recursive: true, force: true });
  }
});

it("keeps a scoped npm-installed package inside its portable dependency root", async () => {
  const deploymentRoot = await mkdtemp(
    join(tmpdir(), "paperclip-npm-provider-root-"),
  );
  const deployedPackageRoot = join(
    deploymentRoot,
    "node_modules",
    "@paperclipai",
    "paperclip-runner",
  );
  await mkdir(join(deployedPackageRoot, "dist", "cli"), { recursive: true });
  try {
    expect(
      runnerdLaunchProfileInternals.acpxProviderPackageAuthority(
        join(
          deployedPackageRoot,
          "dist",
          "cli",
          "acpx-runtime-sidecar.cjs",
        ),
        deployedPackageRoot,
      ),
    ).toEqual({
      root: deploymentRoot,
      manifest: join(deployedPackageRoot, "package.json"),
    });
  } finally {
    await rm(deploymentRoot, { recursive: true, force: true });
  }
});

it("requires a provider-pack authority for remote ACPX artifact hashes", () => {
  expect(() =>
    runnerdLaunchProfileInternals.acpxRunnerLaunchProfile(
      {
        runnerFilesystemRoot: "/runner",
        providerNodeCommand: "/provider-pack/node",
        providerNodeCommandSha256: `sha256:${"a".repeat(64)}`,
        acpxSidecarPath: "/provider-pack/acpx-sidecar.js",
        acpxSidecarSha256: `sha256:${"b".repeat(64)}`,
      },
      "/provider-pack/node",
      "/provider-pack/acpx-sidecar.js",
    ),
  ).toThrow("omitted its provider-pack authority");
});

it("adds Codex-style turn updates only when collaboration instructions are enabled", () => {
  const base = "Base Paperclip instructions.";
  const enabled = withCodexCollaborationRuntimeInstructions(base, true);
  expect(enabled).toContain(base);
  expect(enabled).toContain("Before the first tool call in a turn");
  expect(enabled).toContain(
    "Do not call it merely to create a completion comment",
  );
  expect(enabled).toContain("semantic completion tool exactly once before");
  expect(enabled).toContain("After it succeeds");
  expect(enabled).not.toContain("Before semantic finalization");
  expect(withCodexCollaborationRuntimeInstructions(base, false)).toBe(base);
});

it("resolves the ordinary ~/.codex credential home when CODEX_HOME is unset", () => {
  expect(resolveSourceCodexHome({ HOME: "/Users/tester" })).toBe(
    "/Users/tester/.codex",
  );
  expect(
    resolveSourceCodexHome({
      HOME: "/Users/tester",
      CODEX_HOME: "/managed/codex",
    }),
  ).toBe("/managed/codex");
});

it("preserves OpenCode runtime bindings when a durable runner is respawned", () => {
  const environment = createCapabilityRunnerdProviderEnvironment({
    provider: "opencode",
    options: {
      provider: "opencode",
      stateDirectory: "/isolated/session",
      opencodePermissionMode: "deny",
      environment: {
        PATH: "/bin",
        OPENROUTER_API_KEY: "test-provider-key",
        HOME: "/host/home",
        CODEX_HOME: "/host/codex-home",
        DATABASE_URL: "must-not-reach-runnerd",
        PAPERCLIP_API_KEY: "must-not-reach-runnerd",
        NODE_OPTIONS: "--require=/untrusted/bootstrap.cjs",
      },
      opencodeCommand: "/provider-pack/opencode",
      opencodeRuntimeDirectory: "/isolated/session/opencode",
    },
    identity: {
      runnerInstanceId: "runner-1",
      environmentLeaseId: "lease-1",
      runId: "run-1",
      normalizedSessionId: "session-1",
      turnId: "turn-1",
      itemId: "item-1",
    },
    codexHome: "/isolated/codex-home",
    runtimeContextPath: "/isolated/runtime-context.json",
    hasRuntimeContext: true,
  });
  expect(environment).toMatchObject({
    PAPERCLIP_OPENCODE_PERMISSION_MODE: "deny",
    PAPERCLIP_OPENCODE_RUNTIME_DIR: "/isolated/session/opencode",
    PAPERCLIP_RUNNER_INSTANCE_ID: "runner-1",
    PAPERCLIP_RUN_ID: "run-1",
    PAPERCLIP_NORMALIZED_SESSION_ID: "session-1",
    PAPERCLIP_NATIVE_RUNTIME_CONTEXT_PATH: "/isolated/runtime-context.json",
    OPENROUTER_API_KEY: "test-provider-key",
  });
  expect(environment.HOME).toBeUndefined();
  expect(environment.CODEX_HOME).toBeUndefined();
  expect(environment.DATABASE_URL).toBeUndefined();
  expect(environment.PAPERCLIP_API_KEY).toBeUndefined();
  expect(environment.NODE_OPTIONS).toBeUndefined();
  expect(environment.PAPERCLIP_OPENCODE_COMMAND).toBeUndefined();

  const defaultPermissionEnvironment =
    createCapabilityRunnerdProviderEnvironment({
      provider: "opencode",
      options: {
        provider: "opencode",
        stateDirectory: "/isolated/session",
        environment: { PATH: "/bin" },
      },
      identity: {
        runnerInstanceId: "runner-1",
        environmentLeaseId: "lease-1",
        runId: "run-1",
        normalizedSessionId: "session-1",
        turnId: "turn-1",
        itemId: "item-1",
      },
      codexHome: "/isolated/codex-home",
      runtimeContextPath: "/isolated/runtime-context.json",
      hasRuntimeContext: false,
    });
  expect(defaultPermissionEnvironment.PAPERCLIP_OPENCODE_PERMISSION_MODE).toBe(
    "ask",
  );
});

it("passes the configured Codex API key only through the provider process environment", () => {
  const environment = createCapabilityRunnerdProviderEnvironment({
    provider: "codex",
    options: {
      provider: "codex",
      environment: {
        PATH: "/bin",
        OPENAI_API_KEY: "configured-provider-key",
        CODEX_API_KEY: "configured-automation-key",
        PAPERCLIP_API_KEY: "must-not-reach-provider",
      },
    },
    identity: {
      runnerInstanceId: "runner-1",
      environmentLeaseId: "lease-1",
      runId: "run-1",
      normalizedSessionId: "session-1",
      turnId: "turn-1",
      itemId: "item-1",
    },
    codexHome: "/isolated/codex-home",
    runtimeContextPath: "/isolated/runtime-context.json",
    hasRuntimeContext: false,
  });
  expect(environment).toMatchObject({
    PATH: "/bin",
    HOME: "/isolated/codex-home",
    CODEX_HOME: "/isolated/codex-home",
    OPENAI_API_KEY: "configured-provider-key",
    CODEX_API_KEY: "configured-automation-key",
  });
  expect(environment.PAPERCLIP_API_KEY).toBeUndefined();
});

it("passes only the Anthropic credential to Claude Managed runnerd", () => {
  const environment = createCapabilityRunnerdProviderEnvironment({
    provider: "claude_managed",
    options: {
      provider: "claude_managed",
      environment: {
        PATH: "/bin",
        ANTHROPIC_API_KEY: "anthropic-canary",
        PAPERCLIP_NATIVE_MCP_NAME: "paperclip",
        PAPERCLIP_NATIVE_MCP_URL: "https://paperclip.example/mcp",
        PAPERCLIP_NATIVE_MCP_TOKEN: "must-not-reach-provider",
        PAPERCLIP_API_KEY: "must-not-reach-provider",
        DATABASE_URL: "must-not-reach-provider",
      },
    },
    identity: {
      runnerInstanceId: "runner-1",
      environmentLeaseId: "lease-1",
      runId: "run-1",
      normalizedSessionId: "session-1",
      turnId: "turn-1",
      itemId: "item-1",
    },
    codexHome: "/isolated/codex-home",
    runtimeContextPath: "/isolated/runtime-context.json",
    hasRuntimeContext: true,
  });
  expect(environment).toMatchObject({
    PATH: "/bin",
    ANTHROPIC_API_KEY: "anthropic-canary",
    PAPERCLIP_RUNNER_INSTANCE_ID: "runner-1",
    PAPERCLIP_RUN_ID: "run-1",
    PAPERCLIP_NORMALIZED_SESSION_ID: "session-1",
  });
  expect(environment.PAPERCLIP_NATIVE_MCP_NAME).toBeUndefined();
  expect(environment.PAPERCLIP_NATIVE_MCP_URL).toBeUndefined();
  expect(environment.PAPERCLIP_NATIVE_MCP_TOKEN).toBeUndefined();
  expect(environment.PAPERCLIP_API_KEY).toBeUndefined();
  expect(environment.DATABASE_URL).toBeUndefined();
});

it("uses file-backed AWS workload identity without forwarding access keys or Paperclip tokens", () => {
  const environment = createCapabilityRunnerdProviderEnvironment({
    provider: "aws_agentcore",
    options: {
      provider: "aws_agentcore",
      environment: {
        PATH: "/bin",
        HOME: "/host/home",
        AWS_PROFILE: "host-profile",
        AWS_CONFIG_FILE: "/host/home/.aws/config",
        AWS_SHARED_CREDENTIALS_FILE: "/host/home/.aws/credentials",
        AWS_REGION: "us-east-1",
        AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/runner",
        AWS_WEB_IDENTITY_TOKEN_FILE: "/identity/token",
        AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: "/identity/container-token",
        AWS_ACCESS_KEY_ID: "must-not-reach-provider",
        AWS_SECRET_ACCESS_KEY: "must-not-reach-provider",
        AWS_SESSION_TOKEN: "must-not-reach-provider",
        PAPERCLIP_NATIVE_MCP_URL: "https://paperclip.example/mcp",
        PAPERCLIP_NATIVE_MCP_TOKEN: "must-not-reach-provider",
      },
    },
    identity: {
      runnerInstanceId: "runner-1",
      environmentLeaseId: "lease-1",
      runId: "run-1",
      normalizedSessionId: "session-1",
      turnId: "turn-1",
      itemId: "item-1",
    },
    codexHome: "/isolated/codex-home",
    runtimeContextPath: "/isolated/runtime-context.json",
    hasRuntimeContext: false,
  });
  expect(environment).toMatchObject({
    HOME: "/isolated/codex-home",
    AWS_REGION: "us-east-1",
    AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/runner",
    AWS_WEB_IDENTITY_TOKEN_FILE: "/identity/token",
    AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: "/identity/container-token",
  });
  expect(environment.AWS_ACCESS_KEY_ID).toBeUndefined();
  expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  expect(environment.AWS_SESSION_TOKEN).toBeUndefined();
  expect(environment.AWS_PROFILE).toBeUndefined();
  expect(environment.AWS_CONFIG_FILE).toBeUndefined();
  expect(environment.AWS_SHARED_CREDENTIALS_FILE).toBeUndefined();
  expect(environment.PAPERCLIP_NATIVE_MCP_URL).toBeUndefined();
  expect(environment.PAPERCLIP_NATIVE_MCP_TOKEN).toBeUndefined();
});

it.each([
  {
    agent: "pi" as const,
    allowed: ["OPENROUTER_API_KEY"],
    denied: [
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET",
    ],
  },
  {
    agent: "claude" as const,
    allowed: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
    denied: [
      "OPENROUTER_API_KEY",
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET",
    ],
  },
  {
    agent: "codex" as const,
    allowed: ["OPENAI_API_KEY", "CODEX_API_KEY"],
    denied: [
      "OPENROUTER_API_KEY",
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET",
    ],
  },
])(
  "passes only $agent ACPX credentials and the durable runtime binding",
  ({ agent, allowed, denied }) => {
    const credentialEnvironment: Record<string, string> = {
      OPENROUTER_API_KEY: "openrouter-canary",
      ANTHROPIC_API_KEY: "anthropic-canary",
      CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth-canary",
      OPENAI_API_KEY: "openai-canary",
      CODEX_API_KEY: "codex-canary",
      PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "managed-codex-canary",
    };
    const environment = createCapabilityRunnerdProviderEnvironment({
      provider: "acpx",
      options: {
        provider: "acpx",
        stateDirectory: "/isolated/session",
        acpxAgent: agent,
        environment: {
          PATH: "/bin",
          ...credentialEnvironment,
          PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT: "/attacker/package-root",
          PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST:
            "/attacker/package-root/package.json",
          PAPERCLIP_API_KEY: "must-not-reach-provider",
          DATABASE_URL: "must-not-reach-provider",
        },
      },
      identity: {
        runnerInstanceId: "runner-1",
        environmentLeaseId: "lease-1",
        runId: "run-1",
        normalizedSessionId: "session-1",
        turnId: "turn-1",
        itemId: "item-1",
      },
      codexHome: "/isolated/codex-home",
      runtimeContextPath: "/isolated/runtime-context.json",
      hasRuntimeContext: true,
      acpxSidecarPath:
        "/verified/provider-pack/dist/cli/acpx-runtime-sidecar.cjs",
    });

    expect(environment).toMatchObject({
      PATH: "/bin",
      PAPERCLIP_RUNNER_INSTANCE_ID: "runner-1",
      PAPERCLIP_RUN_ID: "run-1",
      PAPERCLIP_NORMALIZED_SESSION_ID: "session-1",
      PAPERCLIP_NATIVE_RUNTIME_CONTEXT_PATH: "/isolated/runtime-context.json",
      PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT: "/verified/provider-pack",
      PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST:
        "/verified/provider-pack/package.json",
    });
    for (const key of allowed)
      expect(environment[key]).toBe(credentialEnvironment[key]);
    for (const key of denied) expect(environment[key]).toBeUndefined();
    expect(environment.PAPERCLIP_API_KEY).toBeUndefined();
    expect(environment.DATABASE_URL).toBeUndefined();
  },
);

it.each(["opencode", "acpx"] as const)(
  "advertises runner-managed planning through the %s provider boundary",
  async (provider) => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-runner-plan-mode-"));
    const { transport } = createCapabilityRunnerdCodexTransport({
      provider,
      stateDirectory: root,
      ...(provider === "acpx" ? { acpxAgent: "codex" as const } : {}),
    });
    try {
      await expect(
        transport.request("collaborationMode/list", {}),
      ).resolves.toMatchObject({
        data: [{ mode: "plan", model: "runner-managed" }],
      });
    } finally {
      await transport.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("allows trusted package-manager runtime roots without exposing HOME paths", () => {
  expect(
    trustedRuntimeReadOnlyRoots({
      HOME: "/Users/tester",
      PATH: "/Users/tester/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    }),
  ).toEqual(["/opt/homebrew", "/usr/local"]);
});

it("denies the isolated Codex home without denying a remote execution workspace", () => {
  const args = createRunnerdCodexAppServerArgs({
    environment: {
      HOME: "/workspaces/task",
      CODEX_HOME: "/workspaces/task/.codex",
      PATH: "/usr/local/bin:/usr/bin:/bin",
    },
    codexHome:
      "/workspaces/task/.paperclip-runtime/paperclip-runner/sessions/session/filesystem/codex-home",
    readOnlyRoots: ["/usr/local"],
  });
  const serialized = args.join("\n");

  expect(serialized).toContain(
    '"/workspaces/task/.paperclip-runtime/paperclip-runner/sessions/session/filesystem/codex-home"="none"',
  );
  expect(serialized).not.toContain('"/workspaces/task"="none"');
  expect(serialized).not.toContain('"/workspaces/task/.codex"="none"');
  expect(serialized).toContain('\":workspace_roots\"={\".\"=\"write\"}');
});

it("rejects remote OpenCode before spawn when provider-pack paths are absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-runner-remote-pack-"));
  const { transport } = createCapabilityRunnerdCodexTransport({
    provider: "opencode",
    stateDirectory: root,
    runnerFilesystemRoot: "/workspaces/task/.paperclip-runtime/session",
  });
  try {
    await expect(
      transport.request("thread/start", {
        cwd: "/workspaces/task",
        model: "openrouter/model",
        baseInstructions: "Complete the task.",
        dynamicTools: [],
      }),
    ).rejects.toThrow("runner_remote_provider_artifact_incompatible");
  } finally {
    await transport.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("rehydrates normalized usage with the opened driver binding", () => {
  expect(
    rehydrateRunnerdUsageNotification(
      {
        providerSessionId: "backend-session-1",
        threadId: "provider-thread-1",
        turnId: "durable-turn-1",
        cumulative: { inputTokens: 10 },
        runDelta: { inputTokens: 3 },
        runDeltaAvailable: true,
      },
      "opened-thread-1",
      "active-turn-1",
    ),
  ).toMatchObject({
    providerSessionId: "backend-session-1",
    threadId: "opened-thread-1",
    turnId: "active-turn-1",
    runDeltaAvailable: true,
    tokenUsage: {
      total: { inputTokens: 10 },
      runDelta: { inputTokens: 3 },
    },
  });
});

it("rehydrates durable cumulative usage for a cold thread read", () => {
  expect(
    rehydrateRunnerdThreadTokenUsage({ inputTokens: 12, outputTokens: 3 }),
  ).toEqual({
    total: { inputTokens: 12, outputTokens: 3 },
  });
  expect(rehydrateRunnerdThreadTokenUsage(null)).toBeNull();
});

it("binds a durable semantic result to the active provider turn", () => {
  expect(
    rehydrateRunnerdResultNotification(
      { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done" },
      "opened-thread-1",
      "provider-turn-1",
      "finish-1",
    ),
  ).toEqual({
    threadId: "opened-thread-1",
    turnId: "provider-turn-1",
    itemId: "finish-1",
    result: {
      schema: "paperclip.run_result.v1",
      reportedWorkDisposition: "done",
    },
  });
});

it("restores provider identity and streamed text from a canonical delta", () => {
  expect(rehydrateRunnerdDeltaNotification({ text: "Reading Gmail", itemId: "message-1", turnId: "controller-turn" }, "root-thread", "provider-turn"))
    .toMatchObject({ threadId: "root-thread", turnId: "provider-turn", delta: "Reading Gmail", itemId: "message-1" });
});

it("rehydrates a canonical agent item for the strict Codex facade", () => {
  expect(
    rehydrateRunnerdItemNotification(
      {
        itemId: "message-1",
        kind: "agentMessage",
        status: "completed",
        channel: "final",
        providerPhase: "final_answer",
        text: "Durable final reply",
      },
      "opened-thread-1",
      "provider-turn-1",
    ),
  ).toEqual({
    itemId: "message-1",
    kind: "agentMessage",
    status: "completed",
    channel: "final",
    providerPhase: "final_answer",
    text: "Durable final reply",
    threadId: "opened-thread-1",
    turnId: "provider-turn-1",
    item: {
      [RUNNERD_CANONICAL_ITEM]: true,
      id: "message-1",
      type: "agentMessage",
      status: "completed",
      text: "Durable final reply",
      phase: "final_answer",
      channel: "final",
    },
  });
});

it.each([
  ["progress", "commentary"],
  ["final", "final_answer"],
] as const)(
  "rehydrates the %s assistant channel when provider phase is absent",
  (channel, phase) => {
    expect(
      rehydrateRunnerdItemNotification(
        {
          itemId: `message-${channel}`,
          kind: "agentMessage",
          status: "completed",
          channel,
          text: `${channel} reply`,
        },
        "opened-thread-1",
        "provider-turn-1",
      ),
    ).toMatchObject({
      item: { channel, phase },
    });
  },
);

it("binds a canonical runnerd terminal to the active provider turn", () => {
  expect(
    rehydrateRunnerdTurnNotification(
      {
        turnId: "durable-turn-1",
        turn: { id: "durable-turn-1", status: "completed", items: [] },
      },
      "opened-thread-1",
      "provider-turn-1",
      "turn/completed",
    ),
  ).toEqual({
    threadId: "opened-thread-1",
    turnId: "provider-turn-1",
    turn: { id: "provider-turn-1", status: "completed", items: [] },
  });
});

it("rehydrates a canonical runnerd terminal error into the Codex turn", () => {
  expect(
    rehydrateRunnerdTurnNotification(
      {
        providerTurnId: "provider-turn-1",
        status: "failed",
        error: {
          code: "provider_failed",
          message: "provider rejected the turn",
        },
      },
      "opened-thread-1",
      "provider-turn-1",
      "turn/completed",
    ),
  ).toMatchObject({
    threadId: "opened-thread-1",
    turnId: "provider-turn-1",
    turn: {
      id: "provider-turn-1",
      status: "failed",
      error: { code: "provider_failed", message: "provider rejected the turn" },
    },
  });
});

it("preserves the provider identity on a late canonical terminal", () => {
  expect(
    rehydrateRunnerdTurnNotification(
      {
        providerTurnId: "provider-turn-settled",
        status: "interrupted",
      },
      "opened-thread-1",
      "provider-turn-active",
      "turn/completed",
    ),
  ).toMatchObject({
    threadId: "opened-thread-1",
    turnId: "provider-turn-settled",
    turn: { id: "provider-turn-settled", status: "interrupted" },
  });
});

it("preserves the provider turn assigned by a canonical runnerd start", () => {
  expect(
    rehydrateRunnerdTurnNotification(
      { provider: "codex", providerTurnId: "provider-turn-1" },
      "opened-thread-1",
      "temporary-transport-turn",
      "turn/started",
    ),
  ).toEqual({
    provider: "codex",
    providerTurnId: "provider-turn-1",
    threadId: "opened-thread-1",
    turnId: "provider-turn-1",
    turn: { id: "provider-turn-1" },
  });
});

it("rehydrates normalized plans into the Codex notification contract", () => {
  expect(
    rehydrateRunnerdPlanNotification(
      {
        explanation: "Ship in small steps",
        steps: [
          { stepId: "step-1", body: "Inspect", status: "completed" },
          { stepId: "step-2", body: "Implement", status: "in_progress" },
        ],
      },
      "thread-1",
      "turn-1",
    ),
  ).toMatchObject({
    threadId: "thread-1",
    turnId: "turn-1",
    explanation: "Ship in small steps",
    plan: [
      { step: "Inspect", status: "completed" },
      { step: "Implement", status: "in_progress" },
    ],
  });
});

it("rehydrates canonical workspace changes without reconstructing the diff", () => {
  const workspaceChange = {
    schema: "paperclip.workspace.diff.v1",
    changeSetId: "turn-1:workspace",
    revision: 1,
    source: "harness_reported",
    complete: false,
    files: [
      {
        path: "src/index.ts",
        operation: "modify",
        previousPath: null,
        additions: 2,
        deletions: 1,
        binary: false,
        diff: "diff --git a/src/index.ts b/src/index.ts\n",
      },
    ],
    totals: { files: 1, additions: 2, deletions: 1 },
    patchArtifactRef: null,
  };
  expect(
    rehydrateRunnerdWorkspaceChangeNotification(
      workspaceChange,
      "thread-1",
      "turn-1",
    ),
  ).toEqual({
    threadId: "thread-1",
    turnId: "turn-1",
    workspaceChange,
  });
});

it("rehydrates canonical session goals into Codex goal notifications", () => {
  expect(
    rehydrateRunnerdGoalNotification(
      {
        goal: {
          objective: "Finish the browser lifecycle",
          status: "complete",
          tokenBudget: 20_000,
          tokensUsed: 12_345,
          elapsedSeconds: 42,
        },
        workingNow: false,
      },
      "thread-1",
      "thread/goal/updated",
    ),
  ).toEqual({
    threadId: "thread-1",
    goal: {
      threadId: "thread-1",
      objective: "Finish the browser lifecycle",
      status: "complete",
      tokenBudget: 20_000,
      tokensUsed: 12_345,
      timeUsedSeconds: 42,
      createdAt: 0,
      updatedAt: 0,
    },
    workingNow: false,
  });
  expect(
    rehydrateRunnerdGoalNotification(
      { revision: 7, workingNow: false },
      "thread-1",
      "thread/goal/cleared",
    ),
  ).toEqual({ revision: 7, threadId: "thread-1", workingNow: false });
});

it("routes canonical session goals back through the Codex notification facade", () => {
  expect(
    runnerdCanonicalNotificationMethod("session.goal.updated", {
      goal: { status: "complete" },
    }),
  ).toBe("thread/goal/updated");
  expect(
    runnerdCanonicalNotificationMethod("session.goal.snapshot", { goal: null }),
  ).toBeUndefined();
  expect(runnerdCanonicalNotificationMethod("session.goal.cleared", {})).toBe(
    "thread/goal/cleared",
  );
});

it("continues consuming after the durable committed-event window rolls", () => {
  const rollingWindow = Array.from({ length: 64 }, (_, index) => ({
    sourceSeq: index + 65,
    eventType: index === 62 ? "session.goal.updated" : "item.delta",
  }));
  expect(unseenRunnerdCommittedEvents(rollingWindow, 64)).toEqual(
    rollingWindow,
  );
  expect(unseenRunnerdCommittedEvents(rollingWindow, 128)).toEqual([]);
  expect(() => unseenRunnerdCommittedEvents(rollingWindow, 63)).toThrow(
    "provider_notification_window_exceeded",
  );
});

it("resolves canonical and legacy durable session identities", () => {
  expect(
    resolveRunnerdSessionIdentity({
      provider: "codex",
      providerSessionId: "provider-thread-1",
      providerAccountSessionId: "provider-account-1",
      processId: 4242,
    }),
  ).toEqual({
    processId: 4242,
    threadId: "provider-thread-1",
    sessionId: "provider-account-1",
  });
  expect(
    resolveRunnerdSessionIdentity({
      driverSessionId: "provider-thread-2",
      providerSessionId: "provider-account-2",
      processId: 4243,
    }),
  ).toEqual({
    processId: 4243,
    threadId: "provider-thread-2",
    sessionId: "provider-account-2",
  });
  expect(
    resolveRunnerdSessionIdentity({
      threadId: "legacy-thread-1",
      sessionId: "legacy-session-1",
      runtimeIdentity: { process_id: 4343 },
    }),
  ).toEqual({
    processId: 4343,
    threadId: "legacy-thread-1",
    sessionId: "legacy-session-1",
  });
});

it("recovers provider readiness from an already-committed journal without replay", () => {
  const persistedReady = {
    provider: "codex",
    providerSessionId: "provider-thread-persisted",
    providerAccountSessionId: "provider-account-persisted",
    processId: 4242,
    runtimeIdentity: { executionKind: "local_process" },
    providerDescriptor: {
      driver: "codex_app_server",
      providerVersion: "persisted-version",
    },
    providerIdentity: {
      kind: "codex_thread",
      threadId: "provider-thread-persisted",
    },
  };
  expect(
    latestRunnerdSessionReadiness([
      {
        eventType: "harness.ready",
        envelope: { payload: { payload: persistedReady } },
      },
      {
        eventType: "session.goal.snapshot",
        envelope: { payload: { payload: { goal: { status: "paused" } } } },
      },
    ]),
  ).toEqual(persistedReady);
});

const fakeCodex = resolve(
  import.meta.dirname,
  "../../runner/target/debug/fake-codex-app-server",
);

function fakeCodexArgs(stateDirectory: string, ...args: string[]): string[] {
  return [
    "--state-file",
    join(stateDirectory, "fake-codex-state.json"),
    ...args,
  ];
}

function assignedRuntimeContext(
  skillRoot: string,
  instructionRoot: string,
): NativeRuntimeContextSnapshot {
  const digest = "0".repeat(64);
  const value = {
    prompt: {
      revision: PAPERCLIP_EXECUTION_PROMPT_REVISION,
      text: PAPERCLIP_EXECUTION_PROMPT,
      digest: nativeRuntimePromptDigest(),
    },
    instructions: {
      entryPath: "AGENTS.md",
      bundle: {
        schema: NATIVE_RUNTIME_ASSET_SCHEMA,
        digest,
        manifestDigest: digest,
        rootPath: instructionRoot,
        fileCount: 1,
        totalBytes: 1,
      },
    },
    skills: [
      {
        key: "company/assigned",
        runtimeName: "assigned",
        versionId: "version-1",
        bundle: {
          schema: NATIVE_RUNTIME_ASSET_SCHEMA,
          digest,
          manifestDigest: digest,
          rootPath: skillRoot,
          fileCount: 1,
          totalBytes: 1,
        },
      },
    ],
    mcp: { assignmentSetId: "assigned", digest, bindingId: "binding" },
  } satisfies Omit<NativeRuntimeContextSnapshot, "aggregateDigest">;
  return {
    ...value,
    aggregateDigest: canonicalNativeRuntimeContextDigest(value),
  };
}

it("unwraps a coalesced provider notification without losing its turn identity", () => {
  expect(
    unwrapRunnerdProviderNotification({
      coalescedCount: 2,
      latest: {
        method: "turn/started",
        params: { threadId: "thread-1", turn: { id: "provider-turn-1" } },
      },
    }),
  ).toEqual({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "provider-turn-1" } },
  });
});

it("replays every provider notification from a durable coalesced batch", () => {
  expect(
    unwrapRunnerdProviderNotifications({
      coalescedCount: 3,
      events: [
        { method: "item/started", params: { item: { id: "reasoning-1" } } },
        {
          method: "item/reasoning/summaryTextDelta",
          params: { delta: "Checking the task" },
        },
        { method: "item/completed", params: { item: { id: "reasoning-1" } } },
      ],
    }),
  ).toEqual([
    expect.objectContaining({ method: "item/started" }),
    expect.objectContaining({ method: "item/reasoning/summaryTextDelta" }),
    expect.objectContaining({ method: "item/completed" }),
  ]);
});

it("expands coalesced canonical items without dropping strict bindings", () => {
  expect(
    expandRunnerdCanonicalNotifications("item/started", {
      coalescedCount: 2,
      events: [
        { threadId: "thread-1", turnId: "turn-1", item: { id: "reasoning-1" } },
        { threadId: "thread-1", turnId: "turn-1", item: { id: "reasoning-2" } },
      ],
    }),
  ).toEqual([
    {
      method: "item/started",
      params: expect.objectContaining({
        threadId: "thread-1",
        turnId: "turn-1",
      }),
    },
    {
      method: "item/started",
      params: expect.objectContaining({
        threadId: "thread-1",
        turnId: "turn-1",
      }),
    },
  ]);
});

it("runs the lab provider boundary through authenticated durable PRP", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-lab-provider-"));
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory),
    stateDirectory,
  });
  bundle.transport.setServerRequestHandler(async (request) => ({
    success: true,
    contentItems: [
      {
        type: "inputText",
        text: JSON.stringify({
          ok: true,
          result: { task: { title: "PRP lab task" } },
        }),
      },
    ],
  }));
  try {
    await bundle.transport.request("initialize", {});
    const opened = await bundle.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: [
        {
          name: "get_task_context",
          description: "Read the active task.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    });
    expect(opened.thread).toMatchObject({ modelProvider: "openai" });
    await bundle.transport.request("turn/start", {
      input: [{ type: "text", text: "Read the task." }],
    });
    const methods: string[] = [];
    let terminalParams: Record<string, unknown> | null = null;
    for await (const notification of bundle.transport.notifications()) {
      methods.push(notification.method);
      if (notification.method === "turn/completed") {
        terminalParams = notification.params;
        break;
      }
    }
    expect(methods).toContain("turn/completed");
    expect(terminalParams).toMatchObject({
      threadId: opened.thread.id,
      turnId: "provider-turn-1",
    });
    expect(bundle.evidence().diagnostics).toContain(
      "runnerd authenticated to the durable PRP control plane",
    );
  } finally {
    await bundle.transport.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
  expect(bundle.evidence()).toMatchObject({
    runnerExited: true,
    runnerExitCode: 0,
  });
}, 30_000);

it("controls a Codex session goal end to end through durable PRP v2", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-goal-provider-"));
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory, "--goal-autostart"),
    stateDirectory,
  });
  bundle.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [],
  }));
  try {
    await bundle.transport.request("initialize", {});
    const opened = await bundle.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: [
        {
          name: "get_task_context",
          description: "Read the active task.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    });
    const threadId = opened.thread.id;

    await expect(
      bundle.transport.request("thread/goal/set", {
        threadId,
        objective: "Finish the durable PRP goal test",
        status: "active",
        tokenBudget: 12_000,
      }),
    ).resolves.toMatchObject({
      goal: {
        threadId,
        objective: "Finish the durable PRP goal test",
        status: "active",
        tokenBudget: 12_000,
      },
    });
    let durableGoalEvent: Record<string, unknown> | null = null;
    let durableTurnStarted = false;
    const deliveryDeadline = Date.now() + 5_000;
    while (Date.now() < deliveryDeadline) {
      const controlState = JSON.parse(
        await readFile(
          join(stateDirectory, "control-plane", "control-plane-state.json"),
          "utf8",
        ),
      ) as {
        committedEvents?: Array<Record<string, unknown>>;
      };
      durableGoalEvent =
        controlState.committedEvents?.find(
          (event) => event.eventType === "session.goal.updated",
        ) ?? null;
      durableTurnStarted =
        controlState.committedEvents?.some(
          (event) => event.eventType === "turn.started",
        ) ?? false;
      if (durableGoalEvent !== null && durableTurnStarted) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    expect(durableGoalEvent).not.toBeNull();
    expect(durableTurnStarted).toBe(true);
    expect(durableGoalEvent).toMatchObject({
      envelope: {
        payload: {
          payload: {
            goal: { lastReason: null },
          },
        },
      },
    });
    await expect(
      bundle.transport.request("thread/goal/get", { threadId }),
    ).resolves.toMatchObject({
      goal: {
        threadId,
        objective: "Finish the durable PRP goal test",
        status: "active",
      },
    });
    await expect(
      bundle.transport.request("thread/goal/set", {
        threadId,
        status: "paused",
      }),
    ).resolves.toMatchObject({ goal: { status: "paused" } });
    await expect(
      bundle.transport.request("thread/goal/set", {
        threadId,
        status: "active",
      }),
    ).resolves.toMatchObject({ goal: { status: "active" } });
    await expect(
      bundle.transport.request("thread/goal/clear", { threadId }),
    ).resolves.toEqual({});
    await expect(
      bundle.transport.request("thread/goal/get", { threadId }),
    ).resolves.toEqual({ goal: null });
  } finally {
    await bundle.transport.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
  expect(bundle.evidence()).toMatchObject({
    runnerExited: true,
    runnerExitCode: 0,
  });
}, 30_000);

it.each([false, true])("binds goal turns through the full Codex harness (autonomous continuation: %s)", async (autocontinue) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-goal-harness-"));
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory, "--goal-autostart", ...(autocontinue ? ["--goal-autocontinue"] : [])),
    stateDirectory,
  });
  const driver = new CodexAppServerDriver({
    taskEnvelope: {
      schema: "paperclip.skillless_task.v1",
      objective: "Finish the durable goal harness test.",
      completionContract: {
        revision: "goal-harness-v1",
        criteria: [{ id: "goal", requirement: "The goal turn starts." }],
      },
      constraints: [],
      expectedResultSchema: "paperclip.run_result.v1",
    },
    approvalPolicy: "never",
    includeCollaborationModeInstructions: false,
    environment: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: "/isolated/home",
      CODEX_HOME: "/isolated/codex-home",
      LANG: "C.UTF-8",
    },
    transportFactory: () => bundle.transport,
    requireProviderSessionIdentity: true,
  });
  let session: Awaited<ReturnType<typeof driver.openSession>> | null = null;
  try {
    session = await driver.openSession({
      runId: "run-goal-harness-autostart",
      normalizedSessionId: "normalized-goal-harness-autostart",
      workingDirectory: tmpdir(),
    });
    const observed: Array<{ eventType: string }> = [];
    const turnStarted = Promise.race([
      (async () => {
        for await (const event of session!.events()) {
          observed.push(event);
          if (event.eventType === "turn.started" && event.turnId === (autocontinue ? "provider-goal-turn-2" : "provider-goal-turn-1")) return event;
          if (event.eventType === "session.failed") {
            throw new Error(`goal autostart failed: ${JSON.stringify(event.payload)}`);
          }
        }
        throw new Error("goal autostart event stream closed");
      })(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("goal autostart timed out")), 5_000);
      }),
    ]);
    await expect(
      session.goal?.({
        action: "set",
        objective: "Finish the durable goal harness test.",
        status: "active",
        requestId: "goal-harness-autostart",
      }),
    ).resolves.toMatchObject({ status: "active" });
    await expect(turnStarted).resolves.toMatchObject({
      eventType: "turn.started",
      turnId: autocontinue ? "provider-goal-turn-2" : "provider-goal-turn-1",
    });
    expect(observed.some((event) => event.eventType === "session.failed")).toBe(false);
  } finally {
    await session?.close();
    await bundle.transport.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
  expect(bundle.evidence()).toMatchObject({
    runnerExited: true,
    runnerExitCode: 0,
  });
}, 30_000);

it("continues rehydrating events after the committed-event window slides", async () => {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "runnerd-sliding-event-window-"),
  );
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory, "--split-event-burst"),
    stateDirectory,
    lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
  });
  bundle.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [
      {
        type: "inputText",
        text: JSON.stringify({ ok: true, result: { task: { id: "task-1" } } }),
      },
    ],
  }));
  try {
    await bundle.transport.request("initialize", {});
    await bundle.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: [
        {
          name: "get_task_context",
          description: "Read the active task.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    });
    await bundle.transport.request("turn/start", {
      input: [{ type: "text", text: "Emit a split event burst." }],
    });
    const notifications = bundle.transport
      .notifications()
      [Symbol.asyncIterator]();
    const methods: string[] = [];
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const next = await Promise.race([
        notifications.next(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(new Error("sliding event window notification timeout")),
            10_000,
          ),
        ),
      ]);
      if (!next.value) break;
      methods.push(next.value.method);
      if (next.value.method === "turn/completed") break;
    }
    expect(
      methods.filter((method) => method === "item/agentMessage/delta"),
    ).toHaveLength(144);
    expect(methods).toContain("turn/completed");
  } finally {
    await bundle.transport.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);

it.each([
  { suffixCount: 48, suffixLifecycle: null },
  { suffixCount: 1024, suffixLifecycle: "settled-before-output" },
  { suffixCount: 1024, suffixLifecycle: "active-after-output" },
] as const)(
  "proves local suspension after an event backlog before rebinding the next run ($suffixCount suffix deltas; $suffixLifecycle)",
  async ({ suffixCount, suffixLifecycle }) => {
    const stateDirectory = await mkdtemp(
      join(tmpdir(), "runnerd-local-close-backlog-"),
    );
    let closePhase = "before-first-close";
    let closeStartedAt = 0;
    let preserveFailedState = false;
    const readClosedState = async (relativePath: string) => {
      try {
        const value: unknown = JSON.parse(
          await readFile(join(stateDirectory, relativePath), "utf8"),
        );
        return value !== null &&
          typeof value === "object" &&
          !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      } catch {
        return {};
      }
    };
    const readCloseDiagnostic = async () => {
      const runner = await readClosedState("runner/runner-state.json");
      const provider = await readClosedState(
        "runner/codex-provider-state.json",
      );
      const control = await readClosedState(
        "control-plane/control-plane-state.json",
      );
      const commands: Record<string, unknown>[] = Array.isArray(
        control.commands,
      )
        ? control.commands.filter(
            (command): command is Record<string, unknown> =>
              command !== null &&
              typeof command === "object" &&
              !Array.isArray(command),
          )
        : [];
      const closedNumber = (value: unknown) =>
        typeof value === "number" && Number.isSafeInteger(value) ? value : null;
      const closedValue = (value: unknown, allowed: string[]) =>
        typeof value === "string" && allowed.includes(value)
          ? value
          : "unknown";
      return {
        runnerLifecycle: closedValue(runner.lifecycle, [
          "ready",
          "suspended",
          "closed",
          "recoverable_failure",
        ]),
        runnerAckedSourceSeq: closedNumber(runner.ackedSourceSeq),
        runnerNextSourceSeq: closedNumber(runner.nextSourceSeq),
        runnerOutboxCount: Array.isArray(runner.outbox)
          ? runner.outbox.length
          : null,
        providerLifecycle: closedValue(provider.lifecycle, [
          "prepared",
          "session_open",
          "turn_active",
          "closed",
          "provider_exited",
        ]),
        providerHasActiveTurn:
          typeof provider.activeProviderTurnId === "string",
        providerPendingCount: Array.isArray(provider.pendingEvents)
          ? provider.pendingEvents.length
          : null,
        providerQueuedCount: Array.isArray(provider.queuedEvents)
          ? provider.queuedEvents.length
          : null,
        committedEventCount: Array.isArray(control.committedEvents)
          ? control.committedEvents.length
          : null,
        commandsShape: Array.isArray(control.commands)
          ? "array"
          : "unavailable",
        commandCount: commands.length,
        closeCommands: commands
          .filter(
            (command) =>
              typeof command.type === "string" &&
              ["turn.stop", "runner.drain", "runner.suspend"].includes(
                command.type,
              ),
          )
          .slice(-12)
          .map((command) => ({
            type: closedValue(command.type, [
              "turn.stop",
              "runner.drain",
              "runner.suspend",
            ]),
            status: closedValue(command.status, [
              "pending",
              "completed",
              "failed",
              "rejected",
              "indeterminate",
            ]),
          })),
      };
    };
    let firstCloseCompletedState: Awaited<
      ReturnType<typeof readCloseDiagnostic>
    > | null = null;
    const identity = {
      runnerInstanceId: "runner-close-backlog",
      environmentLeaseId: "lease-close-backlog",
      runId: "run-close-first",
      normalizedSessionId: "session-close-backlog",
      turnId: "turn-close-first",
      itemId: "item-close-first",
    };
    const readRunnerState = vi.fn(
      async () =>
        JSON.parse(
          await readFile(
            join(stateDirectory, "runner", "runner-state.json"),
            "utf8",
          ),
        ) as Record<string, unknown>,
    );
    const options = {
      runnerBinary: defaultCapabilityRunnerdBinary(),
      codexCommand: fakeCodex,
      codexArgs: fakeCodexArgs(
        stateDirectory,
        "--split-event-burst",
        "--split-event-suffix-count",
        String(suffixCount),
        "--durable-turn-ids",
        "--call-log",
        join(stateDirectory, "calls.log"),
        "--record-process-start",
        ...(suffixLifecycle === null
          ? []
          : ["--split-event-suffix-lifecycle", suffixLifecycle]),
      ),
      stateDirectory,
      lifecyclePolicy: { mode: "per_turn" as const, idleTimeoutMs: null },
      readRunnerState,
    };
    const first = createCapabilityRunnerdCodexTransport({
      ...options,
      prpIdentity: identity,
    });
    const semanticResult = vi.fn(async () => ({
      success: true,
      contentItems: [],
    }));
    first.transport.setServerRequestHandler(semanticResult);
    let second:
      ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined;
    try {
      const opened = await first.transport.request("thread/start", {
        cwd: tmpdir(),
        dynamicTools: [
          {
            name: "get_task_context",
            description: "Read the current task.",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ],
      });
      const firstTurn = await first.transport.request("turn/start", {
        input: [
          {
            type: "text",
            text: "Emit a split event burst before the queued follow-up.",
          },
        ],
      });
      let deltas = 0;
      for await (const event of first.transport.notifications()) {
        if (event.method === "item/agentMessage/delta") deltas += 1;
        // Match production: semantic result is already returned, but a long
        // provider suffix remains. Close must service stop/suspend alongside
        // cumulative ACKs, not wait for the entire suffix in this consumer.
        if (suffixCount > 48 && deltas === 97) break;
        if (event.method === "turn/completed") break;
      }
      expect(deltas).toBe(suffixCount > 48 ? 97 : 144);
      expect(semanticResult).toHaveBeenCalledTimes(1);
      if (suffixCount > 48) {
        // Both cases stop with unread output. One provider has already
        // persisted completion; the adversarial one still owns active work.
        // Physical exit alone must not turn the latter into a safe resume.
        const fakeBeforeStop = JSON.parse(
          await readFile(join(stateDirectory, "fake-codex-state.json"), "utf8"),
        );
        expect(fakeBeforeStop.nextTurn).toBe(1);
        expect(fakeBeforeStop.activeTurnId).toBe(
          suffixLifecycle === "active-after-output"
            ? (firstTurn.turn as Record<string, unknown>).id
            : null,
        );
        const beforeClose = await readRunnerState();
        const unacknowledgedDeltas = (
          beforeClose.outbox as { eventType: string }[]
        ).filter((event) => event.eventType === "item.delta");
        expect(unacknowledgedDeltas.length).toBeLessThanOrEqual(128);
      }
      closePhase = "first-close";
      closeStartedAt = Date.now();
      await first.transport.close();
      closePhase = "after-first-close";
      firstCloseCompletedState = await readCloseDiagnostic().catch(() => null);
      // Local transports have no remote checkpoint callback. They must still
      // verify suspension rather than treating process termination as proof.
      expect(readRunnerState).toHaveBeenCalled();
      expect(await readRunnerState()).toMatchObject({
        ...identity,
        lifecycle: "suspended",
      });
      const control = JSON.parse(
        await readFile(
          join(stateDirectory, "control-plane", "control-plane-state.json"),
          "utf8",
        ),
      );
      expect(control.commands).toContainEqual(
        expect.objectContaining({
          type: "runner.suspend",
          status: "completed",
        }),
      );
      const durableDeltas = control.committedEvents.filter(
        (event: { eventType: string }) => event.eventType === "item.delta",
      );
      // Explicit stop may cancel provider output not yet ingested. Every
      // admitted delta is retained exactly once, without asserting that future
      // unread output must survive cancellation.
      if (suffixCount === 48) expect(durableDeltas).toHaveLength(144);
      else expect(durableDeltas.length).toBeGreaterThanOrEqual(deltas);
      expect(
        new Set(
          durableDeltas.map(
            (event: { sourceEventId: string }) => event.sourceEventId,
          ),
        ).size,
      ).toBe(durableDeltas.length);
      const provider = JSON.parse(
        await readFile(
          join(stateDirectory, "runner", "codex-provider-state.json"),
          "utf8",
        ),
      );
      expect(provider.pendingEvents).toEqual([]);
      expect(provider.queuedEvents).toEqual([]);
      expect(provider.activeProviderTurnId).toBeNull();
      const firstStoppedJournal = await readRunnerState();
      closePhase = "successor-attach";
      second = createCapabilityRunnerdCodexTransport({
        ...options,
        readRunnerState: undefined,
        prpIdentity: {
          ...identity,
          runId: "run-close-second",
          turnId: "turn-close-second",
          itemId: "item-close-second",
        },
      });
      const secondSemanticResult = vi.fn(async () => ({
        success: true,
        contentItems: [],
      }));
      second.transport.setServerRequestHandler(secondSemanticResult);
      if (suffixLifecycle === "active-after-output") {
        await expect(
          second.transport.request("thread/read", {}),
        ).rejects.toThrow(
          "prepared provider checkpoint resumed unexpected active work",
        );
        expect(secondSemanticResult).not.toHaveBeenCalled();
        const refusedProvider = JSON.parse(
          await readFile(
            join(stateDirectory, "runner/codex-provider-state.json"),
            "utf8",
          ),
        );
        expect(refusedProvider).toMatchObject({
          lifecycle: "closed",
          activeProviderTurnId: null,
          completedTurnAuthoritative: false,
          startupAttempt: {
            schema: "paperclip.provider_startup.v1",
            phase: "initialization_failed",
            failedStage: "admission",
            requestedThreadId: (opened.thread as Record<string, unknown>).id,
            authenticatedThreadId: null,
            directChildExitObserved: true,
            processTreeRetired: false,
            origin: {
              runnerInstanceId: identity.runnerInstanceId,
              normalizedSessionId: identity.normalizedSessionId,
              runId: "run-close-second",
              turnId: "turn-close-second",
              itemId: "item-close-second",
            },
            command: { commandType: "run.attach" },
          },
        });
        expect(refusedProvider.startupAttempt.attemptedProcessGeneration).toBe(
          provider.providerProcessGeneration + 1,
        );
        expect(refusedProvider.startupAttempt.processId).toBeGreaterThan(0);
        expect(refusedProvider.startupAttempt.processGroupId).toBe(
          refusedProvider.startupAttempt.processId,
        );
        for (const pid of [
          refusedProvider.startupAttempt.processId,
          -refusedProvider.startupAttempt.processGroupId,
        ]) {
          expect(() => process.kill(pid, 0)).toThrow(
            expect.objectContaining({ code: "ESRCH" }),
          );
        }
        const refusedControl = JSON.parse(
          await readFile(
            join(stateDirectory, "control-plane/control-plane-state.json"),
            "utf8",
          ),
        );
        expect(refusedControl.commands).toContainEqual(
          expect.objectContaining({
            type: "run.attach",
            status: "failed",
          }),
        );
        expect(
          refusedControl.committedEvents.some((event: { eventType: string }) =>
            [
              "session.started",
              "session.resumed",
              "turn.started",
              "run.attached",
            ].includes(event.eventType),
          ),
        ).toBe(false);
        expect(
          refusedControl.committedEvents
            .filter(
              (event: { eventType: string; envelope: { payload: PrpEvent } }) =>
                event.eventType === "harness.diagnostic" &&
                event.envelope.payload.payload.code ===
                  "provider_startup_ownership",
            )
            .map(
              (event: { envelope: { payload: PrpEvent } }) =>
                (
                  event.envelope.payload.payload.startup as Record<
                    string,
                    unknown
                  >
                ).phase,
            ),
        ).toEqual(["intent", "spawned", "initialization_failed"]);
        const calls = (
          await readFile(join(stateDirectory, "calls.log"), "utf8")
        )
          .trim()
          .split(/\r?\n/);
        expect(calls.filter((call) => call === "process-start")).toHaveLength(
          2,
        );
        expect(calls.filter((call) => call === "thread/start")).toHaveLength(1);
        expect(calls.filter((call) => call === "thread/resume")).toHaveLength(
          1,
        );
        expect(calls.filter((call) => call === "turn/start")).toHaveLength(1);
        const stillActive = JSON.parse(
          await readFile(join(stateDirectory, "fake-codex-state.json"), "utf8"),
        );
        expect(stillActive.activeTurnId).toBe(
          (firstTurn.turn as Record<string, unknown>).id,
        );
        expect(stillActive.nextTurn).toBe(1);
        const epochs = await readdir(join(stateDirectory, "authority-epochs"));
        expect(epochs).toHaveLength(1);
        const archivedStop = JSON.parse(
          await readFile(
            join(
              stateDirectory,
              "authority-epochs",
              epochs[0]!,
              "runner-state.json",
            ),
            "utf8",
          ),
        );
        expect(archivedStop).toEqual(firstStoppedJournal);
        expect(control.commands).toContainEqual(
          expect.objectContaining({
            type: "turn.stop",
            status: "completed",
            result: expect.objectContaining({
              result: expect.objectContaining({
                providerTurnId: (firstTurn.turn as Record<string, unknown>).id,
                status: "stopped",
                providerExitConfirmed: true,
                interruptAccepted: false,
              }),
            }),
          }),
        );
        return;
      }
      const resumed = await second.transport.request("thread/read", {});
      expect(resumed.thread).toMatchObject({
        id: (opened.thread as Record<string, unknown>).id,
      });
      expect(second.evidence().diagnostics).toContain(
        "runnerd attached the durable provider session to a fresh PRP run authority",
      );
      if (suffixCount > 48) {
        closePhase = "successor-start";
        const secondTurn = await second.transport.request("turn/start", {
          input: [
            {
              type: "text",
              text: "Run the queued follow-up under its own authority.",
            },
          ],
        });
        expect((secondTurn.turn as Record<string, unknown>).id).not.toBe(
          (firstTurn.turn as Record<string, unknown>).id,
        );
        let secondDeltas = 0;
        for await (const event of second.transport.notifications()) {
          if (event.method === "item/agentMessage/delta") secondDeltas += 1;
          if (secondDeltas === 97 || event.method === "turn/completed") break;
        }
        expect(secondDeltas).toBe(97);
        expect(secondSemanticResult).toHaveBeenCalledTimes(1);
        closePhase = "second-close";
        closeStartedAt = Date.now();
        await second.transport.close();
        closePhase = "after-second-close";
        expect(await readRunnerState()).toMatchObject({
          lifecycle: "suspended",
          runId: "run-close-second",
          turnId: "turn-close-second",
        });
      }
    } catch (error) {
      preserveFailedState = true;
      try {
        console.error(
          "[backlog-close-state]",
          JSON.stringify({
            suffixCount,
            stateDirectory,
            closePhase,
            closeElapsedMs:
              closeStartedAt === 0 ? null : Date.now() - closeStartedAt,
            firstCloseCompletedState,
            failureState: await readCloseDiagnostic(),
          }),
        );
      } catch {
        // Diagnostics must never replace the original transport failure.
      }
      throw error;
    } finally {
      await Promise.allSettled([
        first.transport.close(),
        second?.transport.close(),
      ]);
      if (!preserveFailedState)
        await rm(stateDirectory, { recursive: true, force: true });
    }
  },
  60_000,
);

it("rejects active work and buffered tools from a resumed stopped checkpoint", async () => {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "runnerd-stopped-resume-active-"),
  );
  const identity = {
    runnerInstanceId: "runner-stopped-active",
    environmentLeaseId: "lease-stopped-active",
    runId: "run-stopped-first",
    normalizedSessionId: "session-stopped-active",
    turnId: "turn-stopped-first",
    itemId: "item-stopped-first",
  };
  const options = {
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(
      stateDirectory,
      "--linger-after-turn-start",
      "--resume-unowned-turn-when-marked",
      "--emit-tool-call-on-resume",
    ),
    stateDirectory,
    lifecyclePolicy: { mode: "per_turn" as const, idleTimeoutMs: null },
  };
  const first = createCapabilityRunnerdCodexTransport({
    ...options,
    prpIdentity: identity,
  });
  let second:
    ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined;
  const semanticHandler = vi.fn(async () => ({
    success: true,
    contentItems: [],
  }));
  first.transport.setServerRequestHandler(semanticHandler);
  try {
    const opened = await first.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: [
        {
          name: "get_task_context",
          description: "Read the current task.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    });
    await first.transport.request("turn/start", {
      input: [{ type: "text", text: "Wait for another instruction." }],
    });
    await expectTurnStarted(
      first.transport.notifications()[Symbol.asyncIterator](),
    );
    await first.transport.close();
    const providerPath = join(
      stateDirectory,
      "runner",
      "codex-provider-state.json",
    );
    expect(JSON.parse(await readFile(providerPath, "utf8"))).toMatchObject({
      lifecycle: "prepared",
      activeProviderTurnId: null,
    });
    await writeFile(join(stateDirectory, "resume-unowned-turn"), "armed");
    const secondIdentity = {
      ...identity,
      runId: "run-stopped-second",
      turnId: "turn-stopped-second",
      itemId: "item-stopped-second",
    };
    second = createCapabilityRunnerdCodexTransport({
      ...options,
      prpIdentity: secondIdentity,
    });
    second.transport.setServerRequestHandler(semanticHandler);
    await expect(second.transport.request("thread/read", {})).rejects.toThrow(
      "prepared provider checkpoint resumed unexpected active work",
    );
    // Exercise the normal durable transfer before inspecting the rejection:
    // provider pendingEvents is an acknowledged queue, not an event journal.
    await vi.waitFor(
      async () => {
        const provider = JSON.parse(await readFile(providerPath, "utf8"));
        expect(provider.pendingEvents).toEqual([]);
        const control = JSON.parse(
          await readFile(
            join(stateDirectory, "control-plane", "control-plane-state.json"),
            "utf8",
          ),
        ) as {
          committedEvents: Array<{
            eventType: string;
            envelope: { payload: { payload: { code?: string } } };
          }>;
        };
        const rejections = control.committedEvents.filter(
          (event) =>
            event.eventType === "harness.diagnostic" &&
            event.envelope.payload.payload.code ===
              "prepared_provider_checkpoint_has_active_work",
        );
        expect(rejections).toEqual([
          expect.objectContaining({
            logicalEffectCount: 1,
            envelope: expect.objectContaining({
              ...secondIdentity,
              payload: expect.objectContaining({
                payload: expect.objectContaining({
                  code: "prepared_provider_checkpoint_has_active_work",
                  paperclipAccepted: false,
                  providerReportedActive: true,
                }),
              }),
            }),
          }),
        ]);
      },
      { timeout: 5_000 },
    );
    const closed = JSON.parse(await readFile(providerPath, "utf8"));
    expect(closed).toMatchObject({
      lifecycle: "closed",
      threadId: (opened.thread as Record<string, unknown>).id,
      activeProviderTurnId: null,
    });
    expect(semanticHandler).not.toHaveBeenCalled();
    expect(closed.pendingEvents).toEqual([]);
  } finally {
    await Promise.allSettled([
      first.transport.close(),
      second?.transport.close(),
    ]);
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);
it("does not retry a real memoized transport close whose suspension proof is unavailable", async () => {
  const identity = {
    runId: "run-recovery",
    sessionId: "session-recovery",
    companyId: "company-recovery",
    issueId: "issue-recovery",
    agentId: "agent-recovery",
  };

  const result: PrpStructuredRunResult = {
    schema: "paperclip.run_result.v1",
    reportedWorkDisposition: "done",
    summary: "Recovered native work completed.",
    completionClaim: {
      contractRevision: "1",
      objectiveSatisfied: true,
      criteria: [
        { criterionId: "objective", status: "satisfied", evidenceRefs: [] },
      ],
      remainingWork: [],
    },
    evidence: [],
    verification: [{ commandOrCheck: "recovery", status: "passed" }],
    attentionRequests: [],
    artifacts: [],
  };

  const terminal: PrpTerminalState = {
    schema: "paperclip.prp.terminal.v1",
    turnTerminalState: "completed",
    runTerminalState: "succeeded",
    reportedWorkDisposition: "done",
  };

  const input: NativeExecutionInputV1 = {
    schema: "paperclip.native-execution-input.v1",
    binding: {
      companyId: identity.companyId,
      runId: identity.runId,
      issueId: identity.issueId,
      agentId: identity.agentId,
      executionWorkspaceId: "workspace-recovery",
    },
    task: {
      identifier: "PAP-RECOVERY",
      title: "Recover native work",
      description: null,
      prompt: "# PAP-RECOVERY: Recover native work",
      workMode: "standard",
    },
    workspace: {
      cwd: "/workspace",
      repoUrl: null,
      repoRef: null,
      branchName: null,
    },
    session: {
      normalizedSessionId: identity.sessionId,
      driverKind: "codex_app_server",
      protocolVersion: 1,
    },
    provider: { kind: "codex", model: null },
    completionContract: {
      id: "contract-recovery",
      sha256: "contract-recovery-sha",
      schemaVersion: "paperclip.completion-contract.v1",
      contract: {
        revision: "1",
        objective: "Recover native work",
        criteria: [{ id: "objective", requirement: "Complete after recovery" }],
      },
    },
    interactionResponses: [],
    credentialBindings: [],
  };

  function runnerEvent(
    sourceSeq: number,
    eventType: PrpEvent["eventType"],
    payload: Record<string, unknown> = {},
  ): PrpEvent {
    return {
      schema: "paperclip.prp.event.v1",
      sourceEventId: `runner-recovery:${identity.runId}:${sourceSeq}`,
      sourceSeq,
      sourceInstanceId: "runner-recovery",
      sourceKind: "runner",
      runId: identity.runId,
      normalizedSessionId: identity.sessionId,
      turnId: "turn-recovery",
      eventType,
      schemaVersion: 1,
      priority: 0,
      emittedAt: "2026-08-09T00:00:00.000Z",
      payload,
    };
  }
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "native-close-quarantine-"),
  );
  const readRunnerState = vi.fn(async () => ({
    schema: "paperclip.runner.durable.state.v1",
    runnerInstanceId: "runner-close-quarantine",
    environmentLeaseId: "lease-close-quarantine",
    runId: identity.runId,
    normalizedSessionId: identity.sessionId,
    turnId: "turn-close-quarantine",
    itemId: "item-close-quarantine",
    lifecycle: "ready",
  }));
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: resolve(
      import.meta.dirname,
      "../../runner/target/debug/fake-codex-app-server",
    ),
    codexArgs: ["--state-file", join(stateDirectory, "fake-codex-state.json")],
    stateDirectory,
    closeGraceMs: 400,
    lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
    prpIdentity: await readRunnerState(),
    readRunnerState,
    // A checkpoint owner requires durable suspension proof. A local transport
    // without a checkpoint can simply terminate its process on close.
    controlPlaneRegistration: async (authority) => {
      await authority.start();
      return {
        connectUrl: authority.connectUrl,
        checkpoint: async () => {},
        release: async () => {},
      };
    },
  });
  try {
    await bundle.transport.request("thread/start", {
      cwd: stateDirectory,
      dynamicTools: [],
    });
    const failedClose = bundle.transport.close();
    const failure = await failedClose.catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "native_session_close_unrecoverable",
    });
    expect(bundle.transport.close()).toBe(failedClose);

    vi.useFakeTimers();
    const close = vi.fn(({ reason }: { reason: string }) =>
      bundle.transport.close(reason),
    );
    const capabilities = {
      resume: true,
      typedEvents: true,
      steering: false,
      interruption: true,
      structuredResult: true,
    };
    const session: NativeSession = {
      identity: () => identity,
      async capabilities() {
        return capabilities;
      },
      async *events() {
        yield runnerEvent(1, "turn.completed");
      },
      async startTurn() {
        return { turnId: "turn-recovery" };
      },
      async result() {
        return { result, terminal, turnId: "turn-recovery" };
      },
      async snapshot() {
        return {
          backendKind: "mock",
          sessionId: identity.sessionId,
          identity,
          providerSessionId: "provider-recovery",
          cursor: null,
          activeTurnId: null,
          pendingRuntimeRequests: [],
          lineage: [],
        };
      },
      close,
    };
    const openSession = vi.fn(async () => session);
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "real-memoized-close-quarantine",
          version: "1",
          capabilities,
        };
      },
      openSession,
    };
    const port: ControlPlanePort = {
      async openRun() {},
      async checkpointSession() {},
      async appendEvent() {
        return {
          cursor: 1,
          highestContiguousSourceSeq: 1,
          disposition: "committed",
        };
      },
      async replayEvents() {
        return { events: [], highestContiguousSourceSeq: 0 };
      },
      async completeRun() {},
    };
    const execute = () =>
      executeNativeSession({
        input,
        backend,
        controlPlane: port,
        runnerInstanceId: "runner-recovery",
        controlPlaneInstanceId: "control-recovery",
        requireSessionCloseBeforeReturn: true,
      });
    await expect(execute()).rejects.toBe(failure);
    const readsAfterClose = readRunnerState.mock.calls.length;
    await expect(execute()).rejects.toMatchObject({
      code: "native_session_cleanup_quarantined",
      recovery: "operator_required",
    });
    await vi.advanceTimersByTimeAsync(600_000);
    await expect(execute()).rejects.toMatchObject({
      code: "native_session_cleanup_quarantined",
    });
    expect(openSession).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(readRunnerState).toHaveBeenCalledTimes(readsAfterClose);
  } finally {
    vi.useRealTimers();
    await bundle.transport.close().catch(() => undefined);
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 10_000);

it.each(["not_suspended", "wrong_identity"] as const)(
  "does not report local runner close healthy with %s durable evidence",
  async (mode) => {
    const stateDirectory = await mkdtemp(
      join(tmpdir(), "runnerd-local-close-unproven-"),
    );
    const identity = {
      runnerInstanceId: "runner-close-unproven",
      environmentLeaseId: "lease-close-unproven",
      runId: "run-close-unproven",
      normalizedSessionId: "session-close-unproven",
      turnId: "turn-close-unproven",
      itemId: "item-close-unproven",
    };
    const bundle = createCapabilityRunnerdCodexTransport({
      runnerBinary: defaultCapabilityRunnerdBinary(),
      codexCommand: fakeCodex,
      codexArgs: fakeCodexArgs(stateDirectory),
      stateDirectory,
      closeGraceMs: 400,
      lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      prpIdentity: identity,
      readRunnerState: async () => ({
        schema: "paperclip.runner.durable.state.v1",
        ...identity,
        ...(mode === "wrong_identity" ? { runId: "some-other-run" } : {}),
        lifecycle: mode === "not_suspended" ? "ready" : "suspended",
      }),
    });
    bundle.transport.setServerRequestHandler(async () => ({
      success: true,
      contentItems: [],
    }));
    try {
      await bundle.transport.request("thread/start", {
        cwd: tmpdir(),
        dynamicTools: [],
      });
      await expect(bundle.transport.close()).rejects.toThrow(
        "runner did not durably suspend before checkpoint",
      );
      const control = JSON.parse(
        await readFile(
          join(stateDirectory, "control-plane", "control-plane-state.json"),
          "utf8",
        ),
      );
      expect(control.identity).toEqual(identity);
      expect(await readdir(stateDirectory)).toContain("runner");
    } finally {
      await bundle.transport.close().catch(() => undefined);
      await rm(stateDirectory, { recursive: true, force: true });
    }
  },
  10_000,
);

it("binds an immediately failed durable turn before exposing its terminal", async () => {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "runnerd-fast-terminal-"),
  );
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory, "--fail-turn-immediately"),
    stateDirectory,
  });
  const driver = new CodexAppServerDriver({
    taskEnvelope: createCodexTaskEnvelope({
      objective: "Exercise an immediate provider failure.",
    }),
    environment: {
      PATH: process.env.PATH,
      HOME: join(tmpdir(), "runnerd-fast-terminal-host-home"),
      PAPERCLIP_WORKSPACE_CWD: stateDirectory,
    },
    approvalPolicy: "never",
    transportFactory: () => bundle.transport,
  });
  const session = await driver.openSession({
    runId: "run-fast-terminal",
    normalizedSessionId: "session-fast-terminal",
    workingDirectory: stateDirectory,
  });
  try {
    const accepted = await session.startTurn({
      message: { role: "user", text: "Fail this test turn." },
    });
    expect(accepted.turnId).toBe("provider-turn-1");
    const durableState = JSON.parse(
      await readFile(
        join(stateDirectory, "control-plane", "control-plane-state.json"),
        "utf8",
      ),
    ) as {
      commands: Array<{
        type: string;
        payload: Record<string, unknown>;
      }>;
    };
    const durableTurnStart = durableState.commands.find(
      (command) => command.type === "turn.start",
    );
    expect(durableTurnStart).toMatchObject({
      payload: {
        turnId: expect.stringMatching(/^turn_lab_[a-f0-9]{32}$/),
      },
    });
    expect(JSON.parse(String(durableTurnStart?.payload.text))).toMatchObject({
      message: "Fail this test turn.",
      task: { objective: "Exercise an immediate provider failure." },
    });
    const events = [];
    for await (const event of session.events()) {
      events.push(event);
      if (event.eventType === "turn.failed") break;
    }
    const eventTypes = events.map((event) => event.eventType);
    expect(eventTypes).toEqual(
      expect.arrayContaining(["turn.started", "turn.accepted", "turn.failed"]),
    );
    expect(eventTypes.indexOf("turn.started")).toBeLessThan(
      eventTypes.indexOf("turn.accepted"),
    );
    expect(eventTypes.indexOf("turn.accepted")).toBeLessThan(
      eventTypes.indexOf("turn.failed"),
    );
    expect(
      events.find((event) => event.eventType === "session.failed"),
    ).toBeUndefined();
    expect(await session.snapshot()).toMatchObject({
      activeTurnId: null,
      terminalTurns: [
        { turnId: "provider-turn-1", fingerprint: expect.any(String) },
      ],
    });
  } finally {
    await session.close();
    await rm(stateDirectory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 25,
    });
  }
}, 30_000);

it("bridges a runnerd-native question into the server request handler and resolves it canonically", async () => {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "runnerd-runtime-question-"),
  );
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory, "--runtime-question"),
    stateDirectory,
  });
  let bridgedRequest: {
    method: string;
    params: Record<string, unknown>;
  } | null = null;
  bundle.transport.setServerRequestHandler(async (request) => {
    if (request.method !== "item/tool/requestUserInput") {
      return { success: true, contentItems: [] };
    }
    bridgedRequest = { method: request.method, params: request.params };
    await bundle.transport.resolveRuntimeRequest?.({
      requestId: String(request.id),
      turnId: String(request.params.turnId),
      resolution: {
        action: "submit",
        response: {
          schema: "paperclip.question_response.v1",
          answers: {
            environment: { selectedOptionIds: ["option-1"] },
            regions: { selectedOptionIds: ["option-1"] },
            notes: { text: "Ship during the maintenance window." },
          },
        },
      },
    });
    return { answers: {} };
  });
  try {
    await bundle.transport.request("initialize", {});
    await bundle.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: [
        {
          name: "get_task_context",
          description: "Read the active task.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    });
    await bundle.transport.request("turn/start", {
      input: [{ type: "text", text: "Ask the deployment questions." }],
    });
    const methods: string[] = [];
    for await (const notification of bundle.transport.notifications()) {
      methods.push(notification.method);
      if (notification.method === "turn/completed") break;
    }
    expect(bridgedRequest).toMatchObject({
      method: "item/tool/requestUserInput",
      params: {
        threadId: "codex-thread-1",
        questions: [
          expect.objectContaining({ id: "environment", isOther: true }),
          expect.objectContaining({ id: "regions", required: true }),
          expect.objectContaining({ id: "notes", required: true }),
        ],
      },
    });
    expect(methods).toContain("turn/completed");
  } finally {
    await bundle.transport.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);

it("fails closed for runnerd-native form elicitation until the Rust bridge preserves typed provider content", async () => {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "runnerd-runtime-elicitation-"),
  );
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory, "--runtime-elicitation"),
    stateDirectory,
  });
  let bridgedRequest: {
    method: string;
    params: Record<string, unknown>;
  } | null = null;
  bundle.transport.setServerRequestHandler(async (request) => {
    bridgedRequest = { method: request.method, params: request.params };
    return { success: true, contentItems: [] };
  });
  try {
    await bundle.transport.request("initialize", {});
    await bundle.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: [
        {
          name: "get_task_context",
          description: "Read the active task.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    });
    await bundle.transport.request("turn/start", {
      input: [{ type: "text", text: "Request typed deployment settings." }],
    });
    const methods: string[] = [];
    for await (const notification of bundle.transport.notifications()) {
      methods.push(notification.method);
      if (notification.method === "turn/completed") break;
    }
    expect(bridgedRequest).toBeNull();
    expect(methods).toContain("turn/completed");
  } finally {
    await bundle.transport.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);

it("captures exact provider frames and correlates Rust and TypeScript interpretation stages", async () => {
  const traceDirectory = await mkdtemp(
    join(tmpdir(), "runnerd-provider-trace-"),
  );
  const hostHome = await mkdtemp(
    join(tmpdir(), "runnerd-provider-trace-home-"),
  );
  const tracePath = join(traceDirectory, "trace.ndjson");
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(traceDirectory, "--structured-activity"),
    stateDirectory: join(traceDirectory, "state"),
    environment: {
      PAPERCLIP_PROVIDER_TRACE_PATH: tracePath,
      PAPERCLIP_PROVIDER_TRACE_MAX_BYTES: String(64 * 1024 * 1024),
    },
  });
  const driver = new CodexAppServerDriver({
    taskEnvelope: createCodexTaskEnvelope({
      objective: "Exercise every structured provider boundary.",
    }),
    environment: {
      PATH: process.env.PATH,
      HOME: hostHome,
      PAPERCLIP_WORKSPACE_CWD: traceDirectory,
    },
    approvalPolicy: "never",
    transportFactory: () => bundle.transport,
  });
  const session = await driver.openSession({
    runId: "run-provider-trace",
    normalizedSessionId: "session-provider-trace",
    workingDirectory: traceDirectory,
  });
  const canonicalEvents = new Map<string, string>();
  const canonicalEventIds = new Set<string>();
  try {
    await session.startTurn({
      message: { role: "user", text: "Return a structured response." },
    });
    for await (const event of session.events()) {
      canonicalEvents.set(event.sourceEventId, event.eventType);
      canonicalEventIds.add(event.sourceEventId);
      if (event.eventType === "turn.completed") break;
    }
  } finally {
    await session.close();
  }
  const snapshot = await session.snapshot();
  for (
    let sourceSeq = 1;
    sourceSeq <= snapshot.lastSourceSequence;
    sourceSeq += 1
  ) {
    canonicalEventIds.add(`runner-codex:run-provider-trace:${sourceSeq}`);
  }

  await expect
    .poll(async () => {
      const [nativeTrace, rehydrationTrace] = await Promise.all([
        readFile(tracePath, "utf8"),
        readFile(`${tracePath}.rehydration`, "utf8"),
      ]);
      return [nativeTrace, rehydrationTrace].map((contents) =>
        JSON.parse(contents.trim().split("\n").at(-1) ?? "{}"),
      );
    })
    .toEqual([
      expect.objectContaining({ status: "complete" }),
      expect.objectContaining({ status: "complete" }),
    ]);

  const nativeEntries = (await readFile(tracePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const rehydratedEntries = (await readFile(`${tracePath}.rehydration`, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const frames = nativeEntries.filter((entry) => entry.kind === "frame");
  expect(frames.map((entry) => entry.frameId)).toEqual(
    frames.map((_, index) => index + 1),
  );
  expect(frames.map((entry) => entry.direction)).toEqual(
    expect.arrayContaining(["client_to_provider", "provider_to_client"]),
  );
  for (const frame of frames) {
    const raw = Buffer.from(String(frame.rawBase64), "base64");
    expect(raw.byteLength).toBe(frame.byteLength);
    expect(`sha256:${createHash("sha256").update(raw).digest("hex")}`).toBe(
      frame.digest,
    );
  }
  const decodedFrames = frames.map((frame) =>
    JSON.parse(Buffer.from(String(frame.rawBase64), "base64").toString("utf8")),
  ) as Array<Record<string, unknown>>;
  expect(
    decodedFrames.find((frame) => frame.method === "thread/start"),
  ).toMatchObject({
    params: {
      baseInstructions: withCodexCollaborationRuntimeInstructions(
        CODEX_SKILLLESS_BASE_INSTRUCTIONS,
      ),
    },
  });
  const stages = new Set(
    [...nativeEntries, ...rehydratedEntries]
      .filter((entry) => entry.kind === "interpretation")
      .map((entry) => entry.stage),
  );
  expect([...stages]).toEqual(
    expect.arrayContaining([
      "rust_native_transport",
      "rust_jsonrpc_parse",
      "rust_durable_normalization",
      "typescript_runnerd_rehydration",
      "typescript_codex_driver_normalization",
    ]),
  );
  expect(
    rehydratedEntries.find(
      (entry) => entry.ruleId === "runnerd.rehydrate.plan.updated",
    ),
  ).toMatchObject({
    stage: "typescript_runnerd_rehydration",
    disposition: "mapped",
  });
  const rustInterpretations = nativeEntries.filter(
    (entry) => entry.stage === "rust_durable_normalization",
  );
  const rehydrationInterpretations = rehydratedEntries.filter(
    (entry) => entry.stage === "typescript_runnerd_rehydration",
  );
  const driverInterpretations = rehydratedEntries.filter(
    (entry) => entry.stage === "typescript_codex_driver_normalization",
  );
  expect(rustInterpretations.length).toBeGreaterThan(0);
  expect(rehydrationInterpretations.length).toBeGreaterThan(0);
  expect(driverInterpretations.length).toBeGreaterThan(0);
  for (const rustEntry of rustInterpretations) {
    expect(rustEntry.disposition).toMatch(/^(mapped|ignored|rejected)$/);
    expect(rustEntry.reason).toEqual(expect.any(String));
    const emittedEventIds = Array.isArray(rustEntry.emittedEventIds)
      ? rustEntry.emittedEventIds.map(String)
      : [];
    if (rustEntry.disposition === "mapped") {
      expect(emittedEventIds.length).toBeGreaterThan(0);
    }
    for (const sourceEventId of emittedEventIds) {
      const rehydrated = rehydrationInterpretations.filter(
        (entry) => entry.sourceEventId === sourceEventId,
      );
      expect(
        rehydrated,
        `missing TypeScript rehydration for ${sourceEventId}`,
      ).toHaveLength(1);
      expect(rehydrated[0]).toMatchObject({
        sourceEventType: expect.any(String),
        disposition: expect.stringMatching(/^(mapped|ignored)$/),
      });
      if (rehydrated[0]?.disposition === "mapped") {
        const interpreted = driverInterpretations.filter(
          (entry) => entry.sourceEventId === sourceEventId,
        );
        expect(
          interpreted,
          `missing driver interpretation for ${sourceEventId}`,
        ).not.toHaveLength(0);
        for (const driverEntry of interpreted) {
          expect(driverEntry.disposition).not.toBe("rejected");
          expect(driverEntry.sourceEventType).toBe(
            rehydrated[0]?.sourceEventType,
          );
          const driverEventIds = Array.isArray(driverEntry.emittedEventIds)
            ? driverEntry.emittedEventIds.map(String)
            : [];
          if (driverEntry.disposition === "mapped") {
            expect(driverEventIds.length).toBeGreaterThan(0);
          } else {
            expect(driverEntry.reason).toEqual(expect.any(String));
            expect(String(driverEntry.reason).length).toBeGreaterThan(0);
            expect(driverEventIds).toHaveLength(0);
          }
          for (const eventId of driverEventIds) {
            expect(
              canonicalEventIds.has(eventId),
              `unknown canonical event ${eventId}`,
            ).toBe(true);
          }
        }
      }
    }
  }
  const planRehydration = rehydrationInterpretations.find(
    (entry) => entry.ruleId === "runnerd.rehydrate.plan.updated",
  );
  expect(planRehydration).toMatchObject({
    sourceEventId: expect.any(String),
    sourceEventType: "plan.updated",
    disposition: "mapped",
  });
  const planDriverInterpretations = driverInterpretations.filter(
    (entry) =>
      entry.sourceEventId === planRehydration?.sourceEventId &&
      entry.sourceEventType === planRehydration?.sourceEventType,
  );
  expect(planDriverInterpretations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        disposition: "mapped",
        emittedEventIds: expect.any(Array),
      }),
    ]),
  );
  const planEventIds = planDriverInterpretations.flatMap((entry) =>
    Array.isArray(entry.emittedEventIds)
      ? entry.emittedEventIds.map(String)
      : [],
  );
  expect(planEventIds.length).toBeGreaterThan(0);
  expect(
    new Set(planEventIds.map((eventId) => canonicalEvents.get(eventId))),
  ).toEqual(new Set(["plan.updated", "item.delta"]));
  for (const channel of ["rust_native", "typescript_runnerd_rehydration"]) {
    const channelEntries = [...nativeEntries, ...rehydratedEntries].filter(
      (entry) => entry.debugChannel === channel,
    );
    expect(channelEntries.map((entry) => entry.debugSequence)).toEqual(
      channelEntries.map((_, index) => index + 1),
    );
    const status = channelEntries.at(-1);
    expect(status).toMatchObject({
      kind: "trace_status",
      status: "complete",
      acknowledgedDebugSequence: channelEntries.length - 1,
    });
  }

  await rm(traceDirectory, { recursive: true, force: true });
  await rm(hostHome, { recursive: true, force: true });
}, 30_000);

it("steers the active provider turn through the durable PRP command path", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-steering-"));
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory, "--linger-after-turn-start"),
    stateDirectory,
  });
  bundle.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [],
  }));
  try {
    await bundle.transport.request("initialize", {});
    await bundle.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: [
        {
          name: "get_task_context",
          description: "Read the active task.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    });
    await bundle.transport.request("turn/start", {
      input: [{ type: "text", text: "Work until I steer you." }],
    });

    await expect(
      bundle.transport.request("turn/steer", {
        input: [{ type: "text", text: "Prioritize the mobile queue layout." }],
        correlationId: "queued-comment-1",
      }),
    ).resolves.toEqual({});
    await expect(
      bundle.transport.request("turn/steer", {
        input: [{ type: "text", text: "Prioritize the mobile queue layout." }],
        correlationId: "queued-comment-1",
      }),
    ).resolves.toEqual({});
    await expect(
      bundle.transport.request("turn/steer", {
        expectedTurnId: "stale-logical-turn",
        input: [{ type: "text", text: "This must not dispatch." }],
      }),
    ).rejects.toThrow("stale turn");

    const notifications = bundle.transport
      .notifications()
      [Symbol.asyncIterator]();
    const methods: string[] = [];
    let acknowledged = false;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !acknowledged) {
      const next = await Promise.race([
        notifications.next(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("steering notification timeout")),
            1_000,
          ),
        ),
      ]);
      if (!next.value) break;
      methods.push(next.value.method);
      acknowledged =
        next.value.method === "item/completed" &&
        (next.value.params?.kind === "steering_acknowledgement" ||
          next.value.params?.item?.kind === "steering_acknowledgement");
    }
    expect(methods).toContain("turn/started");
    expect(acknowledged).toBe(true);
  } finally {
    await bundle.transport.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);

it.each(["held-ack", "lost-ack", "rejected-attach"] as const)(
  "preserves old warm-attach authority and event ownership across %s",
  async (mode) => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-warm-ack-"));
    const callsPath = join(stateDirectory, "calls.log");
    const cores: DurablePrpControlPlane[] = [];
    const effects = new Map<string, { event: PrpEvent; deliveries: number }>();
    const handles: ReturnType<typeof durableControlPlane.spawnRunner>[] = [];
    let armed = false;
    let heldEvent: PrpEvent | null = null;
    let releaseCommit!: () => void;
    let enteredCommit!: () => void;
    const commitGate = new Promise<void>((resolveCommit) => {
      releaseCommit = resolveCommit;
    });
    const commitEntered = new Promise<void>((resolveEntered) => {
      enteredCommit = resolveEntered;
    });
    const OriginalCore = durableControlPlane.DurablePrpControlPlane;
    const coreSpy = vi
      .spyOn(durableControlPlane, "DurablePrpControlPlane")
      .mockImplementation(function (
        options: ConstructorParameters<typeof OriginalCore>[0],
      ) {
        const core = new OriginalCore({
          ...options,
          onCommittedEvent: async (event) => {
            await options.onCommittedEvent?.(event);
            const prior = effects.get(event.sourceEventId);
            if (prior) {
              expect(event).toEqual(prior.event);
              prior.deliveries += 1;
            } else {
              effects.set(event.sourceEventId, {
                event: structuredClone(event),
                deliveries: 1,
              });
            }
            if (
              armed &&
              mode !== "rejected-attach" &&
              heldEvent === null &&
              event.eventType === "run.attached"
            ) {
              heldEvent = structuredClone(event);
              enteredCommit();
              await commitGate;
              if (mode === "lost-ack") {
                // The external durable effect exists, but this connection
                // disappears before its local cursor/ACK can be published.
                throw new Error(
                  "fixture lost the old authority ACK after commit",
                );
              }
            }
          },
        });
        cores.push(core);
        return core;
      } as unknown as typeof OriginalCore);
    const launch = durableControlPlane.spawnRunner;
    const launchSpy = vi
      .spyOn(durableControlPlane, "spawnRunner")
      .mockImplementation((options) => {
        const handle = launch(options);
        handles.push(handle);
        return handle;
      });
    const within = async <T>(
      label: string,
      promise: Promise<T>,
      timeout = 5_000,
    ) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_resolveWait, rejectWait) => {
            timer = setTimeout(
              () => rejectWait(new Error(`${label} timeout`)),
              timeout,
            );
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    const dead = (pid: number) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    };
    const bundle = createCapabilityRunnerdCodexTransport({
      runnerBinary: defaultCapabilityRunnerdBinary(),
      codexCommand: fakeCodex,
      codexArgs: fakeCodexArgs(
        stateDirectory,
        "--call-log",
        callsPath,
        "--record-process-start",
      ),
      stateDirectory,
      lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
      runnerReconnectGraceMs: 5_000,
    });
    const readRunner = async () =>
      JSON.parse(
        await readFile(
          join(stateDirectory, "runner/runner-state.json"),
          "utf8",
        ),
      ) as {
        runId: string;
        ackedSourceSeq: number;
        processedCommands: Record<string, { commandType: string; status: string }>;
        outbox: { envelope: { payload: PrpEvent } }[];
      };
    let providerPid: number | null = null;
    let primaryError: unknown;
    let cleanupProven = false;
    try {
      const opened = await within(
        "initial thread",
        bundle.transport.request("thread/start", {
          cwd: tmpdir(),
          dynamicTools: [],
        }),
      ) as { thread: { id: string } };
      const core = cores[0]!;
      expect(cores).toHaveLength(1);
      const oldIdentity = structuredClone(core.store.state.identity);
      const runnerPid = bundle.evidence().runnerPid;
      providerPid = bundle.evidence().codexPid;
      const rotations: (typeof core.store.state)[] = [];
      const rotate = core.rotateRunIdentity.bind(core);
      vi.spyOn(core, "rotateRunIdentity").mockImplementation(
        (identity, template) => {
          rotations.push(structuredClone(core.store.state));
          return rotate(identity, template);
        },
      );
      if (mode === "rejected-attach") {
        const queue = core.queueCommand.bind(core);
        vi.spyOn(core, "queueCommand").mockImplementation(
          (type, payload = {}, id, immediate) =>
            queue(
              type,
              type === "run.attach"
                ? {
                    ...payload,
                    provider: {
                      ...(payload.provider as Record<string, unknown>),
                      model: "foreign-profile",
                    },
                  }
                : payload,
              id,
              immediate,
            ),
        );
      }
      armed = true;
      const attachment = bundle.transport.attachRun!({
        runId: "run-warm-ack-next",
        turnId: "turn-warm-ack-next",
        itemId: "item-warm-ack-next",
      });
      void attachment.catch(() => undefined);
      if (mode === "rejected-attach") {
        await expect(within("rejected attach", attachment)).rejects.toThrow(
          "run.attach cannot change the durable Codex provider profile",
        );
        expect(rotations).toHaveLength(0);
        expect(core.store.state.identity).toEqual(oldIdentity);
        expect((await readRunner()).runId).toBe(oldIdentity.runId);
        const read = await within(
          "read under unchanged authority",
          bundle.transport.request("thread/read", {}),
        );
        expect((read.thread as { id: string }).id).toBe(opened.thread.id);
        expect(
          core.store.state.commands.find((entry) => entry.type === "run.attach")
            ?.status,
        ).toBe("failed");
      } else {
        await within("old authority commit barrier", commitEntered);
        const retained = await readRunner();
        expect(retained.runId).toBe(oldIdentity.runId);
        expect(
          Object.values(retained.processedCommands).find((entry) => entry.commandType === "run.attach")
            ?.status,
        ).toBe("completed");
        expect(
          retained.outbox.some(
            (entry) =>
              entry.envelope.payload.sourceEventId === heldEvent!.sourceEventId,
          ),
        ).toBe(true);
        expect(
          core.store.state.commands.find((entry) => entry.type === "run.attach")
            ?.status,
        ).toBe("pending");
        expect(rotations).toHaveLength(0);
        if (mode === "lost-ack") core.disconnectActiveRunner();
        releaseCommit();
        await within("warm attach after old ACK", attachment, 10_000);
        expect(rotations).toHaveLength(1);
        const retired = rotations[0]!;
        const attachedEvent = retired.committedEvents.find(
          (entry) => entry.sourceEventId === heldEvent!.sourceEventId,
        )!;
        expect(attachedEvent.logicalEffectCount).toBe(1);
        expect(retired.ackedSourceSeq).toBeGreaterThanOrEqual(
          attachedEvent.sourceSeq,
        );
        expect(
          retired.committedEvents.slice(-4).map((entry) => entry.eventType),
        ).toEqual([
          "session.resumed",
          "session.capabilities.updated",
          "session.goal.snapshot",
          "run.attached",
        ]);
        expect(
          retired.committedEvents.every(
            (entry) => entry.envelope.runId === oldIdentity.runId,
          ),
        ).toBe(true);
        if (mode === "lost-ack") {
          expect(retired.connectionCount).toBeGreaterThanOrEqual(2);
          expect(effects.get(heldEvent!.sourceEventId)?.deliveries).toBe(2);
        } else {
          expect(effects.get(heldEvent!.sourceEventId)?.deliveries).toBe(1);
        }
        await vi.waitFor(async () =>
          expect((await readRunner()).runId).toBe("run-warm-ack-next"),
        );
        const read = await within(
          "read under new authority",
          bundle.transport.request("thread/read", {}),
        );
        expect((read.thread as { id: string }).id).toBe(opened.thread.id);
      }
      expect(bundle.evidence()).toMatchObject({
        runnerPid,
        codexPid: providerPid,
        runnerExited: false,
      });
      const calls = (await readFile(callsPath, "utf8")).trim().split(/\r?\n/);
      expect(calls.filter((call) => call === "process-start")).toHaveLength(1);
      expect(calls.filter((call) => call === "thread/start")).toHaveLength(1);
      expect(calls.filter((call) => call === "turn/start")).toHaveLength(0);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      releaseCommit();
      try {
        await within(
          "warm fixture close",
          bundle.transport.close(),
          10_000,
        ).catch(() => undefined);
        for (const handle of handles) {
          await durableControlPlane
            .waitForProcess(handle, 250)
            .catch(() => undefined);
          await within("exact warm fixture runner exit", handle.completion);
          if (handle.processGroupId && !dead(-handle.processGroupId))
            process.kill(-handle.processGroupId, "SIGKILL");
          await vi.waitFor(() => {
            expect(handle.child.pid && dead(handle.child.pid)).toBe(true);
            expect(handle.processGroupId && dead(-handle.processGroupId)).toBe(
              true,
            );
          });
        }
        if (providerPid && !dead(-providerPid))
          process.kill(-providerPid, "SIGKILL");
        if (providerPid)
          await vi.waitFor(() => expect(dead(-providerPid!)).toBe(true));
        cleanupProven = true;
      } catch (error) {
        if (primaryError === undefined) throw error;
        console.error(
          "Warm ACK fixture cleanup unproven; retaining its private state directory.",
        );
      } finally {
        try {
          for (const core of cores) await core.stop().catch(() => undefined);
        } finally {
          launchSpy.mockRestore();
          coreSpy.mockRestore();
          if (cleanupProven)
            await rm(stateDirectory, { recursive: true, force: true });
        }
      }
    }
  },
  30_000,
);

it.each([false, true])(
  "retains warm attach authority when its result is lost before controller persistence (held observer=%s)",
  async (holdObserver) => {
    const stateDirectory = await mkdtemp(
      join(tmpdir(), "runnerd-attach-result-loss-"),
    );
    const callsPath = join(stateDirectory, "calls.log");
    const cores: DurablePrpControlPlane[] = [];
    const handles: ReturnType<typeof durableControlPlane.spawnRunner>[] = [];
    const OriginalCore = durableControlPlane.DurablePrpControlPlane;
    const coreSpy = vi
      .spyOn(durableControlPlane, "DurablePrpControlPlane")
      .mockImplementation(function (
        options: ConstructorParameters<typeof OriginalCore>[0],
      ) {
        const core = new OriginalCore(options);
        cores.push(core);
        return core;
      } as unknown as typeof OriginalCore);
    const launch = durableControlPlane.spawnRunner;
    const launchSpy = vi
      .spyOn(durableControlPlane, "spawnRunner")
      .mockImplementation((options) => {
        const handle = launch(options);
        handles.push(handle);
        return handle;
      });
    const within = async <T>(
      label: string,
      promise: Promise<T>,
      timeout = 5_000,
    ) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error(`${label} timeout`)),
              timeout,
            );
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    const dead = (pid: number) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    };
    const bundle = createCapabilityRunnerdCodexTransport({
      runnerBinary:
        process.env.PAPERCLIP_ATTACH_TRANSITION_RUNNER ??
        defaultCapabilityRunnerdBinary(),
      codexCommand: fakeCodex,
      codexArgs: fakeCodexArgs(
        stateDirectory,
        "--call-log",
        callsPath,
        "--record-process-start",
      ),
      stateDirectory,
      lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
      runnerReconnectGraceMs: 2_000,
    });
    let providerPid: number | null = null;
    let cleanupProven = false;
    let saveSpy: ReturnType<typeof vi.spyOn> | undefined;
    let observerSpy: { mockRestore(): void } | undefined;
    let attachment: Promise<void> | undefined;
    try {
      await within(
        "initial thread",
        bundle.transport.request("thread/start", {
          cwd: tmpdir(),
          dynamicTools: [],
        }),
      );
      expect(cores).toHaveLength(1);
      const core = cores[0]!;
      const oldIdentity = structuredClone(core.store.state.identity);
      if (holdObserver) {
        const getCommand = core.getCommand.bind(core);
        observerSpy = vi
          .spyOn(core, "getCommand")
          .mockImplementation((commandId) => {
            const command = getCommand(commandId);
            if (
              command?.type === "run.attach" &&
              core.store.state.completedWarmTransition?.command.commandId !==
                commandId
            ) {
              return { ...command, status: "pending", result: null };
            }
            return command;
          });
      }
      providerPid = bundle.evidence().codexPid;
      const store = core.store as typeof core.store & {
        commit(candidate: typeof core.store.state): void;
      };
      const commit = store.commit.bind(store);
      let lostResult = false;
      let observeLoss!: () => void;
      const loss = new Promise<void>((resolveLoss) => {
        observeLoss = resolveLoss;
      });
      saveSpy = vi.spyOn(store, "commit").mockImplementation((candidate) => {
        const attach = candidate.commands.find(
          (entry) => entry.type === "run.attach",
        );
        if (!lostResult && attach?.status === "completed") {
          lostResult = true;
          // The authenticated result reached the receiver, but the durable write
          // did not. The clone has not been exposed in memory or on disk.
          const persisted = JSON.parse(readFileSync(core.store.path, "utf8"));
          expect(persisted.identity).toEqual(oldIdentity);
          expect(
            persisted.commands.find(
              (entry: { type: string }) => entry.type === "run.attach",
            ).status,
          ).toBe("pending");
          core.disconnectActiveRunner();
          observeLoss();
          throw new Error(
            "fixture lost attach result before durable controller commit",
          );
        }
        commit(candidate);
      });
      attachment = bundle.transport.attachRun!({
        runId: "run-result-loss-next",
        turnId: "turn-result-loss-next",
        itemId: "item-result-loss-next",
      });
      void attachment.catch(() => undefined);
      await within("lost attach result", loss);
      expect(lostResult).toBe(true);
      expect(core.store.state.identity).toEqual(oldIdentity);
      expect(
        core.store.state.commands.find((entry) => entry.type === "run.attach")
          ?.status,
      ).toBe("pending");
      const outcome = await within(
        "exact result replay after reconnect",
        attachment.then(
          () => ({ status: "completed" as const }),
          (error: unknown) => ({
            status: "failed" as const,
            message: String(error),
          }),
        ),
        10_000,
      );
      const runner = JSON.parse(
        await readFile(
          join(stateDirectory, "runner/runner-state.json"),
          "utf8",
        ),
      );
      const calls = (await readFile(callsPath, "utf8")).trim().split(/\r?\n/);
      expect(calls.filter((call) => call === "process-start")).toHaveLength(1);
      expect(calls.filter((call) => call === "thread/start")).toHaveLength(1);
      expect(calls.filter((call) => call === "turn/start")).toHaveLength(0);
      expect(
        {
          outcome,
          runnerRunId: runner.runId,
          controllerRunId: core.store.state.identity.runId,
        },
        "lost attach result must replay without leaving the two durable authorities split",
      ).toEqual({
        outcome: { status: "completed" },
        runnerRunId: "run-result-loss-next",
        controllerRunId: "run-result-loss-next",
      });
      if (holdObserver)
        expect(
          core.store.state.completedWarmTransition?.receipt.newIdentity.runId,
        ).toBe("run-result-loss-next");
    } finally {
      saveSpy?.mockRestore();
      observerSpy?.mockRestore();
      try {
        await within(
          "result-loss fixture close",
          bundle.transport.close(),
          5_000,
        ).catch(() => undefined);
        for (const handle of handles) {
          await durableControlPlane
            .waitForProcess(handle, 250)
            .catch(() => undefined);
          await within("exact result-loss runner exit", handle.completion);
          if (handle.processGroupId && !dead(-handle.processGroupId))
            process.kill(-handle.processGroupId, "SIGKILL");
          await vi.waitFor(() => {
            expect(handle.child.pid && dead(handle.child.pid)).toBe(true);
            expect(handle.processGroupId && dead(-handle.processGroupId)).toBe(
              true,
            );
          });
        }
        if (providerPid && !dead(-providerPid))
          process.kill(-providerPid, "SIGKILL");
        if (providerPid)
          await vi.waitFor(() => expect(dead(-providerPid!)).toBe(true));
        cleanupProven = true;
      } finally {
        for (const core of cores) await core.stop().catch(() => undefined);
        launchSpy.mockRestore();
        coreSpy.mockRestore();
        if (cleanupProven)
          await rm(stateDirectory, { recursive: true, force: true });
      }
    }
  },
  30_000,
);

it.each([
  ...[
    "before-result",
    "after-result",
    "after-activation",
    "before-confirmation",
    "after-confirmation",
  ].flatMap((lossPoint) =>
    [false, true].map((routed) => ({
      lossPoint,
      routed,
      recoveryFault: "none",
    })),
  ),
  ...["endpoint", "missing-capability", "listen", "malformed-core"].map(
    (recoveryFault) => ({
      lossPoint: "after-result",
      routed: true,
      recoveryFault,
    }),
  ),
  ...["before_bootstrap", "before_spawn", "before_authentication"].map(
    (stage) => ({
      lossPoint: "after-result",
      routed: true,
      recoveryFault: `authorize_${stage}`,
    }),
  ),
  ...[
    "attach-wait",
    ...(process.env.PAPERCLIP_ATTACH_TRANSITION_LEGACY_RUNNER
      ? ["attach-capability"]
      : []),
  ].map((recoveryFault) => ({
    lossPoint: "before-result",
    routed: true,
    recoveryFault,
  })),
  ...(process.env.PAPERCLIP_ATTACH_TRANSITION_LEGACY_RUNNER
    ? [
        {
          lossPoint: "after-result",
          routed: false,
          recoveryFault: "legacy-parser",
        },
      ]
    : []),
  {
    lossPoint: "after-confirmation",
    routed: true,
    recoveryFault: "none",
    ordinaryFollowup: true,
  },
  ...[
    "missing_snapshot",
    "rejected_snapshot",
    "wrong_thread",
    "callback_failure",
    "callback_async_failure",
  ].map((ordinaryFollowup) => ({
    lossPoint: "after-confirmation",
    routed: true,
    recoveryFault: "none",
    ordinaryFollowup,
  })),
])(
  "recovers a warm attachment with a fresh controller and runner ($lossPoint, routed=$routed, fault=$recoveryFault, followup=$ordinaryFollowup)",
  async (testCase) => {
    const { lossPoint, routed, recoveryFault } = testCase;
    const ordinaryFollowup =
      "ordinaryFollowup" in testCase && testCase.ordinaryFollowup;
    const snapshotFault =
      typeof ordinaryFollowup === "string" &&
      !ordinaryFollowup.startsWith("callback_");
    const stateDirectory = await mkdtemp(
      join(tmpdir(), "runnerd-attach-restart-"),
    );
    const callsPath = join(stateDirectory, "calls.log");
    const cores: DurablePrpControlPlane[] = [];
    const handles: ReturnType<typeof durableControlPlane.spawnRunner>[] = [];
    const routes = new Map<
      string,
      { core: DurablePrpControlPlane; generation: symbol }
    >();
    const routeCalls: string[] = [];
    let recovering = false;
    let recoveryClaimCurrent = true;
    let recoveryFenceActive = true;
    const completionSnapshotIds: string[] = [];
    let rejectHeldCompletion: ((error: Error) => void) | undefined;
    let snapshotObserverSpy: ReturnType<typeof vi.spyOn> | undefined;
    const routeServer = createServer((_request, response) =>
      response.writeHead(404).end(),
    );
    routeServer.on("upgrade", (request, socket, head) => {
      const entry = routes.get(request.url ?? "");
      if (!entry) {
        socket.destroy();
        return;
      }
      entry.core.handleUpgrade(request, socket, request.url!, head);
    });
    if (routed)
      await new Promise<void>((resolveListen) =>
        routeServer.listen(0, "127.0.0.1", resolveListen),
      );
    const routeAddress = routeServer.address();
    const routePort =
      routeAddress && typeof routeAddress === "object" ? routeAddress.port : 0;
    const registration = async (
      core: DurablePrpControlPlane,
      identity = core.store.state.identity,
    ) => {
      if (
        recovering &&
        ordinaryFollowup &&
        recoveryFenceActive &&
        !recoveryClaimCurrent
      ) {
        throw new Error("fixture old recovery claim is no longer current");
      }
      const path = `/api/runner/v1/connect/${identity.runId}`;
      const generation = Symbol();
      routes.set(path, { core, generation });
      routeCalls.push(identity.runId);
      return {
        connection:
          recovering && recoveryFault === "listen"
            ? {
                mode: "listen" as const,
                listenAddress: "0.0.0.0" as const,
                listenPort: routePort,
                listenPath: path,
              }
            : {
                mode: "connect" as const,
                connectUrl: `ws://127.0.0.1:${routePort}${path}${recovering && recoveryFault === "endpoint" ? "/changed" : ""}`,
              },
        release: () => {
          if (routes.get(path)?.generation === generation) routes.delete(path);
        },
      };
    };
    const OriginalCore = durableControlPlane.DurablePrpControlPlane;
    const coreSpy = vi
      .spyOn(durableControlPlane, "DurablePrpControlPlane")
      .mockImplementation(function (
        options: ConstructorParameters<typeof OriginalCore>[0],
      ) {
        const core = new OriginalCore(options);
        cores.push(core);
        if (recovering && snapshotFault) {
          const getCommand = core.getCommand.bind(core);
          snapshotObserverSpy = vi
            .spyOn(core, "getCommand")
            .mockImplementation((id) => {
              const command = getCommand(id);
              if (
                command?.type !== "session.snapshot" ||
                command.status !== "completed"
              )
                return command;
              const observed = structuredClone(command);
              if (ordinaryFollowup === "rejected_snapshot") {
                observed.status = "failed";
                observed.result = {
                  result: { message: "fixture snapshot observation rejected" },
                };
              } else if (ordinaryFollowup === "wrong_thread") {
                observed.result = {
                  ...observed.result,
                  result: {
                    ...(observed.result?.result as Record<string, unknown>),
                    driverSessionId: "foreign-thread",
                    providerSessionId: "foreign-thread",
                  },
                };
              } else observed.result = { result: { status: "session_open" } };
              return observed;
            });
        }
        return core;
      } as unknown as typeof OriginalCore);
    const launch = durableControlPlane.spawnRunner;
    const launchSpy = vi
      .spyOn(durableControlPlane, "spawnRunner")
      .mockImplementation((options) => {
        const handle = launch(options);
        handles.push(handle);
        return handle;
      });
    const dead = (pid: number) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    };
    const stopOwnedProvider = async (pid: number) => {
      // Exact runner completion can race the OS reaping its already-signalled
      // provider. Absence, not the outcome of a redundant signal, is required.
      try {
        await vi.waitFor(() => expect(dead(-pid)).toBe(true), {
          timeout: 500,
          interval: 10,
        });
      } catch {
        try {
          process.kill(-pid, "SIGKILL");
        } catch (error) {
          if (
            !["ESRCH", "EPERM"].includes(
              String((error as NodeJS.ErrnoException).code),
            )
          )
            throw error;
        }
        await vi.waitFor(() => expect(dead(-pid)).toBe(true), {
          timeout: 2_000,
          interval: 10,
        });
      }
      expect(dead(pid)).toBe(true);
    };
    const fingerprintTree = async (root: string): Promise<unknown[]> => {
      const rows: unknown[] = [];
      const visit = async (path: string, relative: string) => {
        const metadata = await lstat(path);
        rows.push({
          path: relative,
          inode: metadata.ino,
          mode: metadata.mode,
          mtimeMs: metadata.mtimeMs,
          digest: metadata.isFile()
            ? createHash("sha256")
                .update(await readFile(path))
                .digest("hex")
            : metadata.isSymbolicLink()
              ? createHash("sha256")
                  .update(await readlink(path))
                  .digest("hex")
              : null,
        });
        if (metadata.isDirectory())
          for (const child of (await readdir(path)).sort())
            await visit(join(path, child), `${relative}/${child}`);
      };
      await visit(root, ".");
      return rows;
    };
    const within = async <T>(promise: Promise<T>, timeout = 5_000) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("warm restart fixture timed out")),
              timeout,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const options = {
      runnerBinary:
        recoveryFault === "attach-capability"
          ? process.env.PAPERCLIP_ATTACH_TRANSITION_LEGACY_RUNNER!
          : (process.env.PAPERCLIP_ATTACH_TRANSITION_RUNNER ??
            defaultCapabilityRunnerdBinary()),
      codexCommand: fakeCodex,
      codexArgs: fakeCodexArgs(
        stateDirectory,
        "--call-log",
        callsPath,
        "--record-process-start",
      ),
      stateDirectory,
      lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 },
      runnerReconnectGraceMs: 2_000,
      prpIdentity: (() => {
        const runId = randomUUID();
        return {
          runnerInstanceId: randomUUID(),
          environmentLeaseId:
            process.env.PAPERCLIP_ATTACH_TRANSITION_FIXTURE_SCOPE ===
            "transient"
              ? runId
              : randomUUID(),
          runId,
          normalizedSessionId: randomUUID(),
          turnId: `turn-${runId}`,
          itemId: `item-${runId}`,
        };
      })(),
      ...(routed
        ? {
            controlPlaneRegistration: registration,
            warmTransitionRegistrationMode: "routed_connect" as const,
          }
        : {}),
    };
    const first = createCapabilityRunnerdCodexTransport(options);
    let resumed:
      ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined;
    const providerPids = new Set<number>();
    let commitSpy: ReturnType<typeof vi.spyOn> | undefined;
    let commandObserverSpy: ReturnType<typeof vi.spyOn> | undefined;
    let detached: Promise<void> | undefined;
    let cleanupProven = false;
    const legacyProbeDirectories: string[] = [];
    try {
      const opened = await within(
        first.transport.request("thread/start", {
          cwd: tmpdir(),
          dynamicTools: [],
        }),
      );
      const openedThread = opened.thread as { id: string; sessionId: string };
      const thread = { id: openedThread.id, sessionId: openedThread.sessionId };
      const firstThreadSnapshot = await within(
        first.transport.request("thread/read", {}),
      );
      const firstEvidence = first.evidence();
      const cleanRunnerStateBytes = await readFile(
        join(stateDirectory, "runner/runner-state.json"),
      );
      const runnerProcessStartedAt =
        process.platform === "darwin"
          ? new Date(
              execFileSync(
                "ps",
                ["-o", "lstart=", "-p", String(handles[0]!.child.pid)],
                { encoding: "utf8", timeout: 1_500 },
              ).trim(),
            ).toISOString()
          : null;
      if ((first.evidence().codexPid ?? 0) > 0)
        providerPids.add(first.evidence().codexPid!);
      const core = cores[0]!;
      const oldIdentity = structuredClone(core.store.state.identity);
      const nextRunId = randomUUID();
      const desired = {
        ...oldIdentity,
        runId: nextRunId,
        turnId: `turn-${nextRunId}`,
        itemId: `item-${nextRunId}`,
      };
      if (
        recoveryFault === "attach-capability" ||
        recoveryFault === "attach-wait"
      ) {
        if (recoveryFault === "attach-wait") {
          const getCommand = core.getCommand.bind(core);
          commandObserverSpy = vi
            .spyOn(core, "getCommand")
            .mockImplementation((id) => {
              if (
                core.store.state.commands.find(
                  (entry) => entry.commandId === id,
                )?.type === "run.attach"
              ) {
                throw new Error("fixture result observer unavailable");
              }
              return getCommand(id);
            });
        }
        const bootstrapCount = core.store.state.freshBootstraps;
        await expect(
          first.transport.attachRun!({
            runId: desired.runId,
            turnId: desired.turnId,
            itemId: desired.itemId,
          }),
        ).rejects.toThrow(
          recoveryFault === "attach-capability"
            ? "capability is required"
            : "result observer unavailable",
        );
        expect(routeCalls).toEqual([oldIdentity.runId, desired.runId]);
        expect([...routes.keys()]).toEqual([
          `/api/runner/v1/connect/${oldIdentity.runId}`,
        ]);
        expect(core.store.state.freshBootstraps).toBe(bootstrapCount);
        expect(handles).toHaveLength(1);
        if (recoveryFault === "attach-capability")
          expect(
            core.store.state.commands.some(
              (entry) => entry.type === "run.attach",
            ),
          ).toBe(false);
        return;
      }
      const commit = core.store.commit.bind(core.store);
      let lossObserved = false;
      let signalLoss!: () => void;
      const loss = new Promise<void>((resolveLoss) => {
        signalLoss = resolveLoss;
      });
      commitSpy = vi
        .spyOn(core.store, "commit")
        .mockImplementation((candidate) => {
          // The selected process-crash boundary stays unavailable until the
          // exact owned runner is joined. A later replay must not silently
          // settle this fixture before its retained pair is exported.
          if (lossObserved)
            throw new Error(
              "fixture controller persistence unavailable after loss",
            );
          const phase = candidate.warmTransition?.phase;
          const target =
            lossPoint === "after-activation" ? "activated" : "prepared";
          const atBoundary = lossPoint.includes("confirmation")
            ? candidate.completedWarmTransition !== undefined &&
              candidate.warmTransition === undefined
            : phase === target;
          if (!lossObserved && atBoundary) {
            lossObserved = true;
            if (
              lossPoint !== "before-result" &&
              lossPoint !== "before-confirmation"
            )
              commit(candidate);
            // A dead controller cannot accept a reconnect through the second
            // route installed for the in-flight authority rotation. Detaching
            // only the current route leaves that overlapping fixture listener
            // alive; completed-receipt replay needs no further store commit.
            for (const [path, entry] of routes) {
              if (entry.core === core) routes.delete(path);
            }
            core.disconnectActiveRunner();
            detached = first.transport.detachControllerForRestart!();
            signalLoss();
            // A committed confirmation is still before its ACK. Returning from
            // this hook lets the current frame handler send that ACK even after
            // close begins, collapsing the intended crash window on fast peers.
            throw new Error("fixture interrupted exact result commit");
          }
          commit(candidate);
        });
      const attachment = first.transport.attachRun!({
        runId: desired.runId,
        turnId: desired.turnId,
        itemId: desired.itemId,
      });
      void attachment.catch(() => undefined);
      await within(loss);
      await within(detached!);
      expect(lossObserved).toBe(true);
      const runnerPath = join(stateDirectory, "runner/runner-state.json");
      const runner = JSON.parse(await readFile(runnerPath, "utf8"));
      expect(runner.warmTransition.phase).toBe(
        lossPoint === "after-activation" || lossPoint.includes("confirmation")
          ? "activating"
          : "prepared",
      );
      const persisted = JSON.parse(await readFile(core.store.path, "utf8"));
      expect(
        persisted.commands.find(
          (entry: { type: string }) => entry.type === "run.attach",
        )?.status,
      ).toBe(
        lossPoint === "before-result"
          ? "pending"
          : lossPoint === "after-result"
            ? "completed"
            : undefined,
      );
      // Stop only this fixture's exact owned process handles. No stored receipt
      // or PID absence is used as authority to terminate an unknown owner.
      await durableControlPlane
        .waitForProcess(handles[0]!, 100)
        .catch(() => undefined);
      await within(handles[0]!.completion);
      for (const pid of providerPids) {
        await stopOwnedProvider(pid);
      }
      await within(attachment.catch(() => undefined));
      const joinedRunner = JSON.parse(await readFile(runnerPath, "utf8"));
      const joinedCore = JSON.parse(await readFile(core.store.path, "utf8"));
      expect(joinedRunner.warmTransition).toEqual(runner.warmTransition);
      expect(joinedCore.schema).toBe(persisted.schema);
      expect(joinedCore.warmTransition).toEqual(persisted.warmTransition);
      expect(joinedCore.completedWarmTransition).toEqual(
        persisted.completedWarmTransition,
      );
      commitSpy.mockRestore();
      const fixtureOutput =
        process.env.PAPERCLIP_ATTACH_TRANSITION_FIXTURE_DIRECTORY;
      if (fixtureOutput && recoveryFault === "none") {
        const retainedArtifact = join(fixtureOutput, "paperclip-runnerd");
        await cp(options.runnerBinary, retainedArtifact, { force: false });
        expect(
          createHash("sha256")
            .update(await readFile(retainedArtifact))
            .digest("hex"),
        ).toBe(
          createHash("sha256")
            .update(await readFile(options.runnerBinary))
            .digest("hex"),
        );
        const retained = join(
          fixtureOutput,
          `${lossPoint}-${routed ? "routed" : "local"}`,
        );
        await cp(stateDirectory, retained, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
        await writeFile(
          join(retained, "transition-fixture-metadata.json"),
          JSON.stringify(
            {
              schema: "paperclip.test.warm-transition-fixture.v1",
              oldIdentity,
              newIdentity: desired,
              lossPoint,
              routed,
              runner: {
                pid: handles[0]!.child.pid,
                processGroupId: handles[0]!.processGroupId,
                startedAt: runnerProcessStartedAt,
                spawnObservedAt: handles[0]!.startedAt,
                completion: await handles[0]!.completion,
                processAbsent: dead(handles[0]!.child.pid!),
                groupAbsent: dead(-handles[0]!.processGroupId!),
              },
              providers: [...providerPids].map((pid) => ({
                pid,
                processGroupId: pid,
                startedAt: firstEvidence.providerProcessStartedAt,
                processAbsent: dead(pid),
                groupAbsent: dead(-pid),
              })),
              artifact: {
                path: retainedArtifact,
                version: runner.warmTransition.receipt.runnerVersion,
                digest: runner.warmTransition.receipt.runnerDigest,
              },
              thread,
              firstThreadSnapshot,
              firstEvidence,
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
      }
      routes.clear();
      const routeCallCount = routeCalls.length;
      const beforeCalls = (await readFile(callsPath, "utf8"))
        .trim()
        .split(/\r?\n/);
      expect(
        beforeCalls.filter((call) => call === "process-start"),
      ).toHaveLength(1);
      if (recoveryFault === "legacy-parser") {
        const legacyBinary =
          process.env.PAPERCLIP_ATTACH_TRANSITION_LEGACY_RUNNER!;
        const legacyDigest = `sha256:${createHash("sha256")
          .update(await readFile(legacyBinary))
          .digest("hex")}`;
        for (const [mode, bytes] of [
          ["pending", await readFile(runnerPath)],
          ["clean", cleanRunnerStateBytes],
        ] as const) {
          const probe = await mkdtemp(
            join(tmpdir(), "runnerd-legacy-schema-probe-"),
          );
          legacyProbeDirectories.push(probe);
          await writeFile(join(probe, "runner-state.json"), bytes, {
            mode: 0o600,
          });
          const handle = durableControlPlane.spawnRunner({
            connection: runner.warmTransition.receipt.connection,
            stateDirectory: probe,
            identity: oldIdentity,
            runnerBinaryPath: legacyBinary,
            runnerVersion: "0.3.0",
            runnerDigest: legacyDigest,
            ticket: "bootstrap_legacy_parser_probe",
            maxOutboxBytes: runner.maxOutboxBytes,
            p0ReserveBytes: runner.p0ReserveBytes,
            maxRuntimeMs: 200,
            reconnectGraceMs: 200,
          });
          const result = await within(handle.completion, 5_000);
          expect(result.code).not.toBe(0);
          if (mode === "pending") {
            expect(result.stderr).toContain(
              "durable state binding does not match",
            );
            expect(await readFile(join(probe, "runner-state.json"))).toEqual(
              bytes,
            );
          } else {
            expect(result.stderr).not.toContain(
              "durable state binding does not match",
            );
            expect(
              JSON.parse(
                await readFile(join(probe, "runner-state.json"), "utf8"),
              ).nextSourceSeq,
            ).toBeGreaterThan(JSON.parse(bytes.toString("utf8")).nextSourceSeq);
          }
        }
        expect(
          (await readFile(callsPath, "utf8")).trim().split(/\r?\n/),
        ).toEqual(beforeCalls);
        return;
      }
      recovering = true;
      if (recoveryFault === "malformed-core")
        await writeFile(core.store.path, "{", { mode: 0o600 });
      const beforeRecoveryBytes = await Promise.all(
        [core.store.path, runnerPath].map((path) => readFile(path)),
      );
      const beforeRecoveryTree =
        recoveryFault === "none" ? null : await fingerprintTree(stateDirectory);
      const authorizationStages: string[] = [];
      let releaseHeldAuthorization: (() => void) | undefined;
      const authorizationFault = recoveryFault.startsWith("authorize_");
      const failedAuthorizationStage = recoveryFault.slice("authorize_".length);
      const beforeProviderBytes = await readFile(
        join(stateDirectory, "runner", "codex-provider-state.json"),
      );
      resumed = createCapabilityRunnerdCodexTransport({
        ...options,
        ...(ordinaryFollowup
          ? {
              authorizeWarmTransitionRecovery: async () => {
                if (!recoveryClaimCurrent)
                  throw new Error(
                    "fixture old recovery claim is no longer current",
                  );
              },
              onWarmTransitionRecoveryCompleted: (completion: {
                transitionId: string;
              }) => {
                expect(completion.transitionId).toBe(
                  runner.warmTransition.receipt.transitionId,
                );
                const completedSnapshot = cores[1]!.store.state.commands
                  .filter((command) => command.type === "session.snapshot")
                  .at(-1)!;
                expect(completedSnapshot.status).toBe("completed");
                expect(cores[1]!.store.state.identity).toEqual(desired);
                expect(cores[1]!.store.state.warmTransition).toBeUndefined();
                completionSnapshotIds.push(completedSnapshot.commandId);
                if (
                  ordinaryFollowup === "callback_failure" &&
                  completionSnapshotIds.length === 1
                ) {
                  throw new Error(
                    "fixture recovery completion callback failed",
                  );
                }
                if (
                  ordinaryFollowup === "callback_async_failure" &&
                  completionSnapshotIds.length === 1
                ) {
                  return new Promise<void>((_resolve, reject) => {
                    rejectHeldCompletion = reject;
                  });
                }
                recoveryFenceActive = false;
              },
            }
          : {}),
        ...(authorizationFault
          ? {
              authorizeWarmTransitionRecovery: async (stage: string) => {
                authorizationStages.push(stage);
                if (
                  stage === "before_bootstrap" &&
                  failedAuthorizationStage === "before_bootstrap"
                ) {
                  await new Promise<void>((resolveGate) => {
                    releaseHeldAuthorization = resolveGate;
                  });
                }
                if (stage === failedAuthorizationStage)
                  throw new Error("fixture recovery authority revoked");
              },
            }
          : {}),
        ...(recoveryFault === "missing-capability"
          ? { warmTransitionRegistrationMode: undefined }
          : {}),
        ...(recoveryFault !== "none"
          ? {
              environment: {
                CODEX_API_KEY: "synthetic-refused-route-credential",
              },
            }
          : {}),
        prpIdentity: desired,
        resumeProviderSession: {
          driverSessionId: thread.id,
          providerSessionId: thread.sessionId,
        },
      });
      if (recoveryFault !== "none") {
        const recoveryRequest = within(
          resumed.transport.request("thread/read", {}),
        );
        void recoveryRequest.catch(() => undefined);
        if (
          authorizationFault &&
          failedAuthorizationStage === "before_bootstrap"
        ) {
          await vi.waitFor(() =>
            expect(releaseHeldAuthorization).toBeTypeOf("function"),
          );
          const queuedBefore = cores[1]!.store.state.commands.map(
            (command) => command.commandId,
          );
          try {
            await expect(
              resumed.transport.request("turn/start", {
                input: [{ text: "must not queue before bootstrap" }],
              }),
            ).rejects.toThrow("warm_transition_completion_pending");
            await expect(
              resumed.transport.attachRun!({
                runId: "must-not-attach",
                turnId: "must-not-attach",
                itemId: "must-not-attach",
              }),
            ).rejects.toThrow("warm_transition_completion_pending");
            await expect(
              resumed.transport.resolveRuntimeRequest!({
                requestId: "must-not-resolve",
                turnId: desired.turnId,
                resolution: { action: "cancel" },
              }),
            ).rejects.toThrow("warm_transition_completion_pending");
            expect(
              cores[1]!.store.state.commands.map(
                (command) => command.commandId,
              ),
            ).toEqual(queuedBefore);
            expect(handles).toHaveLength(1);
          } finally {
            releaseHeldAuthorization!();
          }
        }
        const failedRecovery = expect(recoveryRequest).rejects;
        if (authorizationFault) {
          await failedRecovery.toThrow(
            failedAuthorizationStage === "before_authentication"
              ? "native_runner_warm_transition_recovery_pending"
              : "fixture recovery authority revoked",
          );
          const expectedStages = [
            "before_bootstrap",
            "before_spawn",
            "before_authentication",
          ];
          expect([...new Set(authorizationStages)]).toEqual(
            expectedStages.slice(
              0,
              expectedStages.indexOf(failedAuthorizationStage) + 1,
            ),
          );
          expect(handles).toHaveLength(
            failedAuthorizationStage === "before_authentication" ? 2 : 1,
          );
          expect(
            await readFile(
              join(stateDirectory, "runner", "codex-provider-state.json"),
            ),
          ).toEqual(beforeProviderBytes);
          const refusedRunner = JSON.parse(await readFile(runnerPath, "utf8"));
          expect(refusedRunner.warmTransition).toEqual(runner.warmTransition);
          expect(
            (await readFile(callsPath, "utf8")).trim().split(/\r?\n/),
          ).toEqual(beforeCalls);
          if (failedAuthorizationStage !== "before_authentication")
            expect(await readFile(runnerPath)).toEqual(beforeRecoveryBytes[1]);
          if (failedAuthorizationStage === "before_bootstrap")
            expect(await readFile(core.store.path)).toEqual(
              beforeRecoveryBytes[0],
            );
          await within(resumed.transport.close()).catch(() => undefined);
          expect([...routes.keys()]).toEqual([]);
          return;
        }
        if (recoveryFault === "malformed-core") await failedRecovery.toThrow();
        else
          await failedRecovery.toThrow(
            recoveryFault === "missing-capability"
              ? "requires_exact_owned_endpoint"
              : "registered_endpoint_mismatch",
          );
        expect(handles).toHaveLength(1);
        expect(
          await Promise.all(
            [core.store.path, runnerPath].map((path) => readFile(path)),
          ),
        ).toEqual(beforeRecoveryBytes);
        expect(await fingerprintTree(stateDirectory)).toEqual(
          beforeRecoveryTree,
        );
        expect(
          (await readFile(callsPath, "utf8")).trim().split(/\r?\n/),
        ).toEqual(beforeCalls);
        expect([...routes.keys()]).toEqual([]);
        return;
      }
      if (
        snapshotFault ||
        ordinaryFollowup === "callback_failure" ||
        ordinaryFollowup === "callback_async_failure"
      ) {
        const firstRead = within(resumed.transport.request("thread/read", {}));
        void firstRead.catch(() => undefined);
        if (ordinaryFollowup === "callback_async_failure") {
          await vi.waitFor(() =>
            expect(rejectHeldCompletion).toBeTypeOf("function"),
          );
          try {
            expect(recoveryFenceActive).toBe(true);
            const queuedBefore = cores[1]!.store.state.commands.map(
              (command) => command.commandId,
            );
            await expect(
              resumed.transport.request("turn/start", {
                input: [{ text: "must not pass held completion" }],
              }),
            ).rejects.toThrow("warm_transition_completion_pending");
            await expect(
              resumed.transport.request("thread/resume", {}),
            ).rejects.toThrow("warm_transition_completion_pending");
            expect(
              cores[1]!.store.state.commands.map(
                (command) => command.commandId,
              ),
            ).toEqual(queuedBefore);
          } finally {
            rejectHeldCompletion!(
              new Error("fixture recovery completion callback failed"),
            );
          }
        }
        await expect(firstRead).rejects.toThrow(
          snapshotFault
            ? ordinaryFollowup === "rejected_snapshot"
              ? "snapshot observation rejected"
              : "completion_unproven"
            : "recovery completion callback failed",
        );
        expect(recoveryFenceActive).toBe(true);
        expect(completionSnapshotIds).toHaveLength(snapshotFault ? 0 : 1);
        const beforeDeniedWork = cores[1]!.store.state.commands.map(
          (command) => command.commandId,
        );
        const beforeDeniedProviderCalls = await readFile(callsPath, "utf8");
        await expect(
          resumed.transport.request("turn/start", {
            input: [{ text: "must remain fenced" }],
          }),
        ).rejects.toThrow("warm_transition_completion_pending");
        await expect(
          resumed.transport.request("thread/resume", {}),
        ).rejects.toThrow("warm_transition_completion_pending");
        await expect(
          resumed.transport.attachRun!({
            runId: "must-not-attach",
            turnId: "must-not-attach",
            itemId: "must-not-attach",
          }),
        ).rejects.toThrow("warm_transition_completion_pending");
        expect(
          cores[1]!.store.state.commands.map((command) => command.commandId),
        ).toEqual(beforeDeniedWork);
        expect(await readFile(callsPath, "utf8")).toBe(
          beforeDeniedProviderCalls,
        );
        snapshotObserverSpy?.mockRestore();
        const providerCallsBeforeRetry = await readFile(callsPath, "utf8");
        expect(
          (await within(resumed.transport.request("thread/read", {}))).thread,
        ).toMatchObject(thread);
        expect(recoveryFenceActive).toBe(false);
        expect(completionSnapshotIds).toHaveLength(snapshotFault ? 1 : 2);
        expect(new Set(completionSnapshotIds).size).toBe(
          completionSnapshotIds.length,
        );
        expect(await readFile(callsPath, "utf8")).toBe(
          providerCallsBeforeRetry,
        );
        return;
      }
      const read = await within(
        resumed.transport.request("thread/read", {}),
        10_000,
      );
      if ((resumed.evidence().codexPid ?? 0) > 0)
        providerPids.add(resumed.evidence().codexPid!);
      expect(read.thread).toMatchObject(thread);
      expect(cores).toHaveLength(2);
      expect(cores[1]!.store.state.identity).toEqual(desired);
      expect(cores[1]!.store.state.warmTransition).toBeUndefined();
      expect(
        cores[1]!.store.state.completedWarmTransition?.receipt.transitionId,
      ).toBe(runner.warmTransition.receipt.transitionId);
      if (routed) {
        expect(routeCalls.slice(routeCallCount)).toEqual([
          oldIdentity.runId,
          desired.runId,
        ]);
        expect([...routes.keys()]).toEqual([
          `/api/runner/v1/connect/${desired.runId}`,
        ]);
      }
      const calls = (await readFile(callsPath, "utf8")).trim().split(/\r?\n/);
      expect(calls.filter((call) => call === "process-start")).toHaveLength(2);
      expect(calls.filter((call) => call === "thread/start")).toHaveLength(1);
      expect(calls.filter((call) => call === "thread/resume")).toHaveLength(1);
      expect(calls.filter((call) => call === "turn/start")).toHaveLength(0);
      if (ordinaryFollowup) {
        recoveryClaimCurrent = false;
        const resumedCore = cores[1]!;
        resumedCore.disconnectActiveRunner();
        await vi.waitFor(
          () => expect(resumedCore.activeRunnerConnectionCount()).toBe(1),
          { timeout: 2_000 },
        );
        expect(recoveryFenceActive).toBe(false);
        expect(
          (await within(resumed.transport.request("thread/read", {}))).thread,
        ).toMatchObject(thread);
        const thirdRunId = randomUUID();
        await within(
          resumed.transport.attachRun!({
            runId: thirdRunId,
            turnId: `turn-${thirdRunId}`,
            itemId: `item-${thirdRunId}`,
          }),
        );
        expect(resumedCore.store.state.identity.runId).toBe(thirdRunId);
        expect(
          (await readFile(callsPath, "utf8")).trim().split(/\r?\n/),
        ).toEqual([...calls, "thread/goal/get"]);
      }
    } finally {
      snapshotObserverSpy?.mockRestore();
      commitSpy?.mockRestore();
      commandObserverSpy?.mockRestore();
      try {
        await within(resumed?.transport.close() ?? Promise.resolve()).catch(
          () => undefined,
        );
        await within(first.transport.detachControllerForRestart!()).catch(
          () => undefined,
        );
        for (const handle of handles) {
          await durableControlPlane
            .waitForProcess(handle, 250)
            .catch(() => undefined);
          await within(handle.completion);
          if (handle.processGroupId && !dead(-handle.processGroupId))
            process.kill(-handle.processGroupId, "SIGKILL");
          await vi.waitFor(() => {
            expect(handle.child.pid && dead(handle.child.pid)).toBe(true);
            expect(handle.processGroupId && dead(-handle.processGroupId)).toBe(
              true,
            );
          });
        }
        for (const pid of providerPids) {
          await stopOwnedProvider(pid);
        }
        cleanupProven = true;
      } finally {
        for (const core of cores) await core.stop().catch(() => undefined);
        if (routed)
          await new Promise<void>((resolveClose) =>
            routeServer.close(() => resolveClose()),
          );
        coreSpy.mockRestore();
        launchSpy.mockRestore();
        if (cleanupProven)
          await rm(stateDirectory, { recursive: true, force: true });
        if (cleanupProven)
          for (const directory of legacyProbeDirectories)
            await rm(directory, { recursive: true, force: true });
      }
    }
  },
  30_000,
);

it("rotates PRP authority in place for a warm cross-run attachment", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-warm-attach-"));
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory),
    stateDirectory,
    lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
  });
  bundle.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [],
  }));
  const within = async <T>(label: string, promise: Promise<T>) =>
    await Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timeout`)), 5_000),
      ),
    ]);
  try {
    await within("initialize", bundle.transport.request("initialize", {}));
    await within(
      "thread start",
      bundle.transport.request("thread/start", {
        cwd: tmpdir(),
        dynamicTools: [
          {
            name: "get_task_context",
            description: "Read the active task.",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ],
        completionContract: {
          revision: "sha256:warm-three-turn-contract",
          criterionIds: ["objective"],
        },
      }),
    );
    const runnerPid = bundle.evidence().runnerPid;
    const providerPid = bundle.evidence().codexPid;
    const notifications = bundle.transport
      .notifications()
      [Symbol.asyncIterator]();
    const waitForCompletion = async (label: string) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const next = await Promise.race([
          notifications.next(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`${label} notification timeout`)),
              1_000,
            ),
          ),
        ]);
        if (next.value?.method === "turn/completed") return;
      }
      throw new Error(`${label} completion timeout`);
    };
    await within(
      "first turn start",
      bundle.transport.request("turn/start", {
        input: [{ type: "text", text: "first run" }],
      }),
    );
    await waitForCompletion("first run");

    await within(
      "warm attach",
      bundle.transport.attachRun!({
        runId: "run-warm-second",
        turnId: "turn-warm-second",
        itemId: "item-warm-second",
      }),
    );
    await within(
      "second turn start",
      bundle.transport.request("turn/start", {
        input: [{ type: "text", text: "second run" }],
      }),
    );
    await waitForCompletion("second run");

    await within(
      "second warm attach",
      bundle.transport.attachRun!({
        runId: "run-warm-third",
        turnId: "turn-warm-third",
        itemId: "item-warm-third",
      }),
    );
    await within(
      "third turn start",
      bundle.transport.request("turn/start", {
        input: [{ type: "text", text: "third run" }],
      }),
    );
    await waitForCompletion("third run");

    expect(bundle.evidence()).toMatchObject({
      runnerPid,
      codexPid: providerPid,
      runnerExited: false,
    });
  } finally {
    await bundle.transport.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);

it("waits for a warm runner to re-authenticate before probing attachment readiness", async () => {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "runnerd-warm-reattach-before-probe-"),
  );
  const server = createServer();
  const authorities = new Map<string, DurablePrpControlPlane>();
  let blockFirstAuthorityReconnect = false;
  let resolveRejectedReconnect!: () => void;
  const rejectedReconnect = new Promise<void>((resolvePromise) => {
    resolveRejectedReconnect = resolvePromise;
  });
  server.on("upgrade", (request, socket, head) => {
    const route = request.url ?? "";
    if (route === "/runner-1" && blockFirstAuthorityReconnect) {
      resolveRejectedReconnect();
      socket.destroy();
      return;
    }
    const authority = authorities.get(route);
    if (!authority) {
      socket.destroy();
      return;
    }
    authority.handleUpgrade(request, socket, route, head);
  });
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected warm reconnect test listener");
  }
  let registrationCount = 0;
  const diagnostics: string[] = [];
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory),
    stateDirectory,
    lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
    runnerReconnectGraceMs: 5_000,
    onDiagnostic: (message) => diagnostics.push(message),
    controlPlaneRegistration: async (authority) => {
      registrationCount += 1;
      const route = `/runner-${registrationCount}`;
      authorities.set(route, authority);
      return {
        connectUrl: `ws://127.0.0.1:${address.port}${route}`,
        release: () => {
          if (authorities.get(route) === authority) authorities.delete(route);
        },
      };
    },
  });
  bundle.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [],
  }));
  let runnerPid: number | null = null;
  try {
    await bundle.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: codexSemanticToolSpecs(),
    });
    runnerPid = bundle.evidence().runnerPid;
    const firstAuthority = authorities.get("/runner-1");
    if (!firstAuthority) throw new Error("Missing first warm authority");
    const priorSnapshotCount = firstAuthority.store.state.commands.filter(
      (command) => command.type === "session.snapshot",
    ).length;

    blockFirstAuthorityReconnect = true;
    firstAuthority.disconnectActiveRunner();
    const attachment = bundle.transport.attachRun!({
      runId: "run-warm-after-reconnect",
      turnId: "turn-warm-after-reconnect",
      itemId: "item-warm-after-reconnect",
    });
    await Promise.race([
      rejectedReconnect,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("runner did not attempt to reconnect")),
          5_000,
        ),
      ),
    ]);

    // No command may be queued while its sole authenticated consumer is
    // absent. The generic 30-second command timeout used to turn this state
    // into same-run recovery and replace the healthy warm runner process.
    expect(
      firstAuthority.store.state.commands.filter(
        (command) => command.type === "session.snapshot",
      ),
    ).toHaveLength(priorSnapshotCount);

    blockFirstAuthorityReconnect = false;
    await Promise.race([
      attachment,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("warm attachment timeout")), 10_000),
      ),
    ]);
    expect(bundle.evidence()).toMatchObject({
      runnerPid,
      runnerExited: false,
    });
    expect(diagnostics).toContain(
      "warm runner connection interrupted; waiting for re-authentication before authority rotation",
    );
    expect(diagnostics).toContain(
      "warm runner re-authenticated before authority rotation",
    );
  } finally {
    await bundle.transport.close().catch(() => undefined);
    if (runnerPid) {
      try {
        process.kill(-runnerPid, "SIGKILL");
      } catch {
        // A successful durable close already stopped the runner process group.
      }
    }
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
    }
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);

it("releases both PRP authorities when warm rotation activation fails", async () => {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "runnerd-warm-attach-activation-failure-"),
  );
  const server = createServer();
  const authorities = new Map<string, DurablePrpControlPlane>();
  const released: string[] = [];
  server.on("upgrade", (request, socket, head) => {
    const route = request.url ?? "";
    const authority = authorities.get(route);
    if (!authority) {
      socket.destroy();
      return;
    }
    authority.handleUpgrade(request, socket, route, head);
  });
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected warm activation failure test listener");
  }
  let registrationCount = 0;
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory),
    stateDirectory,
    lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
    controlPlaneRegistration: async (authority) => {
      registrationCount += 1;
      const route = `/runner-${registrationCount}`;
      authorities.set(route, authority);
      return {
        connectUrl: `ws://127.0.0.1:${address.port}${route}`,
        ...(registrationCount === 1
          ? {}
          : {
              activate: () => {
                throw new Error("rotation activation failed");
              },
            }),
        release: () => {
          released.push(route);
          if (authorities.get(route) === authority) authorities.delete(route);
        },
      };
    },
  });
  bundle.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [],
  }));
  let runnerPid: number | null = null;
  try {
    await bundle.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: codexSemanticToolSpecs(),
    });
    runnerPid = bundle.evidence().runnerPid;

    await expect(
      bundle.transport.attachRun!({
        runId: "run-warm-activation-failure",
        turnId: "turn-warm-activation-failure",
        itemId: "item-warm-activation-failure",
      }),
    ).rejects.toThrow("rotation activation failed");
    expect(new Set(released)).toEqual(new Set(["/runner-1", "/runner-2"]));
    expect(authorities.size).toBe(0);
    await expect(bundle.transport.request("thread/read", {})).rejects.toThrow(
      "rotation activation failed",
    );
  } finally {
    await bundle.transport.close().catch(() => undefined);
    if (runnerPid) {
      try {
        process.kill(-runnerPid, "SIGKILL");
      } catch {
        // A successful durable close already stopped the runner process group.
      }
    }
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
    }
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);

it.each([
  {
    binding: "runner instance",
    priorRunnerInstanceId: "runner-other",
    priorEnvironmentLeaseId: "lease-current",
  },
  {
    binding: "environment lease",
    priorRunnerInstanceId: "runner-current",
    priorEnvironmentLeaseId: "lease-other",
  },
])(
  "quarantines a mismatched $binding instead of reusing its provider session",
  async ({ priorRunnerInstanceId, priorEnvironmentLeaseId }) => {
    const container = await mkdtemp(
      join(tmpdir(), "runnerd-mismatched-authority-"),
    );
    const stateDirectory = join(container, "state");
    await mkdir(join(stateDirectory, "control-plane"), { recursive: true });
    await writeFile(
      join(stateDirectory, "control-plane", "control-plane-state.json"),
      JSON.stringify({
        identity: {
          runnerInstanceId: priorRunnerInstanceId,
          environmentLeaseId: priorEnvironmentLeaseId,
          runId: "run-old",
          normalizedSessionId: "session-current",
          turnId: "turn-old",
          itemId: "item-old",
        },
      }),
      { mode: 0o600 },
    );
    const bundle = createCapabilityRunnerdCodexTransport({
      runnerBinary: defaultCapabilityRunnerdBinary(),
      stateDirectory,
      lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      prpIdentity: {
        runnerInstanceId: "runner-current",
        environmentLeaseId: "lease-current",
        runId: "run-new",
        normalizedSessionId: "session-current",
        turnId: "turn-new",
        itemId: "item-new",
      },
    });
    try {
      await expect(bundle.transport.request("thread/read", {})).rejects.toThrow(
        "native_runner_state_quarantined",
      );
      expect(await readdir(stateDirectory)).toEqual([]);
      expect(
        (await readdir(container)).some((entry) =>
          entry.startsWith("state.quarantine-"),
        ),
      ).toBe(true);
    } finally {
      await bundle.transport.close();
      await rm(container, { recursive: true, force: true });
    }
  },
);

it("probes an exact-authority resume and confirms its live provider identity", async () => {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "runnerd-exact-authority-resume-"),
  );
  const identity = {
    runnerInstanceId: "runner-exact-resume",
    environmentLeaseId: "lease-exact-resume",
    runId: "run-exact-resume",
    normalizedSessionId: "session-exact-resume",
    turnId: "turn-exact-resume",
    itemId: "item-exact-resume",
  };
  const options = {
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory, "--durable-turn-ids"),
    stateDirectory,
    lifecyclePolicy: { mode: "per_turn" as const, idleTimeoutMs: null },
    prpIdentity: identity,
  };
  const first = createCapabilityRunnerdCodexTransport(options);
  first.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [],
  }));
  let providerThread: { id: string; sessionId: string } | null = null;
  try {
    const opened = await first.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: [],
    });
    const thread = opened.thread as Record<string, unknown>;
    providerThread = {
      id: String(thread.id),
      sessionId: String(thread.sessionId),
    };
  } finally {
    await first.transport.close();
  }
  if (providerThread === null) {
    throw new Error("exact-authority fixture did not return a provider thread");
  }

  const statePath = join(
    stateDirectory,
    "control-plane",
    "control-plane-state.json",
  );
  const beforeResume = JSON.parse(await readFile(statePath, "utf8")) as {
    commands: Array<{ type: string }>;
    committedEvents: Array<{ eventType: string }>;
  };
  expect(
    beforeResume.commands.some((command) => command.type === "run.attach"),
  ).toBe(false);
  const priorResumeEvents = beforeResume.committedEvents.filter(
    (event) => event.eventType === "session.resumed",
  ).length;
  const priorSnapshots = beforeResume.commands.filter(
    (command) => command.type === "session.snapshot",
  ).length;

  const resumed = createCapabilityRunnerdCodexTransport({
    ...options,
    resumeProviderSession: {
      driverSessionId: providerThread.id,
      providerSessionId: providerThread.sessionId,
    },
  });
  resumed.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [],
  }));
  try {
    const read = await resumed.transport.request("thread/read", {});
    expect(read.thread).toMatchObject(providerThread);
    const afterResume = JSON.parse(await readFile(statePath, "utf8")) as {
      commands: Array<{ commandId: string; type: string; status: string }>;
      committedEvents: Array<{ eventType: string }>;
    };
    expect(afterResume.commands).toContainEqual(
      expect.objectContaining({
        commandId: expect.stringMatching(/^command_resume_probe_/),
        type: "runner.drain",
        status: "completed",
      }),
    );
    expect(afterResume.commands).toContainEqual(
      expect.objectContaining({
        type: "session.snapshot",
        status: "completed",
      }),
    );
    expect(
      afterResume.commands.filter(
        (command) => command.type === "session.snapshot",
      ),
    ).toHaveLength(priorSnapshots + 2);
    // The authenticated snapshot above proves the live provider identity.
    // Control-first dispatch may deliver that command before the independent
    // session event is ingested. Still require exactly one durable event;
    // don't mistake an immediate file read for an event-delivery barrier.
    await vi.waitFor(async () => {
      const delivered = JSON.parse(await readFile(statePath, "utf8")) as {
        committedEvents: Array<{ eventType: string }>;
      };
      expect(
        delivered.committedEvents.filter(
          (event) => event.eventType === "session.resumed",
        ),
      ).toHaveLength(priorResumeEvents + 1);
    }, { timeout: 3_000, interval: 25 });
  } finally {
    await resumed.transport.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);

it("cold-restores a suspended provider session under its durable run binding", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-cold-attach-"));
  const tracePath = join(stateDirectory, "provider-trace.ndjson");
  const skillRoot = join(stateDirectory, "runtime-skill");
  const instructionRoot = join(stateDirectory, "runtime-instructions");
  await Promise.all([mkdir(skillRoot), mkdir(instructionRoot)]);
  await writeFile(join(skillRoot, "SKILL.md"), "# Assigned runtime skill\n");
  await writeFile(join(instructionRoot, "AGENTS.md"), "Runtime instructions\n");
  const baseIdentity = {
    runnerInstanceId: "runner-cold-attach",
    environmentLeaseId: "lease-cold-attach",
    runId: "run-cold-first",
    normalizedSessionId: "session-cold-attach",
    turnId: "turn-cold-first",
    itemId: "item-cold-first",
  };
  const options = {
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(
      stateDirectory,
      "--include-skill-instructions",
      "--durable-turn-ids",
      "-c",
      'shell_environment_policy.set={PATH="/run/A"}',
    ),
    stateDirectory,
    environment: {
      PAPERCLIP_GITHUB_BROKER_TOKEN: "test-run-A-capability",
      PAPERCLIP_PROVIDER_TRACE_PATH: tracePath,
      PAPERCLIP_PROVIDER_TRACE_MAX_BYTES: String(64 * 1024 * 1024),
    },
    lifecyclePolicy: { mode: "per_turn" as const, idleTimeoutMs: null },
    runtimeContext: assignedRuntimeContext(skillRoot, instructionRoot),
  };
  const dynamicTools = [
    {
      name: "get_task_context",
      description: "Read the active task.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ];
  const first = createCapabilityRunnerdCodexTransport({
    ...options,
    prpIdentity: baseIdentity,
  });
  first.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [],
  }));
  let firstProviderThread: { id: string; sessionId: string } | null = null;
  try {
    const started = await first.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: [...dynamicTools, ...codexSemanticToolSpecs()],
      completionContract: {
        revision: "contract-first",
        criterionIds: ["criterion-first"],
      },
    });
    const startedThread = started.thread as Record<string, unknown>;
    firstProviderThread = {
      id: String(startedThread.id),
      sessionId: String(startedThread.sessionId),
    };
    expect(
      (await stat(join(stateDirectory, "codex-home", "skills", "assigned")))
        .mode & 0o222,
    ).toBe(0);
    expect(
      (
        await stat(
          join(stateDirectory, "codex-home", "skills", "assigned", "SKILL.md"),
        )
      ).mode & 0o222,
    ).toBe(0);
    await first.transport.request("turn/start", {
      input: [{ type: "text", text: "first process" }],
    });
    for await (const event of first.transport.notifications()) {
      if (event.method === "turn/completed") break;
    }
  } finally {
    await first.transport.close();
  }
  if (!firstProviderThread) {
    throw new Error("cold attach fixture did not return a provider thread");
  }

  const secondIdentity = {
    ...baseIdentity,
    runId: "run-cold-second",
    turnId: "turn-cold-second",
    itemId: "item-cold-second",
  };
  const rotated = createCapabilityRunnerdCodexTransport({
    ...options,
    environment: { ...options.environment, PAPERCLIP_GITHUB_BROKER_TOKEN: "test-run-B-capability" },
    codexArgs: options.codexArgs.map((arg) => arg.replace('/run/A', '/run/B')),
    resumeDynamicTools: dynamicTools,
    resumeCompletionContract: {
      revision: "contract-second",
      criterionIds: ["criterion-second"],
    },
    prpIdentity: secondIdentity,
  });
  rotated.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [],
  }));
  try {
    const read = await rotated.transport.request("thread/read", {});
    const persistedProvider = JSON.parse(await readFile(join(stateDirectory, "runner", "codex-provider-state.json"), "utf8"));
    expect(persistedProvider.config.args.join("\n")).toContain('/run/B');
    expect(JSON.stringify(persistedProvider)).not.toContain("test-run-B-capability");
    expect(read.thread).toMatchObject({
      id: firstProviderThread.id,
      sessionId: firstProviderThread.sessionId,
      cwd: tmpdir(),
    });
    await rotated.transport.request("turn/start", {
      input: [{ type: "text", text: "second authority epoch" }],
    });
    for await (const event of rotated.transport.notifications()) {
      if (event.method === "paperclip/runResult") break;
    }
    expect(rotated.evidence().diagnostics).toContain(
      "runnerd attached the durable provider session to a fresh PRP run authority",
    );
    expect(await stat(join(stateDirectory, "authority-epochs"))).toBeDefined();
  } finally {
    await rotated.transport.close();
  }
  const resumeFrames = (await readFile(tracePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter(
      (entry) =>
        entry.kind === "frame" && entry.direction === "client_to_provider",
    )
    .map(
      (entry) =>
        JSON.parse(
          Buffer.from(String(entry.rawBase64), "base64").toString("utf8"),
        ) as Record<string, unknown>,
    )
    .filter((frame) => frame.method === "thread/resume");
  expect(resumeFrames.length).toBeGreaterThanOrEqual(1);
  for (const frame of resumeFrames) {
    expect(frame).toEqual(
      expect.objectContaining({
        method: "thread/resume",
        params: expect.objectContaining({ threadId: firstProviderThread.id }),
      }),
    );
  }

  // A remote process owner keeps runner-state outside the controller's local
  // session root. Resume must defer to its explicit state reader instead of
  // rejecting recovery before the remote checkpoint can be made available.
  const externallyOwnedRunnerStateDirectory = join(
    stateDirectory,
    "externally-owned-runner",
  );
  await rename(
    join(stateDirectory, "runner"),
    externallyOwnedRunnerStateDirectory,
  );
  const readRunnerState = async () =>
    JSON.parse(
      await readFile(
        join(externallyOwnedRunnerStateDirectory, "runner-state.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
  const mismatched = createCapabilityRunnerdCodexTransport({
    ...options,
    runnerStateDirectory: externallyOwnedRunnerStateDirectory,
    readRunnerState,
    resumeDynamicTools: dynamicTools,
    prpIdentity: {
      ...secondIdentity,
      runId: "run-cold-other",
      turnId: "turn-cold-other",
      itemId: "item-cold-other",
    },
  });
  await expect(mismatched.transport.request("thread/read", {})).rejects.toThrow(
    "native_runner_prp_run_rotation_unavailable",
  );
  await mismatched.transport.close();

  const externalIdentity = {
    ...secondIdentity,
    runId: "run-cold-external",
    turnId: "turn-cold-external",
    itemId: "item-cold-external",
  };
  const rejectedExternalRotationSteps: string[] = [];
  let externalArchiveDirectory: string | null = null;
  const rejectedExternalRotation = createCapabilityRunnerdCodexTransport({
    ...options,
    runnerStateDirectory: externallyOwnedRunnerStateDirectory,
    readRunnerState,
    prepareExternalRunnerState: async () => {
      rejectedExternalRotationSteps.push("prepared");
    },
    archiveExternalRunnerState: async ({ archiveKey }) => {
      await expect(
        stat(join(stateDirectory, "control-plane")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        await stat(
          join(
            stateDirectory,
            "authority-epochs",
            `epoch-${archiveKey}`,
            "control-plane",
          ),
        ),
      ).toBeDefined();
      externalArchiveDirectory = join(
        stateDirectory,
        "external-authority-epochs",
        archiveKey,
      );
      await mkdir(externalArchiveDirectory, { recursive: true });
      await rename(
        join(externallyOwnedRunnerStateDirectory, "runner-state.json"),
        join(externalArchiveDirectory, "runner-state.json"),
      );
      rejectedExternalRotationSteps.push("remote-archived");
      throw new Error("controller crashed after external archive");
    },
    resumeDynamicTools: dynamicTools,
    prpIdentity: externalIdentity,
  });
  await expect(
    rejectedExternalRotation.transport.request("thread/read", {}),
  ).rejects.toThrow("controller crashed after external archive");
  await rejectedExternalRotation.transport.close();
  expect(rejectedExternalRotationSteps).toEqual([
    "prepared",
    "remote-archived",
  ]);
  await expect(stat(join(stateDirectory, "control-plane"))).rejects.toThrow();
  await expect(
    stat(join(externallyOwnedRunnerStateDirectory, "runner-state.json")),
  ).rejects.toThrow();

  const externalRotationSteps: string[] = [];
  const externallyRotated = createCapabilityRunnerdCodexTransport({
    ...options,
    runnerStateDirectory: externallyOwnedRunnerStateDirectory,
    readRunnerState,
    prepareExternalRunnerState: async () => {
      throw new Error("retry must not prepare a new external runner");
    },
    archiveExternalRunnerState: async ({ archiveKey }) => {
      expect(externalArchiveDirectory).toBe(
        join(stateDirectory, "external-authority-epochs", archiveKey),
      );
      externalRotationSteps.push("archived");
      return JSON.parse(
        await readFile(
          join(externalArchiveDirectory!, "runner-state.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
    },
    resumeDynamicTools: dynamicTools,
    resumeCompletionContract: {
      revision: "contract-external",
      criterionIds: ["criterion-external"],
    },
    prpIdentity: externalIdentity,
  });
  externallyRotated.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [],
  }));
  try {
    const read = await externallyRotated.transport.request("thread/read", {});
    expect(read.thread).toMatchObject({
      id: firstProviderThread.id,
      sessionId: firstProviderThread.sessionId,
      cwd: tmpdir(),
    });
    expect(externalRotationSteps).toEqual(["archived"]);
  } finally {
    await externallyRotated.transport.close();
  }

  const restored = createCapabilityRunnerdCodexTransport({
    ...options,
    runnerStateDirectory: externallyOwnedRunnerStateDirectory,
    readRunnerState,
    resumeDynamicTools: dynamicTools,
    prpIdentity: externalIdentity,
  });
  restored.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [],
  }));
  try {
    const read = await restored.transport.request("thread/read", {});
    expect(read.thread).toMatchObject({
      id: "codex-thread-1",
      cwd: tmpdir(),
    });
    expect(
      (await stat(join(stateDirectory, "codex-home", "skills", "assigned")))
        .mode & 0o222,
    ).toBe(0);
    expect(
      (
        await stat(
          join(stateDirectory, "codex-home", "skills", "assigned", "SKILL.md"),
        )
      ).mode & 0o222,
    ).toBe(0);
    const providerState = JSON.parse(
      await readFile(
        join(externallyOwnedRunnerStateDirectory, "codex-provider-state.json"),
        "utf8",
      ),
    ) as { toolBridge?: { authorized?: Record<string, unknown> } };
    expect(Object.keys(providerState.toolBridge?.authorized ?? {})).toEqual([
      "get_task_context",
      "paperclip_block",
      "paperclip_finish",
    ]);
    await restored.transport.request("turn/start", {
      input: [{ type: "text", text: "restored process" }],
    });
    for await (const event of restored.transport.notifications()) {
      if (event.method === "turn/completed") break;
    }
    expect(restored.evidence()).toMatchObject({
      runnerExited: false,
      codexPid: expect.any(Number),
    });
  } finally {
    await restored.transport.close();
    await releaseMaterializedNativeRuntimeSkills(
      join(stateDirectory, "codex-home", "skills"),
    );
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);

async function verifyLiveRunnerAdoption(
  mismatchedCheckpoint: boolean,
  mismatchedArtifact = false,
  goalMidTurn = false,
) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-live-adopt-"));
  const server = createServer();
  let authority: DurablePrpControlPlane | null = null;
  const checkpoint = vi.fn(async () => undefined);
  server.on("upgrade", (request, socket, head) => {
    if (!authority) {
      socket.destroy();
      return;
    }
    authority.handleUpgrade(request, socket, "/runner", head);
  });
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected adoption test listener");
  const registration = async (next: DurablePrpControlPlane) => {
    authority = next;
    return {
      connectUrl: `ws://127.0.0.1:${address.port}/runner`,
      ...(mismatchedArtifact ? { checkpoint } : {}),
      release: async () => {
        if (authority === next) authority = null;
      },
    };
  };
  const identity = {
    runnerInstanceId: "runner-live-adopt",
    environmentLeaseId: "lease-live-adopt",
    runId: "run-live-adopt",
    normalizedSessionId: "session-live-adopt",
    turnId: "turn-live-adopt",
    itemId: "item-live-adopt",
  };
  const sharedOptions = {
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory, ...(goalMidTurn ? ["--goal-autostart", "--goal-item-trigger", join(stateDirectory, "emit-goal-item")] : [])),
    stateDirectory,
    prpIdentity: identity,
    lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 },
    controlPlaneRegistration: registration,
  };
  const first = createCapabilityRunnerdCodexTransport(sharedOptions);
  let runnerPid: number | null = null;
  let adopted: ReturnType<typeof createCapabilityRunnerdCodexTransport> | null =
    null;
  try {
    let opened: Record<string, unknown>;
    try {
      opened = await first.transport.request("thread/start", {
        cwd: tmpdir(),
        dynamicTools: codexSemanticToolSpecs(),
      });
    } catch (error) {
      const stderr = await readFile(
        join(stateDirectory, "diagnostics", "runnerd.stderr.log"),
        "utf8",
      ).catch(() => "");
      throw new Error(
        `${String(error)}\n${JSON.stringify(first.evidence())}${stderr ? `\n${stderr}` : ""}`,
      );
    }
    runnerPid = first.evidence().runnerPid;
    expect(runnerPid).toEqual(expect.any(Number));

    if (goalMidTurn) {
      await first.transport.request("thread/goal/set", { objective: "Recover a live goal", status: "active" });
      for await (const event of first.transport.notifications()) {
        if (event.method === "turn/started") break;
      }
    }

    await first.detachControllerForRestart();
    expect(() => process.kill(runnerPid!, 0)).not.toThrow();
    if (goalMidTurn) {
      await writeFile(join(stateDirectory, "emit-goal-item"), "emit");
      // runnerd need not poll the provider into its PRP outbox while disconnected.
      // Wait for flushed provider output, not a platform-dependent final poll
      // racing the disconnect. Adoption must still bind that buffered item.
      await vi.waitFor(async () => {
        expect(await readFile(join(stateDirectory, "emit-goal-item.sent"), "utf8")).toBe("sent");
      }, { timeout: 5_000 });
    }

    const controlPlaneStatePath = join(
      stateDirectory,
      "control-plane",
      "control-plane-state.json",
    );
    const compactProviderIdentityEvents = async () => {
      const controlPlaneState = JSON.parse(
        await readFile(controlPlaneStatePath, "utf8"),
      ) as { committedEvents: Array<{ eventType: string }> };
      controlPlaneState.committedEvents =
        controlPlaneState.committedEvents.filter(
          (event) =>
            event.eventType !== "harness.ready" &&
            event.eventType !== "session.started" &&
            event.eventType !== "session.resumed",
        );
      await writeFile(
        controlPlaneStatePath,
        `${JSON.stringify(controlPlaneState, null, 2)}\n`,
        { mode: 0o600 },
      );
    };
    await compactProviderIdentityEvents();

    const duplicateLauncher = vi.fn(() => {
      throw new Error("duplicate runner spawn attempted");
    });
    const openedThread = opened.thread as Record<string, unknown>;
    const signal = vi.fn(() => true);
    adopted = createCapabilityRunnerdCodexTransport({
      ...sharedOptions,
      // Hash different stable bytes without replacing the real runner artifact
      // used by concurrent tests. Adoption must never execute this path.
      ...(mismatchedArtifact
        ? {
            runnerBinary: resolve(import.meta.dirname, "../../package.json"),
            runnerReconnectGraceMs: 150,
          }
        : {}),
      resumeDynamicTools: [],
      resumeProviderSession: {
        driverSessionId: String(openedThread.id),
        providerSessionId: mismatchedCheckpoint
          ? "wrong-provider-session"
          : String(openedThread.sessionId),
      },
      runnerProcessLauncher: duplicateLauncher,
      adoptExistingRunner: {
        pid: runnerPid!,
        processGroupId: runnerPid,
        startedAt: new Date().toISOString(),
        signal,
        isAlive: () => {
          try {
            process.kill(runnerPid!, 0);
            return true;
          } catch {
            return false;
          }
        },
      },
    });
    if (mismatchedArtifact) {
      await expect(
        adopted.transport.request("thread/read", {}),
      ).rejects.toThrow("native_adopted_runner_authentication_timeout");
      expect(authority?.activeRunnerConnectionCount()).toBe(0);
      await expect(
        adopted.transport.request("turn/start", {
          input: [{ type: "text", text: "must not be dispatched" }],
        }),
      ).rejects.toThrow("native_adopted_runner_authentication_timeout");
      await adopted.transport.close();
      expect(signal).not.toHaveBeenCalled();
      expect(checkpoint).not.toHaveBeenCalled();
      expect(duplicateLauncher).not.toHaveBeenCalled();
      expect(() => process.kill(runnerPid!, 0)).not.toThrow();
      const retained = JSON.parse(
        await readFile(controlPlaneStatePath, "utf8"),
      ) as {
        identity: unknown;
        commands: Array<{ type: string; status: string }>;
      };
      expect(retained.identity).toEqual(identity);
      expect(
        retained.commands.some(
          (command) =>
            command.type === "runner.drain" && command.status === "pending",
        ),
      ).toBe(true);
      expect(retained.commands.map((command) => command.type)).not.toEqual(
        expect.arrayContaining(["runner.suspend"]),
      );
      expect(retained.commands.map((command) => command.type)).not.toEqual(
        expect.arrayContaining(["turn.stop"]),
      );
      return;
    }
    if (mismatchedCheckpoint) {
      await expect(
        adopted.transport.request("thread/read", {}),
      ).rejects.toThrow("native_adopted_provider_identity_mismatch");
      expect(duplicateLauncher).not.toHaveBeenCalled();
      expect(() => process.kill(runnerPid!, 0)).not.toThrow();
      return;
    }
    await expect(adopted.transport.request("thread/read", {})).resolves.toEqual(
      expect.objectContaining({
        thread: expect.objectContaining({ id: "codex-thread-1" }),
      }),
    );
    expect(adopted.evidence().runnerPid).toBe(runnerPid);
    if (goalMidTurn) {
      const observed = await Promise.race([
        (async () => {
          for await (const notification of adopted!.transport.notifications()) {
            if (notification.method === "item/started") return notification;
          }
          throw new Error("recovered goal item was lost");
        })(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("recovered item timed out")), 5_000)),
      ]);
      expect(observed.params).toMatchObject({ threadId: "codex-thread-1", turnId: "provider-goal-turn-1" });
    }
    expect(duplicateLauncher).not.toHaveBeenCalled();
    expect(adopted.evidence().diagnostics).toContain(
      `adopted runner ${runnerPid} authenticated to its durable PRP authority`,
    );
    expect(adopted.evidence().diagnostics).toContain(
      "restored adopted provider identity from the exact durable checkpoint after PRP event compaction; awaiting live confirmation",
    );
    expect(adopted.evidence().diagnostics).toContain(
      "confirmed adopted provider identity against authenticated recovery session.snapshot",
    );
  } finally {
    await adopted?.transport.close().catch(() => undefined);
    if (runnerPid) {
      try {
        process.kill(-runnerPid, "SIGKILL");
      } catch {
        // The adopted runner normally exits after its durable suspend command.
      }
    }
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
    }
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

it(
  "adopts a live runner on the same durable authority without spawning a duplicate",
  () => verifyLiveRunnerAdoption(false),
  30_000,
);

it(
  "blocks adopted runner artifact drift without duplicate launch, checkpoint replacement, or process signals",
  () => verifyLiveRunnerAdoption(false, true),
  15_000,
);

it(
  "rejects a live runner whose provider identity mismatches the compacted checkpoint",
  () => verifyLiveRunnerAdoption(true),
  30_000,
);

it("binds buffered mid-goal items only after the authenticated recovery snapshot", () => verifyLiveRunnerAdoption(false, false, true), 30_000);

it("surfaces a runner exit while provider-ingress readiness is still pending", async () => {
  const neverReady = new Promise<void>(() => undefined);
  const bundle = createCapabilityRunnerdCodexTransport({
    // The external process launcher owns execution in this test. Point the
    // artifact identity at stable local bytes so the authority still hashes a
    // real file instead of accepting caller-supplied digest metadata.
    runnerBinary: resolve(import.meta.dirname, "../../package.json"),
    runnerProcessLauncher: () => ({
      child: {
        pid: 42,
        exitCode: 1,
        signalCode: null,
        kill: () => true,
      },
      completion: Promise.resolve({
        code: 1,
        signal: null,
        stdout: "",
        stderr: "restored runner could not start",
      }),
    }),
    controlPlaneRegistration: async () => ({
      connection: {
        mode: "listen",
        listenAddress: "0.0.0.0",
        listenPort: 43_127,
        listenPath: "/api/runner/v1/connect/run-ingress-exit",
      },
      ready: () => neverReady,
      startupFailureCode: "runner_ingress_unavailable",
      release: () => undefined,
    }),
  });
  bundle.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [],
  }));
  try {
    await expect(
      bundle.transport.request("thread/start", {
        cwd: tmpdir(),
        dynamicTools: [],
      }),
    ).rejects.toThrow(
      "runner_ingress_unavailable: runnerd exited unexpectedly with code 1: restored runner could not start",
    );
  } finally {
    await bundle.transport.close();
  }
});

it("rejects the notification stream promptly when runnerd exits after accepting a turn", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-exit-stream-"));
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory, "--linger-after-turn-start"),
    stateDirectory,
    closeGraceMs: 400,
  });
  bundle.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [],
  }));
  try {
    await bundle.transport.request("initialize", {});
    await bundle.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: [
        {
          name: "get_task_context",
          description: "Read the active task.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    });
    await bundle.transport.request("turn/start", {
      input: [{ type: "text", text: "Wait for another instruction." }],
    });
    const notifications = bundle.transport
      .notifications()
      [Symbol.asyncIterator]();
    await expectTurnStarted(notifications);
    const runnerPid = bundle.evidence().runnerPid;
    expect(runnerPid).not.toBeNull();
    process.kill(runnerPid!, "SIGKILL");
    await expect(
      Promise.race([
        notifications.next(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("notification stream hung")),
            2_000,
          ),
        ),
      ]),
    ).rejects.toThrow("native_runner_process_exited");
  } finally {
    try {
      await expect(bundle.transport.close()).rejects.toThrow(
        "runner did not durably suspend before checkpoint",
      );
      const runnerState = JSON.parse(
        await readFile(
          join(stateDirectory, "runner", "runner-state.json"),
          "utf8",
        ),
      );
      expect(runnerState.lifecycle).not.toBe("suspended");
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  }
}, 30_000);

it("persists an active provider as settled before bounded suspension", async () => {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "runnerd-active-suspension-"),
  );
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory, "--linger-after-turn-start"),
    stateDirectory,
  });
  bundle.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [],
  }));
  try {
    await bundle.transport.request("initialize", {});
    await bundle.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: [],
    });
    await bundle.transport.request("turn/start", {
      input: [{ type: "text", text: "Wait for another instruction." }],
    });
    const notifications = bundle.transport
      .notifications()
      [Symbol.asyncIterator]();
    await expectTurnStarted(notifications);
    await bundle.transport.close();

    const providerState = JSON.parse(
      await readFile(
        join(stateDirectory, "runner", "codex-provider-state.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(providerState).toMatchObject({
      lifecycle: "prepared",
      activeProviderTurnId: null,
    });
  } finally {
    await bundle.transport.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);
