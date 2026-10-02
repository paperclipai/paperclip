// Protocol fixture: no provider network calls and no secrets.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const home = process.env.PI_CODING_AGENT_DIR;
mkdirSync(join(home, "sessions"), { recursive: true });
const sessionFile = join(home, "sessions", "fixture.jsonl");
writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "fixture-session", cwd: process.cwd() }) + "\n");
let assistantActive = false;
let messageTimestamp = 0;
const nativeMessage = (stopReason = "stop", usage = {}) => ({ role: "assistant", timestamp: messageTimestamp, content: [], stopReason, usage });
// Protocol fixture emits Pi 1's serialized delta form. Actual SDK serialization
// and the owned extension are exercised separately by the local-only package test.
const streamBlocks = new Map();
const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
const output = value => {
  if (value.type === "message_start" && value.message?.role === "assistant") streamBlocks.clear();
  if (value.type === "message_update") {
    const original = value.assistantMessageEvent;
    const kind = original.type.split("_")[0];
    const index = original.contentIndex ?? (kind === "thinking" ? 1 : 0);
    if (original.type === "toolcall_start") {
      const call = original.toolCall ?? original.partial?.content?.[index];
      streamBlocks.set(index, { kind, call });
      emit({ type: "message_update", usage: {}, assistantMessageEvent: { type: "toolcall_start", contentIndex: index, id: call.id, toolName: call.name } });
      return;
    }
    if (!streamBlocks.has(index)) {
      streamBlocks.set(index, { kind, text: "" });
      emit({ type: "message_update", usage: {}, assistantMessageEvent: { type: `${kind}_start`, contentIndex: index } });
    }
    if (typeof original.delta === "string") streamBlocks.get(index).text += original.delta;
    const { partial: _partial, ...delta } = original;
    emit({ type: "message_update", usage: {}, assistantMessageEvent: { ...delta, contentIndex: index } }); return;
  }
  if (value.type === "message_end" && value.message?.role === "assistant") {
    const content = [];
    for (const [index, block] of streamBlocks) {
      content[index] = block.call ?? { type: block.kind, [block.kind === "text" ? "text" : "thinking"]: block.text };
      emit({ type: "message_update", usage: {}, assistantMessageEvent: { type: `${block.kind}_end`, contentIndex: index, ...(block.call ? { toolCall: block.call } : { content: block.text }) } });
    }
    value = { ...value, message: { ...value.message, content } };
    streamBlocks.clear();
  }
  emit(value);
};
const endMessage = (stopReason = "stop", usage = { input: 11, output: 3, cacheRead: 2, cacheWrite: 0, cost: { total: 0.01 } }) => {
  output({ type: "message_end", message: nativeMessage(stopReason, usage) }); assistantActive = false;
};
let active = false;
let modelIteration = 0;
const invocationNamespace = JSON.parse(process.env.PAPERCLIP_PI_RUNTIME_CONFIGURATION).invocationNamespace;
const toolIdentity = (id) => `pi-${createHash("sha256").update(JSON.stringify([invocationNamespace, modelIteration, id])).digest("hex")}`;
const begin = () => { modelIteration++; output({ type: "turn_start" });
  messageTimestamp++; assistantActive = true; output({ type: "message_start", message: nativeMessage() });
};
let model = "fixture-model";
const thinkingFile = join(home, "thinking.json");
let thinkingLevel = existsSync(thinkingFile) ? JSON.parse(readFileSync(thinkingFile, "utf8")) : process.env.PI_FIXTURE_THINKING_CURRENT ?? "off";
const availableThinkingLevels = () => model === "fixture-alternate" ? ["off", "high"] : ["off", "low", "high", "max"];
const compaction = () => ({ firstKeptEntryId: "fixture-entry", tokensBefore: 50, summary: "Fixture compacted", usage: { input: 5, output: 2, cacheRead: 1, cacheWrite: 0, cost: { total: 0.02 } } });
const finish = (answer = "done") => {
  if (!assistantActive) { output({ type: "turn_end" }); begin(); }
  output({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: answer } });
  endMessage();
  output({ type: "turn_end" });
  output({ type: "agent_end" });
  // An agent_end alone must not settle the ACP prompt.
  setTimeout(() => { active = false; output({ type: "agent_settled" }); }, 15);
};
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  const response = (data = {}) => output({ type: "response", id: request.id, command: request.type, success: true, data });
  if (request.type === "extension_ui_response") { finish(JSON.stringify(request)); return; }
  if (request.type === "get_state") { response({ sessionId: "fixture-session", sessionFile, model: { provider: "openrouter", id: model }, thinkingLevel }); return; }
  if (request.type === "get_available_thinking_levels") {
    const scenario = process.env.PI_FIXTURE_THINKING_CAPABILITIES;
    if (scenario === "failed") { output({ type: "response", id: request.id, command: request.type, success: false, error: "fixture capability failure" }); return; }
    response({ levels: scenario === "duplicate" ? ["off", "off"] : scenario === "unknown" ? ["off", "future"] : scenario === "empty" ? [] : scenario === "missing" ? undefined : availableThinkingLevels() }); return;
  }
  if (request.type === "set_thinking_level") {
    appendFileSync(join(home, "thinking-calls.jsonl"), JSON.stringify(request.level) + "\n");
    thinkingLevel = process.env.PI_FIXTURE_THINKING_CLAMP === "1" ? "high" : request.level;
    writeFileSync(thinkingFile, JSON.stringify(thinkingLevel)); response(); return;
  }
  if (request.type === "get_available_models") { response({ models: [{ provider: "openrouter", id: "fixture-model", name: "Fixture" }, { provider: "openrouter", id: "fixture-alternate", name: "Alternate" }] }); return; }
  if (request.type === "set_model") { model = request.modelId; if (!availableThinkingLevels().includes(thinkingLevel)) thinkingLevel = "high"; response({ model: { provider: request.provider, id: model } }); return; }
  if (request.type === "get_messages") { response({ messages: process.env.PI_FIXTURE_HISTORY ? [
    { role: "toolResult", toolName: "mcp__paperclip__paperclip_finish", toolCallId: "call_0", content: [{ type: "text", text: "correct criteria" }], isError: true },
    { role: "toolResult", toolName: "mcp__paperclip__paperclip_finish", toolCallId: "call_0", content: [{ type: "text", text: "accepted" }] },
    { role: "assistant", content: [{ type: "text", text: "Historical reply" }] },
  ] : [] }); return; }
  if (request.type === "get_commands") { response({ commands: process.env.PI_FIXTURE_EXTENSION_FAIL ? [] : [{ name: "paperclip-runtime-ready-v1", description: "Paperclip runtime gate v1", source: "extension" }] }); return; }
  const inputDisposition = process.env.PI_FIXTURE_INPUT_DISPOSITION === "missing" ? {} : { disposition: process.env.PI_FIXTURE_INPUT_DISPOSITION === "malformed" ? { queued: true } : process.env.PI_FIXTURE_INPUT_DISPOSITION ?? "queued" };
  if (request.type === "steer") { response(inputDisposition); if (inputDisposition.disposition !== "queued") return; output({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `steered:${request.message}` } }); return; }
  if (request.type === "follow_up") { response(inputDisposition); if (inputDisposition.disposition !== "queued") return; finish(`follow-up:${request.message}`); return; }
  if (request.type === "compact") { output({ type: "compaction_start", reason: "manual" }); const result = compaction(); output({ type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false }); response(result); return; }
  if (request.type === "abort") { response(); if (active) { active = false; if (assistantActive) endMessage("aborted", {}); output({ type: "turn_end" }); output({ type: "agent_settled" }); } return; }
  if (request.type === "prompt") {
    response({ disposition: "started" }); active = true; output({ type: "agent_start" });
    if (request.message === "missing-message-start") { modelIteration++; output({ type: "turn_start" }); output({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "invalid" } }); return; }
    begin();
    if (request.message === "duplicate-message-start") { output({ type: "message_start", message: nativeMessage() }); return; }
    if (request.message === "mismatched-message-end") { output({ type: "message_end", message: { ...nativeMessage(), timestamp: messageTimestamp + 1 } }); return; }
    if (request.message === "missing-message-end") { output({ type: "agent_settled" }); return; }
    if (["narration-final", "tool-only", "empty-final"].includes(request.message)) {
      output({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Calling finish." } });
      endMessage("toolUse", {});
      const args = {}; output({ type: "tool_execution_start", toolCallId: "finish", toolName: "paperclip_finish", args });
      output({ type: "tool_execution_end", toolCallId: "finish", toolName: "paperclip_finish", result: { content: [{ type: "text", text: "accepted" }] } });
      if (request.message === "tool-only") { output({ type: "turn_end" }); active = false; output({ type: "agent_settled" }); }
      else finish(request.message === "empty-final" ? "" : "EXACT_MARKER");
      return;
    }
    if (request.message === "reused-tool-ids") {
      for (const [index, toolName] of ["mcp__paperclip__paperclip_finish", "mcp__paperclip__paperclip_finish", "mcp__paperclip__get_task_context"].entries()) {
        if (index) { output({ type: "turn_end" }); begin(); }
        const args = { revision: index + 1 };
        output({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: { content: [{ type: "toolCall", id: "call_0", name: toolName, arguments: args }] } } });
        endMessage("toolUse", {});
        output({ type: "tool_execution_start", toolCallId: "call_0", toolName, args });
        output({ type: "tool_execution_update", toolCallId: "call_0", toolName, partialResult: { content: [{ type: "text", text: "working" }] } });
        output({ type: "tool_execution_end", toolCallId: "call_0", toolName, result: { content: [{ type: "text", text: index ? "accepted" : "correct criteria" }] }, isError: index === 0 });
      }
      finish("reused IDs handled"); return;
    }
    if (request.message.startsWith("bash-")) {
      const failure = request.message === "bash-failure";
      const oversized = request.message === "bash-oversized";
      const args = { command: failure ? "printf failure >&2; exit 7" : "printf done", timeout: 3 };
      const result = { content: [{ type: "text", text: oversized ? "x".repeat(65536) : failure ? "failure\n" : "done\n" }], details: { exitCode: failure ? 7 : 0, truncated: false } };
      output({ type: "tool_execution_start", toolCallId: "bash-fixture", toolName: "bash", args });
      output({ type: "tool_execution_update", toolCallId: "bash-fixture", toolName: "bash", partialResult: { content: [{ type: "text", text: "partial" }] } });
      output({ type: "tool_execution_end", toolCallId: "bash-fixture", toolName: "bash", result, isError: failure });
      finish("bash completed"); return;
    }
    if (request.message === "die") { process.exit(4); }
    if (request.message === "long") return;
    if (["retry-success", "retry-failure", "retry-unknown"].includes(request.message)) {
      output({ type: "auto_retry_start", attempt: 2, maxAttempts: 2, delayMs: 10, errorMessage: "Fixture provider unavailable" });
      output({ type: "auto_retry_end", attempt: 2, ...(request.message === "retry-unknown" ? {} : { success: request.message === "retry-success" }) });
      if (request.message === "retry-failure") {
        endMessage("error", { input: 1, output: 0 });
        active = false; output({ type: "turn_end" }); output({ type: "agent_settled" });
      } else finish("retry outcome received");
      return;
    }
    if (request.message === "auto-compact" || request.message === "retry-compact") { output({ type: "compaction_start", reason: "threshold" }); if (request.message === "retry-compact") output({ type: "summarization_retry_scheduled" }); output({ type: "compaction_end", reason: "threshold", result: compaction(), aborted: false, willRetry: true }); finish("compacted"); return; }
    if (request.message === "question") { output({ type: "extension_ui_request", id: "question-id", method: "input", title: "Project name", placeholder: "Name" }); return; }
    if (request.message === "oversized-question") { output({ type: "extension_ui_request", id: "oversized", method: "select", title: "Native question", options: ["x".repeat(1001)] }); return; }
    if (request.message.startsWith("native-question-")) {
      const method = request.message.slice("native-question-".length);
      output({ type: "extension_ui_request", id: `native-${method}`, method, title: "Native question", options: ["Red", "Blue"], message: "Continue?", placeholder: "Name", prefill: "Old\ntext" }); return;
    }
    if (request.message === "permission") { output({ type: "extension_ui_request", id: "permission-id", method: "select", title: "paperclip.pi.permission.v1:" + JSON.stringify({toolCallId:toolIdentity("tool-1"),nativeToolCallId:"tool-1",modelIteration,toolName:"bash",input:{command:"pwd"}}), options: ["Allow once", "Allow for this session", "Deny"] }); return; }
    if (request.message === "failure") {
      endMessage("error", { input: 1, output: 0 });
      active = false; output({ type: "turn_end" }); output({ type: "agent_settled" }); return;
    }
    output({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "fixture reasoning" } });
    finish("hello🌒\u2028world"); return;
  }
  response();
}).on("close", () => process.exit(0));
