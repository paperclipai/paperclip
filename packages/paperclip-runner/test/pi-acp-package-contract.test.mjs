import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Optional test-only package location permits the isolated Pi branch to test
// before the integration owner updates package.json and the shared lockfile.
const packageJson = process.env.PAPERCLIP_TEST_PI_ACP_PACKAGE
  ?? createRequire(import.meta.url).resolve("pi-acp/package.json");
const packageRoot = dirname(packageJson);
const packageMetadata = JSON.parse(await readFile(packageJson, "utf8"));
const packageSource = await readFile(join(packageRoot, "dist/index.js"), "utf8");
const helperSource = await readFile(join(packageRoot, "dist/paperclip-runtime.js"), "utf8");
const localHelper = await readFile(new URL("../src/drivers/acpx/pi-acp-runtime.ts", import.meta.url), "utf8");
const normalize = (source) => source.split("\n").map((line) => line.trimEnd()).join("\n");

test("Pi patch embeds the reviewed helper and pins exact upstream version", () => {
  assert.equal(packageMetadata.version, "0.0.33");
  assert.equal(normalize(helperSource), normalize(stripTypeScriptTypes(localHelper)));
  assert.match(packageSource, /createPiLaunchSpec\(params, process\.env\)/);
  assert.match(packageSource, /shell: false/);
  assert.match(packageSource, /snapshotPiWorkspaceFile\(this\.cwd, abs\)/);
});

async function fixture(t, extra = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-pi-acp-contract-")));
  await mkdir(join(root, "workspace")); await mkdir(join(root, "agent"));
  await writeFile(join(root, "extension.js"), "export default function() {}\n");
  const fakePi = fileURLToPath(new URL("../test-fixtures/pi-acp/fake-pi.mjs", import.meta.url));
  const child = spawn(process.execPath, [join(packageRoot, "dist/index.js")], {
    cwd: join(root, "workspace"), stdio: "pipe",
    env: {
      PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: join(root, "agent"),
      PAPERCLIP_ACPX_ISOLATED_CONTEXT: "1", PAPERCLIP_PI_READ_ONLY: "0",
      PAPERCLIP_PI_NODE_EXECUTABLE: await realpath(process.execPath),
      PAPERCLIP_PI_ENTRYPOINT: fakePi, PAPERCLIP_PI_EXTENSION_PATH: join(root, "extension.js"),
      ...extra,
    },
  });
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
  const pending = new Map(); const notifications = []; const requests = [];
  let id = 0; let answer = async (request) => request.method === "session/request_permission"
    ? { outcome: { outcome: "selected", optionId: "allow_once" } }
    : { action: "accept", content: { answer: "Paperclip" } };
  const send = (value) => child.stdin.write(JSON.stringify(value) + "\n");
  const receive = (line) => {
    const message = JSON.parse(line);
    if (message.method && Object.hasOwn(message, "id")) {
      requests.push(message);
      void answer(message).then((result) => send({ jsonrpc: "2.0", id: message.id, result }));
    } else if (Object.hasOwn(message, "id")) {
      const waiter = pending.get(message.id); pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(JSON.stringify(message.error))); else waiter?.resolve(message.result);
    } else notifications.push(message);
  };
  const decoder = new StringDecoder("utf8"); let buffered = "";
  child.stdout.on("data", (chunk) => {
    buffered += decoder.write(chunk);
    for (;;) { const at = buffered.indexOf("\n"); if (at < 0) break; const line = buffered.slice(0, at); buffered = buffered.slice(at + 1); if (line.trim()) receive(line); }
  });
  child.once("exit", () => { for (const waiter of pending.values()) waiter.reject(new Error(`wrapper exited: ${stderr}`)); pending.clear(); });
  const call = (method, params) => new Promise((resolve_, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`timeout: ${method}: ${stderr}`)); }, 5000);
    pending.set(requestId, { resolve: (value) => { clearTimeout(timer); resolve_(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    send({ jsonrpc: "2.0", id: requestId, method, params });
  });
  t.after(async () => {
    child.stdin.end();
    if (child.exitCode === null) { const timer = setTimeout(() => child.kill("SIGKILL"), 3000); await once(child, "exit"); clearTimeout(timer); }
    await rm(root, { recursive: true, force: true });
  });
  const initialized = await call("initialize", { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } });
  return { call, notify(method, params) { send({ jsonrpc: "2.0", method, params }); }, initialized, root, notifications, requests, setAnswer(value) { answer = value; } };
}

