import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { RunnerdDotDriver, type RunnerdDotDriverOptions } from "./runnerd-dot-driver.js";
import { describeRunnerdNativeSessionBackend } from "../../backends/codex-native-backend.js";
import { createNativeSessionBackend } from "../../backends/native-backend-factory.js";
import * as controlPlane from "../../control-plane/durable-prp-control-plane.js";
import { externalOperationDigest, type ExternalProviderOperation } from "../../contracts/external-provider.js";
import { buildNativeModelEnvelope, parseNativeExecutionInput, type NativeExecutionInputV6 } from "../../contracts/native-execution.js";
import { NATIVE_RUNTIME_ASSET_SCHEMA, PAPERCLIP_EXECUTION_PROMPT, PAPERCLIP_EXECUTION_PROMPT_REVISION,
  nativeRuntimePromptDigest, canonicalNativeRuntimeContextDigest } from "../../contracts/runtime-context.js";

function execution(root: string): NativeExecutionInputV6 {
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
    provider: { kind: "openai_dot", model: null, binding: { companyId, agentId, bindingId: randomUUID(), bindingGeneration: 1,
      acceptByUnixMs: Date.now() + 600_000, expiresAtUnixMs: Date.now() + 7_200_000 } },
    workspace: { access: "none", cwd: null, repoUrl: null, repoRef: null, branchName: null },
    session: { normalizedSessionId: randomUUID(), driverKind: "openai_dot_mcp", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
    executionMode: "default", planningContext: null,
    completionContract: { id: randomUUID(), sha256: "sha256:" + digest, schemaVersion: "paperclip.completion-contract.v1",
      contract: { revision: "1", objective: "Read the counter", criteria: [{ id: "objective", requirement: "Read the counter" }] } },
    runtimeContext: { ...context, aggregateDigest: canonicalNativeRuntimeContextDigest(context) }, interactionResponses: [], credentialBindings: [],
  }) as NativeExecutionInputV6;
}

it("v6 closes Dot identity, workspace, model and credential fields", () => {
  const input = execution("/synthetic/pinned-instructions");
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

it("admits the heartbeat descriptor with the real Dot capabilities and no broker or process startup", async () => {
  const input = execution("/synthetic/pinned-instructions");
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
      kind: "runner", name: "openai_dot_mcp", version: "dot-mcp-v1",
      capabilities: { resume: false, steering: false, interruption: false, usage: false, dynamicTools: true },
      runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" },
    });
    expect(spawnSpy).not.toHaveBeenCalled();
  } finally { spawnSpy.mockRestore(); }
});

it.each(["shutdown", "unexpected exit"] as const)("classifies a real Rust %s before the next command poll", async kind => {
  const root = await mkdtemp(join(tmpdir(), "dot-driver-exit-"));
  await writeFile(join(root, "AGENTS.md"), "Use only the synthetic counter.");
  const input = execution(root);
  let handle: controlPlane.RunnerProcessHandle | undefined;
  let exited = false;
  const spawn = controlPlane.spawnRunner;
  const spawnSpy = vi.spyOn(controlPlane, "spawnRunner").mockImplementation(options => {
    handle = spawn(options);
    void handle.completion.then(() => { exited = true; });
    return handle;
  });
  const getCommand = controlPlane.DurablePrpControlPlane.prototype.getCommand;
  const commandSpy = vi.spyOn(controlPlane.DurablePrpControlPlane.prototype, "getCommand").mockImplementation(function (id) {
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
    runnerBinary: resolve("runner/target/debug/paperclip-runnerd"),
    port: { dispatch: async () => {}, settle: async () => {}, attach: async () => async () => {} },
  });
  let session: Awaited<ReturnType<typeof driver.openSession>> | undefined;
  try {
    session = await driver.openSession({ runId: input.binding.runId, normalizedSessionId: input.session.normalizedSessionId! });
    if (kind === "shutdown") {
      await expect(session.close({ reason: "Test complete" })).resolves.toBeUndefined();
      expect(exited).toBe(true);
      expect((await handle!.completion).code).toBe(0);
    } else {
      handle!.child.kill("SIGTERM");
      await handle!.completion;
      await expect(session.read!()).rejects.toThrow("dot_runner_process_exited_recovery_required");
    }
  } finally {
    commandSpy.mockRestore(); spawnSpy.mockRestore();
    await session?.detachControllerForRestart?.();
    if (!exited) handle?.child.kill("SIGTERM");
    await handle?.completion;
    await rm(root, { recursive: true, force: true });
  }
}, 45000);

