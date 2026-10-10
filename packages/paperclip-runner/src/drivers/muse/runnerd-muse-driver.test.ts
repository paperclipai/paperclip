import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

import { HarnessDriverBackend } from "../../backends/harness-driver-backend.js";
import { executeNativeSession } from "../../native-session-runtime.js";
import type { NativeSession } from "../../contracts/native-session-backend.js";
import type { ControlPlanePort } from "../../contracts/control-plane-port.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";
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
    expect(descriptor).toMatchObject({ name: "muse_external", version: "muse-v1", capabilities: { runtimeRequestResolution: true, runtimeRequestHandoff: true, usage: false } });
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
    const handoff = { requestId, turnId: options.identity.turnId, reason: "durable_handoff" as const, signal: new AbortController().signal };
    expect(session.handoffRuntimeRequest!(handoff).result).toBe("handed_off");
    expect(session.handoffRuntimeRequest!({ ...handoff, turnId: "other-turn" }).result).toBe("already_settled");
    expect(session.handoffRuntimeRequest!({ ...handoff, signal: AbortSignal.abort() }).result).toBe("already_settled");
    const waitingSnapshot = await session.snapshot();
    await session.detachControllerForRestart!();
    driver = new RunnerdMuseDriver({ ...options, adoptExistingRunner: { ...spawned!, isAlive: () => true } });
    const waitingRecovery = await driver.recoverSession(waitingSnapshot, { signal: new AbortController().signal });
    expect(waitingRecovery.recovered).toBe(true);
    session = waitingRecovery.session!;
    expect(session.pendingRuntimeRequests!()).toMatchObject([{ requestId }]);
    expect(session.handoffRuntimeRequest!(handoff).result).toBe("handed_off");
    await expect(session.resolveRuntimeRequest!({ commandId: "invalid_question_answer", requestId, turnId: options.identity.turnId,
      resolution: { action: "submit", response: { schema: "paperclip.question_response.v1", answers: { environment: { selectedOptionIds: ["missing-option"] } } } } })).rejects.toThrow();
    expect(session.handoffRuntimeRequest!(handoff).result).toBe("handed_off");
    const response = { schema: "paperclip.question_response.v1" as const, answers: { environment: { selectedOptionIds: ["test"] } } };
    const commandId = "question_" + randomUUID();
    await session.resolveRuntimeRequest!({ commandId, requestId, turnId: options.identity.turnId, resolution: { action: "submit", response } });
    expect(commandSpy).toHaveBeenCalledWith("request.resolve", { requestId, response }, commandId, true);
    await vi.waitFor(() => expect(deliveries).toHaveLength(1), { timeout: 10000 });
    const inputDigest = digestPaperclipSemanticContent({ requestId, turnId: options.identity.turnId, response });
    expect(deliveries[0]!.payload).toMatchObject({ requestId, turnId: options.identity.turnId, response, inputDigest });
    expect(session.pendingRuntimeRequests!()).toEqual([]);
    expect(session.handoffRuntimeRequest!(handoff).result).toBe("already_settled");
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

