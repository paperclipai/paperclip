// Independent, dependency-free npm harness fixture. It intentionally implements
// the public JSONL contract without importing a Paperclip runtime implementation.
const fs = require("node:fs");
const crypto = require("node:crypto");
const readline = require("node:readline");
let sequence = 0, correlation, provider, nativeTurn, completion, nativeSessionId;
let turns = 0;
let active = false;
const runtimeRequest = (requestId, requestKind) => emit("runtime_request.created", { request: {
  schema: "paperclip.runtime_request.v2", requestId, requestKind, type: requestKind === "runtime" ? "input" : "approval",
  status: "pending", prompt: "Continue the fixture operation?", turnId: correlation.turnId, itemId: `item-${requestId}`,
  ...(requestKind === "runtime" ? { input: { schema: "paperclip.question_set.v1", questions: [
    { id: "answer", prompt: "Provide the fixture answer", required: true, answerMode: "text" } ] } } : { details: { command: "fixture-only", cwd: provider.cwd } }),
} });
const reply = (id, result) => process.stdout.write(JSON.stringify({ schema: "paperclip.harness.v1", id, ok: true, result }) + "\n");
const emit = (eventType, payload) => process.stdout.write(JSON.stringify({ schema: "paperclip.harness.v1", sequence: ++sequence,
  eventType, priority: "p0", payload }) + "\n");
const canonical = value => JSON.stringify(value, (_key, entry) => entry && typeof entry === "object" && !Array.isArray(entry)
  ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
const call = (operationId, input) => emit("semantic_tool.input", { semantic_tool: {
  schema: "paperclip.prp.semantic_tool.v1", schemaVersion: 1, phase: "input", callId: `${operationId}_${turns}`,
  operationId, correlation, idempotencyKey: null, input,
  content: { digest: "sha256:" + crypto.createHash("sha256").update(canonical(input)).digest("hex"), redactionDisposition: "digest_only", references: [] },
} });

readline.createInterface({ input: process.stdin }).on("line", line => {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") {
    provider = params.provider;
    if (provider.mode === "plan" && provider.capabilities.planning !== true) throw Error("This fixture does not support native planning");
    correlation = params.correlation;
    turns = params.snapshot?.turns ?? 0;
    nativeSessionId = params.snapshot?.nativeSessionId ?? crypto.randomUUID();
    fs.writeFileSync(provider.config.pidPath, String(process.pid));
    return reply(id, { identity: params.identity, capabilities: provider.capabilities });
  }
  if (method === "snapshot") return reply(id, { nativeSessionId, turns });
  if (method === "close") return reply(id, {});
  const command = params.command;
  if (command.type === "session.open") emit("session.started", {
    threadId: `extension-thread-${nativeSessionId}`, sessionId: nativeSessionId, providerSessionId: nativeSessionId,
    processId: process.pid, runtimeIdentity: { executionKind: "local_process", processId: process.pid },
    providerDescriptor: { driver: "extension", providerVersion: "1.0.0", effectiveModel: provider.model },
  });
  if (command.type === "turn.start") {
    turns += 1;
    active = true;
    nativeTurn = command.payload.turnId;
    emit("turn.started", { providerTurnId: nativeTurn });
    reply(id, { providerTurnId: nativeTurn });
    if (provider.config.mode === "requests") runtimeRequest("fixture-question", "runtime");
    else if (provider.config.mode === "plan") {
      emit("item.completed", { providerTurnId: nativeTurn, item: { id: "native-plan", type: "plan", text: "A provider-owned native plan" } });
      emit("turn.completed", { providerTurnId: nativeTurn, status: "completed" });
      active = false;
    } else if (provider.config.mode !== "hold") call("get_fixture_value", {});
    return;
  }
  if (command.type === "request.resolve") {
    fs.appendFileSync(provider.config.outputPath, JSON.stringify(command.payload) + "\n");
    emit("runtime_request.resolved", { requestId: command.payload.requestId, action: command.payload.resolution?.action ?? "submit" });
    reply(id, {});
    if (command.payload.requestId === "fixture-question") runtimeRequest("fixture-approval", "command_approval");
    else if (command.payload.requestId === "fixture-approval") runtimeRequest("fixture-file-approval", "file_approval");
    else {
      emit("turn.completed", { providerTurnId: nativeTurn, status: "completed" });
      active = false;
    }
    return;
  }
  if (command.type === "semantic_tool.result" && command.payload.operationId === "get_fixture_value") {
    fs.writeFileSync(provider.config.outputPath, JSON.stringify({ turns, result: command.payload.result }));
    completion = { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Independent harness produced the verified file.",
      completionClaim: { contractRevision: "1", objectiveSatisfied: true,
        criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }], remainingWork: [] },
      evidence: [], verification: [{ commandOrCheck: "read supplied tool value and write fixture file", status: "passed" }], attentionRequests: [], artifacts: [] };
    reply(id, {});
    call("paperclip_finish", completion);
    return;
  }
  if (command.type === "semantic_tool.result" && command.payload.operationId === "paperclip_finish") {
    if (command.payload.isError) throw Error("Completion was rejected");
    reply(id, {});
    if (provider.config.mode !== "core-completion-only") emit("run.result.proposed", completion);
    else {
      const usage = { inputTokens: 123, outputTokens: 17, cacheReadTokens: 0, cacheWriteTokens: 0,
        activeSeconds: 0, requests: 5, providerCostUsd: 0.004 };
      emit("usage.reported", { provider: "fixture", model: provider.model, providerSessionId: nativeSessionId,
        providerRequestId: "fixture-final-request", cumulative: usage, runDeltaAvailable: true, runDeltaBasis: "run", runDelta: usage });
    }
    emit("item.completed", { providerTurnId: nativeTurn, item: { id: "fixture-final", type: "agentMessage", text: completion.summary } });
    emit("turn.completed", { providerTurnId: nativeTurn, status: "completed" });
    active = false;
    return;
  }
  if (active && ["turn.stop", "turn.interrupt", "run.cancel"].includes(command.type)) {
    emit("turn.cancelled", { providerTurnId: nativeTurn, status: "cancelled" });
    active = false;
  }
  reply(id, { sessionId: nativeSessionId, providerSessionId: nativeSessionId, threadId: `extension-thread-${nativeSessionId}`, providerTurnId: nativeTurn });
});