it("reattaches the same Rust bridge without duplicating a settled operation and refuses a lost checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "dot-driver-recovery-"));
  await writeFile(join(root, "AGENTS.md"), "Use only the synthetic counter.");
  const input = execution(root);
  let send: ((op: ExternalProviderOperation) => Promise<void>) | undefined;
  let spawned: { pid: number; processGroupId: number | null; startedAt: string } | undefined;
  let calls = 0;
  const settlements = new Map<string, unknown>();
  const dispatches: unknown[] = [];
  let controllerPort = 0;
  const options: RunnerdDotDriverOptions = {
    execution: input, stateDirectory: join(root, "state"),
    identity: { runnerInstanceId: randomUUID(), environmentLeaseId: randomUUID(), runId: input.binding.runId,
      normalizedSessionId: input.session.normalizedSessionId!, turnId: "turn-" + input.binding.runId, itemId: "item-" + input.binding.runId },
    runnerBinary: resolve("runner/target/debug/paperclip-runnerd"),
    onSpawn: process => { spawned = process; },
    controlPlaneRegistration: async authority => {
      await authority.start(controllerPort);
      controllerPort = Number(new URL(authority.connectUrl).port);
      return { connectUrl: authority.connectUrl, release: () => authority.stop() };
    },
    dynamicTools: [{ name: "synthetic_counter", description: "Read a synthetic counter", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
    dynamicToolHandler: async () => ({ count: ++calls }),
    port: { dispatch: async event => { dispatches.push(event); }, settle: async event => { settlements.set(String(event.payload.requestId), event.payload.outcome); },
      attach: async callback => { send = callback; return async () => { send = undefined; }; } },
  };
  const driver = new RunnerdDotDriver(options);
  let session = await driver.openSession({ runId: input.binding.runId, normalizedSessionId: input.session.normalizedSessionId! });
  const operation = (action: ExternalProviderOperation["action"], args: Record<string, unknown>): ExternalProviderOperation => ({
    requestId: randomUUID(), bindingId: input.provider.binding.bindingId, bindingGeneration: 1, runId: input.binding.runId,
    normalizedSessionId: input.session.normalizedSessionId!, turnId: options.identity.turnId, assignmentRevision: 1,
    action, input: args, digest: externalOperationDigest(action, args),
  });
  try {
    await session.startTurn({ message: { role: "user", text: "Read the synthetic counter." } });
    await send!(operation("accept", {}));
    const call = operation("tool", { name: "synthetic_counter", arguments: {} });
    await send!(call);
    await vi.waitFor(() => expect(settlements.get(call.requestId)).toMatchObject({ status: "completed", isError: false }), { timeout: 10000 });
    const snapshot = await session.snapshot();
    expect(snapshot).toMatchObject({ providerSessionId: null, activeTurnId: options.identity.turnId, providerRecoveryPolicy: "same_session_only" });
    await session.detachControllerForRestart!();
    const recoveredDriver = new RunnerdDotDriver({ ...options, adoptExistingRunner: { ...spawned!, isAlive: () => true } });
    const recovered = await recoveredDriver.recoverSession(snapshot, { signal: new AbortController().signal });
    expect(recovered.recovered).toBe(true);
    session = recovered.session!;
    await send!(call);
    expect(calls).toBe(1);
    expect(dispatches).toHaveLength(1);
    await session.interrupt!({ reason: "Synthetic test complete" });
    await session.close({ reason: "Synthetic test complete" });
    await rm(join(root, "state/runner/dot-provider-state.json"));
    expect(await recoveredDriver.recoverSession(snapshot, { signal: new AbortController().signal })).toMatchObject({ recovered: false });
  } finally {
    await session.close({ reason: "Test cleanup", force: true }).catch(() => {});
    if (spawned) { try { process.kill(spawned.pid, "SIGTERM"); } catch {} }
    await rm(root, { recursive: true, force: true });
  }
}, 45000);