test("actual patched ACP process streams thinking and waits for settlement with usage", async (t) => {
  const f = await fixture(t);
  assert.equal(f.initialized.agentCapabilities._meta.paperclipPi.steering, true);
  assert.deepEqual(f.initialized.authMethods, []);
  const session = await f.call("session/new", { cwd: join(f.root, "workspace"), mcpServers: [] });
  const result = await f.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] });
  assert.equal(result.stopReason, "end_turn"); assert.equal(result.usage.inputTokens, 11); assert.equal(result.usage.totalTokens, 16);
  assert.ok(f.notifications.some((event) => event.params?.update?.sessionUpdate === "agent_thought_chunk"));
  assert.ok(f.notifications.some((event) => event.params?.update?.content?.text === "hello🌒\u2028world"));
});

for (const scenario of ["narration-final", "tool-only", "empty-final"]) test(`actual patched wrapper preserves native message provenance for ${scenario}`, async t => {
  const f = await fixture(t); const session = await f.call("session/new", { cwd: join(f.root, "workspace"), mcpServers: [] });
  for (let warm = 0; warm < 2; warm++) {
    const from = f.notifications.length;
    await f.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: scenario }] });
    const updates = f.notifications.slice(from).map(event => event.params?.update).filter(update => update?.sessionUpdate === "agent_message_chunk");
    assert.ok(updates.every(update => /^pi-message-[a-f0-9]{64}$/.test(update.messageId)));
    assert.equal(updates[0]._meta.kind, "start"); assert.equal(updates[0].content.text, "");
    assert.equal(updates[1].content.text, "Calling finish.");
    assert.equal(updates[2]._meta.kind, "end:toolUse");
    if (scenario === "tool-only") assert.equal(updates.length, 3);
    else {
      assert.equal(updates[3]._meta.kind, "start"); assert.notEqual(updates[3].messageId, updates[0].messageId);
      assert.equal(updates[4].content.text, scenario === "empty-final" ? "" : "EXACT_MARKER");
      assert.equal(updates[5]._meta.kind, "end:stop");
    }
  }
});

for (const scenario of ["missing-message-start", "duplicate-message-start", "mismatched-message-end", "missing-message-end"]) test(`actual wrapper rejects malformed native boundaries: ${scenario}`, async t => {
  const f = await fixture(t); const session = await f.call("session/new", { cwd: join(f.root, "workspace"), mcpServers: [] });
  await assert.rejects(f.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: scenario }] }), /exited|Internal error/);
  const failure = f.notifications.find(event => event.method === "paperclip/pi_notice" && event.params.category === "runtime_failure");
  assert.ok(failure, "native failure notice is flushed before prompt rejection");
  assert.ok(["rpc_delta_boundary_invalid", "assistant_boundary_invalid"].includes(failure.params.details.reason));
  assert.equal(failure.params.severity, "error");
});

test("actual patched ACP process scopes recycled native IDs across iterations and warm prompts", async (t) => {
  const f = await fixture(t); const session = await f.call("session/new", { cwd: join(f.root, "workspace"), mcpServers: [] });
  for (let turn = 0; turn < 2; turn++) await f.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "reused-tool-ids" }] });
  const updates = f.notifications.map(event => event.params?.update).filter(update => update?.toolCallId);
  const starts = updates.filter(update => update.sessionUpdate === "tool_call");
  assert.equal(starts.length, 6);
  assert.equal(new Set(starts.map(update => update.toolCallId)).size, 6, "each model iteration has an independent tool identity");
  for (const start of starts) {
    assert.match(start.toolCallId, /^pi-[a-f0-9]{64}$/);
    const lifecycle = updates.filter(update => update.toolCallId === start.toolCallId);
    assert.ok(lifecycle.some(update => update.status === "in_progress"));
    assert.equal(lifecycle.filter(update => ["failed", "completed"].includes(update.status)).length, 1);
    assert.ok(lifecycle.every(update => update._meta.paperclipPi.nativeToolCallId === "call_0"));
  }
  assert.deepEqual(starts.map(update => update._meta.paperclipPi.modelIteration), [1, 2, 3, 5, 6, 7]);
});

