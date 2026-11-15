import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RunnerdDotDriver, externalRunnerExitMessage, type RunnerdDotDriverOptions } from "./runnerd-dot-driver.js";
import { describeRunnerdNativeSessionBackend } from "../../backends/codex-native-backend.js";
import { createNativeSessionBackend } from "../../backends/native-backend-factory.js";
import * as controlPlane from "../../control-plane/durable-prp-control-plane.js";
import { defaultCapabilityRunnerdBinary } from "../../live/runnerd-codex-transport.js";
import { externalOperationDigest, type ExternalProviderOperation } from "../../contracts/external-provider.js";
import { buildNativeModelEnvelope, parseNativeExecutionInput, type NativeExecutionInputV6 } from "../../contracts/native-execution.js";
import { NATIVE_RUNTIME_ASSET_SCHEMA, PAPERCLIP_EXECUTION_PROMPT, PAPERCLIP_EXECUTION_PROMPT_REVISION,
  nativeRuntimePromptDigest, canonicalNativeRuntimeContextDigest } from "../../contracts/runtime-context.js";

function execution(root: string, provider: "openai_dot" | "grok_bot" = "openai_dot"): NativeExecutionInputV6 {
  const companyId = randomUUID(), agentId = randomUUID();
  const digest = "0".repeat(64);
  const context = {
    prompt: { revision: PAPERCLIP_EXECUTION_PROMPT_REVISION, text: PAPERCLIP_EXECUTION_PROMPT, digest: nativeRuntimePromptDigest() },
    instructions: { entryPath: "AGENTS.md", bundle: { schema: NATIVE_RUNTIME_ASSET_SCHEMA, digest, manifestDigest: digest, rootPath: root, fileCount: 1, totalBytes: 4 } },
    skills: [], mcp: { assignmentSetId: "none", digest, bindingId: null },
  };
  return parseNativeExecutionInput({
    schema: "paperclip.native-execution-input.v6",
    binding: { companyId, agentId, runId: randomUUID(), issueId: randomUUID(), executionWorkspaceId: randomUUID() },
    task: { identifier: "DOT-1", title: "Synthetic bridge recovery", description: null, prompt: "Read the synthetic counter.", workMode: "standard" },
    provider: { kind: provider, model: null, binding: { companyId, agentId, bindingId: randomUUID(), bindingGeneration: 1,
      acceptByUnixMs: Date.now() + 600_000, expiresAtUnixMs: Date.now() + 7_200_000 } },
    workspace: { access: "none", cwd: null, repoUrl: null, repoRef: null, branchName: null },
    session: { normalizedSessionId: randomUUID(), driverKind: provider === "grok_bot" ? "grok_bot_mcp" : "openai_dot_mcp", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
    executionMode: "default", planningContext: null,
    completionContract: { id: randomUUID(), sha256: "sha256:" + digest, schemaVersion: "paperclip.completion-contract.v1",
      contract: { revision: "1", objective: "Read the counter", criteria: [{ id: "objective", requirement: "Read the counter" }] } },
    runtimeContext: { ...context, aggregateDigest: canonicalNativeRuntimeContextDigest(context) }, interactionResponses: [], credentialBindings: [],
  }) as NativeExecutionInputV6;
}

it.each(["openai_dot", "grok_bot"] as const)("v6 closes %s identity, workspace, model and credential fields", provider => {
  const input = execution("/synthetic/pinned-instructions", provider);
  expect(parseNativeExecutionInput(input)).toEqual(input);
  expect(buildNativeModelEnvelope(input).workspace).toBeNull();
  expect(JSON.stringify(buildNativeModelEnvelope(input))).not.toContain("/synthetic");
  for (const changed of [
    { ...input, workspace: { ...input.workspace, cwd: "/private/project" } },
    { ...input, provider: { ...input.provider, model: "a-model" } },
    { ...input, provider: { ...input.provider, apiKey: "secret" } },
    { ...input, provider: { ...input.provider, binding: { ...input.provider.binding, agentId: randomUUID() } } },
    { ...input, credentialBindings: [{ bindingId: "secret-binding", service: "openai", destination: "api.openai.com", expiresAt: null, displayName: "API" }] },
    { ...input, session: { ...input.session, lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60000 } } },
  ]) expect(() => parseNativeExecutionInput(changed)).toThrow();
});