it("keeps the exact Muse question and assignment alive past the native live window, then settles a delayed answer", async () => {
  const root = await mkdtemp(join(tmpdir(), "muse-native-live-window-"));
  await writeFile(join(root, "AGENTS.md"), "Use only first-party tools.");
  const input = execution(root);
  const events: PrpEvent[] = [];
  const dispatches: PrpEvent[] = [];
  const deliveries: PrpEvent[] = [];
  const settlements = new Map<string, Record<string, unknown>>();
  let send: ((operation: ExternalProviderOperation) => Promise<void>) | undefined;
  let spawned: { pid: number; processGroupId: number | null; startedAt: string } | undefined;
  let nativeSession: NativeSession | undefined;
  let handoffSpy: ReturnType<typeof vi.spyOn> | undefined;
  let completed = false;
  const identity = { runnerInstanceId: randomUUID(), environmentLeaseId: randomUUID(), runId: input.binding.runId,
    normalizedSessionId: input.session.normalizedSessionId!, turnId: "turn-" + input.binding.runId, itemId: "item-" + input.binding.runId };
  const driver = new RunnerdMuseDriver({
    execution: input, stateDirectory: join(root, "state"), identity,
    runnerBinary: resolve("runner/target/debug/paperclip-runnerd"), onSpawn: process => { spawned = process; },
    port: { dispatch: async event => { dispatches.push(event); }, inputAvailable: async event => { deliveries.push(event); },
      settle: async event => { settlements.set(String(event.payload.requestId), event.payload.outcome as Record<string, unknown>); },
      attach: async callback => { send = callback; return async () => { send = undefined; }; } },
  });
  const port: ControlPlanePort = {
    async openRun() {}, async checkpointSession() {},
    async appendEvent(event) {
      const durable = event as PrpEvent;
      if (!events.some(saved => saved.sourceEventId === durable.sourceEventId)) events.push(structuredClone(durable));
      return { cursor: events.length, highestContiguousSourceSeq: durable.sourceSeq, disposition: "committed" };
    },
    async replayEvents(query) {
      const replay = events.filter(event => event.sourceInstanceId === query.sourceInstanceId && event.sourceSeq > query.afterSourceSeq);
      return { events: replay, highestContiguousSourceSeq: replay.at(-1)?.sourceSeq ?? query.afterSourceSeq };
    },
    async completeRun() { completed = true; },
  };
  const abort = new AbortController();
  const running = executeNativeSession({ input, backend: new HarnessDriverBackend(driver), controlPlane: port,
    runnerInstanceId: identity.runnerInstanceId, controlPlaneInstanceId: randomUUID(), runtimeInputLiveWindowMs: 60,
    requireSessionCloseBeforeReturn: true, signal: abort.signal,
    onSession: session => { if (session) { nativeSession = session; handoffSpy = vi.spyOn(session, "handoffRuntimeRequest"); } },
  });
  void running.catch(() => undefined);
  const operation = (action: ExternalProviderOperation["action"], args: Record<string, unknown>): ExternalProviderOperation => ({
    requestId: randomUUID(), bindingId: input.provider.binding.bindingId, bindingGeneration: 1, runId: input.binding.runId,
    normalizedSessionId: identity.normalizedSessionId, turnId: identity.turnId, assignmentRevision: 1,
    action, input: args, digest: externalOperationDigest(action, args),
  });
  let stage = "assignment-dispatch";
  try {
    await vi.waitFor(() => expect(dispatches).toHaveLength(1), { timeout: 10000 });
    expect(await nativeSession!.capabilities()).toMatchObject({ runtimeRequestResolution: true, runtimeRequestHandoff: true });
    await send!(operation("accept", {}));
    stage = "durable-question-handoff";
    const requestId = "delayed-native-question";
    const questionSet = { schema: "paperclip.question_set.v1", questions: [{ id: "environment", prompt: "Which environment?", required: true,
      answerMode: "single_select", options: [{ id: "test", label: "Test" }] }] };
    await send!(operation("request_user_input", { requestId, questionSet }));
    await vi.waitFor(() => expect(handoffSpy).toHaveBeenCalledOnce(), { timeout: 10000 });
    expect(handoffSpy!.mock.results[0]!.value).toMatchObject({ result: "handed_off" });
    const checkpoint = JSON.parse(await readFile(join(root, "state/runner/muse-provider-state.json"), "utf8"));
    expect(checkpoint).toMatchObject({ lifecycle: "running", runtimeInputs: { [requestId]: { request: { requestId, status: "pending" }, response: null, consumed: false } } });
    expect(events.filter(event => event.eventType === "runtime_request.created")).toHaveLength(1);
    expect(events.some(event => ["runtime_request.expired", "turn.cancelled", "run.terminal"].includes(event.eventType))).toBe(false);
    expect(completed).toBe(false);
    const response = { schema: "paperclip.question_response.v1" as const, answers: { environment: { selectedOptionIds: ["test"] } } };
    stage = "delayed-answer-resolution";
    await nativeSession!.resolveRuntimeRequest!({ commandId: "question_delayed-interaction", requestId, turnId: identity.turnId, resolution: { action: "submit", response } });
    await vi.waitFor(() => expect(events.some(event => event.eventType === "runtime_request.resolved")).toBe(true), { timeout: 10000 });
    const resolved = events.find(event => event.eventType === "runtime_request.resolved")!;
    expect(resolved.payload).toMatchObject({ requestId, turnId: identity.turnId, action: "submit", response });
    await vi.waitFor(() => expect(deliveries).toHaveLength(1), { timeout: 10000 });
    const inputDigest = digestPaperclipSemanticContent({ requestId, turnId: identity.turnId, response });
    const consume = operation("consume_input", { requestId, inputDigest });
    stage = "answer-ingestion";
    await send!(consume);
    await vi.waitFor(() => expect(settlements.get(consume.requestId)).toMatchObject({ status: "consumed", requestId, inputDigest }), { timeout: 10000 });
    const result = { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Ingested the delayed answer",
      completionClaim: { contractRevision: "1", objectiveSatisfied: true, criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }], remainingWork: [] },
      evidence: [], verification: [], attentionRequests: [], artifacts: [] };
    stage = "canonical-completion";
    const completion = operation("tool", { name: "paperclip_finish", arguments: result });
    await send!(completion);
    await vi.waitFor(() => expect(settlements.get(completion.requestId)).toMatchObject({ status: "completed", isError: false }), { timeout: 10000 });
    await send!(operation("finish", { result }));
    stage = "native-finalization";
    await expect(running).resolves.toMatchObject({ result: { reportedWorkDisposition: "done" } });
    expect(completed).toBe(true);
    expect(events.some(event => event.eventType === "runtime_request.expired")).toBe(false);
    expect(handoffSpy).toHaveBeenCalledOnce();
  } catch (error) {
    throw new Error(`Muse native live-window regression failed at ${stage}`, { cause: error });
  } finally {
    abort.abort(new Error("Synthetic native live-window test cleanup"));
    const settled = await Promise.race([
      running.then(() => true, () => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 5000)),
    ]);
    handoffSpy?.mockRestore();
    if (spawned) { try { process.kill(spawned.pid, "SIGTERM"); } catch {} }
    if (settled) await rm(root, { recursive: true, force: true });
  }
}, 45000);