test("cancellation closes the iteration before a warm prompt reuses native IDs", async (t) => {
  const f = await fixture(t); const session = await f.call("session/new", { cwd: join(f.root, "workspace"), mcpServers: [] });
  const active = f.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "long" }] });
  // The acknowledged native control is a FIFO barrier proving prompt admission.
  await f.call("pi/steer", { sessionId: session.sessionId, message: "fixture admission fence" });
  f.notify("session/cancel", { sessionId: session.sessionId }); await active;
  const warm = await f.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "reused-tool-ids" }] });
  assert.equal(warm.stopReason, "end_turn");
  const starts = f.notifications.map(event => event.params?.update).filter(update => update?.sessionUpdate === "tool_call");
  assert.deepEqual(starts.map(update => update._meta.paperclipPi.modelIteration), [2, 3, 4]);
  assert.equal(new Set(starts.map(update => update.toolCallId)).size, 3);
});

test("acknowledged native cancellation preserves partial usage and refuses service-failure metadata", async t => {
  const f = await fixture(t, { PI_FIXTURE_CANCEL_ERROR: "1" });
  const session = await f.call("session/new", { cwd: join(f.root, "workspace"), mcpServers: [] });
  const active = f.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "long" }] });
  await f.call("pi/steer", { sessionId: session.sessionId, message: "fixture admission fence" });
  f.notify("session/cancel", { sessionId: session.sessionId });
  const result = await active;
  assert.equal(result.stopReason, "cancelled");
  assert.equal(result._meta, undefined);
  assert.equal(result.usage.inputTokens, 11);
  assert.equal(result.usage.outputTokens, 3);
  assert.equal(result.usage.cachedReadTokens, undefined);
  assert.equal(result.usage._meta.paperclipPi.costUsd, undefined);
});

test("warm load uses stable display-only history IDs distinct from live execution", async (t) => {
  const f = await fixture(t, { PI_FIXTURE_HISTORY: "1" });
  const session = await f.call("session/new", { cwd: join(f.root, "workspace"), mcpServers: [] });
  const loads = [];
  for (let load = 0; load < 2; load++) {
    f.notifications.length = 0;
    await f.call("session/load", { sessionId: session.sessionId, cwd: join(f.root, "workspace"), mcpServers: [] });
    const starts = f.notifications.map(event => event.params?.update).filter(update => update?.sessionUpdate === "tool_call");
    assert.equal(starts.length, 2);
    const historicalMessage = f.notifications.map(event => event.params?.update).find(update => update?.content?.text === "Historical reply");
    assert.match(historicalMessage.messageId, /^pi-history-message-[a-f0-9]{64}$/);
    assert.deepEqual(historicalMessage._meta, { origin: "pi-history-assistant", source: "pi-session-history-v1", kind: "history" });
    assert.notEqual(starts[0].toolCallId, starts[1].toolCallId);
    for (const start of starts) {
      assert.match(start.toolCallId, /^pi-history-[a-f0-9]{64}$/);
      assert.equal(start._meta.paperclipPi.nativeToolCallId, "call_0");
      assert.equal(start._meta.paperclipPi.identityScope, "history-display-only");
    }
    loads.push(starts.map(update => update.toolCallId));
  }
  assert.deepEqual(loads[0], loads[1]);
  f.notifications.length = 0;
  await f.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "reused-tool-ids" }] });
  assert.ok(f.notifications.map(event => event.params?.update).filter(update => update?.toolCallId).every(update => /^pi-[a-f0-9]{64}$/.test(update.toolCallId)));
});

test("actual patched ACP process keeps text questions separate from native permissions", async (t) => {
  const f = await fixture(t); const session = await f.call("session/new", { cwd: join(f.root, "workspace"), mcpServers: [] });
  await f.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "question" }] });
  assert.equal(f.requests.length, 1); assert.notEqual(f.requests[0].method, "session/request_permission");
  await f.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "permission" }] });
  assert.equal(f.requests[1].method, "session/request_permission");
  assert.equal(f.requests[1].params.options[1].kind, "allow_always");
});