it.each(["openai_dot", "grok_bot"] as const)("admits the %s descriptor without a broker or process startup", async provider => {
  const input = execution("/synthetic/pinned-instructions", provider);
  const spawnSpy = vi.spyOn(controlPlane, "spawnRunner");
  try {
    const descriptor = await describeRunnerdNativeSessionBackend(input);
    const backend = createNativeSessionBackend(input, {
      dotRunnerOptions: {
        stateDirectory: "/must-not-be-created",
        identity: { runnerInstanceId: randomUUID(), environmentLeaseId: randomUUID(), runId: input.binding.runId,
          normalizedSessionId: input.session.normalizedSessionId!, turnId: "turn", itemId: "item" },
        port: {
          dispatch: async () => { throw new Error("Descriptor must not dispatch work"); },
          settle: async () => { throw new Error("Descriptor must not settle work"); },
          attach: async () => { throw new Error("Descriptor must not attach a broker"); },
        },
      },
    });
    expect(descriptor).toEqual(await backend.descriptor());
    expect(descriptor).toMatchObject({
      kind: "runner", name: provider === "grok_bot" ? "grok_bot_mcp" : "openai_dot_mcp", version: provider === "grok_bot" ? "grok-bot-mcp-v1" : "dot-mcp-v1",
      capabilities: { resume: false, steering: false, interruption: false, usage: false, dynamicTools: true, completionBoundary: "paperclip_work_session", providerTermination: "unavailable", providerTranscriptStreaming: false },
      runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" },
    });
    expect(spawnSpy).not.toHaveBeenCalled();
  } finally { spawnSpy.mockRestore(); }
});

it.each([
  { kind: "shutdown", remote: false }, { kind: "unexpected exit", remote: false },
  { kind: "shutdown", remote: true }, { kind: "unexpected exit", remote: true },
])("classifies a real Rust $kind before the next command poll (remote=$remote)", async ({ kind, remote }) => {
  const root = await mkdtemp(join(tmpdir(), "dot-driver-exit-"));
  await writeFile(join(root, "AGENTS.md"), "Use only the synthetic counter.");
  const input = execution(root);
  let handle: controlPlane.RunnerProcessHandle | undefined;
  let exited = false;
  const spawn = controlPlane.spawnRunner;
  const spawnSpy = vi.spyOn(controlPlane, "spawnRunner").mockImplementation(options => {
    const process = spawn(options);
    // Managed monitors preserve process identity but have no OS exit status.
    handle = remote ? { ...process, completion: process.completion.then(result => ({ ...result, code: null })) } : process;
    void handle.completion.then(() => { exited = true; });
    return handle;
  });
  const getCommand = controlPlane.DurablePrpControlPlane.prototype.getCommand;
  const commandSpy = vi.spyOn(controlPlane.DurablePrpControlPlane.prototype, "getCommand").mockImplementation(function (this: controlPlane.DurablePrpControlPlane, id) {
    const command = getCommand.call(this, id);
    // Hold the SDK poll until the real process has exited. The authenticated
    // shutdown receipt and its ACK remain committed in the transport journal.
    if (id === "dot_shutdown" && command?.status === "completed" && !exited) return { ...command, status: "pending" };
    return command;
  });
  const driver = new RunnerdDotDriver({
    execution: input, stateDirectory: join(root, "state"),
    identity: { runnerInstanceId: randomUUID(), environmentLeaseId: randomUUID(), runId: input.binding.runId,
      normalizedSessionId: input.session.normalizedSessionId!, turnId: "turn-" + input.binding.runId, itemId: "item-" + input.binding.runId },
    runnerBinary: process.env.PAPERCLIP_ATTACH_TRANSITION_RUNNER ?? defaultCapabilityRunnerdBinary(),
    port: { dispatch: async () => {}, settle: async () => {}, attach: async () => async () => {} },
  });
  let session: Awaited<ReturnType<typeof driver.openSession>> | undefined;
  try {
    session = await driver.openSession({ runId: input.binding.runId, normalizedSessionId: input.session.normalizedSessionId!, workingDirectory: root });
    if (kind === "shutdown") {
      await expect(session.close({ reason: "Test complete" })).resolves.toBeUndefined();
      expect(exited).toBe(true);
      expect((await handle!.completion).code).toBe(remote ? null : 0);
    } else {
      handle!.child.kill("SIGTERM");
      await handle!.completion;
      await expect(session.read!()).rejects.toThrow(
        /^dot_runner_process_exited_recovery_required: code=\S+ signal=\S+ disconnectedMs=(?:none|\d+)$/);
    }
  } finally {
    commandSpy.mockRestore(); spawnSpy.mockRestore();
    await session?.detachControllerForRestart?.();
    if (!exited) handle?.child.kill("SIGTERM");
    await handle?.completion;
    await rm(root, { recursive: true, force: true });
  }
}, 45000);

