import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { RunnerdMuseDriver, type RunnerdMuseDriverOptions } from "./runnerd-muse-driver.js";
import { describeRunnerdNativeSessionBackend } from "../../backends/codex-native-backend.js";
import { createNativeSessionBackend } from "../../backends/native-backend-factory.js";
import * as controlPlane from "../../control-plane/durable-prp-control-plane.js";
import { externalOperationDigest, type ExternalProviderOperation } from "../../contracts/external-provider.js";
import { buildNativeModelEnvelope, parseNativeExecutionInput, type NativeExecutionInputV7 } from "../../contracts/native-execution.js";
import { NATIVE_RUNTIME_ASSET_SCHEMA, PAPERCLIP_EXECUTION_PROMPT, PAPERCLIP_EXECUTION_PROMPT_REVISION,
  nativeRuntimePromptDigest, canonicalNativeRuntimeContextDigest } from "../../contracts/runtime-context.js";

import { digestPaperclipSemanticContent } from "../../semantic-tools/receipts.js";
function execution(root: string): NativeExecutionInputV7 {
  const companyId = randomUUID(), agentId = randomUUID();
  const digest = "0".repeat(64);
  const context = {
    prompt: { revision: PAPERCLIP_EXECUTION_PROMPT_REVISION, text: PAPERCLIP_EXECUTION_PROMPT, digest: nativeRuntimePromptDigest() },
    instructions: { entryPath: "AGENTS.md", bundle: { schema: NATIVE_RUNTIME_ASSET_SCHEMA, digest, manifestDigest: digest, rootPath: root, fileCount: 1, totalBytes: 4 } },
    skills: [], mcp: { assignmentSetId: "none", digest, bindingId: null },
  };
  return parseNativeExecutionInput({
    schema: "paperclip.native-execution-input.v7",
    binding: { companyId, agentId, runId: randomUUID(), issueId: randomUUID(), executionWorkspaceId: randomUUID() },
    task: { identifier: "DOT-1", title: "Synthetic bridge recovery", description: null, prompt: "Read the synthetic counter.", workMode: "standard" },
    provider: { kind: "muse", model: null, bridgeRevision: "muse-v1", binding: { companyId, agentId, bindingId: randomUUID(), bindingGeneration: 1,
      acceptByUnixMs: Date.now() + 600_000, expiresAtUnixMs: Date.now() + 7_200_000 } },
    workspace: { access: "none", cwd: null, repoUrl: null, repoRef: null, branchName: null },
    session: { normalizedSessionId: randomUUID(), driverKind: "muse_external", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
    executionMode: "default", planningContext: null,
    completionContract: { id: randomUUID(), sha256: "sha256:" + digest, schemaVersion: "paperclip.completion-contract.v1",
      contract: { revision: "1", objective: "Read the counter", criteria: [{ id: "objective", requirement: "Read the counter" }] } },
    runtimeContext: { ...context, aggregateDigest: canonicalNativeRuntimeContextDigest(context) }, interactionResponses: [], credentialBindings: [],
  }) as NativeExecutionInputV7;
}

it("v7 closes Muse authority, workspace, credentials and bridge revision", () => {
  const input = execution("/synthetic/pinned-instructions");
  expect(buildNativeModelEnvelope(input).workspace).toBeNull();
  for (const changed of [
    { ...input, provider: { ...input.provider, bridgeRevision: "dot-mcp-v1" } },
    { ...input, session: { ...input.session, driverKind: "openai_dot_mcp" } },
    { ...input, workspace: { ...input.workspace, cwd: "/private/project" } },
    { ...input, provider: { ...input.provider, model: "a-model" } },
    { ...input, credentialBindings: [{ bindingId: "secret-binding", service: "muse", destination: "api.example.com", expiresAt: null, displayName: "API" }] },
  ]) expect(() => parseNativeExecutionInput(changed)).toThrow();
});
it("describes Muse without allocating a broker or process", async () => {
  const input = execution("/synthetic/pinned-instructions");
  const spawnSpy = vi.spyOn(controlPlane, "spawnRunner");
  try {
    const backend = createNativeSessionBackend(input, { museRunnerOptions: {
      stateDirectory: "/must-not-be-created", identity: { runnerInstanceId: randomUUID(), environmentLeaseId: randomUUID(), runId: input.binding.runId,
        normalizedSessionId: input.session.normalizedSessionId!, turnId: "turn", itemId: "item" },
      port: { dispatch: async () => {}, settle: async () => {}, inputAvailable: async () => {}, attach: async () => async () => {} },
    } });
    const descriptor = await describeRunnerdNativeSessionBackend(input);
    expect(descriptor).toEqual(await backend.descriptor());
    expect(descriptor).toMatchObject({ name: "muse_external", version: "muse-v1", capabilities: { runtimeRequestResolution: true, usage: false } });
    expect(spawnSpy).not.toHaveBeenCalled();
  } finally { spawnSpy.mockRestore(); }
});
it("uses the native request, exact question command ID and durable answer receipt across controller recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "muse-driver-input-"));
  await writeFile(join(root, "AGENTS.md"), "Use only first-party tools.");
  const input = execution(root);
  let send: ((operation: ExternalProviderOperation) => Promise<void>) | undefined;
  let spawned: { pid: number; processGroupId: number | null; startedAt: string } | undefined;
  const deliveries: Array<{ sourceEventId: string; payload: Record<string, unknown> }> = [];
  const settlements = new Map<string, unknown>();
  let controllerPort = 0;
  const options: RunnerdMuseDriverOptions = {
    execution: input, stateDirectory: join(root, "state"), runnerBinary: resolve("runner/target/debug/paperclip-runnerd"),
    identity: { runnerInstanceId: randomUUID(), environmentLeaseId: randomUUID(), runId: input.binding.runId,
      normalizedSessionId: input.session.normalizedSessionId!, turnId: "turn-" + input.binding.runId, itemId: "item-" + input.binding.runId },
    onSpawn: process => { spawned = process; },
    controlPlaneRegistration: async authority => { await authority.start(controllerPort); controllerPort = Number(new URL(authority.connectUrl).port);
      return { connectUrl: authority.connectUrl, release: () => authority.stop() }; },
    port: { dispatch: async () => {}, settle: async event => { settlements.set(String(event.payload.requestId), event.payload.outcome); },
      inputAvailable: async event => { deliveries.push(event); }, attach: async callback => { send = callback; return async () => { send = undefined; }; } },
  };
  const operation = (action: ExternalProviderOperation["action"], args: Record<string, unknown>): ExternalProviderOperation => ({
    requestId: randomUUID(), bindingId: input.provider.binding.bindingId, bindingGeneration: 1, runId: input.binding.runId,
    normalizedSessionId: input.session.normalizedSessionId!, turnId: options.identity.turnId, assignmentRevision: 1,
    action, input: args, digest: externalOperationDigest(action, args),
  });
  const commandSpy = vi.spyOn(controlPlane.DurablePrpControlPlane.prototype, "queueCommand");
  let driver = new RunnerdMuseDriver(options);
  let session = await driver.openSession({ runId: input.binding.runId, normalizedSessionId: input.session.normalizedSessionId! });
  try {
    const prepared = commandSpy.mock.calls.find(call => call[0] === "run.prepare");
    expect(JSON.stringify(prepared?.[1])).not.toContain("connections_search");
    expect(JSON.stringify(prepared?.[1])).not.toContain("search_api");
    await session.startTurn({ message: { role: "user", text: "Read the selected environment." } });
    await send!(operation("accept", {}));
    const requestId = "original-native-question";
    const questionSet = { schema: "paperclip.question_set.v1", questions: [{ id: "environment", prompt: "Which environment?", required: true,
      answerMode: "single_select", options: [{ id: "test", label: "Test" }, { id: "prod", label: "Production" }] }] };
    await send!(operation("request_user_input", { requestId, questionSet }));
    await vi.waitFor(() => expect(session.pendingRuntimeRequests!()).toMatchObject([{ requestId, turnId: options.identity.turnId, input: questionSet }]), { timeout: 10000 });
    const response = { schema: "paperclip.question_response.v1" as const, answers: { environment: { selectedOptionIds: ["test"] } } };
    const commandId = "question_" + randomUUID();
    await session.resolveRuntimeRequest!({ commandId, requestId, turnId: options.identity.turnId, resolution: { action: "submit", response } });
    expect(commandSpy).toHaveBeenCalledWith("request.resolve", { requestId, response }, commandId, true);
    await vi.waitFor(() => expect(deliveries).toHaveLength(1), { timeout: 10000 });
    const inputDigest = digestPaperclipSemanticContent({ requestId, turnId: options.identity.turnId, response });
    expect(deliveries[0]!.payload).toMatchObject({ requestId, turnId: options.identity.turnId, response, inputDigest });
    expect(session.pendingRuntimeRequests!()).toEqual([]);
    expect(await session.read!()).toMatchObject({ unconsumedInputs: 1 });
    const snapshot = await session.snapshot();
    await session.detachControllerForRestart!();
    driver = new RunnerdMuseDriver({ ...options, adoptExistingRunner: { ...spawned!, isAlive: () => true } });
    const recovered = await driver.recoverSession(snapshot, { signal: new AbortController().signal });
    expect(recovered.recovered).toBe(true);
    session = recovered.session!;
    expect(await session.read!()).toMatchObject({ unconsumedInputs: 1 });
    const consume = operation("consume_input", { requestId, inputDigest });
    await send!(consume);
    await vi.waitFor(() => expect(settlements.get(consume.requestId)).toMatchObject({ status: "consumed", requestId, inputDigest }), { timeout: 10000 });
    expect(await session.read!()).toMatchObject({ unconsumedInputs: 0 });
    const checkpoint = JSON.parse(await readFile(join(root, "state/runner/muse-provider-state.json"), "utf8"));
    expect(checkpoint).toMatchObject({ schema: "paperclip.runner.muse-provider-state.v1", runtimeInputs: { [requestId]: { consumed: true, inputDigest } } });
  } finally {
    commandSpy.mockRestore();
    await session.close({ reason: "Test cleanup", force: true }).catch(() => {});
    if (spawned) { try { process.kill(spawned.pid, "SIGTERM"); } catch {} }
    await rm(root, { recursive: true, force: true });
  }
}, 45000);