for (const [method, answer, expected] of [["select", "Blue", { value: "Blue" }], ["confirm", false, { confirmed: false }], ["input", "Ada", { value: "Ada" }], ["editor", "New\ntext", { value: "New\ntext" }]]) {
  test(`actual patched ACP ${method} question round-trips through form elicitation`, async t => {
    const f = await fixture(t); const session = await f.call("session/new", { cwd: join(f.root, "workspace"), mcpServers: [] });
    f.setAnswer(async () => ({ action: "accept", content: { answer } }));
    await f.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: `native-question-${method}` }] });
    assert.equal(f.requests.length, 1); assert.notEqual(f.requests[0].method, "session/request_permission");
    assert.equal(f.requests[0].params._meta.paperclipPi.method, method);
    const response = f.notifications.map(event => event.params?.update?.content?.text).find(text => text?.includes('"extension_ui_response"'));
    assert.deepEqual(JSON.parse(response), { type: "extension_ui_response", id: `native-${method}`, ...expected });
  });
}

test("actual patched ACP reports unsupported external UI as an error and stops the session", async t => {
  const f = await fixture(t); const session = await f.call("session/new", { cwd: join(f.root, "workspace"), mcpServers: [] });
  await assert.rejects(f.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "oversized-question" }] }), /exited/);
  assert.equal(f.requests.length, 0);
  assert.ok(f.notifications.some(event => event.method === "paperclip/pi_notice" && event.params?.summary === "Pi structured question is unsupported or invalid; the session was stopped"));
});

test("native steering is explicit and does not replace the active ACP turn", async (t) => {
  const f = await fixture(t); const session = await f.call("session/new", { cwd: join(f.root, "workspace"), mcpServers: [] });
  const prompt = f.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "long" }] });
  assert.equal((await f.call("pi/steer", { sessionId: session.sessionId, message: "focus" })).disposition, "queued");
  assert.equal((await f.call("pi/follow_up", { sessionId: session.sessionId, message: "then finish" })).disposition, "queued");
  assert.equal((await prompt).stopReason, "end_turn");
  await assert.rejects(f.call("pi/steer", { sessionId: session.sessionId, message: "too late" }), /active turn/);
});

for (const disposition of ["handled", "started", "missing", "malformed"]) for (const method of ["pi/steer", "pi/follow_up"]) {
  test(`${method} never claims delivery for Pi 1 disposition ${disposition}`, async (t) => {
    const f = await fixture(t, { PI_FIXTURE_INPUT_DISPOSITION: disposition });
    const session = await f.call("session/new", { cwd: join(f.root, "workspace"), mcpServers: [] });
    const prompt = f.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "long" }] });
    await assert.rejects(f.call(method, { sessionId: session.sessionId, message: "not queued" }), /not queued by the native runtime/);
    f.notify("session/cancel", { sessionId: session.sessionId });
    await prompt;
  });
}

test("provider exit fails promptly and missing owned extension fails admission", async (t) => {
  const f = await fixture(t); const session = await f.call("session/new", { cwd: join(f.root, "workspace"), mcpServers: [] });
  await assert.rejects(f.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "die" }] }), /exited/);
  const missing = await fixture(t, { PI_FIXTURE_EXTENSION_FAIL: "1" });
  await assert.rejects(missing.call("session/new", { cwd: join(missing.root, "workspace"), mcpServers: [] }), /failed admission/);
});

test("provider failure is typed and unadmitted slash commands cannot bypass controls", async (t) => {
  const f = await fixture(t); const session = await f.call("session/new", { cwd: join(f.root, "workspace"), mcpServers: [] });
  const result = await f.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "failure" }] });
  assert.equal(result._meta.jetbrains.air.sessionFailure.severity, "error");
  await assert.rejects(f.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "/export /outside/report.html" }] }), /not admitted/);
});