it.each(["local", "local pending finish", "custom local directory", "external launcher", "grok external launcher", "external launcher empty controller", "external launcher dead daemon"])("reattaches the %s Rust bridge without duplicate operations and refuses lost checkpoints", async launch => {
  const root = await mkdtemp(join(tmpdir(), "dot-driver-recovery-"));
  await writeFile(join(root, "AGENTS.md"), "Use only the synthetic counter.");
  const input = execution(root, launch === "grok external launcher" ? "grok_bot" : "openai_dot");
  let send: ((op: ExternalProviderOperation) => Promise<void>) | undefined;
  let spawned: { pid: number; processGroupId: number | null; startedAt: string } | undefined;
  let calls = 0;
  const settlements = new Map<string, unknown>();
  const dispatches: unknown[] = [];
  let controllerPort = 0;
  const deadDaemon = launch === "external launcher dead daemon";
  let ownedChild: ReturnType<typeof spawn> | undefined;
  let ownedCompletion: Promise<unknown> | undefined;
  const emptyController = launch === "external launcher empty controller";
  const pendingFinish = launch === "local pending finish";
  const firstCompletion = vi.fn(() => new Promise<string>(() => {}));
  const recoveredCompletion = vi.fn(async () => "Completion accepted");
  let checkpoint: controlPlane.DurablePrpCheckpoint | undefined;
  const options: RunnerdDotDriverOptions = {
    execution: input, stateDirectory: join(root, "state"),
    identity: { runnerInstanceId: randomUUID(), environmentLeaseId: randomUUID(), runId: input.binding.runId,
      normalizedSessionId: input.session.normalizedSessionId!, turnId: "turn-" + input.binding.runId, itemId: "item-" + input.binding.runId },
    runnerBinary: deadDaemon ? process.env.PAPERCLIP_ATTACH_TRANSITION_RUNNER ?? defaultCapabilityRunnerdBinary() : resolve("runner/target/debug/paperclip-runnerd"),
    onSpawn: async process => { spawned = process; },
    controlPlaneRegistration: async authority => {
      if (emptyController) {
        authority.setCheckpointPersistence(async saved => { checkpoint = controlPlane.decodeDurablePrpCheckpoint(new Map(saved.records)); });
        await authority.flushCheckpoint();
      }
      await authority.start(controllerPort);
      controllerPort = Number(new URL(authority.connectUrl).port);
      return { connectUrl: authority.connectUrl, release: () => authority.stop() };
    },
    dynamicTools: [{ name: "synthetic_counter", description: "Read a synthetic counter", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
    dynamicToolHandler: async () => ({ count: ++calls }),
    ...(pendingFinish ? { completionFeedback: firstCompletion } : {}),
    port: { dispatch: async event => { dispatches.push(event); }, settle: async event => { settlements.set(String(event.payload.requestId), event.payload.outcome); },
      attach: async callback => { send = callback; return async () => { send = undefined; }; } },
  };
  const runnerState = launch === "local" || pendingFinish ? join(root, "state/runner") : join(root, "external-runtime/runner");
  if (launch === "custom local directory") options.runnerStateDirectory = runnerState;
  if (launch.includes("external launcher")) {
    await mkdir(runnerState, { recursive: true });
    options.runnerStateDirectory = runnerState;
    options.readProviderState = async () => {
      try { return JSON.parse(await readFile(join(runnerState, "dot-provider-state.json"), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    };
    options.runnerProcessLauncher = spec => {
      if (emptyController) expect(Object.keys(JSON.parse(checkpoint!.records.get("header")!).state.tickets)).toHaveLength(1);
      expect(spec.environment).not.toHaveProperty("OPENAI_API_KEY");
      expect(spec.args).toContain(runnerState);
      const child = spawn(spec.command, [...spec.args], { cwd: runnerState, env: spec.environment, stdio: "ignore" });
      const startedAt = new Date().toISOString();
      spawned = { pid: child.pid!, processGroupId: null, startedAt };
      const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
        child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal, stdout: "", stderr: "" }));
      });
      ownedChild = child; ownedCompletion = completion;
      return { child, startedAt, completion };
    };
  }
  let firstFailure: unknown;
  const driver = new RunnerdDotDriver(options);
  let session: Awaited<ReturnType<typeof driver.openSession>> | undefined;
  const operation = (action: ExternalProviderOperation["action"], args: Record<string, unknown>): ExternalProviderOperation => ({
    requestId: randomUUID(), bindingId: input.provider.binding.bindingId, bindingGeneration: 1, runId: input.binding.runId,
    normalizedSessionId: input.session.normalizedSessionId!, turnId: options.identity.turnId, assignmentRevision: 1,
    action, input: args, digest: externalOperationDigest(action, args),
  });
  try {
    session = await driver.openSession({ runId: input.binding.runId, normalizedSessionId: input.session.normalizedSessionId!, workingDirectory: root });
    await session.startTurn({ message: { role: "user", text: "Read the synthetic counter." } });
    await send!(operation("accept", {}));
    const call = operation("tool", { name: "synthetic_counter", arguments: {} });
    await send!(call);
    await vi.waitFor(() => expect(settlements.get(call.requestId)).toMatchObject({ status: "completed", isError: false }), { timeout: 10000 });
    if (input.provider.kind === "grok_bot") {
      const renewal = operation("renew", { expiresAtUnixMs: Date.now() + 3600000 });
      await send!(renewal);
      await vi.waitFor(() => expect(settlements.get(renewal.requestId)).toMatchObject({ status: "renewed" }), { timeout: 10000 });
    }
    const finish = operation("tool", { name: "paperclip_finish", arguments: {
      schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Read the counter",
      completionClaim: { contractRevision: "1", objectiveSatisfied: true, criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }], remainingWork: [] },
      evidence: [], verification: [], attentionRequests: [], artifacts: [],
    } });
    if (pendingFinish) {
      await send!(finish);
      await vi.waitFor(() => expect(firstCompletion).toHaveBeenCalledOnce(), { timeout: 10000 });
      expect(settlements.has(finish.requestId)).toBe(false);
    }
    const snapshot = await session.snapshot();
    expect(snapshot).toMatchObject({ providerSessionId: null, activeTurnId: options.identity.turnId, providerRecoveryPolicy: "same_session_only" });
    await session.detachControllerForRestart!();
    const priorDaemonPid = spawned!.pid;
    if (deadDaemon) {
      expect(ownedChild?.pid).toBe(priorDaemonPid);
      expect(ownedChild!.kill("SIGTERM")).toBe(true);
      await ownedCompletion;
      expect(ownedChild!.exitCode !== null || ownedChild!.signalCode !== null).toBe(true);
    }
    if (emptyController) {
      await rm(options.stateDirectory, { recursive: true });
      checkpoint!.restoreSessionDirectory(options.stateDirectory);
    }
    const recoveredDriver = new RunnerdDotDriver({ ...options,
      ...(pendingFinish ? { completionFeedback: recoveredCompletion } : {}),
      ...(emptyController ? { runnerBinary: join(root, "unavailable-old-runner"),
        runnerArtifact: { version: checkpoint!.runnerVersion, digest: checkpoint!.runnerDigest } } : {}),
      ...(!deadDaemon ? { adoptExistingRunner: { ...spawned!, isAlive: () => true } } : {}) });
    const recovered = await recoveredDriver.recoverSession(snapshot, { signal: new AbortController().signal });
    expect(recovered.recovered).toBe(true);
    session = recovered.session!;
    if (deadDaemon) expect(spawned!.pid).not.toBe(priorDaemonPid);
    if (pendingFinish) {
      expect(options.recoverSemanticToolInput).toBeUndefined();
      await vi.waitFor(() => expect(settlements.get(finish.requestId)).toMatchObject({ status: "completed", isError: false }), { timeout: 10000 });
      expect(recoveredCompletion).toHaveBeenCalledOnce();
      expect(firstCompletion).toHaveBeenCalledOnce();
    }
    await send!(call);
    expect(calls).toBe(1);
    expect(dispatches).toHaveLength(1);
    await session.interrupt!({ reason: "Synthetic test complete" });
    await session.close({ reason: "Synthetic test complete" });
    await rm(join(runnerState, "dot-provider-state.json"));
    expect(await recoveredDriver.recoverSession(snapshot, { signal: new AbortController().signal })).toMatchObject({ recovered: false });
  } catch (error) {
    firstFailure = error; throw error;
  } finally {
    if (deadDaemon) {
      const cleanupFailures: unknown[] = [];
      try { await session?.close({ reason: "Test cleanup", force: true }); } catch (error) { cleanupFailures.push(error); }
      try {
        if (ownedChild && ownedChild.exitCode === null && ownedChild.signalCode === null) ownedChild.kill("SIGTERM");
        await ownedCompletion;
      } catch (error) { cleanupFailures.push(error); }
      try { await rm(root, { recursive: true, force: true }); } catch (error) { cleanupFailures.push(error); }
      if (cleanupFailures.length) throw new AggregateError(firstFailure === undefined ? cleanupFailures : [firstFailure, ...cleanupFailures],
        "Dead external daemon recovery cleanup failed", { cause: firstFailure ?? cleanupFailures[0] });
    } else {
      await session?.close({ reason: "Test cleanup", force: true }).catch(() => {});
      if (ownedChild && ownedChild.exitCode === null && ownedChild.signalCode === null) ownedChild.kill("SIGTERM");
      await ownedCompletion;
      if (!ownedChild && spawned) { try { process.kill(spawned.pid, "SIGTERM"); } catch {} }
      await rm(root, { recursive: true, force: true });
    }
  }
}, 45000);

