import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

// Tests run real pinned Pi RPC without live provider credentials. The final
// stream regressions use synthetic loopback responses and a socket deny guard.
const packageRoot = process.env.PAPERCLIP_TEST_PI_RUNTIME_ROOT
  ?? dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const extensionSource = await readFile(new URL("../src/drivers/acpx/pi-runtime-extension.ts", import.meta.url), "utf8");

test("Pi 1 offline catalog retains the exact qualification model", async () => {
  const { ModelRuntime } = await import(pathToFileURL(join(packageRoot, "dist/core/model-runtime.js")).href);
  const { AuthStorage } = await import(pathToFileURL(join(packageRoot, "dist/core/auth-storage.js")).href);
  const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory({}), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const model = runtime.getModel("openrouter", "deepseek/deepseek-v4-flash-0731");
  assert.equal(model?.provider, "openrouter");
  assert.equal(model?.id, "deepseek/deepseek-v4-flash-0731");
});

test("owned gate authorizes the actual pinned SDK path expansions and read fallbacks", async () => {
  assert.equal(metadata.version, "1.0.0");
  const { resolveToCwd, resolveReadPathAsync } = await import(pathToFileURL(join(packageRoot, "dist/core/tools/path-utils.js")).href);
  const root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-pi-native-paths-")));
  try {
    const workspace = join(root, "workspace"); const privateRoot = join(root, "private");
    await mkdir(workspace); await mkdir(privateRoot);
    const secret = join(privateRoot, "sentinel"); await writeFile(secret, "private fixture");
    await writeFile(join(root, "extension.mjs"), stripTypeScriptTypes(extensionSource));
    await writeFile(join(root, "pi-acp-runtime.js"), stripTypeScriptTypes(await readFile(new URL("../src/drivers/acpx/pi-acp-runtime.ts", import.meta.url), "utf8")));
    const { piNativeToolPaths, checkPiNativeTool } = await import(pathToFileURL(join(root, "extension.mjs")).href);
    const config = { workspace, readOnly: false, readRoots: [], protectedRoots: [privateRoot] };
    const context = { cwd: workspace };
    for (const path of [`@${secret}`, `file://${secret}`, "~", "~/sentinel", "@~/sentinel", "~//sentinel", "space\u00a0name/sentinel", "space\u202fname/sentinel", "@safe", "ordinary"]) {
      assert.equal(piNativeToolPaths(path, workspace, false)[0], resolveToCwd(path, workspace), path);
    }
    for (const path of [`@${secret}`, `file://${secret}`, "~", "~/sentinel", "@~/sentinel"]) {
      assert.notEqual(await checkPiNativeTool({ toolName: "read", input: { path } }, context, config), null, path);
    }
    for (const [path, alternate] of [["capture 1 PM.png", "capture 1\u202fPM.png"], ["a'b", "a\u2019b"], ["caf\u00e9'b", "cafe\u0301\u2019b"]]) {
      await symlink(secret, join(workspace, alternate));
      const actual = await resolveReadPathAsync(path, workspace);
      assert.equal(await realpath(actual), secret);
      assert.ok(piNativeToolPaths(path, workspace, true).includes(actual));
      assert.notEqual(await checkPiNativeTool({ toolName: "read", input: { path } }, context, config), null, path);
    }
    await mkdir(join(workspace, "space name")); await symlink(secret, join(workspace, "space name/sentinel"));
    assert.equal(await realpath(resolveToCwd("space\u00a0name/sentinel", workspace)), secret);
    assert.notEqual(await checkPiNativeTool({ toolName: "read", input: { path: "space\u00a0name/sentinel" } }, context, config), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const brokenCatalog of [false, true]) {
  test(`real pinned Pi ${brokenCatalog ? "withholds" : "registers"} readiness after MCP initialization`, { timeout: 20_000 }, async (t) => {
    assert.equal(metadata.version, "1.0.0");
    const root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-pi-native-contract-")));
    await mkdir(join(root, "workspace")); await mkdir(join(root, "agent"));
    const extension = join(root, "extension.mjs");
    await writeFile(extension, stripTypeScriptTypes(extensionSource));
    await writeFile(join(root, "pi-acp-runtime.js"), stripTypeScriptTypes(await readFile(new URL("../src/drivers/acpx/pi-acp-runtime.ts", import.meta.url), "utf8")));
    const calls = [];
    const server = createServer(async (request, response) => {
      assert.equal(request.headers.authorization, "Bearer 0123456789abcdef0123456789abcdef");
      let body = ""; for await (const chunk of request) body += chunk;
      const rpc = JSON.parse(body); calls.push(rpc.method);
      response.setHeader("Content-Type", "application/json");
      const result = rpc.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
        : { tools: [{ name: brokenCatalog ? "invalid/name" : "connection:search", description: "Report progress", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] };
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const port = server.address().port;
    const child = spawn(await realpath(process.execPath), [join(packageRoot, "dist/cli.js"), "--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-approve", "--offline", "-e", extension], {
      cwd: join(root, "workspace"), stdio: "pipe",
      env: {
        PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: join(root, "agent"), PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
        PAPERCLIP_PI_RUNTIME_CONFIGURATION: JSON.stringify({
          invocationNamespace: "00000000-0000-4000-8000-000000000000",
          workspace: join(root, "workspace"), readOnly: true, readRoots: [], protectedRoots: [join(root, "agent")], instructions: "Use the assigned tools",
          servers: [{ type: "http", name: "paperclip", url: `http://127.0.0.1:${port}/mcp`, headers: [{ name: "Authorization", value: "Bearer 0123456789abcdef0123456789abcdef" }] }],
        }),
      },
    });
    let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
    t.after(async () => {
      child.stdin.end();
      if (child.exitCode === null) { const timer = setTimeout(() => child.kill("SIGKILL"), 2000); await once(child, "exit"); clearTimeout(timer); }
      server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    });
    const admission = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Pi RPC admission timed out: ${stderr}`)), 15_000);
      const decoder = new StringDecoder("utf8"); let buffered = "";
      child.stdout.on("data", (chunk) => {
        buffered += decoder.write(chunk);
        for (;;) {
          const at = buffered.indexOf("\n"); if (at < 0) break;
          const line = buffered.slice(0, at); buffered = buffered.slice(at + 1); if (!line.trim()) continue;
          const value = JSON.parse(line);
          if (value.type === "response" && value.id === "admission") { clearTimeout(timer); resolve(value); }
        }
      });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(`Pi RPC exited before admission: ${stderr}`)); });
      child.stdin.write(JSON.stringify({ type: "get_commands", id: "admission" }) + "\n");
    });
    if (brokenCatalog) {
      await assert.rejects(admission, /Pi RPC exited before admission: Error: Failed to load extension/);
      assert.deepEqual(calls, ["initialize", "tools/list"]);
      return;
    }
    const result = await admission;
    assert.equal(result.success, true);
    assert.deepEqual(calls, ["initialize", "tools/list"]);
    const readiness = result.data.commands.find((command) => command.name === "paperclip-runtime-ready-v1");
    assert.equal(readiness?.description, "Paperclip runtime gate v1");
  });
}

test("real pinned Pi model iterations align owned identities across warm prompts", { timeout: 20_000 }, async () => {
  assert.equal(metadata.version, "1.0.0");
  const load = (name) => import(pathToFileURL(join(packageRoot, `dist/core/${name}.js`)).href);
  const [{ createAgentSession }, { DefaultResourceLoader }, { ModelRuntime }, { SessionManager }, { SettingsManager }, { AuthStorage }] = await Promise.all(
    ["sdk", "resource-loader", "model-runtime", "session-manager", "settings-manager", "auth-storage"].map(load),
  );
  const root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-pi-native-order-")));
  let session;
  try {
    await writeFile(join(root, "helper.mjs"), stripTypeScriptTypes(await readFile(new URL("../src/drivers/acpx/pi-acp-runtime.ts", import.meta.url), "utf8")));
    const { PiToolIdentities, PiAssistantMessages, piAssistantChunk } = await import(pathToFileURL(join(root, "helper.mjs")).href);
    const namespace = "00000000-0000-4000-8000-000000000000";
    const extensionIds = new PiToolIdentities(namespace); const wrapperIds = new PiToolIdentities(namespace);
    const assistantIds = new PiAssistantMessages(namespace); const boundaries = [];
    const events = []; const delivered = []; const displayed = []; let streams = 0;
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const modelRuntime = await ModelRuntime.create({ credentials: AuthStorage.inMemory({}), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    const model = { id: "fixture", name: "Fixture", api: "openai-completions", provider: "fixture", baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 64 };
    const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [(pi) => {
      pi.on("turn_start", (event) => { extensionIds.begin(); events.push({ surface: "extension", type: event.type, turnIndex: event.turnIndex }); });
      pi.on("turn_end", () => extensionIds.end());
      pi.on("tool_call", (event) => { extensionIds.bind(event.toolCallId, event.toolName, event.input, true); });
      pi.registerTool({ name: "fixture_echo", label: "Fixture echo", description: "No side effects", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async (nativeId, args) => {
        delivered.push(extensionIds.bind(nativeId, "fixture_echo", args));
        return { content: [{ type: "text", text: "fixture result" }] };
      } });
    }] });
    await resourceLoader.reload();
    const manager = SessionManager.create(root, join(root, "sessions"));
    ({ session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime, settingsManager: settings, sessionManager: manager, resourceLoader, noTools: "builtin", thinkingLevel: "off" }));
    const extensionErrors = [];
    await session.bindExtensions({ onError: (error) => extensionErrors.push(error.event) });
    session.subscribe((event) => {
      const normalized = wrapperIds.normalize(assistantIds.normalize(event));
      if (normalized.paperclipAssistantMessage && event.type !== "message_update") boundaries.push(piAssistantChunk(normalized.paperclipAssistantMessage));
      if (event.type === "message_update" && ["text_delta", "thinking_delta"].includes(event.assistantMessageEvent.type)) boundaries.push(piAssistantChunk(normalized.paperclipAssistantMessage, event.assistantMessageEvent.delta, event.assistantMessageEvent.type === "thinking_delta"));
      if (event.type === "turn_start") events.push({ surface: "session", type: event.type });
      if (event.type === "tool_execution_start") displayed.push(normalized.toolCallId);
    });
    // Only the model stream is replaced. These are actual pinned Agent loop,
    // AgentSession dispatch, extension hooks, and tool execution paths. No key,
    // network model lookup, provider request, or inference is involved.
    session.agent.streamFunction = () => {
      const index = ++streams; const isTool = index % 3 !== 0;
      const message = { role: "assistant", content: isTool ? [{ type: "text", text: "Calling fixture tool." }, { type: "toolCall", id: "call_0", name: "fixture_echo", arguments: {} }] : [{ type: "text", text: "done" }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: isTool ? "toolUse" : "stop", timestamp: index };
      return { async *[Symbol.asyncIterator]() { yield { type: "start", partial: message }; yield { type: "text_delta", contentIndex: 0, delta: isTool ? "Calling fixture tool." : "done", partial: message }; yield { type: "done", reason: message.stopReason, message }; }, result: async () => message };
    };
    await session.agent.prompt("fixture first"); await session.agent.waitForIdle();
    await session.agent.prompt("fixture warm"); await session.agent.waitForIdle();
    assert.deepEqual(extensionErrors, []);
    assert.equal(streams, 6); assert.equal(delivered.length, 4);
    assert.deepEqual(displayed, delivered); assert.equal(new Set(delivered).size, 4);
    assert.equal(boundaries.filter(chunk => chunk._meta.kind === "start").length, 6);
    assert.equal(new Set(boundaries.map(chunk => chunk.messageId)).size, 6);
    assert.deepEqual(boundaries.filter(chunk => chunk._meta.kind.startsWith("end:")).map(chunk => chunk._meta.kind), ["end:toolUse", "end:toolUse", "end:stop", "end:toolUse", "end:toolUse", "end:stop"]);
    assert.deepEqual(events.filter((event) => event.surface === "extension").map((event) => event.turnIndex), [0, 1, 2, 0, 1, 2]);
    for (let index = 0; index < events.length; index++) if (events[index].surface === "session") assert.equal(events[index - 1]?.surface, "extension");
    const lastId = boundaries.at(-1).messageId;
    assert.equal(boundaries.filter(chunk => chunk.messageId === lastId).map(chunk => chunk.content.text).join(""), "done");
    assert.ok(boundaries.some(chunk => chunk.content.text === "Calling fixture tool." && chunk.messageId !== lastId));
    const persistedFile = manager.getSessionFile(); assert.ok(persistedFile);
    session.dispose();
    const loadedMessages = new PiAssistantMessages("00000000-0000-4000-8000-000000000001"); const loaded = [];
    ({ session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime, settingsManager: settings, sessionManager: SessionManager.open(persistedFile), resourceLoader, noTools: "builtin", thinkingLevel: "off" }));
    await session.bindExtensions({ onError: error => extensionErrors.push(error.event) });
    assert.ok(session.agent.state.messages.some(message => message.role === "assistant"));
    session.subscribe(event => { const normalized = loadedMessages.normalize(event); if (normalized.paperclipAssistantMessage && event.type !== "message_update") loaded.push(piAssistantChunk(normalized.paperclipAssistantMessage)); });
    session.agent.streamFunction = () => {
      const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 100 };
      return { async *[Symbol.asyncIterator]() { yield { type: "start", partial: message }; yield { type: "done", reason: "stop", message }; }, result: async () => message };
    };
    await session.agent.prompt("loaded empty final"); await session.agent.waitForIdle();
    assert.deepEqual(loaded.map(chunk => [chunk._meta.kind, chunk.content.text]), [["start", ""], ["end:stop", ""]]);
    assert.ok(loaded.every(chunk => !boundaries.some(prior => prior.messageId === chunk.messageId)));

  } finally {
    session?.dispose(); await rm(root, { recursive: true, force: true });
  }
});

test("real pinned Pi executes all four owned native question methods without permission authority", { timeout: 20_000 }, async () => {
  const load = (name) => import(pathToFileURL(join(packageRoot, `dist/core/${name}.js`)).href);
  const [{ createAgentSession }, { DefaultResourceLoader }, { ModelRuntime }, { SessionManager }, { SettingsManager }, { AuthStorage }] = await Promise.all(
    ["sdk", "resource-loader", "model-runtime", "session-manager", "settings-manager", "auth-storage"].map(load),
  );
  const root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-pi-native-questions-")));
  let session;
  try {
    await writeFile(join(root, "extension.mjs"), stripTypeScriptTypes(extensionSource));
    await writeFile(join(root, "pi-acp-runtime.js"), stripTypeScriptTypes(await readFile(new URL("../src/drivers/acpx/pi-acp-runtime.ts", import.meta.url), "utf8")));
    const { installPiRuntimeExtension, PI_NATIVE_QUESTION_TOOL } = await import(pathToFileURL(join(root, "extension.mjs")).href);
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const modelRuntime = await ModelRuntime.create({ credentials: AuthStorage.inMemory({}), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    const model = { id: "fixture", name: "Fixture", api: "openai-completions", provider: "fixture", baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 64 };
    const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => installPiRuntimeExtension(pi, { invocationNamespace: "00000000-0000-4000-8000-000000000000", workspace: root, readOnly: true, readRoots: [], protectedRoots: [], instructions: "", servers: [] })] });
    await resourceLoader.reload();
    ({ session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime, settingsManager: settings, sessionManager: SessionManager.inMemory(root), resourceLoader, noTools: "builtin", thinkingLevel: "off" }));
    const dialogs = []; const results = []; const errors = [];
    const uiContext = {
      select: async (title, options) => { dialogs.push({ method: "select", title, options }); return "Blue"; },
      confirm: async (title, message) => { dialogs.push({ method: "confirm", title, message }); return false; },
      input: async (title, placeholder) => { dialogs.push({ method: "input", title, placeholder }); return "Ada"; },
      editor: async (title, prefill) => { dialogs.push({ method: "editor", title, prefill }); return "New\ntext"; },
      notify() {}, setStatus() {}, setWidget() {}, setTitle() {}, setEditorText() {}, getEditorText: () => "", setWorkingMessage() {},
    };
    await session.bindExtensions({ uiContext, onError: error => errors.push(error.event) });
    // Exercise the actual Pi 1 extension dispatch used immediately before a
    // paid cache refresh; native economics cannot override Runner's policy.
    assert.equal(await session.extensionRunner.emitCacheWarmingDecision({ type: "cache_warming_decision", action: "warm", warmCost: 0.01, missCost: 10, continuationProbability: 1 }), "stop");

    session.subscribe(event => { if (event.type === "tool_execution_end") results.push(event); });
    const requests = [
      { method: "select", title: "Color", options: [{ id: "blue", label: "Blue" }, { id: "red", label: "Red" }] },
      { method: "confirm", title: "Continue", message: "Continue editing?" },
      { method: "input", title: "Name", placeholder: "Your name" },
      { method: "editor", title: "Draft", prefill: "Old\ntext" },
    ];
    let streams = 0;
    session.agent.streamFunction = () => {
      const args = requests[streams++];
      const message = { role: "assistant", content: args ? [{ type: "toolCall", id: "call_0", name: PI_NATIVE_QUESTION_TOOL, arguments: args }] : [{ type: "text", text: "done" }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: args ? "toolUse" : "stop", timestamp: streams };
      return { async *[Symbol.asyncIterator]() { yield { type: "start", partial: message }; yield { type: "done", reason: message.stopReason, message }; }, result: async () => message };
    };
    await session.agent.prompt("fixture native questions"); await session.agent.waitForIdle();
    assert.deepEqual(errors, []); assert.equal(results.length, 4);
    assert.ok(results.every(event => !event.isError));
    assert.deepEqual(dialogs.map(dialog => dialog.method), ["select", "confirm", "input", "editor"]);
    assert.ok(dialogs.every(dialog => !dialog.title.startsWith("paperclip.pi.permission.v1:")));
    assert.deepEqual(results.map(event => event.result.details), [{ status: "answered", optionId: "blue" }, { status: "negative_or_cancelled", confirmed: false }, { status: "answered", value: "Ada" }, { status: "answered", value: "New\ntext" }]);
  } finally { session?.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("real pinned Pi dispatches aliased MCP tools with their exact original names", { timeout: 20_000 }, async () => {
  const { getCurrentTools } = await import(pathToFileURL(join(packageRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
  const load = (name) => import(pathToFileURL(join(packageRoot, `dist/core/${name}.js`)).href);
  const [{ createAgentSession }, { DefaultResourceLoader }, { ModelRuntime }, { SessionManager }, { SettingsManager }, { AuthStorage }] = await Promise.all(
    ["sdk", "resource-loader", "model-runtime", "session-manager", "settings-manager", "auth-storage"].map(load),
  );
  const root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-pi-mcp-alias-")));
  let session;
  try {
    await writeFile(join(root, "extension.mjs"), stripTypeScriptTypes(extensionSource));
    await writeFile(join(root, "pi-acp-runtime.js"), stripTypeScriptTypes(await readFile(new URL("../src/drivers/acpx/pi-acp-runtime.ts", import.meta.url), "utf8")));
    const { installPiRuntimeExtension } = await import(pathToFileURL(join(root, "extension.mjs")).href);
    const names = ["connection:search", "connection_search", "connection.search", "x".repeat(128)];
    const calls = [];
    const request = async (_server, method, params) => method === "tools/list"
      ? { tools: names.map(name => ({ name, description: name, inputSchema: { type: "object", properties: { index: { type: "number" } } } })) }
      : method === "tools/call" ? (calls.push(params), { content: [{ type: "text", text: "recorded" }] }) : {};
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const modelRuntime = await ModelRuntime.create({ credentials: AuthStorage.inMemory({}), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    const model = { id: "fixture", name: "Fixture", api: "openai-completions", provider: "fixture", baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 64 };
    const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => installPiRuntimeExtension(pi, { invocationNamespace: "00000000-0000-4000-8000-000000000000", workspace: root, readOnly: true, readRoots: [], protectedRoots: [], instructions: "", servers: [{ type: "http", name: "paperclip", url: "http://127.0.0.1:1", headers: [] }] }, request)] });
    await resourceLoader.reload();
    ({ session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime, settingsManager: settings, sessionManager: SessionManager.inMemory(root), resourceLoader, noTools: "builtin", thinkingLevel: "off" }));
    const errors = []; const results = [];
    await session.bindExtensions({ onError: error => errors.push(error.event) });
    session.subscribe(event => { if (event.type === "tool_execution_end") results.push(event); });
    let streams = 0;
    session.agent.streamFunction = (_model, context) => {
      const index = streams++; const original = names[index];
      const exposed = getCurrentTools(context.messages).filter(tool => names.includes(tool.description));
      assert.equal(exposed.length, names.length);
      assert.equal(new Set(exposed.map(tool => tool.name)).size, names.length);
      assert.ok(exposed.every(tool => /^[A-Za-z0-9_-]{1,64}$/.test(tool.name)));
      const name = exposed.find(tool => tool.description === original)?.name;
      const message = { role: "assistant", content: name ? [{ type: "toolCall", id: "call_0", name, arguments: { index } }] : [{ type: "text", text: "done" }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: name ? "toolUse" : "stop", timestamp: streams };
      return { async *[Symbol.asyncIterator]() { yield { type: "start", partial: message }; yield { type: "done", reason: message.stopReason, message }; }, result: async () => message };
    };
    await session.agent.prompt("fixture aliases"); await session.agent.waitForIdle();
    assert.deepEqual(errors, []); assert.equal(results.length, names.length); assert.ok(results.every(event => !event.isError));
    assert.deepEqual(calls, names.map((name, index) => ({ name, arguments: { index } })));
  } finally { session?.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("real pinned Pi tool dispatch admits registered agent files and rejects unassigned roots", { timeout: 20_000 }, async () => {
  const load = (name) => import(pathToFileURL(join(packageRoot, `dist/core/${name}.js`)).href);
  const [{ createAgentSession }, { DefaultResourceLoader }, { ModelRuntime }, { SessionManager }, { SettingsManager }, { AuthStorage }] = await Promise.all(
    ["sdk", "resource-loader", "model-runtime", "session-manager", "settings-manager", "auth-storage"].map(load),
  );
  const root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-pi-native-agent-files-")));
  let session;
  try {
    const workspace = join(root, "workspace"); const agentHome = join(root, "agent-files"); const privateRoot = join(root, "private"); const outside = join(root, "outside");
    for (const directory of [workspace, agentHome, privateRoot, outside]) await mkdir(directory);
    await symlink(outside, join(agentHome, "escape"));
    await writeFile(join(root, "extension.mjs"), stripTypeScriptTypes(extensionSource));
    await writeFile(join(root, "pi-acp-runtime.js"), stripTypeScriptTypes(await readFile(new URL("../src/drivers/acpx/pi-acp-runtime.ts", import.meta.url), "utf8")));
    const { installPiRuntimeExtension } = await import(pathToFileURL(join(root, "extension.mjs")).href);
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const modelRuntime = await ModelRuntime.create({ credentials: AuthStorage.inMemory({}), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    const model = { id: "fixture", name: "Fixture", api: "openai-completions", provider: "fixture", baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 64 };
    const resourceLoader = new DefaultResourceLoader({ cwd: workspace, agentDir: privateRoot, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => installPiRuntimeExtension(pi, { invocationNamespace: "00000000-0000-4000-8000-000000000000", workspace, agentHome, readOnly: false, readRoots: [], protectedRoots: [privateRoot], instructions: "", servers: [] })] });
    await resourceLoader.reload();
    ({ session } = await createAgentSession({ cwd: workspace, agentDir: privateRoot, model, modelRuntime, settingsManager: settings, sessionManager: SessionManager.inMemory(workspace), resourceLoader, thinkingLevel: "off" }));
    const dialogs = []; const results = []; const errors = [];
    const uiContext = { select: async (title) => { dialogs.push(title); return "Allow once"; }, notify() {}, setStatus() {}, setWidget() {}, setTitle() {}, setEditorText() {}, getEditorText: () => "", setWorkingMessage() {} };
    await session.bindExtensions({ uiContext, onError: error => errors.push(error.event) });
    // Exercise the actual Pi 1 extension dispatch used immediately before a
    // paid cache refresh; native economics cannot override Runner's policy.
    assert.equal(await session.extensionRunner.emitCacheWarmingDecision({ type: "cache_warming_decision", action: "warm", warmCost: 0.01, missCost: 10, continuationProbability: 1 }), "stop");

    session.subscribe(event => { if (event.type === "tool_execution_end") results.push(event); });
    const memory = join(agentHome, "memory.txt");
    const requests = [
      { name: "write", arguments: { path: memory, content: "private memory nonce\n" } },
      { name: "read", arguments: { path: memory } },
      { name: "write", arguments: { path: join(outside, "denied.txt"), content: "forbidden" } },
      { name: "write", arguments: { path: join(agentHome, "escape/denied.txt"), content: "forbidden" } },
      { name: "write", arguments: { path: join(privateRoot, "denied.txt"), content: "forbidden" } },
    ];
    let streams = 0;
    session.agent.streamFunction = () => {
      const request = requests[streams++];
      const message = { role: "assistant", content: request ? [{ type: "toolCall", id: "call_0", ...request }] : [{ type: "text", text: "done" }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: request ? "toolUse" : "stop", timestamp: streams };
      return { async *[Symbol.asyncIterator]() { yield { type: "start", partial: message }; yield { type: "done", reason: message.stopReason, message }; }, result: async () => message };
    };
    await session.agent.prompt("fixture native agent files"); await session.agent.waitForIdle();
    assert.deepEqual(errors, []); assert.equal(results.length, 5);
    assert.deepEqual(results.map(event => Boolean(event.isError)), [false, false, true, true, true]);
    assert.equal(await readFile(memory, "utf8"), "private memory nonce\n");
    assert.match(JSON.stringify(results[1].result), /private memory nonce/);
    for (const path of [join(outside, "denied.txt"), join(privateRoot, "denied.txt")]) await assert.rejects(readFile(path), { code: "ENOENT" });
    assert.equal(dialogs.length, 2); assert.ok(dialogs.every(title => title.startsWith("paperclip.pi.permission.v1:")));
  } finally { session?.dispose(); await rm(root, { recursive: true, force: true }); }
});

// This regression crosses Pi 1's real RPC serializer, the owned extension and
// the patched ACP wrapper. Only an owned loopback HTTP fixture can be reached;
// dummy authentication is unrelated to any provider account.
for (const scenario of ["hello", "interleaved-tools", "provider-error", "provider-unknown", "thinking-modes", "warm-recovery", "warm-pending-cancel"]) {
  test(`real Pi 1 serialized RPC ${scenario} through owned ACP/MCP bridge`, { timeout: 30_000 }, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-pi-stream-")));
    let child; let server;
    const warm = scenario.startsWith("warm-");
    const retirements = [];
    t.after(async () => {
      if (child) {
        // Loaded-session command updates can still be pending at EOF. Retire
        // through the owned wrapper handler so every native child is awaited.
        if (scenario === "thinking-modes" || warm) child.kill("SIGTERM"); else child.stdin.end();
        if (child.exitCode === null) { const timer = setTimeout(() => child.kill("SIGTERM"), 3000); await once(child, "exit"); clearTimeout(timer); }
      }
      if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      try {
        if (child) {
          const retirement = JSON.parse(await readFile(join(root, "owned-retirement.json"), "utf8"));
          retirements.push(retirement);
          assert.ok(retirements.every(value => value.allOwnedChildrenClosed && value.spawnErrors === 0));
          if (warm) assert.deepEqual(retirements.map(value => value.count), [1, 1]);
          if (scenario === "thinking-modes") { assert.equal(retirement.count, 2); assert.equal(retirement.spawnErrors, 0); }
        }
      } finally { await rm(root, { recursive: true, force: true }); }
    });
    await mkdir(join(root, "workspace")); await mkdir(join(root, "agent"));
    const wrapperRoot = process.env.PAPERCLIP_TEST_PI_ACP_PACKAGE
      ? dirname(process.env.PAPERCLIP_TEST_PI_ACP_PACKAGE)
      : join(dirname(dirname(packageRoot)), "pi-acp");
    const calls = []; const modelRequests = []; const reasoningRequests = [];
    const agentHomes = [join(root, "run-1-agent"), join(root, "run-2-agent")];
    if (warm) for (const path of agentHomes) await mkdir(path);
    const contracts = [
      { revision: "1", criterionIds: ["objective"] },
      { revision: "2", criterionIds: ["human_response"] },
    ];
    const finishArguments = index => ({
      reportedWorkDisposition: "needs_review", summary: `WARM_T${index + 1}`,
      completionClaim: { contractRevision: contracts[index].revision, objectiveSatisfied: true,
        criteria: [{ criterionId: contracts[index].criterionIds[0], status: "satisfied", evidenceRefs: [] }], remainingWork: [] },
      attentionRequests: [{ kind: "review", ownerClass: "human", summary: "Review fixture result" }],
      evidence: [], verification: [],
    });
    let stalledResponse;
    const tools = ["paperclip_get_context", "paperclip_finish"].map(name => ({ name, description: name, inputSchema: { type: "object", properties: {}, additionalProperties: true } }));
    server = createServer(async (request, response) => {
      let body = ""; for await (const chunk of request) { body += chunk; assert.ok(body.length < 1_048_576); }
      const value = JSON.parse(body);
      if (request.url === "/v1/chat/completions") {
        modelRequests.push(value.model); reasoningRequests.push({ model: value.model, reasoning: value.reasoning }); assert.ok(modelRequests.length <= (warm ? 6 : 3));
        if (scenario.startsWith("provider-")) {
          response.writeHead(scenario === "provider-error" ? 401 : 418, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "Bearer sensitive-canary /private/sensitive-canary", type: "authentication_error" } })); return;
        }
        const n = modelRequests.length;
        if (warm) {
          const index = n <= 3 ? 0 : 1;
          const step = (n - 1) % 3;
          const latestUser = value.messages.filter(message => message.role === "user").at(-1);
          const submitted = JSON.parse(typeof latestUser.content === "string" ? latestUser.content
            : latestUser.content.filter(block => block.type === "text").map(block => block.text).join(""));
          assert.deepEqual(submitted.completion, contracts[index]);
          assert.equal(submitted.events[0].agentHome, agentHomes[index]);
          const tool = step === 0
            ? { name: index === 0 ? "write" : "read", arguments: index === 0
              ? { path: join(agentHomes[index], "memory.txt"), content: "T1 fixture memory\n" }
              : { path: join(agentHomes[index], "memory.txt") } }
            : { name: "mcp__paperclip__paperclip_finish", arguments: finishArguments(index) };
          const chunks = [];
          if (step < 2) {
            const args = JSON.stringify(tool.arguments);
            chunks.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `warm_${index}_${step}`, type: "function", function: { name: tool.name, arguments: args.slice(0, 12) } }] } }] });
            chunks.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(12) } }] } }] });
          } else chunks.push({ choices: [{ index: 0, delta: { content: `WARM_T${index + 1}` } }] });
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(chunks.map(chunk => `data: ${JSON.stringify({ id: "offline-warm", ...chunk })}\n\n`).join(""));
          if (scenario === "warm-pending-cancel" && n === 5) {
            // A complete JSON argument buffer is still only generation. Withhold
            // the provider finish marker: the real SDK must not execute it.
            stalledResponse = response;
            return;
          }
          response.end(`data: ${JSON.stringify({ id: "offline-warm", choices: [{ index: 0, delta: {}, finish_reason: step < 2 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`);
          return;
        }
        const toolTurn = scenario !== "thinking-modes" && (n === 1 || scenario === "hello" && n === 2);
        const names = scenario === "interleaved-tools" ? tools.map(tool => tool.name) : [n === 1 ? tools[0].name : tools[1].name];
        const chunks = [];
        if (toolTurn) {
          chunks.push({ choices: [{ index: 0, delta: { tool_calls: names.map((name, index) => ({ index, id: `call_${n}_${index}`, type: "function", function: { name: `mcp__paperclip__${name}`, arguments: '{"fixture":' } })) } }] });
          // Reverse delivery order proves index correlation, not FIFO guessing.
          for (const index of names.map((_, index) => index).reverse()) chunks.push({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: `${index}}` } }] } }] });
        } else chunks.push({ choices: [{ index: 0, delta: { reasoning: "Fixture thought", content: "HELLO_COMPLETE" } }] });
        chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: toolTurn ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(chunks.map(chunk => `data: ${JSON.stringify({ id: "offline", ...chunk })}\n\n`).join("") + "data: [DONE]\n\n"); return;
      }
      assert.equal(request.url, "/mcp");
      calls.push({ method: value.method, name: value.params?.name, args: value.params?.arguments });
      if (warm && value.method === "tools/call") {
        assert.equal(value.params.name, "paperclip_finish");
        const index = calls.filter(call => call.method === "tools/call").length - 1;
        assert.deepEqual(value.params.arguments, finishArguments(index));
      }
      const result = value.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
        : value.method === "tools/list" ? { tools }
          : { content: [{ type: "text", text: JSON.stringify({ accepted: true }) }] };
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: value.id, result }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    await writeFile(join(root, "agent/models.json"), JSON.stringify({ providers: { openrouter: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "offline-fixture-not-a-key" } } }));
    const bootstrap = join(root, "bootstrap.mjs");
    await writeFile(bootstrap, `
import net from "node:net";
import { writeFileSync } from "node:fs";
const original = net.Socket.prototype.connect; let admitted = 0;
net.Socket.prototype.connect = function(...args) {
  const a = Array.isArray(args[0]) ? args[0] : args;
  const options = typeof a[0] === "object" ? a[0] : { port: a[0], host: a[1] };
  if (options.path || options.host !== "127.0.0.1" || Number(options.port) !== ${port}) throw new Error("OFFLINE_NETWORK_DENIED_BEFORE_CONNECT");
  admitted++; return original.apply(this, args);
};
try { new net.Socket().connect({ host: "203.0.113.1", port: 443 }); throw new Error("guard failed"); }
catch (error) { if (error.message !== "OFFLINE_NETWORK_DENIED_BEFORE_CONNECT" || admitted !== 0) throw error; }
writeFileSync(${JSON.stringify(join(root, "network-denial.json"))}, JSON.stringify({ deniedBeforeConnect: true, underlyingConnections: admitted }));
await import(${JSON.stringify(pathToFileURL(join(packageRoot, "dist/cli.js")).href)});
`);
    const extension = join(root, "extension.mjs");
    await writeFile(extension, stripTypeScriptTypes(extensionSource));
    await writeFile(join(root, "pi-acp-runtime.js"), stripTypeScriptTypes(await readFile(new URL("../src/drivers/acpx/pi-acp-runtime.ts", import.meta.url), "utf8")));
    // The fixture owns each real Pi ChildProcess handle even if the wrapper
    // elects to exit early. No numeric PID/group selector is used for cleanup.
    const owner = join(root, "wrapper-owner.mjs");
    await writeFile(owner, `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { writeFileSync } from "node:fs";
const spawn = childProcess.spawn; const children = [];
childProcess.spawn = (...args) => {
  const child = spawn(...args); const owned = { child, closed: false, spawnError: false, completion: null };
  child.on("error", () => { owned.spawnError = true; });
  owned.completion = new Promise(resolve => child.once("close", () => { owned.closed = true; resolve(); }));
  children.push(owned); return child;
};
syncBuiltinESMExports();
const exit = process.exit.bind(process); let retiring;
process.exit = code => {
  retiring ??= (async () => {
    const retirements = await Promise.allSettled(children.map(async owned => {
      const child = owned.child;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 1500);
      try { await owned.completion; } finally { clearTimeout(timer); }
    }));
    writeFileSync(${JSON.stringify(join(root, "owned-retirement.json"))}, JSON.stringify({ allOwnedChildrenClosed: children.every(owned => owned.closed) && retirements.every(result => result.status === "fulfilled"), spawnErrors: children.filter(owned => owned.spawnError).length, count: children.length }));
  })().finally(() => exit(code));
};
process.on("SIGTERM", () => process.exit(143)); process.on("SIGINT", () => process.exit(130));
await import(${JSON.stringify(pathToFileURL(join(wrapperRoot, "dist/index.js")).href)});
`);
    const launchWrapper = async agentHome => {
      child = spawn(process.execPath, [owner], {
        cwd: join(root, "workspace"), stdio: "pipe", env: {
          PATH: "/usr/bin:/bin", HOME: root, PI_CODING_AGENT_DIR: join(root, "agent"), PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
          PAPERCLIP_ACPX_ISOLATED_CONTEXT: "1", PAPERCLIP_PI_READ_ONLY: "0",
          ...(agentHome ? { PAPERCLIP_PI_AGENT_HOME: agentHome } : {}),
          PAPERCLIP_PI_NODE_EXECUTABLE: await realpath(process.execPath), PAPERCLIP_PI_ENTRYPOINT: bootstrap, PAPERCLIP_PI_EXTENSION_PATH: extension,
        },
      });
      let buffered = "";
      child.stderr.on("data", chunk => { stderr += chunk; });
      const decoder = new StringDecoder("utf8");
      child.stdout.on("data", chunk => {
        buffered += decoder.write(chunk);
        for (;;) {
          const index = buffered.indexOf("\n"); if (index < 0) break;
          const message = JSON.parse(buffered.slice(0, index)); buffered = buffered.slice(index + 1);
          if (warm && message.method === "session/request_permission") {
            const option = message.params.options.find(value => value.kind === "allow_once");
            assert.ok(option);
            const path = message.params.toolCall.rawInput?.path;
            assert.equal(path, join(agentHome, "memory.txt"));
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "selected", optionId: option.optionId } } }) + "\n");
            continue;
          }
          const waiter = pending.get(message.id);
          if (waiter) { pending.delete(message.id); message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result); }
          else notifications.push(message);
        }
      });
      child.once("exit", () => { for (const waiter of pending.values()) waiter.reject(new Error(`wrapper exited: ${stderr}`)); pending.clear(); });
    };
    let stderr = ""; let sequence = 0; const pending = new Map(); const notifications = [];
    await launchWrapper(warm ? agentHomes[0] : undefined);
    const call = (method, params) => new Promise((resolve, reject) => {
      const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, 15_000);
      pending.set(id, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    await call("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const session = await call("session/new", { cwd: join(root, "workspace"), mcpServers: [{ type: "http", name: "paperclip", url: `http://127.0.0.1:${port}/mcp`, headers: [{ name: "Authorization", value: "Bearer 0123456789abcdef0123456789abcdef" }] }] });
    const model = "openrouter/deepseek/deepseek-v4-flash-0731";
    const selected = await call("session/set_config_option", { sessionId: session.sessionId, configId: "model", value: model });
    if (warm) {
      const low = await call("session/set_config_option", { sessionId: session.sessionId, configId: "thought_level", value: "low" });
      assert.equal(low.configOptions.find(option => option.id === "thought_level").currentValue, "low");
      const prompt = index => [{ type: "text", text: JSON.stringify({ schema: "paperclip.native-continuation.v1", completion: contracts[index], events: [{ type: "fixture", agentHome: agentHomes[index] }] }) }];
      assert.equal((await call("session/prompt", { sessionId: session.sessionId, prompt: prompt(0) })).stopReason, "end_turn");
      assert.equal(await readFile(join(agentHomes[0], "memory.txt"), "utf8"), "T1 fixture memory\n");
      const firstUpdates = notifications.map(event => event.params?.update).filter(Boolean);
      const firstFinish = firstUpdates.find(update => update.sessionUpdate === "tool_call" && update.title === "mcp__paperclip__paperclip_finish");
      assert.ok(firstFinish);
      assert.equal(firstUpdates.filter(update => update.toolCallId === firstFinish.toolCallId && update.status === "completed").length, 1);
      // Product ends the old provider for registered-file collection. Reopen
      // the saved native session in a fresh wrapper, with the next admitted
      // AGENT_HOME; the file transfer here models that external sync boundary.
      const firstClosed = once(child, "close"); child.kill("SIGTERM"); await firstClosed;
      retirements.push(JSON.parse(await readFile(join(root, "owned-retirement.json"), "utf8")));
      await writeFile(join(agentHomes[1], "memory.txt"), await readFile(join(agentHomes[0], "memory.txt")));
      await rm(agentHomes[0], { recursive: true });
      await launchWrapper(agentHomes[1]);
      await call("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const loaded = await call("session/load", { sessionId: session.sessionId, cwd: join(root, "workspace"), mcpServers: [{ type: "http", name: "paperclip", url: `http://127.0.0.1:${port}/mcp`, headers: [{ name: "Authorization", value: "Bearer 0123456789abcdef0123456789abcdef" }] }] });
      assert.equal(loaded.modes.currentModeId, "low");
      const secondStart = notifications.length;
      const second = call("session/prompt", { sessionId: session.sessionId, prompt: prompt(1) });
      second.catch(() => {}); // Cleanup still drains a failed/pending prompt if an assertion throws.
      if (scenario === "warm-pending-cancel") {
        await new Promise((resolve, reject) => {
          const until = Date.now() + 5000;
          const check = () => {
            const updates = notifications.slice(secondStart).map(event => event.params?.update).filter(Boolean);
            const finish = updates.find(update => update.sessionUpdate === "tool_call" && update.title === "mcp__paperclip__paperclip_finish");
            if (stalledResponse && finish && updates.some(update => update.toolCallId === finish.toolCallId && JSON.stringify(update.rawInput) === JSON.stringify(finishArguments(1)))) return resolve();
            if (Date.now() >= until) return reject(new Error("pending-only fixture boundary not observed"));
            setTimeout(check, 10);
          }; check();
        });
        assert.equal(calls.filter(call => call.method === "tools/call").length, 1, "pending generation cannot invoke the MCP bridge");
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: session.sessionId } }) + "\n");
        assert.equal((await second).stopReason, "cancelled");
      } else assert.equal((await second).stopReason, "end_turn");
      const updates = notifications.slice(secondStart).map(event => event.params?.update).filter(Boolean);
      assert.ok(modelRequests.every(value => value === "deepseek/deepseek-v4-flash-0731"));
      const readIds = [...new Set(updates.filter(update => update.rawInput?.path === join(agentHomes[1], "memory.txt")).map(update => update.toolCallId))];
      assert.equal(readIds.length, 1);
      const readLifecycle = updates.filter(update => update.toolCallId === readIds[0]);
      assert.ok(readLifecycle.some(update => update.sessionUpdate === "tool_call" && update.title === "read"));
      assert.equal(readLifecycle.filter(update => update.status === "failed").length, 0);
      const readCompleted = readLifecycle.filter(update => update.status === "completed");
      assert.equal(readCompleted.length, 1);
      assert.ok(readCompleted[0].content.some(block => block.type === "content" && block.content?.type === "text" && block.content.text.includes("T1 fixture memory")));
      const secondFinish = updates.find(update => update.sessionUpdate === "tool_call" && update.title === "mcp__paperclip__paperclip_finish");
      assert.ok(secondFinish); assert.notEqual(secondFinish.toolCallId, firstFinish.toolCallId);
      const lifecycle = updates.filter(update => update.toolCallId === secondFinish.toolCallId);
      const executed = scenario === "warm-recovery";
      assert.equal(lifecycle.some(update => update.status === "in_progress"), executed);
      assert.equal(lifecycle.filter(update => update.status === "completed").length, executed ? 1 : 0);
      assert.equal(calls.filter(call => call.method === "tools/call").length, executed ? 2 : 1);
      assert.equal(modelRequests.length, executed ? 6 : 5);
      assert.ok(reasoningRequests.every(request => request.reasoning?.effort === "low"));
      assert.deepEqual(JSON.parse(await readFile(join(root, "network-denial.json"), "utf8")), { deniedBeforeConnect: true, underlyingConnections: 0 });
      t.diagnostic(JSON.stringify({ scenario, prompts: 2, modelRequests: modelRequests.length, semanticCalls: executed ? 2 : 1, secondFinishStatuses: lifecycle.map(update => update.status), requestedAndEffectiveMode: "low", restoredSession: true, refreshedAgentHome: true, externalConnections: 0 }));
      return;
    }
    if (scenario === "thinking-modes") {
      const thought = config => config.configOptions.find(option => option.id === "thought_level");
      assert.equal(thought(selected).currentValue, "high", "native medium default clamps to high for this exact model");
      assert.deepEqual(thought(selected).options.map(option => option.value), ["off", "low", "high", "max"]);
      await call("session/set_mode", { sessionId: session.sessionId, modeId: "high" });
      assert.equal((await call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "Reply HELLO_COMPLETE." }] })).stopReason, "end_turn");
      const low = await call("session/set_config_option", { sessionId: session.sessionId, configId: "thought_level", value: "low" });
      assert.equal(thought(low).currentValue, "low");
      assert.equal((await call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "Reply HELLO_COMPLETE again." }] })).stopReason, "end_turn");
      assert.deepEqual(reasoningRequests, [
        { model: "deepseek/deepseek-v4-flash-0731", reasoning: { effort: "high" } },
        { model: "deepseek/deepseek-v4-flash-0731", reasoning: { effort: "low" } },
      ]);
      await assert.rejects(call("session/set_mode", { sessionId: session.sessionId, modeId: "medium" }), /Unsupported thinking level/);
      const maximum = await call("session/set_config_option", { sessionId: session.sessionId, configId: "thought_level", value: "max" });
      assert.equal(thought(maximum).currentValue, "max");
      const loaded = await call("session/load", { sessionId: session.sessionId, cwd: join(root, "workspace"), mcpServers: [] });
      assert.equal(loaded.modes.currentModeId, "max"); assert.equal(thought(loaded).currentValue, "max");
      assert.deepEqual(loaded.modes.availableModes.map(mode => mode.id), ["off", "low", "high", "max"]);
      const modes = notifications.filter(event => event.params?.update?.sessionUpdate === "current_mode_update").map(event => event.params.update.currentModeId);
      assert.deepEqual(modes, ["high", "low", "max"]);
      assert.deepEqual(JSON.parse(await readFile(join(root, "network-denial.json"), "utf8")), { deniedBeforeConnect: true, underlyingConnections: 0 });
      assert.equal(calls.filter(call => call.method === "tools/call").length, 0);
      return;
    }
    const result = await call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "Call paperclip_get_context, then paperclip_finish. Finally say HELLO_COMPLETE." }] });
    assert.deepEqual(JSON.parse(await readFile(join(root, "network-denial.json"), "utf8")), { deniedBeforeConnect: true, underlyingConnections: 0 });
    assert.ok(modelRequests.every(value => value === "deepseek/deepseek-v4-flash-0731"));
    assert.doesNotMatch(JSON.stringify({ result, notifications, stderr }), /sensitive-canary/);
    if (scenario.startsWith("provider-")) {
      assert.equal(modelRequests.length, 1); assert.equal(calls.filter(call => call.method === "tools/call").length, 0);
      assert.equal(result._meta.jetbrains.air.sessionFailure.severity, "error");
      const notice = notifications.find(event => event.method === "paperclip/pi_notice" && event.params.category === "runtime_failure");
      assert.equal(notice?.params.details.reason, scenario === "provider-error" ? "provider_http_401" : "unknown_native_failure"); return;
    }
    assert.equal(result.stopReason, "end_turn"); assert.equal(result._meta?.jetbrains, undefined);
    assert.deepEqual(calls.filter(call => call.method === "tools/call").map(call => call.name), ["paperclip_get_context", "paperclip_finish"]);
    assert.equal(result.usage.totalTokens, (scenario === "hello" ? 3 : 2) * 13);
    const updates = notifications.map(event => event.params?.update).filter(Boolean);
    assert.equal(updates.filter(update => update.content?.text === "HELLO_COMPLETE").length, 1);
    assert.ok(updates.some(update => update.sessionUpdate === "agent_thought_chunk" && update.content.text === "Fixture thought"));
    const starts = updates.filter(update => update.sessionUpdate === "tool_call");
    assert.equal(starts.length, 2); assert.notEqual(starts[0].toolCallId, starts[1].toolCallId);
    for (const start of starts) {
      assert.equal(updates.filter(update => update.toolCallId === start.toolCallId && update.status === "completed").length, 1);
      assert.ok(updates.some(update => update.toolCallId === start.toolCallId && update.status === "in_progress"));
    }
  });
}
