import {
  bindRunnerLaunchResources,
  createRunnerProviderLaunch,
  runnerLaunchRequirementsDigest,
  type RunnerProviderLaunchRequirements,
} from "./runner-provider-launch.js";
import { coldAdmissionTimeoutMs, waitForRunnerCommand } from "./runnerd-codex-transport.js";
import { configuredEnvironmentProjection } from "../configured-environment.js";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, truncate, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { bindAcpxAgentFiles } from "../drivers/acpx/agent-files-binding.js";
import { resolveRunnerProviderAssetsRoot } from "../drivers/acpx/provider-assets-root.js";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PrpEvent } from "../protocol/replay-contract.js";
import { PRP_PROTOCOL_VERSION } from "../protocol/replay-contract.js";
import { redactCapabilityEvidenceData } from "./evidence-redaction.js";
import { NativeSessionCloseUnrecoverableError } from "../contracts/native-session-backend.js";
import { parsePaperclipQuestionSet } from "../contracts/question-set.js";
import {
  ACPX_CREDENTIAL_BINDING_ENV,
  createAcpxCredentialBinding,
  createAcpxSidecarHostEnvironment,
} from "../drivers/acpx/environment.js";
import { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import * as durableControlPlane from "../control-plane/durable-prp-control-plane.js";
import * as codexCommandRuntime from "../drivers/codex/codex-command.js";
import { composeNativeSystemInstructions, type NativeRuntimeContextSnapshot } from "../contracts/runtime-context.js";
import { CODEX_SKILLLESS_BASE_INSTRUCTIONS, createCodexTaskEnvelope } from "../contracts/codex.js";
import { PRP_BLOCK_TOOL_DESCRIPTION, PRP_COMPLETION_TOOL_DESCRIPTION } from "../contracts/completion-result.js";
import { CodexAppServerDriver, codexSemanticToolSpecs } from "../drivers/codex/codex-app-server-driver.js";
import * as runtimeMaterializer from "../drivers/runtime-context-materializer.js";
import { RUNNERD_CANONICAL_ITEM } from "../drivers/codex/codex-driver-values.js";
import {
  probeNativeRunnerEnvironment,
  NativeEnvironmentProbeCleanupError,
  parseAcpxTurnControlCapabilities,
  authorizedToolSetForProvider,
  createCapabilityRunnerdCodexTransport,
  createCapabilityRunnerdProviderEnvironment,
  createRunnerdCodexAppServerArgs,
  readRunnerdArtifactBinding,
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
  trustedRuntimeReadOnlyRoots,
  unseenRunnerdCommittedEvents,
  unwrapRunnerdProviderNotification,
  unwrapRunnerdProviderNotifications,
  resolveRunnerdCodexSkillInputs,
  withCodexCollaborationRuntimeInstructions,
} from "./runnerd-codex-transport.js";
import {
  defaultCapabilityRunnerdBinary,
  expectTurnStarted,
  fakeCodex,
  fakeCodexArgs,
  assignedRuntimeContext,
} from "../../test/support/runnerd-transport.js";

it("attributes opened candidate sessions to the harness biller instead of the model vendor", () => {
  const provider = runnerdLaunchProfileInternals.openedThreadModelProvider;
  for (const model of ["gpt-5.6-luna[context=272k,reasoning=medium,fast=false]", "claude-sonnet-5"]) {
    expect(provider("acpx", "cursor", model)).toBe("cursor");
    expect(provider("acpx", "copilot", model)).toBe("github");
  }
  expect(provider("acpx", "pi", "openrouter/deepseek/deepseek-v4-flash-0731")).toBe("openrouter");
  expect(provider("acpx", "claude", "claude-sonnet-5")).toBe("anthropic");
  expect(provider("acpx", "codex", "gpt-5.6-sol")).toBe("openai");
  expect(provider("acpx", "antigravity", "gemini-3.8-flash-low")).toBe("google");
  expect(provider("opencode", "codex", "openrouter/openai/gpt-6-astra")).toBe("openrouter");
  expect(provider("claude_managed", "codex", "claude-sonnet-5")).toBe("anthropic");
  expect(provider("aws_agentcore", "codex", "global.anthropic.claude-sonnet-4-6")).toBe("aws");
});

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
        expect(state.lastConnectionProtocolVersion).toBe(PRP_PROTOCOL_VERSION);
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

it.each(["resolved", "rejected"] as const)(
  "retains a live authenticated runner when remote supervision is %s without exit proof",
  async outcome => {
    const directory = await mkdtemp(join(tmpdir(), "runnerd-uncertain-health-"));
    const children: ReturnType<typeof spawn>[] = [];
    const exits: Promise<void>[] = [];
    const probeError = new Error("remote health probe unavailable");
    let failObservation!: () => void;
    const bundle = createCapabilityRunnerdCodexTransport({
      runnerBinary: defaultCapabilityRunnerdBinary(),
      codexCommand: fakeCodex,
      codexArgs: fakeCodexArgs(directory),
      stateDirectory: directory,
      lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
      runnerReconnectGraceMs: 1_000,
      runnerProcessLauncher: spec => {
        const child = spawn(spec.command, [...spec.args], {
          cwd: spec.cwd, env: spec.environment, stdio: "ignore",
        });
        children.push(child);
        exits.push(new Promise(resolveExit => child.once("exit", () => resolveExit())));
        const completion = new Promise<durableControlPlane.RunnerProcessResult>((resolveObservation, rejectObservation) => {
          child.once("error", rejectObservation);
          failObservation = () => {
            if (outcome === "rejected") rejectObservation(probeError);
            else resolveObservation({ code: null, signal: null, stdout: "", stderr: "remote health probe unavailable" });
          };
        });
        return { child, completion, isExitConfirmed: () => false };
      },
    });
    try {
      await bundle.transport.request("thread/start", { cwd: directory });
      const notifications = (async () => {
        for await (const _event of bundle.transport.notifications()) {}
      })();
      const failure = notifications.catch(error => error as Error);
      failObservation();
      const error = await failure;
      expect(error).toMatchObject({ message: expect.stringContaining("runner_process_termination_unconfirmed") });
      if (outcome === "rejected") expect(error).toHaveProperty("cause", probeError);
      expect(children).toHaveLength(1);
      expect(bundle.transport.processInfo()).toMatchObject({ exited: false });
      expect(() => process.kill(children[0]!.pid!, 0)).not.toThrow();
    } finally {
      const providerPid = bundle.evidence().codexPid;
      if (providerPid) {
        try { process.kill(providerPid, "SIGKILL"); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      await bundle.transport.detachControllerForRestart!();
      for (const child of children) child.kill("SIGKILL");
      await Promise.all(exits);
      await rm(directory, { recursive: true, force: true });
    }
  },
  15_000,
);

it.each([
  "transport_reconnect_grace_exceeded",
  "transport reconnect grace exceeded; durable state is preserved",
])("does not restart an exhausted reconnect incident: %s", async detail => {
  const directory = await mkdtemp(join(tmpdir(), "runnerd-exhausted-grace-"));
  const children: ReturnType<typeof spawn>[] = [];
  const exits: Promise<unknown>[] = [];
  const launch = vi.fn((spec: durableControlPlane.RunnerProcessLaunchSpec) => {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd, env: spec.environment, stdio: "ignore",
    });
    children.push(child);
    const completion = new Promise<durableControlPlane.RunnerProcessResult>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", (code, signal) => resolveExit({ code, signal, stdout: "", stderr: detail }));
    });
    exits.push(completion);
    return { child, completion, isExitConfirmed: () => child.exitCode !== null || child.signalCode !== null };
  });
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(), codexCommand: process.execPath,
    codexArgs: [fileURLToPath(new URL("../../test/fixtures/fake-durable-codex-app-server.mjs", import.meta.url)), join(directory, "fake-state.json")], stateDirectory: directory,
    lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
    runnerReconnectGraceMs: 1_000, runnerProcessLauncher: launch,
  });
  try {
    await bundle.transport.request("thread/start", { cwd: directory });
    const failure = (async () => {
      for await (const _event of bundle.transport.notifications()) {}
    })().catch(error => error as Error);
    children[0]!.kill("SIGKILL");
    // The runner's terminal receipt is the exhausted incident authority.
    const result = await Promise.race([failure, new Promise(resolve => setTimeout(() => resolve("still active"), 2_000))]);
    expect(result).toMatchObject({ message: expect.stringContaining("transport_reconnect_grace_exceeded") });
    expect(launch).toHaveBeenCalledTimes(1);
  } finally {
    const providerPid = bundle.evidence().codexPid;
    if (providerPid) { try { process.kill(providerPid, "SIGKILL"); } catch {} }
    await bundle.transport.detachControllerForRestart!();
    for (const child of children) child.kill("SIGKILL");
    await Promise.allSettled(exits);
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

it("preserves the cause when a replacement runner's health cannot be verified", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runnerd-replacement-health-"));
  const probeError = Object.assign(new Error("remote recovery process_verification: probe_timeout"), {
    code: "runner_remote_process_identity_unavailable",
    remoteRunnerRecovery: { stage: "process_verification", reason: "probe_timeout" },
  });
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<void> | undefined;
  const launch = vi.fn((spec: durableControlPlane.RunnerProcessLaunchSpec) => {
    if (child) return {
      child: { pid: 42, exitCode: null, kill: () => false },
      completion: Promise.reject(probeError),
      isExitConfirmed: () => false,
    };
    child = spawn(spec.command, [...spec.args], { cwd: spec.cwd, env: spec.environment, stdio: "ignore" });
    const ownedChild = child;
    exited = new Promise(resolveExit => ownedChild.once("exit", () => resolveExit()));
    return {
      child: ownedChild,
      completion: new Promise<durableControlPlane.RunnerProcessResult>((resolveExit, rejectExit) => {
        ownedChild.once("error", rejectExit);
        ownedChild.once("exit", (code, signal) => resolveExit({ code, signal, stdout: "", stderr: "" }));
      }),
      isExitConfirmed: () => ownedChild.exitCode !== null || ownedChild.signalCode !== null,
    };
  });
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(), codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(directory), stateDirectory: directory,
    lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
    runnerReconnectGraceMs: 1_000, runnerProcessLauncher: launch,
  });
  try {
    await bundle.transport.request("thread/start", { cwd: directory });
    const failed = (async () => {
      for await (const _event of bundle.transport.notifications()) {}
    })().catch(error => error as Error);
    child!.kill("SIGKILL");
    const error = await failed;
    expect(error).toMatchObject({
      message: expect.stringContaining("runner_process_termination_unconfirmed"), cause: probeError,
    });
    expect(error).toHaveProperty("message", expect.stringContaining("probe_timeout"));
    expect(launch).toHaveBeenCalledTimes(2);
    expect(bundle.transport.processInfo()).toMatchObject({ exited: false });
  } finally {
    const providerPid = bundle.evidence().codexPid;
    if (providerPid) {
      try { process.kill(providerPid, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await bundle.transport.detachControllerForRestart!();
    child?.kill("SIGKILL");
    await exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

it("retries a replacement whose staging failed before any process launched", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runnerd-replacement-staging-"));
  const stagingError = new Error("runtime context upload: no space left on device");
  const children: ReturnType<typeof spawn>[] = [];
  const exits: Promise<void>[] = [];
  const launch = vi.fn((spec: durableControlPlane.RunnerProcessLaunchSpec) => {
    // The first replacement fails during staging: nothing was dispatched.
    if (launch.mock.calls.length === 2) return {
      child: { pid: undefined, exitCode: null, kill: () => false },
      completion: Promise.reject(stagingError),
      isExitConfirmed: () => true,
    };
    const child = spawn(spec.command, [...spec.args], { cwd: spec.cwd, env: spec.environment, stdio: "ignore" });
    children.push(child);
    exits.push(new Promise(resolveExit => child.once("exit", () => resolveExit())));
    return {
      child,
      completion: new Promise<durableControlPlane.RunnerProcessResult>((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("exit", (code, signal) => resolveExit({ code, signal, stdout: "", stderr: "" }));
      }),
      isExitConfirmed: () => child.exitCode !== null || child.signalCode !== null,
    };
  });
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(), codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(directory), stateDirectory: directory,
    lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
    runnerReconnectGraceMs: 5_000, runnerProcessLauncher: launch,
  });
  try {
    const opened = await bundle.transport.request("thread/start", { cwd: directory }) as { thread: { id: string } };
    let failure: unknown = null;
    const pump = (async () => {
      for await (const _event of bundle.transport.notifications()) {}
    })().catch(error => { failure = error; });
    children[0]!.kill("SIGKILL");
    // Recovery reports restoration only after the replacement authenticates
    // as the single active connection to the durable PRP authority.
    await vi.waitFor(
      () => expect(bundle.evidence().diagnostics).toContain("runner process restored its durable PRP session"),
      { timeout: 4_000 },
    );
    expect(launch).toHaveBeenCalledTimes(3);
    expect(children).toHaveLength(2);
    expect(bundle.evidence().runnerPid).toBe(children[1]!.pid);
    expect(failure).toBeNull();
    // The restored runner still serves the same provider thread.
    const resumed = await bundle.transport.request("thread/resume", { threadId: opened.thread.id }) as { thread: { id: string } };
    expect(resumed.thread.id).toBe(opened.thread.id);
    expect(failure).toBeNull();
    void pump;
  } finally {
    const providerPid = bundle.evidence().codexPid;
    if (providerPid) { try { process.kill(providerPid, "SIGKILL"); } catch {} }
    await bundle.transport.detachControllerForRestart!();
    for (const child of children) child.kill("SIGKILL");
    await Promise.all(exits);
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

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

it("publishes spawned runner ownership before waiting for provider startup", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runner-spawn-ownership-"));
  let releaseOwnership!: () => void;
  const persisted = new Promise<void>((resolve) => { releaseOwnership = resolve; });
  const onSpawn = vi.fn(async () => persisted);
  const activate = vi.fn();
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory),
    stateDirectory,
    onSpawn,
    controlPlaneRegistration: async (authority) => {
      await authority.start();
      return { activate, release: () => undefined };
    },
  });
  const opening = bundle.transport.request("thread/start", { cwd: tmpdir(), dynamicTools: codexSemanticToolSpecs() });
  try {
    await expect(bundle.transport.request("thread/read", { threadId: "rejected-duplicate" }))
      .rejects.toThrow("PRP provider thread is already started");
    await vi.waitFor(() => expect(onSpawn).toHaveBeenCalledOnce());
    expect(onSpawn).toHaveBeenCalledWith({ pid: expect.any(Number), processGroupId: expect.any(Number), startedAt: expect.any(String) });
    expect(bundle.transport.processInfo?.().pid).toBeGreaterThan(0);
    expect(activate).not.toHaveBeenCalled();
    releaseOwnership();
    await opening;
    expect(activate).toHaveBeenCalledOnce();
    const turnStarted = expectTurnStarted(bundle.transport.notifications()[Symbol.asyncIterator]());
    void turnStarted.catch(() => undefined);
    await bundle.transport.request("turn/start", { input: [{ type: "text", text: "Verify fixture turn delivery." }] });
    await turnStarted;
  } finally {
    releaseOwnership();
    await opening.catch(() => undefined);
    await bundle.transport.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);

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

it("rejects an adoption authorization hook without launch preparation", () => {
  const launch = vi.fn();
  const registration = vi.fn();
  const authorizeRunnerAdoption = vi.fn();
  expect(() => createCapabilityRunnerdCodexTransport({
    stateDirectory: tmpdir(),
    runnerProcessLauncher: launch,
    controlPlaneRegistration: registration,
    authorizeRunnerAdoption,
    adoptExistingRunner: {
      pid: 123, processGroupId: 123, startedAt: null, isAlive: () => true,
    },
  })).toThrow("runner_adoption_authorization_requires_launch_preparation");
  expect(launch).not.toHaveBeenCalled();
  expect(registration).not.toHaveBeenCalled();
  expect(authorizeRunnerAdoption).not.toHaveBeenCalled();
});

it("reads valid control-plane history above 64 MiB and rejects it above 256 MiB", async () => {
  const root = await mkdtemp(join(tmpdir(), "runnerd-large-control-state-"));
  const stateDirectory = join(root, "control-plane");
  const statePath = join(stateDirectory, "control-plane-state.json");
  try {
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        committedEvents: [
          {
            eventType: "history",
            payload: { text: "x".repeat(64 * 1024 * 1024 + 1) },
          },
        ],
      }),
    );
    expect(
      runnerdRecoveryInternals.readControlPlaneState(stateDirectory),
    ).toMatchObject({
      committedEvents: [{ eventType: "history" }],
    });

    await truncate(statePath, 256 * 1024 * 1024 + 1);
    expect(() =>
      runnerdRecoveryInternals.readControlPlaneState(stateDirectory),
    ).toThrow("native_runner_control_plane_state_unsafe");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

it("projects a warm Copilot grant onto the remote runner filesystem", () => {
  const runtimeContext = assignedRuntimeContext("/controller/skills", "/controller/instructions");
  runtimeContext.instructions.workingCopy = { kind: "agent_files", rootPath: "/remote/registered-agent", entryPath: "AGENTS.md" };
  const grant = { runtimeContext, instructions: "Read-only instruction sibling root: /controller/instructions" };
  const projected = runnerdRecoveryInternals.projectCopilotRunGrant(grant, "/remote/session/filesystem");
  expect(projected.runtimeContext?.instructions.bundle.rootPath).toBe("/remote/session/filesystem/context/instructions");
  expect(projected.runtimeContext?.skills[0]?.bundle.rootPath).toBe(`/remote/session/filesystem/context/skills/0-${runtimeContext.skills[0]!.bundle.digest.slice(0, 12)}`);
  expect(projected.runtimeContext?.instructions.workingCopy).toEqual(runtimeContext.instructions.workingCopy);
  expect(projected.runtimeContext?.aggregateDigest).toBe(runtimeContext.aggregateDigest);
  expect(projected.instructions).toBe("Read-only instruction sibling root: /remote/session/filesystem/context/instructions");
  expect(grant.runtimeContext.instructions.bundle.rootPath).toBe("/controller/instructions");
  expect(runnerdRecoveryInternals.projectCopilotRunGrant(grant)).toEqual(grant);
});

it("reopens Copilot with the current registered files after collecting the previous run copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "copilot-current-attachment-"));
  const previousRoot = join(root, "previous-agent");
  const currentRoot = join(root, "current-agent");
  try {
    await mkdir(previousRoot);
    await mkdir(currentRoot);
    await writeFile(join(currentRoot, "AGENTS.md"), "Current instructions.\n");
    const previousContext = assignedRuntimeContext("/skills", "/bundle");
    previousContext.instructions.workingCopy = { kind: "agent_files", rootPath: previousRoot, entryPath: "AGENTS.md" };
    const currentContext = structuredClone(previousContext);
    currentContext.instructions.workingCopy!.rootPath = currentRoot;
    const seed = {
      provider: { kind: "acpx", agent: "copilot", runId: "prior-run", normalizedSessionId: "same-session",
        instructions: "Previous instructions.", runtimeContext: previousContext, commandDigest: "unchanged", model: "selected-model" },
    };
    await rm(previousRoot, { recursive: true });
    const attached = runnerdRecoveryInternals.rotatedRunAttachPayload(
      { runAttachTemplate: seed },
      { runnerInstanceId: "runner", environmentLeaseId: "lease", runId: "current-run", normalizedSessionId: "same-session", turnId: "turn", itemId: "item" },
      null, undefined,
      currentContext, { text: "Current instructions.", context: currentContext },
    );
    const provider = attached.provider as typeof seed.provider;
    const files = bindAcpxAgentFiles(provider.runtimeContext, []);
    expect(files?.root).toBe(await realpath(currentRoot));
    files?.assertHeld();
    expect(provider).toMatchObject({ instructions: "Current instructions.", commandDigest: "unchanged", model: "selected-model", normalizedSessionId: "same-session" });
    expect(seed.provider.runtimeContext).toEqual(previousContext);
    expect(seed.provider.instructions).toBe("Previous instructions.");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("refreshes Cloud instructions on cold rotation without replacing the pinned launch profile", () => {
  const identity = { runnerInstanceId: "runner", environmentLeaseId: "lease", runId: "next-run", normalizedSessionId: "session", turnId: "turn", itemId: "item" };
  const provider = { kind: "cursor_cloud", provider: "cursor_cloud", instructions: "Prior instructions.", command: "/pinned/node", args: ["/pinned/proxy.cjs"], model: "pinned-model", conversationMode: "task" };
  const payload = runnerdRecoveryInternals.rotatedRunAttachPayload({ runAttachTemplate: { provider } }, identity, null, undefined,
    null, { text: "Current instructions.", context: null });
  expect(payload.provider).toEqual({ ...provider, instructions: "Current instructions." });
  expect(provider.instructions).toBe("Prior instructions.");
  expect(runnerdRecoveryInternals.rotatedRunAttachPayload({ runAttachTemplate: { provider } }, identity, null, undefined).provider).toEqual(provider);
});

it.each(["claude", "codex", "cursor", "pi", "copilot"])("keeps %s's pinned grants on same-run recovery", (agent) => {
  const identity = { runnerInstanceId: "runner", environmentLeaseId: "lease", runId: "same-run", normalizedSessionId: "session", turnId: "turn", itemId: "item" };
  const provider = { kind: "acpx", agent, runId: identity.runId, instructions: "Pinned instructions.", runtimeContext: assignedRuntimeContext("/skills", "/pinned") };
  const payload = runnerdRecoveryInternals.rotatedRunAttachPayload({ runAttachTemplate: { provider } }, identity, null, undefined,
    undefined);
  expect(payload.provider).toMatchObject(provider);
});

it.each(["claude", "codex", "cursor", "pi"])("preserves %s's cross-run context when no new grant is supplied", (agent) => {
  const provider = { kind: "acpx", agent, runId: "prior-run", instructions: "Pinned instructions.", runtimeContext: assignedRuntimeContext("/skills", "/pinned") };
  const payload = runnerdRecoveryInternals.rotatedRunAttachPayload({ runAttachTemplate: { provider } },
    { runnerInstanceId: "runner", environmentLeaseId: "lease", runId: "new-run", normalizedSessionId: "session", turnId: "turn", itemId: "item" }, null, undefined,
    undefined);
  expect(payload.provider).toMatchObject({ ...provider, runId: "new-run" });
  });

it("restores ACPX with the current registered copy after the old run copy is collected", async () => {
  const root = await mkdtemp(join(tmpdir(), "runnerd-acpx-context-rotation-"));
  const priorRoot = join(root, "prior-run-copy");
  const currentRoot = join(root, "current-run-copy");
  await Promise.all([mkdir(priorRoot), mkdir(currentRoot)]);
  const context = (rootPath: string) => {
    const value = assignedRuntimeContext(join(root, "skills"), join(rootPath, "bundle"));
    value.instructions.workingCopy = { kind: "agent_files", rootPath, entryPath: "AGENTS.md" };
    return value;
  };
  const prior = context(priorRoot);
  const current = context(currentRoot);
  const customInstructions = `Keep custom instructions intact. A historical path example is ${priorRoot}.`;
  const desired = {
    runnerInstanceId: "runner", environmentLeaseId: "lease", runId: "new-run",
    normalizedSessionId: "same-session", turnId: "new-turn", itemId: "new-item",
  };
  const provider = {
    kind: "acpx", agent: "copilot", runId: "old-run",
    normalizedSessionId: "same-session", commandDigest: "sha256:immutable",
    model: "explicit-model", runtimeContext: prior,
    instructions: composeNativeSystemInstructions(prior, customInstructions),
  };
  const state = {
    runAttachTemplate: { provider, workspace: { cwd: root } },
    commands: [{ type: "turn.start", payload: { text: "must not replay" } }],
  };
  try {
    await rm(priorRoot, { recursive: true });
    expect(() => bindAcpxAgentFiles(prior, [])).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
    const restored = runnerdRecoveryInternals.rotatedRunAttachPayload(
      state, desired, null, undefined, current,
    );
    const restoredProvider = restored.provider as typeof provider;
    expect(restoredProvider).toEqual({
      ...provider, runId: desired.runId, runtimeContext: current,
      instructions: composeNativeSystemInstructions(current, customInstructions),
    });
    expect(restoredProvider.instructions).toContain(customInstructions);
    expect(restoredProvider.instructions).not.toContain(`(AGENT_HOME) is ${priorRoot}.`);
    expect(restoredProvider.instructions).toContain(`(AGENT_HOME) is ${currentRoot}.`);
    expect(bindAcpxAgentFiles(restoredProvider.runtimeContext, [])?.root).toContain("current-run-copy");
    expect(restored).not.toHaveProperty("text");
    expect(state.runAttachTemplate.provider.runtimeContext).toBe(prior);
    // A reopened provider can retain the current grant on another restoration.
    const same = runnerdRecoveryInternals.rotatedRunAttachPayload(
      { runAttachTemplate: restored }, desired, null, undefined, current,
    );
    expect(same).toEqual(restored);
    expect((same.provider as typeof provider).runtimeContext).not.toBe(current);
    // Live warm attachment has no new provider process and must preserve its
    // existing context until settlement, rather than replace its filesystem grant.
    const live = runnerdRecoveryInternals.rotatedRunAttachPayload(
      state, desired, null, undefined,
    );
    expect((live.provider as typeof provider).runtimeContext).toEqual(prior);
    expect((live.provider as typeof provider).instructions).toBe(provider.instructions);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("retargets only composed instruction framing and retains legacy custom instructions", () => {
  const prior = assignedRuntimeContext("/skills", "/old-bundle");
  prior.instructions.workingCopy = { kind: "agent_files", rootPath: "/old-copy", entryPath: "AGENTS.md" };
  const current = assignedRuntimeContext("/skills", "/new-bundle");
  current.instructions.workingCopy = { kind: "agent_files", rootPath: "/new-copy", entryPath: "AGENTS.md" };
  const desired = {
    runnerInstanceId: "runner", environmentLeaseId: "lease", runId: "new-run",
    normalizedSessionId: "same-session", turnId: "turn", itemId: "item",
  };
  const restore = (
    oldContext: NativeRuntimeContextSnapshot,
    nextContext: NativeRuntimeContextSnapshot | null,
    instructions: string,
    currentInstructions?: string,
  ) => (runnerdRecoveryInternals.rotatedRunAttachPayload(
    { runAttachTemplate: { provider: { kind: "acpx", runtimeContext: oldContext, instructions } } },
    desired, null, undefined, nextContext,
    currentInstructions === undefined ? undefined : { text: currentInstructions, context: nextContext },
  ).provider as { instructions: string }).instructions;
  // A quoted complete old asset paragraph is custom text, not a rewrite target.
  const quotedOldBlock = composeNativeSystemInstructions(prior, "").slice(prior.prompt.text.length);
  for (const custom of ["", `Historical example:${quotedOldBlock}\n\nKeep this exact custom ending.`]) {
    expect(restore(prior, current, composeNativeSystemInstructions(prior, custom)))
      .toBe(composeNativeSystemInstructions(current, custom));
    expect(restore(prior, null, composeNativeSystemInstructions(prior, custom)))
      .toBe([prior.prompt.text, custom].filter(Boolean).join("\n\n"));
  }
  const noWorkingCopy = assignedRuntimeContext("/skills", "/plain-bundle");
  expect(restore(noWorkingCopy, current, composeNativeSystemInstructions(noWorkingCopy, "Custom")))
    .toBe(composeNativeSystemInstructions(current, "Custom"));
  expect(restore(prior, noWorkingCopy, composeNativeSystemInstructions(prior, "Custom")))
    .toBe(composeNativeSystemInstructions(noWorkingCopy, "Custom"));
  const opaque = "Legacy custom instructions mention /old-copy; keep every byte.";
  expect(restore(prior, current, opaque)).toBe(opaque);
  const fresh = composeNativeSystemInstructions(current, "Updated registered entry content");
  expect(restore(prior, current, composeNativeSystemInstructions(prior, "Old content"), fresh))
    .toBe(fresh);
  const remote = assignedRuntimeContext("/runner/skills", "/runner/context/instructions");
  remote.instructions.workingCopy = { ...current.instructions.workingCopy, rootPath: "/runner/agent-home" };
  const custom = "Current instructions keep a literal example /new-copy unchanged.";
  const remoteProvider = runnerdRecoveryInternals.rotatedRunAttachPayload(
    { runAttachTemplate: { provider: { kind: "acpx", runtimeContext: prior, instructions: composeNativeSystemInstructions(prior, "Old") } } },
    desired, null, undefined, remote,
    { text: composeNativeSystemInstructions(current, custom), context: current },
  ).provider as { instructions: string; runtimeContext: NativeRuntimeContextSnapshot };
  expect(remoteProvider.instructions).toBe(composeNativeSystemInstructions(remote, custom));
  expect(remoteProvider.runtimeContext).toEqual(remote);

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
  expect(runnerdRecoveryInternals.providerDrainStateFromSnapshot({
    activeProviderTurnId: null, pendingEvents: [], providerExitUnconfirmed: true,
  })).toEqual({ pendingEventCount: 0, activeProviderTurnId: null, providerSettled: false });
});

it.each([
  {},
  { pendingEvents: null },
  { pendingEvents: {}, queuedEvents: [] },
  { pendingEvents: [], queuedEvents: false },
  { pendingEvents: [], activeProviderTurnId: 1 },
  { pendingEvents: [], activeTurnId: "" },
  { pendingEvents: [], ambiguousTurnStartPending: "false" },
  { pendingEvents: [], providerExitUnconfirmed: "false" },
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

it("installs required accounting acceptance before the Runner acknowledgement callback returns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runnerd-required-accounting-"));
  const OriginalCore = durableControlPlane.DurablePrpControlPlane;
  let callbacks!: ConstructorParameters<typeof OriginalCore>[0];
  const spy = vi.spyOn(durableControlPlane, "DurablePrpControlPlane").mockImplementation(function (options) {
    callbacks = options;
    return new OriginalCore(options);
  });
  let release!: () => void;
  const accepted = new Promise<void>(resolve => { release = resolve; });
  const onAccountingEvent = vi.fn(async () => accepted);
  const bundle = createCapabilityRunnerdCodexTransport({ stateDirectory: directory, sourceCodexHome: "", environment: {},
    runnerBinary: process.execPath, runnerArtifact: { version: "test", digest: `sha256:${"a".repeat(64)}` },
    codexCommand: process.execPath, codexArgs: [], onAccountingEvent,
    controlPlaneRegistration: async () => { throw new Error("stop before Runner dispatch"); },
  });
  try {
    await expect(bundle.transport.request("thread/start", { cwd: directory })).rejects.toThrow();
    const report = { eventType: "usage.reported", sourceEventId: "required-usage" } as PrpEvent;
    let returned = false;
    const result = callbacks.onCommittedEvent!(report).then(() => { returned = true; });
    await vi.waitFor(() => expect(onAccountingEvent).toHaveBeenCalledExactlyOnceWith(report));
    expect(returned).toBe(false);
    release();
    await result;
    expect(returned).toBe(true);
    const failure = new Error("receipt unavailable");
    onAccountingEvent.mockRejectedValueOnce(failure);
    await expect(callbacks.onCommittedEvent!(report)).rejects.toBe(failure);
  } finally {
    release();
    await bundle.transport.close().catch(() => undefined);
    spy.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([false, true])("uses the same API result envelope and fences handler publication (owner changed: %s)", async changedOwner => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-recovered-api-"));
  const OriginalCore = durableControlPlane.DurablePrpControlPlane;
  let callbacks!: ConstructorParameters<typeof OriginalCore>[0];
  let core!: DurablePrpControlPlane;
  const coreSpy = vi.spyOn(durableControlPlane, "DurablePrpControlPlane").mockImplementation(function (options) {
    callbacks = options;
    return core = new OriginalCore(options);
  });
  let outcome: { result: unknown; isError?: boolean } | null = {
    result: { ok: true, apiOperationId: "POST /api/example", data: { saved: true } }, isError: false,
  };
  let owner: string | undefined;
  const bundle = createCapabilityRunnerdCodexTransport({
    get authorityRunId() { return owner; },
    runnerBinary: defaultCapabilityRunnerdBinary(), codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory), stateDirectory,
    recoverSemanticToolInput: async () => outcome,
  });
  const handler = vi.fn(async () => ({ success: !outcome?.isError,
    contentItems: [{ type: "inputText" as const, text: JSON.stringify(outcome?.result) }] }));
  if (!changedOwner) bundle.transport.setServerRequestHandler(handler);
  try {
    await bundle.transport.request("thread/start", { cwd: tmpdir() });
    const call = { callId: "recovered-api", operationId: "call_api", input: { operationId: "POST /api/example" },
      sourceEventId: "saved-event", sourceEventType: "semantic_tool.input", correlation: core.store.state.identity };
    if (changedOwner) {
      owner = core.store.state.identity.runId;
      const pending = callbacks.onSemanticToolInput!(call);
      await new Promise<void>(resolveTurn => setImmediate(resolveTurn));
      owner = "replacement-owner";
      bundle.transport.setServerRequestHandler(handler);
      await expect(pending).rejects.toBeInstanceOf(durableControlPlane.SemanticToolNotDispatchedError);
      expect(handler).not.toHaveBeenCalled();
      expect(await callbacks.recoverSemanticToolInput!(call)).toBeNull();
      return;
    }
    const live = await callbacks.onSemanticToolInput!(call);
    expect(live).toMatchObject({ isError: false, result: { ok: true, operationId: "call_api", callId: call.callId, result: outcome!.result } });
    expect(await callbacks.recoverSemanticToolInput!(call)).toMatchObject({ result: live.result, isError: live.isError });
    outcome = { result: { error: "saved failure" }, isError: true };
    const liveError = await callbacks.onSemanticToolInput!(call);
    expect(await callbacks.recoverSemanticToolInput!(call)).toMatchObject({ result: liveError.result, isError: liveError.isError });
    outcome = null;
    expect(await callbacks.recoverSemanticToolInput!(call)).toBeNull();
  } finally {
    await bundle.transport.close();
    coreSpy.mockRestore();
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 20_000);

it.each(["after_budget", "within_budget", "interrupted_within_budget", "persistence_failure"] as const)(
  "fences reusable suspension against late semantic completion (%s)",
  async (mode) => {
    const settles = mode === "within_budget" || mode === "interrupted_within_budget";
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
      // Exercise a real output suffix around the held semantic callback.
      // The default 96/48-frame stress burst spends seconds on unrelated
      // durable text fsyncs before handler entry, consuming this barrier test's
      // wall-clock budget under the full suite. Stress cases retain defaults.
      codexArgs: mode === "interrupted_within_budget"
        ? fakeCodexArgs(stateDirectory, "--emit-tool-call")
        : fakeCodexArgs(
        stateDirectory, "--split-event-burst",
        "--split-event-prefix-count", "2", "--split-event-suffix-count", "2",
      ),
      stateDirectory,
      // Successful cases use the production close budget for the real
      // semantic-result, stop, drain and suspension round trips. Keep the
      // shorter deadline only for intentionally unfinishable callbacks.
      ...(settles ? {} : { closeGraceMs: 5_000 }),
      controlPlaneRegistration: async (authority) => {
        core = authority;
        await authority.start();
        return { checkpoint, release: () => undefined };
      },
    });
    const handler = vi.fn(async () => {
      entered();
      await handlerRelease;
      return { success: true, contentItems: [] };
    });
    bundle.transport.setServerRequestHandler(handler);
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
      if (mode === "interrupted_within_budget") {
        await bundle.transport.request("turn/interrupt", { reason: "test-stop-during-server-write" });
        expect(core.semanticToolResultsSettled()).toBe(false);
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
      expect(handler).toHaveBeenCalledTimes(1);
      if (!settles) {
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
            settles ? "completed" : "pending",
          );
          if (settles) {
            const results = control.committedEvents.filter(
              (event: { eventType: string }) =>
                event.eventType === "semantic_tool.result",
            );
            expect(results).toHaveLength(1);
            expect(results[0].envelope.runId).toBe(control.identity.runId);
          }
        });
      }
      if (settles) {
        expect(closeFailure).toBeNull();
        expect(core.semanticToolResultsSettled()).toBe(true);
        expect(checkpoint).toHaveBeenCalledWith("settled");
      } else {
        expect(closeFailure).toBeInstanceOf(
          NativeSessionCloseUnrecoverableError,
        );
        expect(closeFailure).toHaveProperty("semanticToolsSettled", false);
        expect(closeFailure).toHaveProperty("settlement.semanticTools.pending", expect.arrayContaining([
          expect.objectContaining({ callId: expect.any(String), operationId: expect.any(String),
            sourceEventId: expect.any(String), inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }),
        ]));
        expect(checkpoint).toHaveBeenCalledWith("unsettled");
        expect(checkpoint).not.toHaveBeenCalledWith("settled");
      }
    } finally {
      release();
      await bundle.transport.close().catch(() => undefined);
      await rm(stateDirectory, { recursive: true, force: true });
    }
  },
  25_000,
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

it("does not release a session before asynchronous process containment settles", async () => {
  let finishKill!: () => void;
  const killed = new Promise<void>((resolve) => { finishKill = resolve; });
  const steps: string[] = [];
  const released = runnerdRecoveryInternals.releaseRunnerProcessOwnership({
    runnerSettled: false,
    release: () => { steps.push("route-closed"); },
    checkpoint: () => { steps.push("checkpoint"); },
    forceKill: async () => { steps.push("kill-dispatched"); await killed; steps.push("process-exited"); },
  }).then(() => { steps.push("session-reusable"); });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(steps).toEqual(["route-closed", "checkpoint", "kill-dispatched"]);
  finishKill();
  await released;
  expect(steps).toEqual(["route-closed", "checkpoint", "kill-dispatched", "process-exited", "session-reusable"]);
});

it("refuses session reuse when asynchronous process containment fails", async () => {
  await expect(runnerdRecoveryInternals.releaseRunnerProcessOwnership({
    runnerSettled: true, release: null, checkpoint: null,
    forceKill: async () => { throw new Error("remote process still alive"); },
  })).rejects.toThrow("remote process still alive");
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

it.each([
  { existingCommand: false, rejectLateRead: false },
  { existingCommand: false, rejectLateRead: true },
  { existingCommand: true, rejectLateRead: false },
  { existingCommand: true, rejectLateRead: true },
])("returns unconfirmed suspension at its deadline while a remote state read is still pending ($existingCommand, $rejectLateRead)", async ({ existingCommand, rejectLateRead }) => {
  vi.useFakeTimers();
  const commands: { commandId: string; type: string; status: string }[] = existingCommand
    ? [{ commandId: "exact-suspend", type: "runner.suspend", status: "completed" }]
    : [];
  const readRunnerState = vi.fn(async () => {
    await new Promise<void>(resolveRead => setTimeout(resolveRead, 10_000));
    if (rejectLateRead) throw new Error("remote state unavailable after its own timeout");
    return { lifecycle: "suspended" };
  });
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  const queueSuspend = vi.fn((commandId: string) => commands.push({ commandId, type: "runner.suspend", status: "completed" }));
  const release = vi.fn();
  let settled = false;
  let suspended: boolean | undefined;
  const result = runnerdRecoveryInternals.awaitRunnerSuspensionBarrier({
    commands: () => commands,
    queueSuspend,
    readRunnerState,
    runnerHasExited: async () => true,
    pump: () => undefined,
    deadline: Date.now() + 2_500,
    pollIntervalMs: 0,
  }).then(value => {
    settled = true;
    suspended = value;
    if (value) release();
    return value;
  });
  try {
    await vi.advanceTimersByTimeAsync(2_500);
    expect(readRunnerState).toHaveBeenCalledOnce();
    expect(settled).toBe(true);
    expect(suspended).toBe(false);
    expect(queueSuspend).toHaveBeenCalledTimes(existingCommand ? 0 : 1);
    expect(release).not.toHaveBeenCalled();
  } finally {
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(result).resolves.toBe(false);
      expect(release).not.toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
      vi.useRealTimers();
    }
  }
});

it.each([
  { provider: "acpx" as const, acpxAgent: "pi" as const, closeGraceMs: undefined, drained: true },
  { provider: "codex" as const, acpxAgent: undefined, closeGraceMs: undefined, drained: false },
  { provider: "acpx" as const, acpxAgent: "pi" as const, closeGraceMs: 400, drained: false },
])("keeps Pi stop, remote drain and suspension within a finite close budget ($provider, $closeGraceMs)", async ({ drained, ...options }) => {
  vi.useFakeTimers();
  try {
    const { preparationDeadline, closeDeadline } = runnerdRecoveryInternals.runnerCloseDeadlines(
      Date.now(), runnerdRecoveryInternals.runnerCloseGraceMs(options),
    );
    // Native Pi allows thirty seconds for snapshot cleanup and five seconds
    // for its lifetime fence before the drain acknowledgement round trip.
    const stopMs = options.provider === "acpx" && options.acpxAgent === "pi"
      && options.closeGraceMs === undefined ? 35_200 : 5_200;
    await vi.advanceTimersByTimeAsync(stopMs);
    const commands: { commandId: string; status: string; result?: unknown }[] = [];
    const result = runnerdRecoveryInternals.awaitProviderDrainBarrier({
      readProviderState: () => null,
      semanticResultsSettled: () => true,
      commands: () => commands,
      queueDrain: commandId => {
        const command = { commandId, status: "pending", result: undefined as unknown };
        commands.push(command);
        setTimeout(() => {
          command.status = "completed";
          command.result = { result: { retainedEventsDrained: true } };
        }, 2_800);
      },
      pump: () => undefined,
      deadline: Date.now() + Math.min(5_000, Math.max(0, preparationDeadline - Date.now())),
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await result).toBe(drained);
    expect(closeDeadline - preparationDeadline).toBeLessThanOrEqual(2_500);
    expect(runnerdRecoveryInternals.runnerCloseGraceMs(options)).toBeLessThanOrEqual(45_000);
  } finally { vi.useRealTimers(); }
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

it("includes ACPX terminal tools in the authenticated bridge catalog", () => {
  const tools = [
    {
      name: "get_task_context",
      description: "Read the task context.",
      inputSchema: { type: "object" },
    },
    ...codexSemanticToolSpecs(),
  ];

  expect(authorizedToolSetForProvider("acpx", tools)).toMatchObject({
    operations: [
      { operationId: "get_task_context" },
      { operationId: "paperclip_block" },
      { operationId: "paperclip_finish" },
    ],
  });
  expect(authorizedToolSetForProvider("codex", tools)).toMatchObject({
    operations: [
      { operationId: "get_task_context" },
      { operationId: "paperclip_block" },
      { operationId: "paperclip_finish" },
    ],
  });
});

it.each(["codex", "opencode", "claude_managed", "aws_agentcore", "acpx"] as const)("preserves answer and internal wait descriptions in the serialized native %s tool catalog", (provider) => {
  const catalog = JSON.parse(
    JSON.stringify(authorizedToolSetForProvider(provider, codexSemanticToolSpecs())),
  );
  const finish = catalog.operations.find(
    (operation: { operationId: string }) =>
      operation.operationId === "paperclip_finish",
  );
  const block = catalog.operations.find(
    (operation: { operationId: string }) => operation.operationId === "paperclip_block",
  );
  expect(finish.description).toBe(PRP_COMPLETION_TOOL_DESCRIPTION);
  expect(block.description).toBe(PRP_BLOCK_TOOL_DESCRIPTION);
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

it("defaults runnerd ACPX permissions to authorized Paperclip actions", () => {
  expect(resolveRunnerdAcpxPermissionMode(undefined)).toBe("approve-all");
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

it("requires a remote OpenCode executable before resolving controller dependencies", () => {
  expect(() => runnerdLaunchProfileInternals.resolveRunnerOpenCodeExecutable({
    runnerFilesystemRoot: "/provider-pack",
  })).toThrow("OpenCode executable is missing from the provider pack");
  expect(runnerdLaunchProfileInternals.resolveRunnerOpenCodeExecutable({
    runnerFilesystemRoot: "/provider-pack", opencodeCommand: "/provider-pack/opencode",
  })).toBe("/provider-pack/opencode");
});

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

it("uses the public server npm package as the authority for vendored sidecars", () => {
  expect(runnerdLaunchProfileInternals.acpxProviderPackageAuthority(
    "/clean/node_modules/@paperclipai/server/dist/vendor/paperclip-runner/cli/acpx-runtime-sidecar.cjs",
  )).toEqual({
    root: "/clean/node_modules/@paperclipai/server",
    manifest: "/clean/node_modules/@paperclipai/server/package.json",
  });
});

it.each([false, true])("binds a vendored source server to its pnpm dependency root (self-rooted: %s)", async selfRooted => {
  const workspace = await mkdtemp(join(tmpdir(), "paperclip-vendored-source-"));
  const server = join(workspace, "server");
  await mkdir(join(workspace, "node_modules", ".pnpm"), { recursive: true });
  await mkdir(join(server, "node_modules", ...(selfRooted ? [".pnpm"] : [])), { recursive: true });
  await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "paperclip", private: true }));
  await writeFile(join(workspace, "pnpm-workspace.yaml"), "packages:\n  - server\n");
  await writeFile(join(server, "package.json"), JSON.stringify({ name: "@paperclipai/server" }));
  try {
    expect(runnerdLaunchProfileInternals.acpxProviderPackageAuthority(
      join(server, "dist/vendor/paperclip-runner/cli/acpx-runtime-sidecar.cjs"),
    )).toEqual({ root: selfRooted ? server : workspace, manifest: join(server, "package.json") });
    for (const agent of ["cursor", "copilot", "pi", "kimi", "antigravity"] as const) {
      expect(runnerdLaunchProfileInternals.acpxProviderPackageAuthority(
        join(server, "dist/vendor/paperclip-runner/cli/acpx-runtime-sidecar.cjs"), workspace, agent,
      )).toEqual({ root: server, manifest: join(server, "package.json") });
    }
    for (const agent of ["claude", "codex", "grok"] as const) {
      expect(runnerdLaunchProfileInternals.acpxProviderPackageAuthority(
        join(server, "dist/vendor/paperclip-runner/cli/acpx-runtime-sidecar.cjs"), workspace, agent,
      )).toEqual({ root: selfRooted ? server : workspace, manifest: join(server, "package.json") });
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

it.each((["cursor", "copilot", "pi", "kimi", "antigravity"] as const).flatMap(agent =>
  ["source", "scoped-npm", "deployment"].map(layout => ({ agent, layout }))))(
  "admits the controller-selected $agent package authority in a $layout layout",
  async ({ agent, layout }) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "copilot-package-authority-")));
    const runnerRoot = layout === "source"
      ? join(directory, "packages/paperclip-runner")
      : layout === "scoped-npm"
        ? join(directory, "node_modules/@paperclipai/paperclip-runner")
        : directory;
    await mkdir(join(runnerRoot, "dist/cli"), { recursive: true });
    await writeFile(join(runnerRoot, "package.json"), JSON.stringify({ name: "@paperclipai/paperclip-runner" }));
    try {
      const authority = runnerdLaunchProfileInternals.acpxProviderPackageAuthority(
        join(runnerRoot, "dist/cli/acpx-runtime-sidecar.cjs"), runnerRoot, agent,
      );
      expect(authority).toEqual({ root: runnerRoot, manifest: join(runnerRoot, "package.json") });
      vi.stubEnv("PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT", authority.root);
      vi.stubEnv("PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST", authority.manifest);
      expect(resolveRunnerProviderAssetsRoot("file:///proc/self/fd/18", agent))
        .toBe(join(runnerRoot, `provider-assets/${agent}`));
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

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
        ...configuredEnvironmentProjection({ PAPERCLIP_OPENCODE_PERFORMANCE_DIAGNOSTICS: "1" }),
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://must-not-reach-opencode.invalid",
        OTEL_EXPORTER_OTLP_HEADERS: "Authorization=private",
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
    PAPERCLIP_OPENCODE_PERFORMANCE_DIAGNOSTICS: "1",
  });
  expect(environment.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  expect(environment.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
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
    "allow",
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
  { agent: "cursor" as const, allowed: ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"],
    denied: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] },
  { agent: "copilot" as const, allowed: ["COPILOT_GITHUB_TOKEN"],
    denied: ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] },
  {
    agent: "pi" as const,
    allowed: ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "COPILOT_GITHUB_TOKEN"],
    denied: [
      "CURSOR_API_KEY", "CURSOR_AUTH_TOKEN", "GH_TOKEN", "GITHUB_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_API_KEY",
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
      CURSOR_API_KEY: "cursor-key-canary", CURSOR_AUTH_TOKEN: "cursor-token-canary",
      COPILOT_GITHUB_TOKEN: "copilot-canary", GH_TOKEN: "ambient-gh-canary", GITHUB_TOKEN: "ambient-github-canary",
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
          [ACPX_CREDENTIAL_BINDING_ENV]: "untrusted-caller-marker",
          PAPERCLIP_ACPX_BUILTIN_ROOT: "/attacker/builtin",
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
      PAPERCLIP_ACPX_BUILTIN_ROOT: "/verified/provider-pack/dist/providers",
      PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT: "/verified/provider-pack",
      PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST:
        "/verified/provider-pack/package.json",
    });
    for (const key of allowed)
      expect(environment[key]).toBe(credentialEnvironment[key]);
    for (const key of denied) expect(environment[key]).toBeUndefined();
    if (["cursor", "copilot", "pi"].includes(agent)) {
      expect(JSON.parse(environment[ACPX_CREDENTIAL_BINDING_ENV]!)).toEqual({
        schema: "paperclip.acpx_credential_binding.v1", agent, sessionId: "session-1", names: allowed,
      });
      const sidecar = createAcpxSidecarHostEnvironment(environment, agent, "session-1");
      for (const key of allowed) expect(sidecar[key]).toBe(credentialEnvironment[key]);
    } else expect(environment[ACPX_CREDENTIAL_BINDING_ENV]).toBeUndefined();
    expect(environment.PAPERCLIP_API_KEY).toBeUndefined();
    expect(environment.DATABASE_URL).toBeUndefined();
  },
);

it("does not bind ambient candidate credentials from an inherited or caller-supplied marker", () => {
  const forged = createAcpxCredentialBinding({ CURSOR_API_KEY: "ambient-secret" }, "cursor", "session-1")!;
  vi.stubEnv("CURSOR_API_KEY", "ambient-secret");
  vi.stubEnv(ACPX_CREDENTIAL_BINDING_ENV, forged);
  try {
    for (const explicitEnvironment of [undefined, { [ACPX_CREDENTIAL_BINDING_ENV]: forged }]) {
      const environment = createCapabilityRunnerdProviderEnvironment({
        provider: "acpx", options: { provider: "acpx", acpxAgent: "cursor", environment: explicitEnvironment },
        identity: { runnerInstanceId: "runner-1", environmentLeaseId: "lease-1", runId: "run-1", normalizedSessionId: "session-1", turnId: "turn-1", itemId: "item-1" },
        codexHome: "/isolated/home", runtimeContextPath: "/isolated/context.json", hasRuntimeContext: false,
      });
      expect(environment.CURSOR_API_KEY).toBeUndefined();
      expect(JSON.parse(environment[ACPX_CREDENTIAL_BINDING_ENV]!)).toMatchObject({ names: [] });
      expect(createAcpxSidecarHostEnvironment(environment, "cursor", "session-1").CURSOR_API_KEY).toBeUndefined();
    }
  } finally { vi.unstubAllEnvs(); }
});

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

it("admits Pi runnerd transport without candidate opt-in and keeps pending Copilot gated", async () => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-pi-production-admission-"));
  const { transport } = createCapabilityRunnerdCodexTransport({ provider: "acpx", acpxAgent: "pi", piThinkingLevel: "low", stateDirectory: root });
  try {
    await expect(transport.request("collaborationMode/list", {})).resolves.toMatchObject({ data: [{ mode: "plan" }] });
    for (const acpxAgent of ["copilot"] as const) {
      expect(() => createCapabilityRunnerdCodexTransport({ provider: "acpx", acpxAgent, stateDirectory: root }))
        .toThrow("explicit evaluation opt-in");
    }
  } finally {
    await transport.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("allows trusted package-manager runtime roots without exposing HOME paths", () => {
  expect(
    trustedRuntimeReadOnlyRoots({
      HOME: "/Users/tester",
      PATH: "/Users/tester/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    }),
  ).toEqual(["/opt/homebrew", "/usr/local"]);
});

it("trusts a preconfigured workspace through launch flags without editing the user config", () => {
  const args = createRunnerdCodexAppServerArgs({
    environment: { HOME: "/home/executor", PAPERCLIP_RUNNER_HOME_MODE: "preconfigured" },
    codexHome: "/home/executor/.codex", workingDirectory: "/work/task",
  });
  expect(args.join("\n")).toContain('projects={"/work/task"={trust_level="trusted"}}');
  expect(args.join("\n")).toContain('HOME="/home/executor"');
  expect(args.join("\n")).not.toContain('"/home/executor"="none"');
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
  expect(args).not.toContain("project_doc_max_bytes=0");

  expect(serialized).toContain(
    '"/workspaces/task/.paperclip-runtime/paperclip-runner/sessions/session/filesystem/codex-home"="none"',
  );
  expect(serialized).not.toContain('"/workspaces/task"="none"');
  expect(serialized).not.toContain('"/workspaces/task/.codex"="none"');
  expect(serialized).toContain('\":workspace_roots\"={\".\"=\"write\"}');
});

it.each(["installed", "explicit"] as const)("records the selected %s Codex command before launch", async (selection) => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-codex-command-selection-"));
  const command = join(root, "codex");
  const runnerBinary = join(root, "runnerd");
  await writeFile(command, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  await writeFile(runnerBinary, "unexecuted fixture artifact", { mode: 0o700 });
  const resolver = vi.spyOn(codexCommandRuntime, "resolveCodexCommand").mockReturnValue(command);
  let template: Record<string, unknown> | null = null;
  const launch = vi.fn(() => { throw new Error("A provider process must not start in this fixture"); });
  const { transport } = createCapabilityRunnerdCodexTransport({
    provider: "codex", runnerBinary, stateDirectory: root, sourceCodexHome: "",
    environment: { PATH: "/missing-ambient-codex" },
    ...(selection === "explicit" ? { codexCommand: command } : {}),
    controlPlaneRegistration: async (authority) => {
      template = structuredClone(authority.store.state.runAttachTemplate!);
      throw new Error("fixture_stop_before_runner_launch");
    },
    runnerProcessLauncher: launch,
  });
  try {
    await expect(transport.request("thread/start", { cwd: root, model: "gpt-6.1-sol", dynamicTools: [] }))
      .rejects.toThrow("fixture_stop_before_runner_launch");
    expect(template).toMatchObject({ provider: { command, model: "gpt-6.1-sol" } });
    expect(JSON.stringify(template)).toContain(`${JSON.stringify(command).replaceAll('"', '\\"')}=\\"read\\"`);
    if (selection === "explicit") expect(resolver).not.toHaveBeenCalled();
    else expect(resolver).toHaveBeenCalledExactlyOnceWith(undefined, { PATH: "/missing-ambient-codex" }, root);
    expect(launch).not.toHaveBeenCalled();
  } finally {
    resolver.mockRestore();
    await transport.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["reuse", "large-instructions", "rotated-recovery", "removed-context", "omitted-context", "close-attachment", "timeout-attachment"] as const)("runs an environment-prepared descriptor without Core filesystem preparation (%s)", async mode => {
  const root = await mkdtemp(join(tmpdir(), "runner-environment-launch-"));
  const binary = defaultCapabilityRunnerdBinary();
  const artifact = { version: "0.3.0", digest: `sha256:${createHash("sha256").update(await readFile(binary)).digest("hex")}` };
  const context = assignedRuntimeContext("/controller-only/skill", "/controller-only/instructions");
  const coreInstructions = composeNativeSystemInstructions(context, mode === "large-instructions" ? "x".repeat(200_000) : "Agent instructions");
  const resolved = structuredClone(context);
  resolved.instructions.bundle.rootPath = "/guest/.agents";
  resolved.skills[0]!.bundle.rootPath = "/guest/.agents/skills/assigned";
  const materialize = vi.spyOn(runtimeMaterializer, "prepareIsolatedCodexHome").mockRejectedValue(new Error("unexpected Core materialization"));
  const discover = vi.spyOn(codexCommandRuntime, "resolveCodexCommand").mockImplementation(() => { throw new Error("unexpected Core discovery"); });
  let configuration: Record<string, unknown> | undefined;
  let recovered = false;
  let requestedRun = "";
  let requestedInstructions = "";
  let requestedContext: NativeRuntimeContextSnapshot | null | undefined;
  const registered = new WeakSet<object>();
  let enterPreparation!: () => void;
  let finishPreparation!: () => void;
  const preparationStarted = new Promise<void>(resolve => { enterPreparation = resolve; });
  const preparationGate = new Promise<void>(resolve => { finishPreparation = resolve; });
  const checkpoint = vi.fn();
  const releaseRoute = vi.fn();
  let currentRun = () => "";
  const create = (closeGraceMs?: number, runId = "run-prepared") => createCapabilityRunnerdCodexTransport({ provider: "codex", runnerArtifact: artifact,
    ...(closeGraceMs === undefined ? {} : { closeGraceMs }),
    stateDirectory: root, runtimeContext: runId === "run-prepared" ? context
      : mode === "removed-context" ? null : mode === "omitted-context" ? undefined : context,
    ...(mode === "rotated-recovery" || mode === "removed-context" || mode === "omitted-context" ? {
      readRunnerState: async () => JSON.parse(await readFile(join(root, "runner/runner-state.json"), "utf8")),
      prepareExternalRunnerState: async () => undefined,
      archiveExternalRunnerState: async () => {
        const path = join(root, "runner/runner-state.json");
        const prior = JSON.parse(await readFile(path, "utf8"));
        await rename(path, join(root, "prior-runner-state.json"));
        return prior;
      },
    } : {}),
    prpIdentity: { runnerInstanceId: "runner-prepared", environmentLeaseId: "lease-prepared", runId,
      normalizedSessionId: "session-prepared", turnId: "turn-prepared", itemId: "item-prepared" },
    prepareLaunch: async (requirements, recovery) => {
      requestedRun = requirements.identity.runId;
      requestedInstructions = requirements.instructions;
      requestedContext = requirements.runtimeContext;
      if (requirements.identity.runId === "run-prepared-next" && (mode === "close-attachment" || mode === "timeout-attachment")) {
        enterPreparation();
        await preparationGate;
      }
      if (recovery) { recovered = true; return recovery; }
      return { configurationId: `owned-${requirements.identity.runId}`,
      requirementsDigest: runnerLaunchRequirementsDigest(requirements),
      provider: createRunnerProviderLaunch(requirements.runtimeContext === null ? requirements : bindRunnerLaunchResources(requirements, resolved), {
        options: { codexArgs: fakeCodexArgs(root) }, root, cwd: root, codexHome: "/guest/.codex",
        codexCommand: fakeCodex, providerNodeCommand: process.execPath,
        opencodeProxyPath: "", acpxSidecarPath: "",
      }),
    }; },
    controlPlaneRegistration: async authority => {
      configuration = authority.store.state.runAttachTemplate;
      currentRun = () => authority.store.state.identity.runId;
      if (!registered.has(authority)) {
        await authority.start();
        registered.add(authority);
      }
      return { release: releaseRoute, checkpoint };
    },
    runnerProcessLauncher: spec => {
      const child = spawn(binary, [...spec.args], { env: spec.environment, stdio: "ignore" });
      return { child, completion: new Promise((resolveExit, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolveExit({ code, signal, stdout: "", stderr: "" }));
      }) };
    },
  });
  const { transport } = create();
  try {
    const opened = await transport.request("thread/start", { cwd: "/controller-only/workspace", model: "selected-model",
      baseInstructions: coreInstructions, dynamicTools: codexSemanticToolSpecs() });
    expect(opened.thread).toHaveProperty("id");
    expect(configuration).toMatchObject({ provider: { command: fakeCodex, cwd: root,
      runtimeContext: { instructions: { bundle: { rootPath: "/guest/.agents" } } } } });
    expect(configuration).not.toHaveProperty("preparedLaunch");
    expect(configuration).not.toHaveProperty("launchRequirements");
    expect(JSON.parse(await readFile(join(root, "launch-preparation.json"), "utf8")))
      .toMatchObject({ entries: [{ prepared: { configurationId: "owned-run-prepared" },
        requirements: { instructions: coreInstructions } }] });
    expect(JSON.stringify(configuration?.provider)).not.toContain("/controller-only/");
    expect(materialize).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
    await expect(stat(join(root, "codex-home"))).rejects.toHaveProperty("code", "ENOENT");
    await expect(stat(join(root, "runtime-context.json"))).rejects.toHaveProperty("code", "ENOENT");
    await transport.close();
    if (mode === "removed-context") {
      const rotated = create(undefined, "run-prepared-removed");
      try {
        await expect(rotated.transport.request("thread/read", { threadId: (opened.thread as { id: string }).id }))
          .rejects.toThrow("cannot change the durable Codex provider profile");
        expect(requestedContext).toBeNull();
        expect(requestedInstructions).toContain("Agent instructions");
        expect(requestedInstructions).not.toContain("Read-only instruction sibling root:");
        expect(requestedInstructions).not.toContain("/controller-only/");
        expect(configuration).toHaveProperty("provider.runtimeContext", null);
        const saved = JSON.parse(await readFile(join(root, "launch-preparation.json"), "utf8"));
        expect(saved.entries[0]).toMatchObject({ requirements: { runtimeContext: null },
          prepared: { provider: { runtimeContext: null } } });
      } finally { await rotated.transport.close(); }
      return;
    }
    if (mode === "rotated-recovery" || mode === "omitted-context") {
      for (let attempt = 0; attempt < 2; attempt++) {
        // Close settlement is bounded by the close grace and must prove the
        // provider drain. A recovered successor needs several drain receipts,
        // each a runner round trip, so keep the production close budget here.
        // A shortened budget fails closed on a loaded CI runner.
        const rotated = create(undefined, "run-prepared-rotated");
        try {
          await rotated.transport.request("thread/read", { threadId: (opened.thread as { id: string }).id });
          expect(requestedRun).toBe("run-prepared-rotated");
          expect(requestedContext).toEqual(context);
          expect(requestedInstructions).toBe(coreInstructions);
          expect(recovered).toBe(attempt > 0);
        } finally { await rotated.transport.close(); }
      }
      return;
    }
    const resumed = create(mode === "timeout-attachment" ? 500 : undefined);
    try {
      await resumed.transport.request("thread/read", { threadId: (opened.thread as { id: string }).id });
      expect(recovered).toBe(true);
      checkpoint.mockClear();
      releaseRoute.mockClear();
      const attaching = resumed.transport.attachRun!({
        runId: "run-prepared-next", turnId: "turn-prepared-next", itemId: "item-prepared-next",
      });
      void attaching.catch(() => undefined);
      if (mode === "close-attachment" || mode === "timeout-attachment") {
        await preparationStarted;
        await expect(resumed.transport.attachRun!({
          runId: "overlapping-run", turnId: "overlapping-turn", itemId: "overlapping-item",
        })).rejects.toThrow("native_runner_run_attachment_in_progress");
        let closed = false;
        const closing = resumed.transport.close().finally(() => { closed = true; });
        void closing.catch(() => undefined);
        if (mode === "timeout-attachment") {
          await expect(closing).rejects.toThrow();
          expect(checkpoint).toHaveBeenCalledExactlyOnceWith("unsettled");
          expect((await stat(root)).isDirectory()).toBe(true);
        } else {
          await new Promise(resolve => setTimeout(resolve, 300));
          expect(closed).toBe(false);
          expect(releaseRoute).not.toHaveBeenCalled();
          expect(checkpoint).not.toHaveBeenCalled();
        }
        finishPreparation();
        await expect(attaching).rejects.toThrow(/closed/);
        if (mode === "close-attachment") {
          await closing;
          expect(checkpoint).toHaveBeenCalledExactlyOnceWith("settled");
        }
        expect(currentRun()).toBe("run-prepared");
        return;
      }
      await attaching;
      expect(requestedRun).toBe("run-prepared-next");
      expect(requestedInstructions).toBe(coreInstructions);
      await expect(resumed.transport.attachRun!({
        runId: "run-prepared-changed", turnId: "turn-prepared-changed", itemId: "item-prepared-changed",
        currentRunGrant: { runtimeContext: context, instructions: composeNativeSystemInstructions(context, "Next run instructions") },
      })).rejects.toThrow("cannot change the durable Codex provider profile");
      expect(requestedRun).toBe("run-prepared-changed");
      expect(requestedInstructions).toContain("Next run instructions");
    } finally {
      finishPreparation();
      if (mode === "timeout-attachment") await resumed.transport.close().catch(() => undefined);
      else await resumed.transport.close();
    }
  } finally {
    finishPreparation();
    await transport.close();
    materialize.mockRestore(); discover.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
  // Up to three closes run under the 10s production close budget. Keep a close
  // regression visible as its settlement error, not as a bare test timeout.
}, 60_000);

it("rejects an environment-prepared policy change before registration or process launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-environment-policy-"));
  const registration = vi.fn();
  const launch = vi.fn();
  const { transport } = createCapabilityRunnerdCodexTransport({ provider: "codex", stateDirectory: root,
    runnerArtifact: { version: "fixture", digest: `sha256:${"a".repeat(64)}` },
    runnerProcessLauncher: launch, controlPlaneRegistration: registration,
    prepareLaunch: async requirements => ({ configurationId: "wrong-policy",
      requirementsDigest: runnerLaunchRequirementsDigest(requirements),
      provider: { kind: "codex", model: requirements.model, approvalPolicy: "never", readOnly: false },
    }),
  });
  try {
    await expect(transport.request("thread/start", { model: "selected", approvalPolicy: "on-request", dynamicTools: [] }))
      .rejects.toThrow("runner_prepared_launch_requirements_mismatch");
    expect(registration).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled();
  } finally { await transport.close(); await rm(root, { recursive: true, force: true }); }
});

it("joins delayed environment preparation before close and prevents a late launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-environment-cancel-"));
  let started!: () => void;
  const preparationStarted = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const registration = vi.fn(); const launch = vi.fn();
  const { transport } = createCapabilityRunnerdCodexTransport({ provider: "codex", stateDirectory: root,
    runnerArtifact: { version: "fixture", digest: `sha256:${"a".repeat(64)}` },
    runnerProcessLauncher: launch, controlPlaneRegistration: registration,
    prepareLaunch: async requirements => {
      started(); await released;
      return { configurationId: "cancelled-preparation", requirementsDigest: runnerLaunchRequirementsDigest(requirements),
        provider: createRunnerProviderLaunch(requirements, { options: { codexArgs: [] }, root, cwd: root,
          codexHome: root, providerNodeCommand: "", codexCommand: "/unused/codex", opencodeProxyPath: "", acpxSidecarPath: "" }) };
    },
  });
  const opening = transport.request("thread/start", { model: "selected", dynamicTools: [] });
  void opening.catch(() => undefined);
  let closed = false;
  try {
    await preparationStarted;
    const closing = transport.close().then(() => { closed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(closed).toBe(false);
    release();
    await expect(opening).rejects.toThrow(/closed/);
    await closing;
    expect(registration).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled();
  } finally { release(); await opening.catch(() => undefined); await transport.close(); await rm(root, { recursive: true, force: true }); }
});

it("does not invoke deferred startup preparation after immediate close", async () => {
  const prepare = vi.spyOn(runtimeMaterializer, "prepareIsolatedCodexHome").mockResolvedValue(undefined);
  const registration = vi.fn(async () => ({ connectUrl: "ws://127.0.0.1:1", release: () => undefined }));
  const launch = vi.fn(() => { throw new Error("unexpected launch"); });
  const { transport } = createCapabilityRunnerdCodexTransport({
    runnerBinary: resolve(import.meta.dirname, "../../package.json"), codexCommand: "/unused-fixture-command", sourceCodexHome: "",
    controlPlaneRegistration: registration, runnerProcessLauncher: launch,
  });
  const opening = transport.request("thread/start", { cwd: tmpdir(), dynamicTools: [] });
  void opening.catch(() => undefined);
  try {
    await transport.close();
    await expect(opening).rejects.toThrow(/closed/);
    expect(prepare).not.toHaveBeenCalled();
    expect(registration).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  } finally {
    await opening.catch(() => undefined);
    await transport.close().catch(() => undefined);
    prepare.mockRestore();
  }
});

it("owns blocked Codex home preparation through driver abort without later registration or launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "runnerd-blocked-home-preparation-"));
  const runnerBinary = join(root, "runnerd");
  const command = join(root, "codex");
  await writeFile(runnerBinary, "unexecuted fixture artifact", { mode: 0o700 });
  await writeFile(command, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  let releasePreparation!: () => void;
  const preparationReleased = new Promise<void>(resolve => { releasePreparation = resolve; });
  let markPreparationStarted!: () => void;
  const preparationStarted = new Promise<void>(resolve => { markPreparationStarted = resolve; });
  let closeSettled = false;
  let preparationContinuedAfterClose = false;
  const prepare = vi.spyOn(runtimeMaterializer, "prepareIsolatedCodexHome").mockImplementation(async input => {
    markPreparationStarted();
    await preparationReleased;
    preparationContinuedAfterClose = closeSettled;
    await mkdir(input.codexHome, { mode: 0o700 });
    await writeFile(join(input.codexHome, "preparation-marker"), "fixture preparation drained\n", { mode: 0o600 });
  });
  const registration = vi.fn(async () => ({
    connection: { mode: "connect" as const, connectUrl: "ws://127.0.0.1:1/fixture-never-connected" },
    release: () => undefined,
  }));
  const launch = vi.fn(() => { throw new Error("fixture_stop_before_runner_launch"); });
  const { transport } = createCapabilityRunnerdCodexTransport({
    provider: "codex", runnerBinary, codexCommand: command, stateDirectory: root,
    sourceCodexHome: "", environment: {}, controlPlaneRegistration: registration, runnerProcessLauncher: launch,
  });
  const request = transport.request.bind(transport);
  let bootstrapOperation: Promise<Record<string, unknown>> | undefined;
  const requestSpy = vi.spyOn(transport, "request").mockImplementation((method, params) => {
    const operation = request(method, params);
    if (method === "thread/start") bootstrapOperation = operation;
    return operation;
  });
  const closeTransport = transport.close.bind(transport);
  let closeOperation: Promise<void> | undefined;
  const closeSpy = vi.spyOn(transport, "close").mockImplementation(reason => {
    closeOperation ??= closeTransport(reason).then(() => { closeSettled = true; });
    return closeOperation;
  });
  const controller = new AbortController();
  const cancelled = new Error("fixture Codex bootstrap cancelled");
  const driver = new CodexAppServerDriver({
    taskEnvelope: {
      schema: "paperclip.skillless_task.v1", objective: "Credential-free bootstrap ownership fixture.",
      completionContract: { revision: "blocked-preparation-v1", criteria: [] },
      constraints: [], expectedResultSchema: "paperclip.run_result.v1",
    },
    conversationMode: "direct", environment: {}, transportFactory: () => transport,
  });
  let openingSettled = false;
  const opening = driver.openSession({ runId: "fixture-blocked-home", normalizedSessionId: "fixture-blocked-home", workingDirectory: root, signal: controller.signal })
    .then(value => { openingSettled = true; return { value }; }, error => { openingSettled = true; return { error }; });
  try {
    await preparationStarted;
    await expect(transport.request("thread/start", { cwd: root, dynamicTools: [] }))
      .rejects.toThrow("PRP provider thread is already started");
    controller.abort(cancelled);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect.soft(closeOperation).toBeDefined();
    expect.soft(closeSettled).toBe(false);
    expect.soft(openingSettled).toBe(false);
    releasePreparation();
    const outcome = await opening;
    await closeOperation;
    await bootstrapOperation?.catch(() => undefined);
    expect.soft(preparationContinuedAfterClose).toBe(false);
    expect.soft(registration.mock.calls.length).toBe(0);
    expect.soft(launch.mock.calls.length).toBe(0);
    expect.soft(outcome).toHaveProperty("error");
    expect.soft(outcome).toHaveProperty("error", cancelled);
  } finally {
    releasePreparation();
    await opening;
    await bootstrapOperation?.catch(() => undefined);
    await transport.close().catch(() => undefined);
    requestSpy.mockRestore();
    closeSpy.mockRestore();
    prepare.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects remote Codex without a guest executable before resolving controller dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-runner-remote-codex-command-"));
  const runnerBinary = join(root, "runnerd");
  await writeFile(runnerBinary, "unexecuted fixture artifact", { mode: 0o700 });
  const resolver = vi.spyOn(codexCommandRuntime, "resolveCodexCommand").mockImplementation(() => {
    throw new Error("Controller package resolution must not authorize a guest executable");
  });
  const { transport } = createCapabilityRunnerdCodexTransport({
    provider: "codex", runnerBinary, stateDirectory: root, sourceCodexHome: "",
    runnerFilesystemRoot: "/workspaces/task/.paperclip-runtime/session",
  });
  try {
    await expect(transport.request("thread/start", { cwd: "/workspaces/task", model: "gpt-6.1-sol", dynamicTools: [] }))
      .rejects.toThrow("runner_remote_provider_artifact_incompatible: remote Codex omitted its qualified guest executable");
    expect(resolver).not.toHaveBeenCalled();
  } finally {
    resolver.mockRestore();
    await transport.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["missing", "changed"] as const)("reuses the recorded Codex command when dependency discovery is %s during resume", async (discovery) => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-codex-recorded-command-"));
  const command = join(root, "recorded-codex");
  const replacement = join(root, "replacement-codex");
  const runnerBinary = join(root, "runnerd");
  await writeFile(command, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  await writeFile(runnerBinary, "unexecuted fixture artifact", { mode: 0o700 });
  const priorIdentity = { runnerInstanceId: "runner-command", environmentLeaseId: "lease-command", normalizedSessionId: "session-command",
    runId: "run-prior", turnId: "turn-prior", itemId: "item-prior" };
  const nextIdentity = { ...priorIdentity, runId: "run-next", turnId: "turn-next", itemId: "item-next" };
  const core = new DurablePrpControlPlane({ stateDirectory: join(root, "control-plane"), identity: priorIdentity,
    expectedRunnerVersion: "fixture", expectedRunnerDigest: "sha256:" + createHash("sha256").update(await readFile(runnerBinary)).digest("hex") });
  core.persistRunAttachTemplate({ provider: { kind: "codex", command, args: [], model: "gpt-6.1-sol" }, workspace: { cwd: root } });
  await core.stop();
  await mkdir(join(root, "runner"), { mode: 0o700 });
  await writeFile(join(root, "runner", "runner-state.json"), JSON.stringify({ schema: "paperclip.runner.durable.state.v1", ...priorIdentity, lifecycle: "suspended" }), { mode: 0o600 });
  const resolver = vi.spyOn(codexCommandRuntime, "resolveCodexCommand").mockImplementation(() => {
    if (discovery === "missing") throw new Error("The current dependency is missing");
    return replacement;
  });
  let template: Record<string, unknown> | null = null;
  const launch = vi.fn(() => { throw new Error("A provider process must not start in this fixture"); });
  const { transport } = createCapabilityRunnerdCodexTransport({
    provider: "codex", runnerBinary, stateDirectory: root, sourceCodexHome: "", prpIdentity: nextIdentity,
    environment: { PATH: "/missing-ambient-codex" },
    controlPlaneRegistration: async (authority) => {
      template = structuredClone(authority.store.state.commands.find(command => command.type === "run.attach")?.payload ?? null);
      throw new Error("fixture_stop_before_resumed_runner_launch");
    },
    runnerProcessLauncher: launch,
  });
  try {
    await expect(transport.request("thread/read", { threadId: "provider-prior" }))
      .rejects.toThrow("fixture_stop_before_resumed_runner_launch");
    expect(template).toMatchObject({ provider: { command, model: "gpt-6.1-sol" } });
    expect(JSON.stringify(template)).toContain(`${JSON.stringify(command).replaceAll('"', '\\"')}=\\"read\\"`);
    expect(JSON.stringify(template)).not.toContain(replacement);
    expect(resolver).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  } finally {
    resolver.mockRestore();
    await transport.close();
    await rm(root, { recursive: true, force: true });
  }
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

it("keeps reported context-window occupancy on rehydrated usage", () => {
  const base = { cumulative: { inputTokens: 10 }, runDelta: { inputTokens: 3 }, runDeltaAvailable: true };
  const params = rehydrateRunnerdUsageNotification(
    { ...base, context: { usedTokens: 26672, windowTokens: 258400 } },
    "opened-thread-1",
    "active-turn-1",
  );
  expect(params.tokenUsage).toMatchObject({ context: { usedTokens: 26672, windowTokens: 258400 } });
  for (const context of [undefined, { usedTokens: -1, windowTokens: 10 }, { usedTokens: 1, windowTokens: 0 }]) {
    const rehydrated = rehydrateRunnerdUsageNotification({ ...base, context }, "opened-thread-1", "active-turn-1");
    expect(rehydrated.tokenUsage).not.toHaveProperty("context");
  }
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

it.each(["summary", "detail"])("preserves canonical reasoning %s deltas without publishing assistant text", (channel) => {
  // Exact shape emitted by the Rust ACPX projector, with synthetic private text.
  const payload = { provider: "acpx", itemId: "reason-1", kind: "reasoning", channel,
    providerMethod: "runtime.event", text: "PRIVATE_REASONING_SENTINEL" };
  const method = runnerdCanonicalNotificationMethod("item.delta", payload);
  expect(method).toBe(channel === "detail" ? "item/reasoning/textDelta" : "item/reasoning/summaryTextDelta");
  const params = rehydrateRunnerdDeltaNotification(payload, "provider-thread", "provider-turn");
  expect(params).toMatchObject({ threadId: "provider-thread", turnId: "provider-turn", itemId: "reason-1" });
  const evidence = redactCapabilityEvidenceData("provider_event", { method, params });
  expect(evidence).toEqual({ event: "reasoning_delta" });
  expect(JSON.stringify(evidence)).not.toContain("PRIVATE_REASONING_SENTINEL");
});

it("classifies each coalesced canonical delta without mixing reasoning into assistant output", () => {
  const notifications = expandRunnerdCanonicalNotifications("item/agentMessage/delta", {
    coalescedCount: 3,
    events: [
      { kind: "reasoning", channel: "summary", text: "PRIVATE_REASONING_SENTINEL" },
      { kind: "agentMessage", channel: "progress", text: "Visible progress" },
      { kind: "reasoning", channel: "detail", text: "PRIVATE_DETAIL_SENTINEL" },
    ],
  }, "item.delta");
  expect(notifications.map((entry) => entry.method)).toEqual([
    "item/reasoning/summaryTextDelta", "item/agentMessage/delta", "item/reasoning/textDelta",
  ]);
  expect(notifications.filter((entry) => entry.method === "item/agentMessage/delta").map((entry) => entry.params.text))
    .toEqual(["Visible progress"]);
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

it("keeps canonical ACPX reasoning out of assistant deltas", () => {
  expect(runnerdCanonicalNotificationMethod("item.delta", {
    kind: "reasoning", channel: "summary", text: "Private reasoning",
  })).toBe("item/reasoning/summaryTextDelta");
  expect(runnerdCanonicalNotificationMethod("item.delta", {
    kind: "reasoning", channel: "detail", text: "Private reasoning",
  })).toBe("item/reasoning/textDelta");
  expect(runnerdCanonicalNotificationMethod("item.delta", {
    kind: "agentMessage", text: "Visible answer",
  })).toBe("item/agentMessage/delta");
});

it("preserves reasoning kinds and order inside coalesced canonical deltas", () => {
  const events = [
    { kind: "reasoning", channel: "summary", text: "Private reasoning", itemId: "thought-1" },
    { kind: "agentMessage", text: "Visible answer", itemId: "answer-1" },
    { kind: "reasoning", channel: "detail", text: "Private detail", itemId: "thought-2" },
  ];
  expect(expandRunnerdCanonicalNotifications("item/agentMessage/delta", {
    coalescedCount: events.length, events,
  }, "item.delta")).toEqual([
    { method: "item/reasoning/summaryTextDelta", params: events[0] },
    { method: "item/agentMessage/delta", params: events[1] },
    { method: "item/reasoning/textDelta", params: events[2] },
  ]);
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

it("keeps the Copilot authentication launch requirements free of Codex search policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "runnerd-copilot-probe-policy-"));
  let captured: RunnerProviderLaunchRequirements | undefined;
  const launch = vi.fn(() => { throw new Error("provider process must not start"); });
  try {
    await expect(probeNativeRunnerEnvironment({ runtimeDirectory: root, provider: "acpx", model: "gpt-5.6-luna",
      environment: {}, timeoutMs: 1_000,
      transportOptions: { acpxAgent: "copilot", acpxCandidateProfile: "copilot", disableCodexWebSearch: true,
        runnerArtifact: { version: "offline-fixture", digest: `sha256:${"a".repeat(64)}` },
        runnerProcessLauncher: launch,
        controlPlaneRegistration: async () => { throw new Error("registration must not start"); },
        prepareLaunch: async requirements => {
          captured = requirements;
          throw new Error("offline-stop-at-Copilot-preparation");
        },
      },
    })).rejects.toThrow("offline-stop-at-Copilot-preparation");
    expect(captured).toBeDefined();
    expect(captured?.settings).not.toHaveProperty("disableCodexWebSearch");
    expect(launch).not.toHaveBeenCalled();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(["stuck", "late-release", "late-release-error", "stuck-release", "cooperative-release", "launch-failure", "launch-failure-sandbox", "launch-failure-unsandboxed"] as const)(
  "bounds setup registration teardown and retains unconfirmed state (%s)",
  async mode => {
    const root = await mkdtemp(join(tmpdir(), "runnerd-setup-registration-"));
    const runtimeDirectory = join(root, "native-state");
    await mkdir(runtimeDirectory, { mode: 0o700 });
    const launchFailure = mode.startsWith("launch-failure");
    let template: Record<string, unknown> | null = null;
    let registrationStarted!: () => void;
    const started = new Promise<void>(resolve => { registrationStarted = resolve; });
    let returnRegistration!: (registration: { connection: { mode: "listen"; listenAddress: string; listenPort: number; listenPath: string }; release: () => Promise<void> }) => void;
    const registration = new Promise<Parameters<typeof returnRegistration>[0]>(resolve => { returnRegistration = resolve; });
    let finishRelease!: () => void;
    const releasing = new Promise<void>(resolve => { finishRelease = resolve; });
    const releaseError = new Error("setup registration release failed");
    let releaseFails = mode === "late-release-error";
    const release = vi.fn(async () => {
      if (mode === "stuck-release") await releasing;
      if (releaseFails) throw releaseError;
    });
    const registered = {
      connection: { mode: "listen" as const, listenAddress: "127.0.0.1", listenPort: 43127, listenPath: "/setup-probe" },
      release,
    };
    let registrationSignal: AbortSignal | undefined;
    const cleanup = vi.fn(async () => { await rm(runtimeDirectory, { recursive: true, force: true }); });
    const launch = vi.fn((spec: durableControlPlane.RunnerProcessLaunchSpec) => {
      expect(spec.environment.PAPERCLIP_RUNNER_EXTERNAL_SANDBOX).toBeUndefined();
      throw new Error("owned launcher failed before execution");
    });
    let settled = false;
    vi.useFakeTimers();
    const result = probeNativeRunnerEnvironment({
      runtimeDirectory, provider: "codex", model: "gpt-test", timeoutMs: 1_000,
      environment: { PATH: "", OPENAI_API_KEY: "inert-test-key", PAPERCLIP_RUNNER_EXTERNAL_SANDBOX: "true" },
      transportOptions: {
        ...(mode === "launch-failure-sandbox" ? { externallySandboxed: true } : mode === "launch-failure-unsandboxed" ? { externallySandboxed: false } : {}),
        runnerBinary: resolve(import.meta.dirname, "../../package.json"),
        codexCommand: resolve(import.meta.dirname, "../../package.json"),
        sourceCodexHome: "", runnerProcessLauncher: launch, disableCodexWebSearch: false,
        controlPlaneRegistration: async (_authority, _identity, signal) => {
          template = structuredClone(_authority.store.state.runAttachTemplate!);
          registrationSignal = signal;
          if (mode === "cooperative-release") signal?.addEventListener("abort", () => returnRegistration(registered), { once: true });
          registrationStarted();
          return registration;
        },
      },
      onCleanupConfirmed: cleanup,
    }).then(value => { settled = true; return value; }, (error: unknown) => { settled = true; return error; });
    try {
      await started;
      if (launchFailure) returnRegistration(registered);
      await vi.advanceTimersByTimeAsync(1_000);
      if (mode === "late-release" || mode === "late-release-error" || mode === "stuck-release") returnRegistration(registered);
      await vi.advanceTimersByTimeAsync(10_000);
      if (mode === "late-release" || mode === "cooperative-release" || launchFailure) await result;
      expect(settled).toBe(true);
      expect(registrationSignal?.aborted).toBe(true);
      const failure = await result;
      expect(template).toMatchObject({ provider: { externallySandboxed: mode === "launch-failure-sandbox", readOnly: true, approvalPolicy: "never", collaborationMode: "plan" } });
      const args = (template!.provider as Record<string, unknown>).args as string[];
      expect(args).toContain("project_doc_max_bytes=0");
      expect(args).toContain('web_search="disabled"');
      expect(args.indexOf('web_search="disabled"')).toBeLessThan(args.indexOf("app-server"));
      expect(args[args.indexOf("project_doc_max_bytes=0") - 1]).toBe("-c");
      expect(args.indexOf("project_doc_max_bytes=0")).toBeLessThan(args.indexOf("app-server"));
      expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(args).toContain('permissions.paperclip-runner-workspace-read-only.network.enabled=false');
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(launchFailure ? "owned launcher failed before execution" : "Native provider hello probe timed out.");
      if (mode === "stuck" || mode === "stuck-release" || mode === "late-release-error") {
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).cause).toMatchObject({ message: "Native provider hello probe timed out." });
        expect(cleanup).not.toHaveBeenCalled();
        expect((await stat(runtimeDirectory)).isDirectory()).toBe(true);
        if (mode === "late-release-error") expect((failure as AggregateError).errors).toContain(releaseError);
        returnRegistration(registered);
        finishRelease();
        await vi.advanceTimersByTimeAsync(0);
        expect(release).toHaveBeenCalledOnce();
        expect(failure).toBeInstanceOf(NativeEnvironmentProbeCleanupError);
        if (mode === "late-release-error") {
          await expect((failure as NativeEnvironmentProbeCleanupError).retired).rejects.toBe(releaseError);
          expect(cleanup).not.toHaveBeenCalled();
          expect((await stat(runtimeDirectory)).isDirectory()).toBe(true);
          releaseFails = false;
          await (failure as NativeEnvironmentProbeCleanupError).retryCleanup!();
          expect(release).toHaveBeenCalledTimes(2);
          expect(cleanup).toHaveBeenCalledOnce();
          await expect(stat(runtimeDirectory)).rejects.toThrow();
        } else {
          await (failure as NativeEnvironmentProbeCleanupError).retired;
          expect(cleanup).toHaveBeenCalledOnce();
          await expect(stat(runtimeDirectory)).rejects.toThrow();
        }
      } else {
        expect(release).toHaveBeenCalledOnce();
        if (failure instanceof NativeEnvironmentProbeCleanupError) await failure.retired;
        expect(cleanup).toHaveBeenCalledOnce();
        await expect(stat(runtimeDirectory)).rejects.toThrow();
      }
      expect(launch).toHaveBeenCalledTimes(launchFailure ? 1 : 0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      returnRegistration(registered);
      finishRelease();
      await vi.advanceTimersByTimeAsync(0);
      await result;
      vi.useRealTimers();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("joins owned credential preparation before close returns and never launches after close", async () => {
  const root = await mkdtemp(join(tmpdir(), "runnerd-owned-startup-"));
  const artifact = join(root, "unexecuted-runner-artifact");
  await writeFile(artifact, "fixture artifact bytes; never executed");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const preparation = vi.spyOn(runtimeMaterializer, "prepareIsolatedCodexHome").mockImplementation(async ({ codexHome }) => {
    entered();
    await gate;
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, "owned-write.txt"), "completed owned preparation");
  });
  const registration = vi.fn(async () => ({ connectUrl: "ws://127.0.0.1:1", release: async () => {} }));
  const launch = vi.fn(() => { throw new Error("unexecuted late launch"); });
  const bundle = createCapabilityRunnerdCodexTransport({ stateDirectory: root, runnerBinary: artifact, codexCommand: artifact, provider: "codex", closeGraceMs: 1000,
    controlPlaneRegistration: registration, runnerProcessLauncher: launch });
  let opening: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  try {
    opening = bundle.transport.request("thread/start", { cwd: root, model: "gpt-test", dynamicTools: [] });
    void opening.catch(() => {});
    await started;
    let closeReturned = false;
    closing = bundle.transport.close("owned preparation test");
    void closing.then(() => { closeReturned = true; }, () => {});
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(closeReturned).toBe(false);
    release();
    await expect(opening).rejects.toThrow(/closed/);
    await closing;
    expect(await readFile(join(root, "codex-home", "owned-write.txt"), "utf8")).toBe("completed owned preparation");
    expect(registration).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  } finally {
    release();
    await Promise.allSettled([opening, closing]);
    preparation.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it("retains owned state when credential preparation outlives bounded close", async () => {
  const root = await mkdtemp(join(tmpdir(), "runnerd-retained-startup-"));
  const artifact = join(root, "unexecuted-artifact");
  await writeFile(artifact, "never executed");
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const preparation = vi.spyOn(runtimeMaterializer, "prepareIsolatedCodexHome").mockImplementation(async () => { entered(); await gate; });
  const registration = vi.fn(async () => ({ connectUrl: "ws://127.0.0.1:1", release: async () => {} }));
  const launch = vi.fn(() => { throw new Error("unexpected launch"); });
  const bundle = createCapabilityRunnerdCodexTransport({ stateDirectory: root, runnerBinary: artifact, codexCommand: artifact, provider: "codex", closeGraceMs: 100,
    controlPlaneRegistration: registration, runnerProcessLauncher: launch });
  const opening = bundle.transport.request("thread/start", { cwd: root, model: "gpt-test", dynamicTools: [] });
  void opening.catch(() => {});
  try {
    await started;
    await expect(bundle.transport.close("bounded preparation")).rejects.toThrow("startup cleanup is unconfirmed");
    expect((await stat(root)).isDirectory()).toBe(true);
    release();
    await expect(opening).rejects.toThrow(/closed/);
    expect(registration).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  } finally {
    release(); await opening.catch(() => {}); preparation.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["settled", "late", "late-release-error"] as const)("retires owned startup registration without post-close launch (%s)", async mode => {
  const root = await mkdtemp(join(tmpdir(), "runnerd-startup-registration-"));
  const artifact = join(root, "unexecuted-artifact");
  await writeFile(artifact, "never executed");
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const registered = new Promise<void>(resolve => { entered = resolve; });
  const preparation = vi.spyOn(runtimeMaterializer, "prepareIsolatedCodexHome").mockResolvedValue(undefined);
  const retire = vi.fn(async () => { if (mode === "late-release-error") throw new Error("owned registration release failed"); });
  const registration = vi.fn(async () => { entered(); await gate; return { connectUrl: "ws://127.0.0.1:1", release: retire }; });
  const launch = vi.fn(() => { throw new Error("unexpected launch"); });
  const bundle = createCapabilityRunnerdCodexTransport({ stateDirectory: root, runnerBinary: artifact, codexCommand: artifact, provider: "codex", closeGraceMs: mode === "settled" ? 1000 : 100,
    controlPlaneRegistration: registration, runnerProcessLauncher: launch });
  const opening = bundle.transport.request("thread/start", { cwd: root, model: "gpt-test", dynamicTools: [] });
  void opening.catch(() => {});
  let closing: Promise<void> | undefined;
  try {
    await registered;
    let closeReturned = false;
    closing = bundle.transport.close("owned registration");
    void closing.then(() => { closeReturned = true; }, () => {});
    if (mode === "settled") {
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(closeReturned).toBe(false);
    } else {
      await expect(closing).rejects.toThrow("startup cleanup is unconfirmed");
      expect((await stat(root)).isDirectory()).toBe(true);
    }
    release();
    await expect(opening).rejects.toThrow(mode === "late-release-error" ? "owned registration release failed" : /closed/);
    if (mode === "settled") await closing;
    expect(retire).toHaveBeenCalledTimes(1);
    expect(launch).not.toHaveBeenCalled();
  } finally {
    release(); await Promise.allSettled([opening, closing]); preparation.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it("does not certify probe cleanup while owned credential preparation is unconfirmed", async () => {
  const root = await mkdtemp(join(tmpdir(), "runnerd-probe-owned-preparation-"));
  const artifact = join(root, "unexecuted-artifact");
  await writeFile(artifact, "never executed");
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const preparation = vi.spyOn(runtimeMaterializer, "prepareIsolatedCodexHome").mockImplementation(async () => { entered(); await gate; });
  const cleanup = vi.fn(async () => {});
  const launch = vi.fn(() => { throw new Error("unexpected launch"); });
  const probe = probeNativeRunnerEnvironment({ runtimeDirectory: root, provider: "codex", model: "gpt-test", timeoutMs: 100,
    environment: { OPENAI_API_KEY: "fixture" }, onCleanupConfirmed: cleanup,
    transportOptions: { runnerBinary: artifact, codexCommand: artifact, runnerProcessLauncher: launch,
      controlPlaneRegistration: async () => ({ connectUrl: "ws://127.0.0.1:1", release: async () => {} }) },
  });
  const result = probe.catch(error => error);
  try {
    await started;
    const error = await result;
    expect(cleanup).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.message).toContain("hello probe timed out");
    expect(error.message).toContain("startup cleanup is unconfirmed");
    expect((await stat(root)).isDirectory()).toBe(true);
    release();
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(launch).not.toHaveBeenCalled();
  } finally {
    release(); await result; preparation.mockRestore();
    await new Promise(resolve => setTimeout(resolve, 25));
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

it.each(["admission-only", "admission-only-mismatched-model", "complete", "api-key", "default-model", "mismatched-model", "model-refresh-error", "model-cleanup-error", "missing-model", "missing-runtime", "missing-completion", "late-bootstrap", "remote-complete", "remote-mismatched-model", "late-remote-preparation", "late-remote-release-error"] as const)("native Codex setup requires its daemon/app-server hello (%s)", async mode => {
  const root = await mkdtemp(join(tmpdir(), "runnerd-native-setup-"));
  const runtimeDirectory = join(root, "native-state");
  await mkdir(runtimeDirectory, { mode: 0o700 });
  const calls = join(root, "calls.jsonl");
  const sourceHome = join(root, "bound-account");
  await mkdir(sourceHome, { mode: 0o700 });
  await writeFile(join(sourceHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: mode === "api-key" ? "unrelated-login" : "selected-account" }), { mode: 0o600 });
  if (mode === "api-key") await writeFile(join(sourceHome, "config.toml"), 'model = "ambient-model"\n[mcp_servers.ambient]\ncommand = "untrusted-ambient-command"\n', { mode: 0o600 });
  const remote = mode.startsWith("remote-") || mode.startsWith("late-remote-");
  const remoteRoot = join(root, "assigned-remote-filesystem");
  const remoteFilesystem = join(remoteRoot, "filesystem");
  const remoteWorkspace = join(remoteFilesystem, "workspace");
  let registrationReleased = false;
  let refreshed = false;
  let cleanupConfirmed = false;
  try {
    const probe = probeNativeRunnerEnvironment({
      runtimeDirectory, provider: "codex", model: mode === "default-model" ? null : "gpt-6.1-sol", reasoningEffort: "low",
      ...(mode.startsWith("admission-only") ? { admissionOnly: true } : {}),
      environment: { PATH: process.env.PATH, OPENAI_API_KEY: mode === "api-key" ? "selected-account" : "", HOME: "/unrelated/home" },
      timeoutMs: mode.startsWith("late-remote-") ? 800 : mode === "late-bootstrap" ? 100 : mode === "missing-completion" ? 1_000 : 10_000,
      ...(remote ? { workingDirectory: remoteWorkspace } : {}),
      transportOptions: {
        ...(remote ? {
          runnerFilesystemRoot: remoteFilesystem, runnerStateDirectory: join(remoteRoot, "runner"),
          readRunnerState: async () => JSON.parse(await readFile(join(remoteRoot, "runner", "runner-state.json"), "utf8")),
          controlPlaneRegistration: async authority => {
            await mkdir(remoteWorkspace, { recursive: true, mode: 0o700 });
            const remoteHome = join(remoteFilesystem, "codex-home");
            await mkdir(remoteHome, { mode: 0o700 });
            for (const name of ["auth.json", "config.toml"] as const) await cp(join(runtimeDirectory, "codex-home", name), join(remoteHome, name));
            if (mode.startsWith("late-remote-")) await new Promise(resolve => setTimeout(resolve, 1000));
            await authority.start();
            return { connectUrl: authority.connectUrl, release: async () => { registrationReleased = true; await authority.stop(); if (mode === "late-remote-release-error") throw new Error("PRP registration release failed"); } };
          },
        } : {}),
        runnerBinary: mode === "missing-runtime" ? join(root, "missing-runner") : resolve("runner/target/debug/paperclip-runnerd"),
        codexCommand: fakeCodex, codexArgs: fakeCodexArgs(root, "--request-log", calls,
          ...(mode === "missing-completion" ? ["--hold-turn"] : []),
          ...(mode === "admission-only-mismatched-model" || mode === "mismatched-model" || mode === "remote-mismatched-model" || mode === "model-refresh-error" || mode === "model-cleanup-error" ? ["--returned-model", "another-model"] : []),
          ...(mode === "missing-model" ? ["--returned-model", ""] : []),
          ...(mode === "late-bootstrap" ? ["--thread-start-delay-ms", "1000"] : [])),
        sourceCodexHome: sourceHome,
      },
      onCodexCredentialRefresh: async filename => {
        expect(filename).toBe(join(remote ? remoteFilesystem : runtimeDirectory, "codex-home", "auth.json"));
        expect(JSON.parse(await readFile(filename, "utf8"))).toEqual({ OPENAI_API_KEY: "selected-account" });
        if (mode === "api-key") {
          const config = await readFile(join(runtimeDirectory, "codex-home", "config.toml"), "utf8");
          expect(config).not.toContain("ambient-model"); expect(config).not.toContain("untrusted-ambient-command");
          expect((await stat(filename)).mode & 0o777).toBe(0o600);
        }
        refreshed = true;
        if (mode === "model-refresh-error") throw new Error("credential refresh failed after the native model error");
      },
      onCleanupConfirmed: async () => {
        cleanupConfirmed = true;
        expect(refreshed || mode === "missing-runtime" || mode === "late-bootstrap" || mode.startsWith("late-remote-")).toBe(true);
        if (mode === "model-cleanup-error") throw new Error("owned temporary state cleanup failed");
        await rm(runtimeDirectory, { recursive: true, force: true });
      },
    });
    if (mode === "admission-only" || mode === "complete" || mode === "api-key" || mode === "default-model" || mode === "remote-complete") {
      const observedModel = mode === "default-model" ? "gpt-test" : "gpt-6.1-sol";
      await expect(probe).resolves.toEqual({ provider: "codex", providerDriver: "codex_app_server", effectiveModel: observedModel, ...(mode === "admission-only" ? { helloProbePassed: false, admissionOnly: true, sessionAdmissionPassed: true } : { helloProbePassed: true }) });
      expect(refreshed).toBe(true);
      if (remote) expect(registrationReleased).toBe(true);
      expect(cleanupConfirmed).toBe(true);
      await expect(stat(runtimeDirectory)).rejects.toThrow();
      const requests = (await readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(requests.find(value => value.method === "thread/start").params).toMatchObject({ ...(remote ? { cwd: remoteWorkspace } : {}), permissions: "paperclip-runner-workspace-read-only", dynamicTools: [] });
      if (mode === "admission-only") expect(requests.some(value => value.method === "turn/start")).toBe(false);
      else expect(requests.find(value => value.method === "turn/start").params).toMatchObject({ effort: "low", permissions: "paperclip-runner-workspace-read-only" });
    } else {
      await expect(probe).rejects.toThrow(mode === "missing-runtime" ? /ENOENT|unavailable|cleanup/i : mode === "admission-only-mismatched-model" || mode === "mismatched-model" || mode === "remote-mismatched-model" || mode === "model-refresh-error" || mode === "model-cleanup-error" || mode === "missing-model" ? /observed model|mismatched provider model/i : /timed out|cleanup|suspension/i);
      if (mode === "late-remote-release-error") {
        await vi.waitFor(() => expect(registrationReleased).toBe(true)); expect(cleanupConfirmed).toBe(false);
        expect((await stat(runtimeDirectory)).isDirectory()).toBe(true);
      }
      if (mode === "model-refresh-error") {
        expect(refreshed).toBe(true);
        expect(cleanupConfirmed).toBe(false);
        expect((await stat(runtimeDirectory)).isDirectory()).toBe(true);
      }
      if (mode === "model-cleanup-error") {
        expect(cleanupConfirmed).toBe(true);
        expect((await stat(runtimeDirectory)).isDirectory()).toBe(true);
      }
      if (mode === "admission-only-mismatched-model" || mode === "mismatched-model" || mode === "remote-mismatched-model" || mode === "missing-model") {
        expect(cleanupConfirmed).toBe(true);
        await expect(stat(runtimeDirectory)).rejects.toThrow();
      }
      if (mode === "admission-only-mismatched-model" || mode === "mismatched-model" || mode === "remote-mismatched-model" || mode === "model-refresh-error" || mode === "model-cleanup-error" || mode === "missing-model" || mode === "late-bootstrap" || mode.startsWith("late-remote-")) {
        const requests = (await readFile(calls, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
        expect(requests.some(value => value.method === "turn/start")).toBe(false);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 20_000);

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
    // A terminal notification alone does not prove that the question reached
    // durable storage or that its answer and provider suffix settled.
    await bundle.transport.close();
    const runnerState = JSON.parse(await readFile(
      join(stateDirectory, "runner", "runner-state.json"), "utf8",
    ));
    expect(runnerState.lifecycle).toBe("suspended");
    const controlState = JSON.parse(await readFile(
      join(stateDirectory, "control-plane", "control-plane-state.json"), "utf8",
    )) as {
      committedEvents: Array<{ eventType: string; envelope: { payload: { payload: { request?: { input: unknown } } } } }>;
      commands: Array<{ type: string; status: string }>;
    };
    const created = controlState.committedEvents.filter(event => event.eventType === "runtime_request.created");
    expect(created).toHaveLength(1);
    const input = parsePaperclipQuestionSet(created[0]!.envelope.payload.payload.request!.input);
    expect(input.questions[0]!.options![0]!.description).toBe("Deploy safely.");
    expect(input.questions[1]!.options![0]).not.toHaveProperty("description");
    expect(controlState.commands.filter(command => command.type === "request.resolve"))
      .toEqual([expect.objectContaining({ status: "completed" })]);
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
    // Qualification builds a debug daemon for this exact source. Its selected
    // binary must win over any separately staged product/runtime artifact.
    runnerBinary: process.env.PAPERCLIP_STOCK_PREFLIGHT_RUNNERD ?? defaultCapabilityRunnerdBinary(),
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
      developerInstructions: withCodexCollaborationRuntimeInstructions(
        CODEX_SKILLLESS_BASE_INSTRUCTIONS,
      ),
    },
  });
  expect(
    (decodedFrames.find((frame) => frame.method === "thread/start")?.params as Record<string, unknown>),
  ).not.toHaveProperty("baseInstructions");
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

it("cancels startup readiness before releasing the route that settles its ready callback", async () => {
  const root = await mkdtemp(join(tmpdir(), "runnerd-ready-release-cycle-"));
  let releaseReady!: () => void;
  const readyReleased = new Promise<void>(resolve => { releaseReady = resolve; });
  let markReadyStarted!: () => void;
  const readyStarted = new Promise<void>(resolve => { markReadyStarted = resolve; });
  const release = vi.fn(async () => { releaseReady(); });
  let core!: DurablePrpControlPlane;
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(), codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(root), stateDirectory: root, sourceCodexHome: "", environment: {}, closeGraceMs: 2_000,
    controlPlaneRegistration: async authority => {
      core = authority;
      await authority.start();
      return { ready: () => { markReadyStarted(); return readyReleased; }, release };
    },
  });
  const opening = bundle.transport.request("thread/start", { cwd: root, dynamicTools: [] });
  void opening.catch(() => undefined);
  try {
    await readyStarted;
    await vi.waitFor(() => expect(core.store.state.commands.find(command => command.type === "session.open")?.status).toBe("completed"));
    await expect(bundle.transport.close("cancel pending ingress authentication")).resolves.toBeUndefined();
    await expect(opening).rejects.toThrow(/closed/);
    expect(release).toHaveBeenCalledOnce();
    expect(bundle.evidence().runnerExited).toBe(true);
    expect(bundle.evidence().diagnostics.join("\n")).not.toContain("startup cleanup is unconfirmed");
  } finally {
    releaseReady();
    await opening.catch(() => undefined);
    await bundle.transport.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

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
  const diagnostics: string[] = [];
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory, "--linger-after-turn-start"),
    stateDirectory,
    closeGraceMs: 400,
    onDiagnostic: (message) => diagnostics.push(message),
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
      const settlement = diagnostics.find((message) => message.startsWith("native_session_settlement_incomplete "));
      expect(settlement).toBeDefined();
      expect(JSON.parse(settlement!.slice("native_session_settlement_incomplete ".length))).toMatchObject({
        runnerSuspended: false,
        suspensionState: { commandStatus: "pending", runnerIdentityMatches: true },
      });
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  }
}, 30_000);

it.each(["claude", "codex"] as const)("keeps the explicitly assigned gateway in the %s runner environment", (agent) => {
  const gateway = {
    PAPERCLIP_NATIVE_MCP_NAME: "paperclip-assigned",
    PAPERCLIP_NATIVE_MCP_URL: "http://127.0.0.1:3100/mcp/gateway",
    PAPERCLIP_NATIVE_MCP_TOKEN: "fixture-scoped-gateway-token-1234567890",
  };
  const environment = createCapabilityRunnerdProviderEnvironment({
    provider: "acpx",
    options: { provider: "acpx", acpxAgent: agent, environment: {
      PATH: "/bin", ...gateway, PAPERCLIP_API_KEY: "must-not-cross", DATABASE_URL: "must-not-cross",
    } },
    identity: { runnerInstanceId: "runner-1", environmentLeaseId: "lease-1", runId: "run-1",
      normalizedSessionId: "session-1", turnId: "turn-1", itemId: "item-1" },
    codexHome: "/isolated/home", runtimeContextPath: "/isolated/context.json", hasRuntimeContext: true,
    acpxSidecarPath: "/verified/provider-pack/dist/cli/acpx-runtime-sidecar.cjs",
  });
  expect(environment).toMatchObject(gateway);
  expect(environment.PAPERCLIP_API_KEY).toBeUndefined();
  expect(environment.DATABASE_URL).toBeUndefined();
});

it("resolves explicit skills to the remote provider home and rejects unassigned paths", () => {
  const context = assignedRuntimeContext("/controller/bundle", "/controller/instructions");
  const skill = { type: "skill", name: "assigned", path: "/controller/bundle/SKILL.md" };
  expect(resolveRunnerdCodexSkillInputs([skill], context, "/runner/codex-home")).toEqual([
    { type: "skill", name: "assigned", path: "/runner/codex-home/skills/assigned/SKILL.md" },
  ]);
  expect(resolveRunnerdCodexSkillInputs([], context, "/runner/codex-home")).toEqual([]);
  for (const inputs of [[{ ...skill, path: "/arbitrary/SKILL.md" }], [{ ...skill, name: "other" }], [skill, skill]]) {
    expect(() => resolveRunnerdCodexSkillInputs(inputs, context, "/runner/codex-home")).toThrow("unique assigned runtime skill");
  }
  expect(() => resolveRunnerdCodexSkillInputs([skill], null, "/runner/codex-home")).toThrow("assigned runtime skill");
});

it("admits only exact live Pi turn controls", () => {
  expect(parseAcpxTurnControlCapabilities(undefined, "pi")).toEqual({ steering: false, queuedFollowUp: false });
  expect(parseAcpxTurnControlCapabilities({ steering: true, queuedFollowUp: true }, "pi")).toEqual({ steering: true, queuedFollowUp: true });
  for (const value of [null, [], {}, { steering: 1, queuedFollowUp: false }, { steering: true, queuedFollowUp: "true" }, { steering: true, queuedFollowUp: true, arbitrary: true }]) {
    expect(() => parseAcpxTurnControlCapabilities(value, "pi")).toThrow("malformed");
  }
  for (const agent of ["cursor", "copilot", "codex", "claude", undefined]) {
    expect(() => parseAcpxTurnControlCapabilities({ steering: true, queuedFollowUp: false }, agent)).toThrow("cannot advertise");
  }
});

async function withPreparedOpenCodeCleanup(input: {
  run: () => Promise<void>;
  closeSession: () => Promise<void>;
  closeTransport: () => Promise<void>;
  removeRoot: () => Promise<void>;
  evidence: () => Pick<
    ReturnType<ReturnType<typeof createCapabilityRunnerdCodexTransport>["evidence"]>,
    "runnerPid" | "runnerExited" | "runnerExitCode" | "runnerSignal" | "diagnostics"
  >;
}): Promise<void> {
  const failures: { stage: string; error: unknown }[] = [];
  for (const [stage, operation] of [
    ["run", input.run],
    ["session.close", input.closeSession],
    ["transport.close", input.closeTransport],
    ["removeRoot", input.removeRoot],
  ] as const) {
    try {
      await operation();
    } catch (error) {
      failures.push({ stage, error });
    }
  }
  if (failures.length === 0) return;
  const evidence = input.evidence();
  // Never dump stderr, environment values, prompts, paths, or arbitrary
  // diagnostic text. Keep only bounded process/settlement facts alongside
  // the original errors, so a finally failure cannot hide the primary one.
  const summary = {
    failedStages: failures.map(({ stage }) => stage),
    runnerStarted: evidence.runnerPid !== null,
    runnerExited: evidence.runnerExited,
    runnerExitCode: evidence.runnerExitCode,
    runnerSignalled: evidence.runnerSignal !== null,
    diagnosticCount: evidence.diagnostics.length,
    suspensionRejected: evidence.diagnostics.includes(
      "runner did not prove durable suspension before checkpoint",
    ),
  };
  throw new AggregateError(
    failures.map(({ error }) => error),
    `Prepared OpenCode fixture failed: ${JSON.stringify(summary)}`,
    { cause: failures[0]!.error },
  );
}

it.each([true, false])("preserves prepared OpenCode cleanup errors (primary failure: %s)", async (failRun) => {
  const primary = new Error("prepared input assertion failed");
  const cleanup = new NativeSessionCloseUnrecoverableError();
  const calls: string[] = [];
  const evidence = {
    runnerPid: 123,
    runnerExited: true,
    runnerExitCode: 1,
    runnerSignal: null,
    diagnostics: ["Bearer fixture-secret", "runner did not prove durable suspension before checkpoint"],
  };
  const failure = await withPreparedOpenCodeCleanup({
    run: async () => { calls.push("run"); if (failRun) throw primary; },
    closeSession: async () => { calls.push("session.close"); throw cleanup; },
    closeTransport: async () => { calls.push("transport.close"); },
    removeRoot: async () => { calls.push("removeRoot"); },
    evidence: () => evidence,
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual(failRun ? [primary, cleanup] : [cleanup]);
  expect((failure as AggregateError).cause).toBe(failRun ? primary : cleanup);
  expect(calls).toEqual(["run", "session.close", "transport.close", "removeRoot"]);
  expect((failure as Error).message).toContain('"suspensionRejected":true');
  expect((failure as Error).message).not.toContain("fixture-secret");
});

it.each([
  { model: "openrouter/deepseek/deepseek-v4-flash-0731", supportsReasoning: true, adoptAfterTurn: false },
  { model: "openrouter/deepseek/deepseek-v4-flash-0731", supportsReasoning: true, adoptAfterTurn: true },
  { model: "anthropic/claude-sonnet-4", supportsReasoning: false, adoptAfterTurn: false },
])("preserves prepared input and completion feedback through runnerd and the real OpenCode proxy boundary ($model, live adoption: $adoptAfterTurn)", async ({ model, supportsReasoning, adoptAfterTurn }) => {
  const root = await mkdtemp(join(tmpdir(), "runnerd-prepared-opencode-"));
  // GitHub-hosted Linux toolcache Node can be group-writable, unlike the AWS
  // fleet. Qualify an owned copy with strict permissions, never chmod the host
  // runtime or weaken the launch boundary. Keep macOS's native runtime path
  // because its signing and dylib lookup can depend on that location.
  const providerNode = process.platform === "linux" ? join(root, "node") : process.execPath;
  if (process.platform === "linux") {
    await cp(process.execPath, providerNode, { dereference: true });
    await chmod(providerNode, 0o500);
  }
  // The qualified launch boundary unlinks its executable after exec. Use a
  // native wrapper, like the real OpenCode binary; a shebang script would need
  // to reopen the now-unlinked path in its interpreter.
  const executable = join(root, "fake-opencode");
  const fixture = resolve("test/fixtures/fake-opencode-server.mjs");
  execFileSync("cc", ["-x", "c", "-o", executable, "-"], {
    input: `#include <unistd.h>\n#include <stdlib.h>\nint main(int argc, char **argv) { char **args = calloc(argc + 2, sizeof(char *)); args[0] = ${JSON.stringify(providerNode)}; args[1] = ${JSON.stringify(fixture)}; for (int i = 1; i < argc; i++) args[i + 1] = argv[i]; execv(args[0], args); return 127; }`,
  });
  // CI may use umask 0002; qualified executables cannot be group-writable.
  await chmod(executable, 0o755);
  // Use the production bundler without depending on (or mutating) shared dist
  // artifacts. The Vitest CI lane builds Rust but does not build TypeScript.
  const proxy = join(root, "opencode-app-server-proxy.cjs");
  const proxyBytes = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { bundleVerifiedProviderEntrypoints } from "./scripts/build-verified-provider-entrypoints.mjs";
    const entries = await bundleVerifiedProviderEntrypoints({ write: false });
    const proxy = entries.find(({ entrypoint }) => entrypoint.name === "opencode-app-server-proxy");
    process.stdout.write(proxy.verifiedResult.outputFiles[0].contents);
  `], { maxBuffer: 16 * 1024 * 1024 });
  await writeFile(proxy, proxyBytes, { mode: 0o755 });
  const digest = (file: string) => `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
  const runtime = join(root, "opencode");
  const server = createServer();
  let authority: DurablePrpControlPlane | null = null;
  server.on("upgrade", (request, socket, head) => {
    if (authority) authority.handleUpgrade(request, socket, "/runner", head);
    else socket.destroy();
  });
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected OpenCode adoption listener");
  const registration = async (next: DurablePrpControlPlane) => {
    authority = next;
    return {
      connectUrl: `ws://127.0.0.1:${address.port}/runner`,
      release: async () => { if (authority === next) authority = null; },
    };
  };
  const identity = {
    runnerInstanceId: "runner-opencode-adopt", environmentLeaseId: "lease-opencode-adopt",
    runId: "prepared-opencode", normalizedSessionId: "prepared-opencode",
    turnId: "turn-opencode-adopt", itemId: "item-opencode-adopt",
  };
  const bundle = createCapabilityRunnerdCodexTransport({
    prpIdentity: identity,
    controlPlaneRegistration: registration,
    provider: "opencode",
    runnerBinary: defaultCapabilityRunnerdBinary(),
    stateDirectory: join(root, "runner-state"),
    opencodeRuntimeDirectory: runtime,
    opencodeCommand: executable,
    opencodeCommandSha256: digest(executable),
    opencodeProxyPath: proxy,
    opencodeProxySha256: digest(proxy),
    providerNodeCommand: providerNode,
    providerNodeCommandSha256: digest(providerNode),
    environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "fixture-key",
      ...(supportsReasoning ? configuredEnvironmentProjection({ PAPERCLIP_OPENCODE_PERFORMANCE_DIAGNOSTICS: "1" }) : {}),
    },
  });
  const task = createCodexTaskEnvelope({
    objective: "Preserve the prepared task.", contractRevision: "prepared-v1",
    criteria: [{ id: "objective", requirement: "Keep this request unchanged." }],
  });
  let completionCalls = 0;
  const feedback = "Include [Saved document](/PAP/issues/PAP-1#document-plan) in your final response.";
  const driver = new CodexAppServerDriver({
    taskEnvelope: task,
    conversationMode: "prepared",
    model,
    transportFactory: () => bundle.transport,
    workingDirectoryAuthority: "remote_runner",
    environment: { PAPERCLIP_WORKSPACE_CWD: root },
    completionFeedback: async () => {
      completionCalls += 1;
      if (completionCalls === 1) throw new Error("Keep the task's required document link in the final response.");
      return feedback;
    },
  });
  let session: Awaited<ReturnType<typeof driver.openSession>> | undefined;
  let adopted: ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined;
  let survivingPid: number | null = null;
  const prepared = JSON.stringify({
    schema: "paperclip.native-model-envelope.v3",
    task: { prompt: "Keep this completion-feedback request unchanged." },
    completionContract: { revision: "prepared-v1", criteria: task.completionContract.criteria },
  });
  await withPreparedOpenCodeCleanup({
    run: async () => {
      session = await driver.openSession({ runId: "prepared-opencode", normalizedSessionId: "prepared-opencode", workingDirectory: root });
      expect(bundle.transport.supportsTurnReasoning?.()).toBe(supportsReasoning);
      const firstTurn = { message: { role: "user" as const, text: prepared } };
      if (!supportsReasoning) {
        await expect(session.startTurn({ ...firstTurn, reasoningMode: "disabled" }))
          .rejects.toThrow("Per-turn reasoning is not supported");
        await expect(bundle.transport.request("turn/start", { input: [{ type: "text", text: prepared }], reasoningMode: "disabled" }))
          .rejects.toThrow("requires an OpenCode/OpenRouter model");
      }
      await session.startTurn({ ...firstTurn, ...(supportsReasoning ? { reasoningMode: "disabled" as const } : {}) });
      const events: PrpEvent[] = [];
      for await (const event of session.events()) {
        events.push(event);
        if (event.eventType === "turn.completed") break;
      }
      expect(events.find(event => event.eventType === "session.started")?.payload.context).toMatchObject({ model });
      expect(completionCalls).toBe(2);
      expect(events.filter(event => event.eventType === "run.result.proposed")).toHaveLength(1);
      const performance = events.filter(event => event.eventType === "harness.diagnostic" && event.payload.code === "provider_performance_spans");
      expect(performance).toHaveLength(supportsReasoning ? 1 : 0);
      if (supportsReasoning) {
        expect(performance[0].payload.spans).toEqual([{
          name: "provider.model.stream", startedAtMs: expect.any(Number), endedAtMs: expect.any(Number), outcome: "ok",
        }]);
        expect(JSON.stringify(performance)).not.toContain("private-performance-sentinel");
      }
      const sessionRoots = (await readdir(runtime, { withFileTypes: true })).filter((entry) => entry.isDirectory());
      expect(sessionRoots).toHaveLength(1);
      const requests = (await readFile(join(runtime, sessionRoots[0]!.name, "data/fake-prompt-requests.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(requests.map((request) => request.parts)).toEqual([[{ type: "text", text: prepared }]]);
      expect(requests[0].variant).toBe(supportsReasoning ? "paperclip-no-reasoning" : undefined);
      const outcomes = JSON.parse(await readFile(join(runtime, sessionRoots[0]!.name, "data/fake-completion-feedback.json"), "utf8"));
      expect(outcomes).toHaveLength(2);
      expect(outcomes[0].result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("required document link") }] });
      expect(outcomes[1].result).toMatchObject({ content: [{ text: expect.stringContaining(feedback) }] });
      if (adoptAfterTurn) {
        const snapshot = await session.snapshot();
        const runnerStartedAt = bundle.transport.processInfo().startedAt;
        survivingPid = bundle.evidence().runnerPid;
        expect(survivingPid).toEqual(expect.any(Number));
        const artifact = readRunnerdArtifactBinding(defaultCapabilityRunnerdBinary());
        await bundle.detachControllerForRestart();
        // These controller launch assets are gone. The original native proxy
        // and harness remain alive; only authenticated adoption is allowed.
        await rm(proxy);
        await rm(executable);
        const duplicateLauncher = vi.fn(() => { throw new Error("duplicate OpenCode runner launch"); });
        adopted = createCapabilityRunnerdCodexTransport({
          provider: "opencode",
          stateDirectory: join(root, "runner-state"),
          runnerFilesystemRoot: join(root, "retired-controller"),
          runnerBinary: join(root, "retired-controller", "runnerd"),
          runnerArtifact: artifact,
          prpIdentity: identity,
          controlPlaneRegistration: registration,
          resumeProviderSession: {
            driverSessionId: snapshot.driverSessionId,
            providerSessionId: snapshot.providerSessionId,
            providerIdentity: snapshot.providerIdentity,
          },
          runnerProcessLauncher: duplicateLauncher,
          adoptExistingRunner: {
            pid: survivingPid!, processGroupId: survivingPid, startedAt: runnerStartedAt,
            signal: () => true,
            isAlive: () => { try { process.kill(survivingPid!, 0); return true; } catch { return false; } },
          },
        });
        const recoveryDriver = new CodexAppServerDriver({
          taskEnvelope: task, conversationMode: "prepared", model,
          transportFactory: () => adopted!.transport,
          workingDirectoryAuthority: "remote_runner",
          environment: { PAPERCLIP_WORKSPACE_CWD: root },
          completionFeedback: async () => feedback,
        });
        const recovery = await recoveryDriver.recoverSession(snapshot);
        if (!recovery.recovered) throw new Error(`OpenCode live adoption failed: ${recovery.reason}`);
        expect(recovery.session).toBeDefined();
        session = recovery.session!;
        expect(adopted.evidence().runnerPid).toBe(survivingPid);
        expect(adopted.transport.processInfo().startedAt).toBe(runnerStartedAt);
        expect((await session.snapshot()).providerSessionId).toBe(snapshot.providerSessionId);
        expect(duplicateLauncher).not.toHaveBeenCalled();
      }
      await session.startTurn({ message: { role: "user", text: "Reply Hi." } });
      for await (const event of session.events()) if (event.eventType === "turn.completed") break;
      const allRequests = (await readFile(join(runtime, sessionRoots[0]!.name, "data/fake-prompt-requests.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(allRequests.map(request => request.variant)).toEqual(supportsReasoning
        ? ["paperclip-no-reasoning", "paperclip-default"] : [undefined, undefined]);
    },
    closeSession: async () => { await session?.close(); },
    closeTransport: async () => {
      try { await adopted?.transport.close(); }
      finally {
        await bundle.transport.close();
        if (survivingPid !== null) { try { process.kill(survivingPid, "SIGKILL"); } catch {} }
      }
    },
    removeRoot: async () => {
      await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
      await rm(root, { recursive: true, force: true });
    },
    evidence: () => adopted?.evidence() ?? bundle.evidence(),
  });
}, 30_000);

it.each([
  { provider: "codex", acpxAgent: "cursor", acpxMode: "plan" },
  { provider: "acpx", acpxAgent: "copilot", acpxMode: "" },
  { provider: "acpx", acpxAgent: "cursor", acpxMode: 3 },
] as const)("rejects invalid provider mode transport options before allocating resources: %j", options => {
  expect(() => createCapabilityRunnerdCodexTransport(options as unknown as Parameters<typeof createCapabilityRunnerdCodexTransport>[0]))
    .toThrow(/acpxMode|Provider mode/);
});

it.each([undefined, "medium", "minimal", "xhigh", null])("rejects non-exact Pi transport thinking level %s before spawn", piThinkingLevel => {
  expect(() => createCapabilityRunnerdCodexTransport({ provider: "acpx", acpxAgent: "pi", piThinkingLevel: piThinkingLevel as never })).toThrow(/thinking/);
});

it("rejects Pi thinking settings on a different transport provider", () => {
  expect(() => createCapabilityRunnerdCodexTransport({ provider: "codex", piThinkingLevel: "low" })).toThrow(/only supported/);
});

describe("runnerd compaction turn payload", () => {
  it("asks Codex for its own compaction and Claude for its /compact command", async () => {
    const { runnerdCompactionTurnPayload } = await import("./runnerd-codex-transport.js");
    expect(runnerdCompactionTurnPayload("codex")).toEqual({ compact: true });
    expect(runnerdCompactionTurnPayload("acpx")).toEqual({ text: "/compact" });
    expect(() => runnerdCompactionTurnPayload("opencode")).toThrow("not supported");
  });
});

describe("cold process admission budget", () => {
  it("bounds Pi cold startup and recovery at 60 seconds", () => {
    expect(coldAdmissionTimeoutMs("acpx", "pi", true)).toBe(60_000);
  });
  it("bounds a cold OpenCode restore at 60 seconds", () => {
    // A replacement runner must start runnerd, the OpenCode proxy and
    // `opencode serve`, then resume the saved session inside one run.attach.
    // A fresh start spreads that work across separate run.prepare and
    // session.open bounds.
    expect(coldAdmissionTimeoutMs("opencode", undefined, true)).toBe(60_000);
  });
  it("preserves live adoption and every other provider at 30 seconds", () => {
    expect(coldAdmissionTimeoutMs("acpx", "pi", false)).toBe(30_000);
    expect(coldAdmissionTimeoutMs("opencode", undefined, false)).toBe(30_000);
    for (const agent of ["codex", "claude", "cursor", "copilot", "grok", undefined]) {
      expect(coldAdmissionTimeoutMs("acpx", agent, true)).toBe(30_000);
    }
    for (const provider of ["codex", "cursor_cloud", undefined]) {
      expect(coldAdmissionTimeoutMs(provider, "pi", true)).toBe(30_000);
    }
  });
});

it("retains the authenticated command failure without implicitly logging its structured result", async () => {
  const result = { commandId: "command-2", commandType: "session.open", status: "failed",
    result: { code: "command_execution_failed", message: "closed runtime failure" } };
  let failure: unknown;
  try {
    await waitForRunnerCommand({ type: "session.open", deadline: Date.now() + 1000, abortOnClose: true,
      isClosed: () => false, throwIfFailed: () => {}, command: () => ({ status: "failed", result }),
      runnerHasExited: async () => false, failureCode: () => "startup_failed" });
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toHaveProperty("message", `PRP command session.open failed: ${JSON.stringify(result)}`);
  const structured = (failure as Error & { runnerCommandResult: unknown }).runnerCommandResult;
  expect(structured).toEqual(result);
  expect(structured).not.toBe(result);
  expect(JSON.stringify(failure)).not.toContain("command_execution_failed");
  result.result.message = "mutated after receipt";
  expect(structured).toHaveProperty("result.message", "closed runtime failure");
});

it.each(["RPC failed: Private provider explanation.", "failed to start ACPX provider: ACPX sidecar command session.open was rejected (retryable=false, classification=session_ensure_failed)"])("keeps a provider explanation private and retains command diagnosis: %s", async message => {
  const providerFailure = { schema: "paperclip.provider-failure.v1", provider: "anthropic", phase: "startup",
    category: "unknown", message: "Private provider explanation.", retryability: "unknown" };
  const result = { result: { code: "command_execution_failed", message, providerFailure } };
  let failure: unknown;
  try {
    await waitForRunnerCommand({ type: "session.open", deadline: Date.now() + 1000, abortOnClose: true,
      isClosed: () => false, throwIfFailed: () => {}, command: () => ({ status: "failed", result }),
      runnerHasExited: async () => false, failureCode: () => "startup_failed" });
  } catch (error) { failure = error; }
  expect(failure).toHaveProperty("runnerCommandResult.result.providerFailure", providerFailure);
  expect(failure).toHaveProperty("runnerCommandResult.result.message", message);
  expect((failure as Error).message).not.toContain(providerFailure.message);
  expect(JSON.stringify(failure)).not.toContain(providerFailure.message);
  // Runner composes the ACPX rejection from closed codes, so its classification stays reportable.
  if (message.startsWith("failed to start ACPX provider")) expect((failure as Error).message).toContain(message);
  else expect((failure as Error).message).toContain('"message":"Provider request failed"');
});

it("reports a generic failure when an ACPX rejection does not match Runner's closed text", async () => {
  const providerFailure = { schema: "paperclip.provider-failure.v1", provider: "anthropic", phase: "startup",
    category: "unknown", message: "Private provider explanation.", retryability: "unknown" };
  const message = "failed to start ACPX provider: ACPX sidecar command session.open was rejected (retryable=false, classification=session_ensure_failed) Private provider explanation.";
  let failure: unknown;
  try {
    await waitForRunnerCommand({ type: "session.open", deadline: Date.now() + 1000, abortOnClose: true,
      isClosed: () => false, throwIfFailed: () => {},
      command: () => ({ status: "failed", result: { result: { code: "command_execution_failed", message, providerFailure } } }),
      runnerHasExited: async () => false, failureCode: () => "startup_failed" });
  } catch (error) { failure = error; }
  expect((failure as Error).message).toContain('"message":"Provider request failed"');
  expect((failure as Error).message).not.toContain("Private provider explanation.");
});

it("shares Pi's absolute cold deadline across recovery barriers and rejects a late ACK", async () => {
  vi.useFakeTimers();
  try {
    const deadline = Date.now() + coldAdmissionTimeoutMs("acpx", "pi", true);
    let status = "pending";
    const wait = (type: string) => waitForRunnerCommand({
      type, deadline, abortOnClose: true, isClosed: () => false,
      throwIfFailed: () => undefined, command: () => ({ status }),
      runnerHasExited: async () => false, failureCode: () => "startup_failed",
    });
    const attached = wait("run.attach");
    await vi.advanceTimersByTimeAsync(40_000);
    status = "completed";
    await vi.advanceTimersByTimeAsync(10);
    await attached;
    status = "pending";
    const drain = wait("runner.drain");
    const rejection = expect(drain).rejects.toThrow("runner.drain timed out");
    await vi.advanceTimersByTimeAsync(20_000);
    await rejection;
    status = "completed";
    await expect(wait("session.open")).rejects.toThrow("session.open timed out");
  } finally { vi.useRealTimers(); }
});

it("aborts startup promptly on close while allowing the owned cleanup command to drain", async () => {
  vi.useFakeTimers();
  try {
    let closed = false;
    let status = "pending";
    const input = {
      deadline: Date.now() + 60_000, isClosed: () => closed,
      throwIfFailed: () => undefined, command: () => ({ status }),
      runnerHasExited: async () => false, failureCode: () => "startup_failed",
    };
    const opening = waitForRunnerCommand({ ...input, type: "session.open", abortOnClose: true });
    const rejection = expect(opening).rejects.toThrow("closed while waiting for session.open");
    closed = true;
    await vi.advanceTimersByTimeAsync(10);
    await rejection;
    // A late open ACK cannot revive the cancelled waiter, but cleanup still owns the process.
    const drain = waitForRunnerCommand({ ...input, type: "runner.drain", abortOnClose: false });
    await vi.advanceTimersByTimeAsync(10);
    status = "completed";
    await vi.advanceTimersByTimeAsync(10);
    await drain;
  } finally { vi.useRealTimers(); }
});

it("launches and closes native Codex without materializing or editing the preconfigured home", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-preconfigured-launch-"));
  const home = join(root, "user-home");
  const codexHome = join(home, ".codex");
  const stateDirectory = join(root, "session");
  await mkdir(codexHome, { recursive: true });
  await mkdir(stateDirectory);
  const config = 'approval_policy = "never"\n';
  const auth = '{"user_owned":true}';
  await writeFile(join(codexHome, "config.toml"), config);
  await writeFile(join(codexHome, "auth.json"), auth);
  const bundle = createCapabilityRunnerdCodexTransport({
    homeMode: "preconfigured", environment: { ...process.env, HOME: home, CODEX_HOME: codexHome },
    runnerBinary: resolve(import.meta.dirname, "../../runner/target/debug/paperclip-runnerd"),
    codexCommand: fakeCodex, codexArgs: fakeCodexArgs(stateDirectory), stateDirectory,
  });
  try {
    await bundle.transport.request("thread/start", { cwd: stateDirectory, model: "gpt-5.6-sol", dynamicTools: [] });
    await bundle.transport.close();
    expect(await readFile(join(codexHome, "config.toml"), "utf8")).toBe(config);
    expect(await readFile(join(codexHome, "auth.json"), "utf8")).toBe(auth);
    await expect(stat(join(stateDirectory, "codex-home"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await bundle.transport.close().catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);