it("rejects a mismatched Grok driver before any provider state is attached", async () => {
  const input = execution("/synthetic/pinned-instructions", "grok_bot");
  expect(() => parseNativeExecutionInput({ ...input, session: { ...input.session, driverKind: "openai_dot_mcp" } })).toThrow();
  expect(() => parseNativeExecutionInput({ ...input, provider: { ...input.provider, kind: "unsupported_bot" } })).toThrow();
});

describe("external Runner failure diagnostics", () => {
  it.each([
    ["active connection lease expired; durable state is preserved", "lease_expired_requires_bootstrap"],
    ["runner_remote_process_exited lifecycle=running recoverableFailure=transport_reconnect_grace_exceeded", "transport_reconnect_grace_exceeded"],
    ["transport reconnect deadline elapsed; durable state is preserved", "transport_reconnect_deadline_exceeded"],
  ])("preserves the bounded failure reason from %s", (stderr, reason) => {
    expect(externalRunnerExitMessage({ code: null, signal: null, stdout: "", stderr }))
      .toContain(`reason=${reason}`);
  });
  it("does not disclose raw diagnostics or transport credentials", () => {
    const stderr = "Bearer qualification-secret https://private.example/path?ticket=qualification-secret UNKNOWN_REASON";
    expect(externalRunnerExitMessage({ code: null, signal: null, stdout: "", stderr }))
      .toBe("dot_runner_process_exited_recovery_required: code=null signal=null");
    const recognized = externalRunnerExitMessage({ code: null, signal: null, stdout: "", stderr: `connection lease expired ${stderr}` });
    expect(recognized).toContain("reason=lease_expired_requires_bootstrap");
    expect(recognized).not.toContain("qualification-secret");
    expect(recognized).not.toContain("private.example");
  });
});


