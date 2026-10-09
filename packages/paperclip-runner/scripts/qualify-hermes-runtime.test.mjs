// Pinned native Hermes + production ACPX host, deterministic model fixture.
// This is transport proof, not live model or product qualification.
// PAPERCLIP_HERMES_QUALIFY=1 node --test scripts/qualify-hermes-runtime.test.mjs
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AcpxRuntimeHost } from "../dist/drivers/acpx/runtime-host.js";
import { openCodexAcpxRuntime } from "../dist/drivers/acpx/codex-runtime-adapter.js";
import { acpxProfileClientCapabilities } from "../dist/drivers/acpx/profile-extensions.js";
import { acpxProviderSessionIdentity } from "../dist/drivers/acpx/recovery-identity.js";

test("pinned Hermes streams through the production ACPX host using a no-auth local connection", {
  skip: process.env.PAPERCLIP_HERMES_QUALIFY !== "1", timeout: 180_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-hermes-transport-"));
  const workspace = join(root, "workspace");
  const agentFiles = join(root, "agent-files");
  await mkdir(workspace); await mkdir(agentFiles); await mkdir(join(root, "runtime"));
  let host;
  const requests = [];
  const bridgeCalls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    requests.push({ path: req.url, authorization: req.headers.authorization, body });
    if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "fixture", object: "chat.completion", model: "hermes-fixture", choices: [{ index: 0, message: { role: "assistant", content: "Fixture title" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const lastUser = body.messages.findLastIndex(message => message.role === "user");
    const userText = JSON.stringify(body.messages[lastUser]?.content);
    if ((userText.includes("NATIVE_STEER_FIXTURE") && !JSON.stringify(body.messages).includes("NATIVE_STEER_ACCEPTED")) || userText.includes("NATIVE_STOP_FIXTURE")) {
      for (let index = 0; index < 150 && !res.destroyed; index++) {
        res.write(`data: ${JSON.stringify({ id: "control-fixture", choices: [{ index: 0, delta: { reasoning_content: "Working. " }, finish_reason: null }] })}\n\n`);
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      if (!res.destroyed) res.end('data: {"id":"control-fixture","choices":[{"index":0,"delta":{"content":"Control fixture complete."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      return;
    }
    const toolDone = body.messages.slice(lastUser + 1).some(message => message.role === "tool");
    if (!toolDone && (userText.includes("NATIVE_TOOL_FIXTURE") || userText.includes("NATIVE_QUESTION_FIXTURE") || userText.includes("NATIVE_MCP_FIXTURE") || userText.includes("NATIVE_MEMORY_FIXTURE") || userText.includes("NATIVE_PLAN_FIXTURE"))) {
      const question = userText.includes("NATIVE_QUESTION_FIXTURE");
      const bridge = userText.includes("NATIVE_MCP_FIXTURE");
      const memory = userText.includes("NATIVE_MEMORY_FIXTURE");
      const plan = userText.includes("NATIVE_PLAN_FIXTURE");
      const name = question ? "clarify" : memory ? "memory" : bridge ? body.tools.find(tool => tool.function?.name.endsWith("fixture_probe"))?.function.name ?? "missing_assigned_tool"
        : plan ? body.tools.find(tool => tool.function?.name.endsWith("write_document"))?.function.name ?? "missing_plan_tool" : "terminal";
      const args = question ? { question: "Choose the fixture color", choices: ["Cobalt", "Amber"] }
        : memory ? { action: "add", target: "memory", content: "NATIVE_PERSISTED_MEMORY: Project uses Cobalt." }
        : bridge ? { marker: "assigned-tool-roundtrip" }
        : plan ? { marker: "planning-workflow-roundtrip" }
        : { command: "printf 'native-hermes-command\\n' > command-proof.txt", timeout: 10 };
      res.write(`data: ${JSON.stringify({ id: "tool-fixture", object: "chat.completion.chunk", model: "hermes-fixture", created: 1, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `native-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}\n\n`);
      res.end(`data: ${JSON.stringify({ id: "tool-fixture", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`);
      return;
    }
    for (const [delta, finish_reason] of [
      [{ role: "assistant", reasoning_content: "Fixture reasoning." }, null],
      [{ content: "Hermes " }, null], [{ content: "transport works." }, null], [{}, "stop"],
    ]) {
      res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "hermes-fixture", created: 1, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    res.end('data: {"id":"fixture","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\ndata: [DONE]\n\n');
  });
  t.after(async () => {
    if (host) await host.close({ reason: "qualification cleanup" });
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (process.env.PAPERCLIP_HERMES_QUALIFY_KEEP === "1") t.diagnostic(`Private fixture evidence: ${root}`);
    else await rm(root, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const options = {
    runtimeDirectory: join(root, "runtime"), normalizedSessionId: "hermes-transport-test", workingDirectory: workspace,
    agent: "hermes", model: "hermes-fixture", permissionMode: "approve-all", providerPolicy: { readOnly: false },
    clientCapabilities: acpxProfileClientCapabilities("hermes"),
    systemInstructions: "This is a transport fixture. Reply briefly.",
    semanticTools: {
      tools: ["fixture_probe", "write_document"].map(name => ({ name, description: "Return the supplied marker (simulated semantic authority).", inputSchema: { type: "object", properties: { marker: { type: "string" } }, required: ["marker"], additionalProperties: false } })),
      handler: async call => { bridgeCalls.push({ tool: call.tool, arguments: call.arguments }); return { marker: "assigned-tool-returned" }; },
    },
    runtimeContext: { instructions: { workingCopy: { kind: "agent_files", rootPath: agentFiles, entryPath: "AGENTS.md" } }, skills: [], mcp: {} },
    environment: { PATH: process.env.PATH,
      PAPERCLIP_HERMES_CONNECTION_FINGERPRINT: "1".repeat(64),
      PAPERCLIP_HERMES_CONFIG_JSON: JSON.stringify({ model: { provider: "custom:paperclip", default: "hermes-fixture" },
        providers: { paperclip: { base_url: endpoint, transport: "chat_completions", default_model: "hermes-fixture", api_key: "no-key-required" } },
        paperclip_auth: { protocol: "chat", style: "none" } }),
    }, signal: AbortSignal.timeout(150_000),
  };
  const dependencies = { openRuntime: openCodexAcpxRuntime, reportRetainedCleanupFailure: failure => t.diagnostic(String(failure.error)) };
  host = await AcpxRuntimeHost.open(options, dependencies);
  const turn = host.startTurn({ text: "Reply with the transport marker.", requestId: "transport-turn" });
  const events = [];
  let completed = false;
  turn.result.then(() => { completed = true; });
  for await (const event of turn.events) events.push({ event, beforeCompletion: !completed });
  assert.equal((await turn.result).status, "completed");
  const text = events.filter(({ event }) => event.type === "text_delta" && event.stream !== "thought");
  assert.equal(text.map(({ event }) => event.text).join(""), "Hermes transport works.");
  assert.ok(text.some(row => row.beforeCompletion));
  assert.ok(requests.some(row => row.body.model === "hermes-fixture"));
  assert.ok(requests.every(row => row.authorization === undefined), `No-auth connection sent credentials: ${JSON.stringify(requests.map(row => ({ path: row.path, authenticated: row.authorization !== undefined })))}`);
  assert.ok(events.some(({ event }) => event.type === "text_delta" && event.stream === "thought"));
  const expectedIdentity = acpxProviderSessionIdentity(host.identity(), host.binding());
  await host.close({ reason: "per-turn process checkpoint" });
  host = await AcpxRuntimeHost.open({ ...options, expectedIdentity }, dependencies);
  const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA1sAAAAASUVORK5CYII=";
  const resumed = host.startTurn({ text: "Continue the previous conversation and inspect this image.", requestId: "resumed-turn",
    attachments: [{ schema: "paperclip.user_attachment.v1", kind: "image", name: "pixel.png", mediaType: "image/png", data: imageData }] });
  const resumedEvents = [];
  for await (const event of resumed.events) resumedEvents.push(event);
  assert.equal(resumedEvents.filter(event => event.type === "text_delta" && event.stream !== "thought").map(event => event.text).join(""), "Hermes transport works.", "Restored history was emitted as new assistant output");
  assert.equal((await resumed.result).status, "completed");
  assert.ok(requests.some(row => row.body.messages?.filter(message => message.role === "user").length >= 2), "Restore lost the previous conversation");
  assert.ok(requests.some(row => row.body.messages?.some(message => Array.isArray(message.content) && message.content.some(part => part.type === "image_url" && part.image_url.url === `data:image/png;base64,${imageData}`))), `The selected model did not receive the authorized image bytes: ${JSON.stringify(requests.filter(row => row.body.stream).map(row => row.body.messages.filter(message => message.role === "user")))}`);
  const tools = host.startTurn({ text: "NATIVE_TOOL_FIXTURE: Run the supplied command.", requestId: "tools-turn" });
  const toolEvents = [];
  for await (const event of tools.events) toolEvents.push(event);
  assert.equal((await tools.result).status, "completed");
  assert.equal(await readFile(join(workspace, "command-proof.txt"), "utf8").catch(() => null), "native-hermes-command\n",
    `Native command failed: ${JSON.stringify(requests.flatMap(row => row.body.messages?.filter(message => message.role === "tool") ?? []))}`);
  assert.ok(toolEvents.some(event => event.type === "tool_call" || event.type === "tool_call_update"), "Native tool events did not reach ACPX");
  let questions = 0;
  const questionTurn = host.startTurn({ text: "NATIVE_QUESTION_FIXTURE: Ask the native question.", requestId: "question-turn",
    onExtensionRequest: async (method, params) => {
      assert.equal(method, "_hermes/ask_questions");
      assert.equal(params.version, 1);
      questions++;
      const question = params.input.questions[0];
      assert.ok(question.options[0].label.startsWith("Cobalt"));
      return { outcome: "answered", answers: { [question.id]: { selectedOptionIds: ["o0"] } } };
    },
  });
  for await (const _event of questionTurn.events) { /* drain */ }
  assert.equal((await questionTurn.result).status, "completed");
  assert.equal(questions, 1, `Native clarify failed: ${JSON.stringify(requests.at(-1)?.body.messages?.filter(message => message.role === "tool"))}`);
  assert.ok(requests.some(row => row.body.messages?.some(message => message.role === "tool" && String(message.content).includes("Cobalt"))), "The native callback did not receive the submitted answer");
  for (const kind of ["MCP", "MEMORY"]) {
    const turn = host.startTurn({ text: `NATIVE_${kind}_FIXTURE: Use the native tool.`, requestId: `${kind.toLowerCase()}-turn` });
    for await (const _event of turn.events) { /* drain */ }
    assert.equal((await turn.result).status, "completed");
  }
  assert.deepEqual(bridgeCalls, [{ tool: "fixture_probe", arguments: { marker: "assigned-tool-roundtrip" } }]);
  assert.equal(host.steeringCapability()?.steering, true);
  assert.equal(host.steeringCapability()?.queuedFollowUp, false);
  const steering = host.startTurn({ text: "NATIVE_STEER_FIXTURE: Continue working until redirected.", requestId: "steering-turn" });
  let steered = false;
  for await (const event of steering.events) {
    if (!steered && event.type === "text_delta") {
      await host.steerActiveTurn("NATIVE_STEER_ACCEPTED: Answer with the transport marker instead.");
      steered = true;
    }
  }
  assert.equal(steered, true);
  assert.equal((await steering.result).status, "completed");
  assert.ok(requests.some(row => JSON.stringify(row.body.messages ?? []).includes("NATIVE_STEER_ACCEPTED")), "Accepted steering did not reach the native turn");
  await assert.rejects(host.steerActiveTurn("stale correction"), /active turn/);
  const stop = host.startTurn({ text: "NATIVE_STOP_FIXTURE: Continue working until cancelled.", requestId: "stop-turn" });
  let stopped = false;
  for await (const event of stop.events) {
    if (!stopped && event.type === "text_delta") {
      stopped = true;
      await host.interruptActiveTurn("qualification stop");
    }
  }
  assert.equal(stopped, true);
  assert.equal((await stop.result).status, "cancelled");
  const stoppedIdentity = acpxProviderSessionIdentity(host.identity(), host.binding());
  await host.close({ reason: "restore cancelled turn" });
  host = await AcpxRuntimeHost.open({ ...options, expectedIdentity: stoppedIdentity }, dependencies);
  const afterStop = host.startTurn({ text: "Reply with a fresh transport marker after cancellation.", requestId: "after-stop-turn" });
  const afterStopEvents = [];
  for await (const event of afterStop.events) afterStopEvents.push(event);
  const afterStopResult = await afterStop.result;
  assert.equal(afterStopResult.status, "completed", JSON.stringify(afterStopResult));
  assert.equal(afterStopEvents.filter(event => event.type === "text_delta" && event.stream !== "thought").map(event => event.text).join(""), "Hermes transport works.", "Cancelled history or old tool results polluted the restored turn");
  assert.ok(!afterStopEvents.some(event => event.type === "tool_call" || event.type === "tool_call_update"), "Old tools replayed as active work");
  assert.ok(requests.at(-1).body.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("NATIVE_STOP_FIXTURE")), "Cancelled turn history was discarded instead of restored");
  const restoreIdentity = acpxProviderSessionIdentity(host.identity(), host.binding());
  await host.close({ reason: "verify missing history" }); host = undefined;
  assert.match(await readFile(join(agentFiles, "hermes/memories/MEMORY.md"), "utf8"), /NATIVE_PERSISTED_MEMORY/);
  const nativeDatabases = (await readdir(join(root, "runtime"), { recursive: true })).filter(path => path.endsWith("state.db"));
  assert.equal(nativeDatabases.length, 1);
  await rm(join(root, "runtime", nativeDatabases[0]));
  let refused = false;
  try {
    host = await AcpxRuntimeHost.open({ ...options, expectedIdentity: restoreIdentity }, dependencies);
    const missing = host.startTurn({ text: "Continue the lost conversation.", requestId: "missing-history" });
    for await (const _event of missing.events) { /* drain */ }
    refused = (await missing.result).status !== "completed";
  } catch (error) {
    assert.match(String(error), /restore|history|session|resume/i);
    refused = true;
  }
  assert.equal(refused, true, "Missing native history was silently replaced with a new conversation");
  await host?.close({ reason: "planning fixture admission" });
  host = await AcpxRuntimeHost.open({ ...options, normalizedSessionId: "hermes-planning-test", providerPolicy: { readOnly: true } }, dependencies);
  const planning = host.startTurn({ text: "NATIVE_PLAN_FIXTURE: Use the assigned plan document tool.", requestId: "planning-turn" });
  const planningEvents = [];
  for await (const event of planning.events) planningEvents.push(event);
  assert.equal((await planning.result).status, "completed");
  assert.deepEqual(bridgeCalls.at(-1), { tool: "write_document", arguments: { marker: "planning-workflow-roundtrip" } });
  assert.ok(planningEvents.some(event => (event.type === "tool_call" || event.type === "tool_call_update") && JSON.stringify(event).includes("assigned-tool-returned")), "Structured native tool output was omitted from the transcript");
  await rm(join(workspace, "command-proof.txt"));
  const forbidden = host.startTurn({ text: "NATIVE_TOOL_FIXTURE: Run the supplied command while planning.", requestId: "planning-forbidden-turn" });
  const forbiddenEvents = [];
  for await (const event of forbidden.events) forbiddenEvents.push(event);
  assert.equal((await forbidden.result).status, "completed");
  assert.equal(await readFile(join(workspace, "command-proof.txt"), "utf8").catch(() => null), null, "Planning mode executed a native write");
  assert.ok(forbiddenEvents.some(event => (event.type === "tool_call" || event.type === "tool_call_update") && JSON.stringify(event).includes("planning mode permits")), `Native policy denial was omitted from the transcript: ${JSON.stringify({ events: forbiddenEvents.filter(event => event.type === "tool_call" || event.type === "tool_call_update"), results: requests.at(-1)?.body.messages.filter(message => message.role === "tool").slice(-1) })}`);
});
