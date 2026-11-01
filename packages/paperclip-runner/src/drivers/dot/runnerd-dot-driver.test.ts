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

it.each(["local", "local pending finish", "custom local directory", "external launcher", "grok external launcher", "external launcher empty controller"])("reattaches the %s Rust bridge without duplicate operations and refuses lost checkpoints", async launch => {
  const root = await mkdtemp(join(tmpdir(), "dot-driver-recovery-"));
  await writeFile(join(root, "AGENTS.md"), "Use only the synthetic counter.");
  const input = execution(root, launch === "grok external launcher" ? "grok_bot" : "openai_dot");
  let send: ((op: ExternalProviderOperation) => Promise<void>) | undefined;
  let spawned: { pid: number; processGroupId: number | null; startedAt: string } | undefined;
  let calls = 0;
  const settlements = new Map<string, unknown>();
  const dispatches: unknown[] = [];
  let controllerPort = 0;
  const emptyController = launch === "external launcher empty controller";
  const pendingFinish = launch === "local pending finish";
  const firstCompletion = vi.fn(() => new Promise<string>(() => {}));
  const recoveredCompletion = vi.fn(async () => "Completion accepted");
  let checkpoint: controlPlane.DurablePrpCheckpoint | undefined;
  const options: RunnerdDotDriverOptions = {
    execution: input, stateDirectory: join(root, "state"),
    identity: { runnerInstanceId: randomUUID(), environmentLeaseId: randomUUID(), runId: input.binding.runId,
      normalizedSessionId: input.session.normalizedSessionId!, turnId: "turn-" + input.binding.runId, itemId: "item-" + input.binding.runId },
    runnerBinary: resolve("runner/target/debug/paperclip-runnerd"),
    onSpawn: process => { spawned = process; },
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
      return { child, startedAt, completion: new Promise((resolve, reject) => {
        child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal, stdout: "", stderr: "" }));
      }) };
    };
  }
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
    if (emptyController) {
      await rm(options.stateDirectory, { recursive: true });
      checkpoint!.restoreSessionDirectory(options.stateDirectory);
    }
    const recoveredDriver = new RunnerdDotDriver({ ...options,
      ...(pendingFinish ? { completionFeedback: recoveredCompletion } : {}),
      ...(emptyController ? { runnerBinary: join(root, "unavailable-old-runner"),
        runnerArtifact: { version: checkpoint!.runnerVersion, digest: checkpoint!.runnerDigest } } : {}),
      adoptExistingRunner: { ...spawned!, isAlive: () => true } });
    const recovered = await recoveredDriver.recoverSession(snapshot, { signal: new AbortController().signal });
    expect(recovered.recovered).toBe(true);
    session = recovered.session!;
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
  } finally {
    await session.close({ reason: "Test cleanup", force: true }).catch(() => {});
    if (spawned) { try { process.kill(spawned.pid, "SIGTERM"); } catch {} }
    await rm(root, { recursive: true, force: true });
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

it.each([false, true])("delivers complete dispatch and exact attachment pages through authenticated Rust PRP (startup failure=%s)", async startupFailure => {
  const root = await mkdtemp(join(tmpdir(), "dot-lossless-transport-"));
  const instructions = "Follow these synthetic instructions. ".repeat(300);
  await writeFile(join(root, "AGENTS.md"), instructions);
  const input = execution(root);
  const body = Buffer.from(Array.from({ length: 64379 }, (_, n) => (n * 73 + Math.floor(n / 251)) % 256));
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(body).digest("hex");
  const attachmentId = randomUUID();
  let send: ((op: ExternalProviderOperation) => Promise<void>) | undefined;
  let reads = 0;
  const settlements = new Map<string, any>();
  const dispatches: any[] = [];
  const identity = { runnerInstanceId: randomUUID(), environmentLeaseId: randomUUID(), runId: input.binding.runId,
    normalizedSessionId: input.session.normalizedSessionId!, turnId: "turn-" + input.binding.runId, itemId: "item-" + input.binding.runId };
  let handle: controlPlane.RunnerProcessHandle | undefined;
  let authority: controlPlane.DurablePrpControlPlane | undefined;
  const spawn = controlPlane.spawnRunner;
  const spawnSpy = vi.spyOn(controlPlane, "spawnRunner").mockImplementation(options => {
    handle = spawn(options);
    return handle;
  });
  const driver = new RunnerdDotDriver({
    execution: input, stateDirectory: join(root, "state"), identity,
    controlPlaneRegistration: startupFailure ? async core => {
      authority = core;
      await core.start();
      return { connectUrl: core.connectUrl, release: () => core.stop() };
    } : undefined,
    onSpawn: startupFailure ? async () => {
      await vi.waitFor(() => expect(authority?.activeRunnerConnectionCount()).toBeGreaterThan(0), { timeout: 5_000 });
      throw new Error("synthetic startup failure");
    } : undefined,
    runnerBinary: resolve("runner/target/debug/paperclip-runnerd"),
    dynamicTools: [{ name: "read_task_attachment", description: "Read a synthetic verified attachment", inputSchema: { type: "object" } }],
    dynamicToolHandler: async call => {
      reads++;
      const offset = (call.arguments as { offset: number }).offset;
      const end = Math.min(body.length, offset + 12000);
      return { attachmentId, sourceCommentId: null, filename: "fixture.bin", contentType: "application/octet-stream",
        byteSize: body.length, sha256: hash, encoding: "base64", content: body.subarray(offset, end).toString("base64"),
        offset, returnedBytes: end - offset, nextOffset: end < body.length ? end : null, contentTrust: "untrusted_attachment" };
    },
    port: { dispatch: async event => { dispatches.push(event); }, settle: async event => { settlements.set(String(event.payload.requestId), event.payload.outcome); },
      attach: async callback => { send = callback; return async () => { send = undefined; }; } },
  });
  let session: Awaited<ReturnType<typeof driver.openSession>> | undefined;
  const operation = (action: ExternalProviderOperation["action"], args: Record<string, unknown>): ExternalProviderOperation => ({
    requestId: randomUUID(), bindingId: input.provider.binding.bindingId, bindingGeneration: 1, runId: input.binding.runId,
    normalizedSessionId: input.session.normalizedSessionId!, turnId: identity.turnId, assignmentRevision: 1,
    action, input: args, digest: externalOperationDigest(action, args),
  });
  try {
    if (startupFailure) {
      await expect(driver.openSession({ runId: input.binding.runId, normalizedSessionId: input.session.normalizedSessionId! }))
        .rejects.toThrow("synthetic startup failure");
      expect(handle).toBeDefined();
      return;
    }
    session = await driver.openSession({ runId: input.binding.runId, normalizedSessionId: input.session.normalizedSessionId! });
    const text = "Preamble é. ".repeat(1500) + "CURRENT MESSAGE: read the complete attachment.";
    await session.startTurn({ message: { role: "user", text } });
    await vi.waitFor(() => expect(dispatches).toHaveLength(1));
    expect(dispatches[0].payload.text).toBe(text);
    expect(dispatches[0].payload.instructions).toContain(instructions.trim());
    await send!(operation("accept", {}));
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < body.length;) {
      const call = operation("tool", { name: "read_task_attachment", arguments: { attachmentId, offset, encoding: "base64", expectedSha256: hash } });
      await send!(call);
      await vi.waitFor(() => expect(settlements.get(call.requestId)?.status).toBe("completed"), { timeout: 10000 });
      const outcome = settlements.get(call.requestId);
      expect(outcome.isError).toBe(false);
      const page = outcome.result;
      const chunk = Buffer.from(page.content, "base64");
      expect(chunk.length).toBe(page.returnedBytes);
      expect(chunk.toString("base64")).toBe(page.content);
      expect(chunk).toEqual(body.subarray(offset, offset + page.returnedBytes));
      chunks.push(chunk);
      await send!(call);
      expect(settlements.get(call.requestId)).toEqual(outcome);
      offset += page.returnedBytes;
      expect(page.nextOffset).toBe(offset < body.length ? offset : null);
    }
    expect(chunks.map(chunk => chunk.length)).toEqual([12000, 12000, 12000, 12000, 12000, 4379]);
    expect(createHash("sha256").update(Buffer.concat(chunks)).digest("hex")).toBe(hash);
    expect(reads).toBe(6);
  } finally {
    spawnSpy.mockRestore();
    if (handle?.child.exitCode === null && handle.child.signalCode === null) handle.child.kill("SIGKILL");
    try {
      if (handle) await controlPlane.waitForProcess(handle, 5_000);
    } finally {
      await session?.detachControllerForRestart?.();
    }
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