for (const [outcome, expected] of [
  ["success", "Retry finished, resuming."],
  ["failure", "Retry failed; the provider request did not recover."],
  ["unknown", "Retry finished; the provider did not report an outcome."],
]) {
  test(`actual patched ACP retry ${outcome} reports only its stated outcome`, async (t) => {
    const f = await fixture(t);
    const session = await f.call("session/new", { cwd: join(f.root, "workspace"), mcpServers: [] });
    const result = await f.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: `retry-${outcome}` }] });
    const messages = f.notifications.filter(event => event.method === "paperclip/pi_notice").map(event => event.params.summary);
    assert.ok(f.notifications.filter(event => event.params?.update?.sessionUpdate === "agent_message_chunk").every(event => !event.params.update.content.text.includes("Retry")));
    assert.ok(messages.includes(expected));
    if (outcome !== "success") assert.ok(messages.every((text) => !text.includes("resuming")));
    if (outcome === "failure") assert.equal(result._meta.jetbrains.air.sessionFailure.severity, "error");
    else assert.equal(result._meta?.jetbrains?.air?.sessionFailure, undefined);
  });
}

test("manual and automatic compaction retain native progress and usage", async (t) => {
  const f = await fixture(t); const session = await f.call("session/new", { cwd: join(f.root, "workspace"), mcpServers: [] });
  const prompt = (text) => f.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text }] });
  const manual = await prompt("/compact");
  assert.equal(manual.usage.inputTokens, 5); assert.equal(manual.usage.totalTokens, 8);
  assert.equal(manual.usage._meta.paperclipPi.provenance, "assistant_message_and_compaction_receipts");
  const automatic = await prompt("auto-compact");
  assert.equal(automatic.usage.inputTokens, 16); assert.equal(automatic.usage.totalTokens, 24);
  assert.equal(automatic.usage._meta.paperclipPi.costUsd, 0.03);
  assert.ok(f.notifications.some((event) => event.method === "paperclip/pi_notice" && event.params?.summary === "Context compaction finished."));
  const retried = await prompt("retry-compact");
  assert.equal(retried.usage.inputTokens, undefined);
  assert.equal(retried.usage._meta.paperclipPi.costUsd, undefined);
  assert.ok(f.notifications.some((event) => event.method === "paperclip/pi_notice" && event.params?.summary === "Context summarization is retrying a provider request."));
  const active = prompt("long"); await new Promise((resolve) => setTimeout(resolve, 25));
  await assert.rejects(prompt("/compact"), /requires an idle session/);
  f.notify("session/cancel", { sessionId: session.sessionId }); await active;
  assert.match(packageSource, /this\.request\(\{ type: "compact", customInstructions \}, 120000\)/);
});

for (const outcome of ["success", "failure", "oversized"]) {
  test(`actual patched ACP Bash ${outcome} retains standard structured tool data`, async (t) => {
    const f = await fixture(t);
    const session = await f.call("session/new", { cwd: join(f.root, "workspace"), mcpServers: [] });
    const result = await f.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: `bash-${outcome}` }] });
    assert.equal(result.stopReason, "end_turn");
    const updates = f.notifications.map((event) => event.params?.update).filter((update) => update?._meta?.paperclipPi?.nativeToolCallId === "bash-fixture");
    assert.deepEqual(updates[0].rawInput, { command: outcome === "failure" ? "printf failure >&2; exit 7" : "printf done", timeout: 3 });
    assert.deepEqual(updates[1].rawOutput, { content: [{ type: "text", text: "partial" }] });
    const terminal = updates.at(-1);
    assert.equal(terminal.status, outcome === "failure" ? "failed" : "completed");
    if (outcome === "oversized") {
      assert.equal(terminal.rawOutput._meta.paperclipPi.omitted, "tool value exceeds 65536 bytes");
      assert.ok(terminal.rawOutput._meta.paperclipPi.originalBytes > 65536);
      assert.ok(Buffer.byteLength(JSON.stringify(terminal.rawOutput)) < 256);
    } else {
      assert.deepEqual(terminal.rawOutput, { content: [{ type: "text", text: outcome === "failure" ? "failure\n" : "done\n" }], details: { exitCode: outcome === "failure" ? 7 : 0, truncated: false } });
    }
    // Preserve existing terminal consumers without inferring a canonical exit code.
    assert.equal(terminal._meta.terminal_exit.exit_code, outcome === "failure" ? 7 : 0);
  });
}


const thoughtOption = configuration => configuration.configOptions.find(option => option.id === "thought_level");
const assertedThinking = (configuration, current, levels = ["off", "low", "high", "max"]) => {
  assert.equal(configuration.modes.currentModeId, current);
  assert.deepEqual(configuration.modes.availableModes.map(mode => mode.id), levels);
  assert.equal(thoughtOption(configuration).currentValue, current);
  assert.deepEqual(thoughtOption(configuration).options.map(option => option.value), levels);
};