it.each(["confirmed", "unconfirmed", "absent", "rejected", "partial"] as const)(
  "joins original external Runner cleanup after real exit (proof=%s)", async proof => {
    const root = await mkdtemp(join(tmpdir(), "dot-driver-owned-exit-"));
    await writeFile(join(root, "AGENTS.md"), "Use only the synthetic counter.");
    const input = execution(root);
    const monitorFailure = new Error("test_original_monitor_rejection");
    const joinFailure = new Error("test_original_local_join_failure");
    let handle: controlPlane.RunnerProcessHandle | undefined;
    let originalCompletion: controlPlane.RunnerProcessHandle["completion"] | undefined;
    let terminated = false, detachCalls = 0, releaseCalls = 0, stopCalls = 0, drainCalls = 0, retiredCalls = 0;
    let releaseDrain!: () => void;
    const drainGate = new Promise<void>(resolve => { releaseDrain = resolve; });
    const spawnRunner = controlPlane.spawnRunner;
    const spawnSpy = vi.spyOn(controlPlane, "spawnRunner").mockImplementation(options => {
      const original = spawnRunner(options);
      originalCompletion = original.completion;
      handle = { ...original, isExitConfirmed: proof === "absent" ? undefined : () => terminated && proof !== "unconfirmed",
        completion: original.completion.then(result => {
          terminated = true;
          if (proof === "rejected") throw monitorFailure;
          return { ...result, code: null, signal: null };
        }) };
      return handle;
    });
    const stop = controlPlane.DurablePrpControlPlane.prototype.stop;
    const drain = controlPlane.DurablePrpControlPlane.prototype.drainPendingConnectionProcessing;
    const retire = controlPlane.DurablePrpControlPlane.prototype.retireSemanticToolCallbacks;
    const stopSpy = vi.spyOn(controlPlane.DurablePrpControlPlane.prototype, "stop").mockImplementation(async function (this: controlPlane.DurablePrpControlPlane) {
      stopCalls++; await stop.call(this);
    });
    const drainSpy = vi.spyOn(controlPlane.DurablePrpControlPlane.prototype, "drainPendingConnectionProcessing").mockImplementation(async function (this: controlPlane.DurablePrpControlPlane) {
      drainCalls++; await drain.call(this);
      if (proof === "partial" && drainCalls === 1) { await drainGate; throw joinFailure; }
    });
    const retireSpy = vi.spyOn(controlPlane.DurablePrpControlPlane.prototype, "retireSemanticToolCallbacks").mockImplementation(function (this: controlPlane.DurablePrpControlPlane) {
      retiredCalls++; return retire.call(this);
    });
    const driver = new RunnerdDotDriver({ execution: input, stateDirectory: join(root, "state"),
      identity: { runnerInstanceId: randomUUID(), environmentLeaseId: randomUUID(), runId: input.binding.runId,
        normalizedSessionId: input.session.normalizedSessionId!, turnId: "turn-" + input.binding.runId, itemId: "item-" + input.binding.runId },
      runnerBinary: process.env.PAPERCLIP_ATTACH_TRANSITION_RUNNER ?? defaultCapabilityRunnerdBinary(),
      controlPlaneRegistration: async authority => {
        await authority.start();
        return { connectUrl: authority.connectUrl, release: () => { releaseCalls++; } };
      },
      port: { dispatch: async () => {}, settle: async () => {}, attach: async () => async () => { detachCalls++; } },
    });
    let session: Awaited<ReturnType<typeof driver.openSession>> | undefined;
    try {
      session = await driver.openSession({ runId: input.binding.runId, normalizedSessionId: input.session.normalizedSessionId!, workingDirectory: root });
      handle!.child.kill("SIGTERM");
      await originalCompletion;
      await handle!.completion.catch(() => {});
      await expect(session.read!()).rejects.toThrow(/^dot_runner_process_exited_recovery_required:/);
      if (proof === "unconfirmed" || proof === "absent" || proof === "rejected") {
        await expect(session.close({ reason: "Unproven cleanup" })).rejects.toThrow(/^dot_runner_process_exited_recovery_required:/);
        expect([detachCalls, releaseCalls, stopCalls, drainCalls, retiredCalls]).toEqual([0, 0, 0, 0, 0]);
      } else if (proof === "partial") {
        const first = session.close({ reason: "First close" });
        const firstOutcome = first.then(() => null, error => error);
        await vi.waitFor(() => expect(drainCalls).toBe(1), { timeout: 2000 });
        const repeated = session.close({ reason: "Concurrent close" });
        const repeatedOutcome = repeated.then(() => null, error => error);
        expect([detachCalls, releaseCalls, stopCalls, drainCalls, retiredCalls]).toEqual([1, 1, 1, 1, 0]);
        releaseDrain();
        expect(await firstOutcome).toBe(joinFailure);
        expect(await repeatedOutcome).toBe(joinFailure);
        await expect(session.close({ reason: "Retry failed local join" })).resolves.toBeUndefined();
        expect([detachCalls, releaseCalls, stopCalls, drainCalls, retiredCalls]).toEqual([1, 1, 1, 2, 1]);
      } else {
        await expect(session.close({ reason: "Confirmed original owner exit" })).resolves.toBeUndefined();
        expect([detachCalls, releaseCalls, stopCalls, drainCalls, retiredCalls]).toEqual([1, 1, 1, 1, 1]);
        await session.close({ reason: "Already joined" });
        expect([detachCalls, releaseCalls, stopCalls, drainCalls, retiredCalls]).toEqual([1, 1, 1, 1, 1]);
      }
    } finally {
      releaseDrain();
      await session?.detachControllerForRestart?.();
      spawnSpy.mockRestore(); stopSpy.mockRestore(); drainSpy.mockRestore(); retireSpy.mockRestore();
      if (!terminated) handle?.child.kill("SIGTERM");
      await originalCompletion;
      await rm(root, { recursive: true, force: true });
    }
  }, 45000,
);