test("thinking modes use native capabilities and preserve effective max across warm load", async t => {
  const f = await fixture(t);
  const session = await f.call("session/new", { cwd: join(f.root, "workspace"), mcpServers: [] });
  assertedThinking(session, "off");
  for (const level of ["high", "low", "max"]) {
    const result = await f.call("session/set_config_option", { sessionId: session.sessionId, configId: "thought_level", value: level });
    assert.equal(thoughtOption(result).currentValue, level);
    assert.equal(f.notifications.filter(event => event.params?.update?.sessionUpdate === "current_mode_update").at(-1).params.update.currentModeId, level);
  }
  assertedThinking(await f.call("session/load", { sessionId: session.sessionId, cwd: join(f.root, "workspace"), mcpServers: [] }), "max");
  await f.call("session/set_mode", { sessionId: session.sessionId, modeId: "off" });
  assert.equal(f.notifications.filter(event => event.params?.update?.sessionUpdate === "current_mode_update").at(-1).params.update.currentModeId, "off");
});

test("unsupported thinking aliases are rejected before native mutation on both ACP routes", async t => {
  const f = await fixture(t); const session = await f.call("session/new", { cwd: join(f.root, "workspace"), mcpServers: [] });
  for (const level of ["minimal", "medium", "xhigh", "unknown"]) {
    await assert.rejects(f.call("session/set_mode", { sessionId: session.sessionId, modeId: level }), /Unsupported thinking level/);
    await assert.rejects(f.call("session/set_config_option", { sessionId: session.sessionId, configId: "thought_level", value: level }), /Unsupported thinking level/);
  }
  await assert.rejects(readFile(join(f.root, "agent/thinking-calls.jsonl")), { code: "ENOENT" });
  assertedThinking(await f.call("session/load", { sessionId: session.sessionId, cwd: join(f.root, "workspace"), mcpServers: [] }), "off");
});

test("model changes refresh supported modes and truthful effective state", async t => {
  const f = await fixture(t); const session = await f.call("session/new", { cwd: join(f.root, "workspace"), mcpServers: [] });
  await f.call("session/set_mode", { sessionId: session.sessionId, modeId: "low" });
  const result = await f.call("session/set_config_option", { sessionId: session.sessionId, configId: "model", value: "openrouter/fixture-alternate" });
  assert.equal(thoughtOption(result).currentValue, "high");
  assert.deepEqual(thoughtOption(result).options.map(option => option.value), ["off", "high"]);
  await assert.rejects(f.call("session/set_mode", { sessionId: session.sessionId, modeId: "low" }), /Unsupported thinking level/);
});

for (const method of ["session/set_mode", "session/set_config_option"]) test(`${method} rejects native silent clamping without a false success update`, async t => {
  const f = await fixture(t, { PI_FIXTURE_THINKING_CLAMP: "1" });
  const session = await f.call("session/new", { cwd: join(f.root, "workspace"), mcpServers: [] });
  const from = f.notifications.length;
  await assert.rejects(f.call(method, { sessionId: session.sessionId, ...(method === "session/set_mode" ? { modeId: "low" } : { configId: "thought_level", value: "low" }) }), /Internal error|did not apply/);
  assert.ok(!f.notifications.slice(from).some(event => event.params?.update?.sessionUpdate === "current_mode_update"));
  assert.deepEqual((await readFile(join(f.root, "agent/thinking-calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse), ["low"]);
});

for (const capability of ["failed", "duplicate", "unknown", "empty", "missing"]) test(`thinking admission rejects ${capability} native capabilities`, async t => {
  const f = await fixture(t, { PI_FIXTURE_THINKING_CAPABILITIES: capability });
  await assert.rejects(f.call("session/new", { cwd: join(f.root, "workspace"), mcpServers: [] }), /Internal error/);
});
for (const current of ["future", "medium"]) test(`thinking admission rejects unsupported effective state ${current}`, async t => {
  const f = await fixture(t, { PI_FIXTURE_THINKING_CURRENT: current });
  await assert.rejects(f.call("session/new", { cwd: join(f.root, "workspace"), mcpServers: [] }), /Internal error/);
});
