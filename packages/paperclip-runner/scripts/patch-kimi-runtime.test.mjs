import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createKimiInstructionRuntime } from "./kimi-instructions-runtime.mjs";
import { KIMI_RUNTIME_PATCH, patchKimiRuntime, patchKimiRuntimeSource, replaceKimiPatchAnchor } from "./patch-kimi-runtime.mjs";

const sha = text => createHash("sha256").update(text, "utf8").digest("hex");
const binding = content => JSON.stringify({ schema: "paperclip.kimi.instructions.v1", content,
  digest: `sha256:${sha(content)}`, byteLength: Buffer.byteLength(content) });
const runtime = raw => createKimiInstructionRuntime(raw, { createHash, byteLength: text => Buffer.byteLength(text, "utf8") });

test("native instruction binding preserves exact literals and rejects false readback", () => {
  const content = "\nGovernance: résumé 日本語 ${cwd} ${base_prompt}\n\n";
  const state = runtime(binding(content));
  const native = "Original native system prompt";
  const effective = `${native}\n\n${content}`;
  assert.equal(state.append(native), effective);
  assert.equal(state.append(effective), effective);
  const receipt = state.receipt("native-session", effective);
  assert.deepEqual(receipt, { schema: "paperclip.kimi.instructions.v1", sessionId: "native-session",
    digest: `sha256:${sha(content)}`, byteLength: Buffer.byteLength(content),
    effectiveDigest: `sha256:${sha(effective)}`, effectiveByteLength: Buffer.byteLength(effective) });
  assert.throws(() => state.receipt("native-session", native), /binding/);
  assert.throws(() => state.receipt("", effective), /binding/);
  assert.throws(() => state.append("x".repeat(2_097_153)), /binding/);
  assert.ok(Object.isFrozen(receipt));
});

test("explicit empty instructions retain the native prompt and acknowledge zero bytes", () => {
  const state = runtime(binding(""));
  assert.equal(state.append("native"), "native");
  assert.equal(state.receipt("s", "native").byteLength, 0);
});

test("malformed, changed, oversized, and ill-formed instruction bindings fail closed", () => {
  const valid = JSON.parse(binding("test"));
  for (const raw of [undefined, "{", "[]", "null", " ".repeat(200_001),
    binding("x\0y"), binding("x".repeat(32_769)), binding("\ud800"),
    JSON.stringify({ ...valid, byteLength: 1 }), JSON.stringify({ ...valid, digest: "sha256:" + "0".repeat(64) }),
    JSON.stringify({ ...valid, extra: true }), JSON.stringify({ schema: valid.schema, content: "test", digest: valid.digest })]) {
    assert.throws(() => runtime(raw), /binding/);
  }
});

test("patch rejects unknown source and ambiguous anchors before writing", async () => {
  assert.throws(() => patchKimiRuntimeSource("unverified runtime"), /input digest/);
  assert.throws(() => replaceKimiPatchAnchor("absent", "needle", "replacement"), /exactly one/);
  assert.throws(() => replaceKimiPatchAnchor("needle needle", "needle", "replacement"), /exactly one/);
  const root = await mkdtemp(join(tmpdir(), "kimi-patch-test-"));
  const path = join(root, "main.mjs");
  try {
    await writeFile(path, "unverified runtime");
    await assert.rejects(patchKimiRuntime(path), /input digest/);
    assert.equal(await readFile(path, "utf8"), "unverified runtime");
  } finally { await rm(root, { recursive: true, force: true }); }
});

function segment(source, start, end) {
  const first = source.indexOf(start);
  assert.ok(first >= 0, `Missing native start: ${start}`);
  const last = source.indexOf(end, first + start.length);
  assert.ok(last > first, `Missing native end: ${end}`);
  return source.slice(first, last);
}

test("pinned native package binds new/load and rejects failed turns", {
  skip: !process.env.PAPERCLIP_KIMI_VENDOR_MAIN,
}, async () => {
  const input = await readFile(process.env.PAPERCLIP_KIMI_VENDOR_MAIN, "utf8");
  const patched = patchKimiRuntimeSource(input);
  assert.equal(sha(patched), KIMI_RUNTIME_PATCH.patchedSha256);
  const { build } = await import("esbuild");
  const bundledRoot = await mkdtemp(join(tmpdir(), "kimi-bundled-patch-test-"));
  try {
    const bundledPath = join(bundledRoot, "patch-kimi-runtime.bundle.cjs");
    await build({ entryPoints: [fileURLToPath(new URL("./patch-kimi-runtime.mjs", import.meta.url))],
      outfile: bundledPath, bundle: true, platform: "node", format: "cjs", target: "node24", logLevel: "silent",
      define: { "import.meta.url": JSON.stringify(pathToFileURL(bundledPath).href) } });
    const bundled = (await import(pathToFileURL(bundledPath))).default;
    assert.equal(sha(bundled.patchKimiRuntimeSource(input)), KIMI_RUNTIME_PATCH.patchedSha256,
      "installed bundled patcher produces exactly the same pinned native bytes");
  } finally { await rm(bundledRoot, { recursive: true, force: true }); }
  const content = " Exact ${cwd} instructions\n日本語\n";
  const env = { PAPERCLIP_KIMI_INSTRUCTIONS: binding(content) };
  const helper = segment(patched, "let paperclipKimiInstructionSnapshot;", "import { fileURLToPath");
  const context = { process: { env }, Buffer, paperclipKimiCreateHash: createHash };
  const state = runInNewContext(`${helper};paperclipKimiInstructionState()`, context);
  assert.equal(env.PAPERCLIP_KIMI_INSTRUCTIONS, undefined);
  env.PAPERCLIP_KIMI_INSTRUCTIONS = binding("replacement");
  assert.equal(runInNewContext("paperclipKimiInstructionState()", context), state);
  env.KIMI_API_KEY = "fake-provider-key";
  env.PAPERCLIP_TASK_SCOPED = "assigned-task-value";
  const childEnvironment = segment(patched, "function buildEnv(overrides) {", "function waitForSpawn(child)");
  const buildEnvironment = runInNewContext(`${childEnvironment};buildEnv`, context);
  for (const overrides of [undefined, { KIMI_API_KEY: "override-key", PAPERCLIP_KIMI_INSTRUCTIONS: "private", EXTRA: "assigned" }]) {
    const child = buildEnvironment(overrides);
    assert.equal(child.KIMI_API_KEY, undefined);
    assert.equal(child.PAPERCLIP_KIMI_INSTRUCTIONS, undefined);
    assert.equal(child.PAPERCLIP_TASK_SCOPED, "assigned-task-value");
    assert.equal(child.EXTRA, overrides?.EXTRA);
  }
  assert.equal(env.KIMI_API_KEY, "fake-provider-key");
  const terminalBinding = segment(patched, "\t\tbindTerminalCapability(terminal) {", "\n\t\tget terminalEnabled()");
  const bindTerminal = runInNewContext(`({${terminalBinding}}).bindTerminalCapability`);
  const terminalHolder = {};
  bindTerminal.call(terminalHolder, true);
  assert.equal(terminalHolder._terminalEnabled, false);
  const getter = segment(patched, "\t\tget systemPrompt() {", "\t\tget thinkingLevel()");
  const native = runInNewContext(`({profileState:{systemPrompt:"native"},${getter}})`, context);
  assert.equal(native.systemPrompt, `native\n\n${content}`);
  assert.equal(native.profileState.systemPrompt, "native");
  const receipt = state.receipt("s", native.systemPrompt);
  const baseline = segment(patched, "\t\tmerged() {\n\t\t\treturn {};", "\n\t\tasync watchConfigFiles()");
  const merged = runInNewContext(`({${baseline}}).merged`, context);
  assert.deepEqual(Object.keys(merged.call(new Proxy({}, { get: () => assert.fail("ambient MCP was read") }))), []);
  const policy = segment(patched, '\t\tasync evaluate(context) {\n\t\t\treturn { policyName: "paperclip-runner"', '\n\t};');
  const evaluate = runInNewContext(`({${policy}}).evaluate`, context);
  assert.equal((await evaluate.call(new Proxy({}, { get: () => assert.fail("native heuristic was read") }), {})).result.kind, "ask");
  const userRoots = segment(patched, "async function userRoots(homeDir, osHomeDir, options = {}) {", "async function projectRoots(");
  const discovered = [];
  const roots = await runInNewContext(`(${userRoots})`, { USER_BRAND_DIRS$1: ["skills"],
    pushBrandGroup: async (_roots, _dirs, home) => { discovered.push(home); },
    pushFirstExisting$1: () => assert.fail("global skills were read") })("/owned-kimi", "/ambient-home");
  assert.deepEqual(discovered, ["/owned-kimi"]);
  assert.equal(roots.length, 0);
  const host = { klient: { session: () => ({ agent: () => ({}) }) },
    bindDefaultModel: async () => {}, bindSessionRuntime: async () => undefined };
  const wire = segment(patched, "\t\tasync wireSession(sessionId) {", "\n\t\t/**");
  await assert.rejects(runInNewContext(`({${wire}}).wireSession`, context).call(host, "s"), /native instruction receipt/);
  const admitted = { ensureAuthed: async () => {}, klient: { global: { sessions: { create: async () => ({ id: "s" }) } } },
    activateSession: async () => ({}), paperclipInstructionReceipts: new Map([["s", receipt]]) };
  const create = segment(patched, "\t\tasync newSession(params) {", "\n\t\t/**");
  const createContext = { ...context, acpMcpServersToConfigRecord: value => value };
  const created = await runInNewContext(`({${create}}).newSession`, createContext).call(admitted, { cwd: "/workspace", mcpServers: [] });
  assert.equal(created._meta.paperclipKimiInstructions, receipt);
  for (const [name, next] of [["loadSession", "resumeSession"], ["resumeSession", "listSessions"]]) {
    const method = segment(patched, `\t\tasync ${name}(params) {`, `\t\tasync ${next}(params)`);
    const response = await runInNewContext(`({${method}}).${name}`, createContext).call({ ...admitted,
      warnIgnoredAdditionalDirs() {}, scheduleAvailableCommandsUpdate() {},
      resumeAcpSession: async () => ({ replayHistory: async () => {}, configOptions: async () => [], modeState: () => ({}) }) },
    { sessionId: "s", mcpServers: [] });
    assert.equal(response._meta.paperclipKimiInstructions, receipt);
  }
  const terminal = segment(patched, "\t\tonTurnEnded(event) {", "\n\t\t/**");
  const rejection = [];
  const RequestError = { authRequired: () => ({ kind: "auth" }), internalError: data => data };
  const end = runInNewContext(`({${terminal}}).onTurnEnded`, { RequestError$1: RequestError,
    isAuthError: error => error?.code === "provider.auth_error", turnEndReasonToStopReason: () => "end_turn" });
  for (const code of ["provider.auth_error", "provider.server_error"]) {
    end.call({ driverFor: () => ({ reject: error => rejection.push(error), resolve: () => assert.fail("failed turn resolved") }),
      settleDriver: (_driver, action) => action(), emitUsageUpdate() {} }, { turnId: 1, reason: "failed", error: { code } });
  }
  assert.equal(rejection[0].kind, "auth");
  assert.equal(rejection[1].kind, "provider_failed");
  const infer = segment(patched, "function inferToolKind(name) {", "\n/**");
  const approval = segment(patched, "function buildPermissionToolCallUpdate(req) {", "\n/**");
  const permission = runInNewContext(`${infer}\n${approval}\nbuildPermissionToolCallUpdate`, {
    displayBlockToAcpContent: () => null, acpToolCallId: (turn, id) => `${turn}:${id}`,
  });
  for (const [toolName, kind] of [["Write", "edit"], ["Edit", "edit"], ["Read", "read"], ["Bash", "execute"], ["mcp__paperclip__read_workspace_file", "other"]]) {
    const args = { path: "/workspace/exact.txt", content: "body" };
    const request = permission({ toolName, toolInput: args, toolCallId: "native-tool", turnId: 1, display: {}, action: "test" });
    assert.equal(request.kind, kind);
    assert.equal(request.rawInput, args);
    assert.equal(request.toolCallId, "1:native-tool");
  }
});

test("native step identity separates identical commentary/final text and retains empty boundaries", {
  skip: !process.env.PAPERCLIP_KIMI_VENDOR_MAIN,
}, async () => {
  const patched = patchKimiRuntimeSource(await readFile(process.env.PAPERCLIP_KIMI_VENDOR_MAIN, "utf8"));
  const methods = segment(patched, "\t\tpaperclipKimiMessageFailure(driver) {", "\n\t\tonToolCallStarted(event)");
  const host = () => {
    const events = [], rejected = [];
    const driver = { reject: value => rejected.push(value) };
    const session = runInNewContext(`new class {${methods}}`, { paperclipKimiCreateHash: createHash,
      RequestError$1: { internalError: value => value } });
    Object.assign(session, { sessionId: "native-session", emit: value => events.push(value),
      driverFor: turnId => turnId === 7 && !driver.settled ? driver : undefined,
      settleDriver: (value, action) => { value.settled = true; action(); } });
    return { session, events, rejected, driver };
  };
  const h = host();
  h.session.paperclipKimiStep({ turnId: 7, step: 1, stepId: "native-step-uuid-one" }, "start");
  h.session.onAssistantDelta({ turnId: 7, delta: "SAME café" });
  h.session.onThinkingDelta({ turnId: 7, delta: "reasoning" });
  h.session.paperclipKimiStep({ turnId: 7, step: 1, stepId: "native-step-uuid-one", finishReason: "tool_use" }, "end");
  h.session.paperclipKimiStep({ turnId: 7, step: 2, stepId: "native-step-uuid-two" }, "start");
  h.session.onAssistantDelta({ turnId: 7, delta: "SAME café" });
  h.session.paperclipKimiStep({ turnId: 7, step: 2, stepId: "native-step-uuid-two", finishReason: "end_turn" }, "end");
  h.session.paperclipKimiStep({ turnId: 7, step: 3, stepId: "native-step-uuid-empty" }, "start");
  h.session.paperclipKimiStep({ turnId: 7, step: 3, stepId: "native-step-uuid-empty", finishReason: "end_turn" }, "end");
  const chunks = h.events.map(event => event.update);
  assert.equal(h.rejected.length, 0);
  assert.deepEqual(chunks.map(chunk => chunk._meta.kind), ["start", "delta", "delta", "end:tool_use", "start", "delta", "end:end_turn", "start", "end:end_turn"]);
  assert.equal(chunks[0].messageId, `kimi-message-${sha(JSON.stringify(["native-session", 7, "native-step-uuid-one"]))}`);
  assert.equal(new Set(chunks.map(chunk => chunk.messageId)).size, 3);
  assert.equal(chunks[2].sessionUpdate, "agent_thought_chunk");
  assert.ok(chunks.every(chunk => chunk._meta.origin === "kimi-native-assistant" && chunk._meta.source === "kimi-turn-step-v1"));
  assert.ok(chunks.filter(chunk => chunk._meta.kind !== "delta").every(chunk => chunk.content.text === ""));
  h.session.onAssistantDelta({ turnId: 8, delta: "foreign turn" });
  assert.equal(h.events.length, 9);
  for (const mutate of [
    value => value.session.onAssistantDelta({ turnId: 7, delta: "orphan" }),
    value => { value.session.paperclipKimiStep({ turnId: 7, step: 1, stepId: "uuid" }, "start"); value.session.paperclipKimiStep({ turnId: 7, step: 2, stepId: "other" }, "start"); },
    value => { value.session.paperclipKimiStep({ turnId: 7, step: 1, stepId: "uuid" }, "start"); value.session.paperclipKimiStep({ turnId: 7, step: 1, stepId: "foreign", finishReason: "end_turn" }, "end"); },
    value => { value.session.paperclipKimiStep({ turnId: 7, step: 1, stepId: "uuid" }, "start"); value.session.paperclipKimiStep({ turnId: 7, step: 1, stepId: "uuid", finishReason: "invented" }, "end"); },
    value => { value.session.paperclipKimiStep({ turnId: 7, step: 1, stepId: "uuid" }, "start"); value.session.paperclipKimiStep({ turnId: 7, step: 1, reason: "aborted" }, "interrupted"); value.session.paperclipKimiStep({ turnId: 7, step: 2, stepId: "uuid" }, "start"); },
  ]) {
    const invalid = host(); mutate(invalid);
    assert.equal(invalid.rejected.length, 1);
    assert.equal(invalid.rejected[0].kind, "message_boundary_invalid");
    const count = invalid.events.length;
    invalid.session.onAssistantDelta({ turnId: 7, delta: "late after failure" });
    assert.equal(invalid.events.length, count);
  }
});

test("real pinned Kimi and ACPX exchange instructions/tools/denial/errors with a simulated local model service", {
  skip: process.env.PAPERCLIP_TEST_KIMI_MODEL_PEER !== "1",
  timeout: 60_000,
}, async t => {
  const packageRoot = await realpath(fileURLToPath(new URL("../", import.meta.url)));
  const assets = join(packageRoot, "provider-assets/kimi", `${process.platform}-${process.arch}`);
  try { await access(join(assets, "native-closure.json")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    t.skip("Install the pinned Kimi runtime with paperclipai runtime setup kimi first");
    return;
  }
  const { tsImport } = await import("tsx/esm/api");
  const selectorPeer = process.env.PAPERCLIP_TEST_KIMI_FAULT_SELECTOR_PEER === "1";
  let compiledFactory;
  if (selectorPeer) {
    assert.equal(process.platform, "darwin"); assert.equal(process.arch, "arm64");
    const cli = join(packageRoot, "dist/cli/acpx-runtime-sidecar.cjs");
    const compiled = await readFile(cli, "utf8");
    const boundary = "var lines = (0, import_node_readline.createInterface)({";
    const at = compiled.indexOf(boundary);
    assert.ok(at > 0 && compiled.lastIndexOf(boundary) === at && Buffer.byteLength(compiled) <= 16 * 1024 * 1024);
    const module = { exports: {} };
    new Function("require", "module", "exports", "__filename", "__dirname", compiled.slice(0, at).replace(/^#![^\n]*\n/, "\n")
      + "\nmodule.exports={verifyKimiInstallation,QUALIFIED_ACPX_PROFILES,acquireAcpxProviderLifetimeLease,createAcpxSidecarHostEnvironment,createSanitizedAcpxSpawnInput};")(
      createRequire(cli), module, module.exports, cli, dirname(cli));
    compiledFactory = module.exports;
  }
  const [{ verifyKimiInstallation }, { QUALIFIED_ACPX_PROFILES }, { kimiManagedConfiguration }, instructionModule, { createKimiMessageProjection }, { normalizeAcpxPermission }, environmentModule, { configuredEnvironmentProjection, CONFIGURED_ENVIRONMENT_KEYS }] = await Promise.all([
    tsImport("../src/drivers/acpx/kimi-installation.ts", import.meta.url),
    tsImport("../src/drivers/acpx/qualified-profiles.ts", import.meta.url),
    tsImport("../src/drivers/acpx/kimi-config.ts", import.meta.url),
    tsImport("../src/drivers/acpx/kimi-instructions.ts", import.meta.url),
    tsImport("../src/drivers/acpx/kimi-message-boundary.ts", import.meta.url),
    tsImport("../src/drivers/acpx/acp-permission-adapter.ts", import.meta.url),
    tsImport("../src/drivers/acpx/environment.ts", import.meta.url),
    tsImport("../src/configured-environment.ts", import.meta.url),
  ]);
  const { createAcpRuntime, createFileSessionStore } = await import(pathToFileURL(join(packageRoot, "node_modules/acpx/dist/runtime.js")));
  const root = await realpath(await mkdtemp(join(tmpdir(), "kimi-simulated-model-peer-")));
  const home = join(root, "home"), workspace = join(root, "workspace");
  await mkdir(home, { mode: 0o700 }); await mkdir(workspace);
  const instructions = "\nExact governance café 日本語 ${cwd} ${base_prompt}\nKeep the final LF.\n";
  const selectedModel = "kimi-for-coding";
  const binding = instructionModule.kimiInstructionBinding(instructions);
  const argumentsObject = { payload: "café 🧪\n${literal}", nested: { count: 0, empty: {}, flag: false } };
  const toolReceipt = sha(JSON.stringify(argumentsObject));
  const deniedPath = join(workspace, "denied-peer.txt");
  const notificationEnvironment = {
    PAPERCLIP_RUNTIME_NOTIFICATION_CONTEXT: join(root, "controlled-notification-context.json"),
    PAPERCLIP_RUNTIME_NOTIFICATION_HELPER: join(root, "controlled-notification-helper"),
  };
  await writeFile(notificationEnvironment.PAPERCLIP_RUNTIME_NOTIFICATION_CONTEXT, '{"controlledEnvironmentOnly":true}\n', { flag: "wx", mode: 0o600 });
  await writeFile(notificationEnvironment.PAPERCLIP_RUNTIME_NOTIFICATION_HELPER, "controlled path fixture\n", { flag: "wx", mode: 0o700 });
  const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const notificationChecks = Object.entries(notificationEnvironment).map(([key, value]) => `if test "$${key}" != ${shellQuote(value)}; then printf "NOTIFICATION_DISCOVERY_CHANGED"; exit 1; fi; `).join("");
  const bashArguments = { command: 'if test -n "${KIMI_API_KEY+x}"; then printf "PROVIDER_KEY_PRESENT"; exit 1; fi; if test -n "${PAPERCLIP_KIMI_INSTRUCTIONS+x}"; then printf "PRIVATE_BINDING_PRESENT"; exit 1; fi; if test "$PAPERCLIP_TASK_SCOPED" != "assigned-task-canary"; then printf "TASK_VARIABLE_MISSING"; exit 1; fi; ' + notificationChecks + 'printf "KIMI_CHILD_CREDENTIAL_FENCE_OK"', timeout: 5 };
  const modelRequests = [], mcpCalls = [], permissions = [], deliveries = [], nativeMessages = [], owners = [];
  let scenario = "echo", modelStep = 0, peerFailure, permissionGate;
  const complete = (response, chunks) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const bytes = Buffer.from(chunks.map(chunk => `data: ${JSON.stringify({ id: "simulated-peer", ...chunk })}\n\n`).join("") + "data: [DONE]\n\n");
    const index = bytes.indexOf(Buffer.from("é"));
    if (index >= 0) { response.write(bytes.subarray(0, index + 1)); response.end(bytes.subarray(index + 1)); }
    else response.end(bytes);
  };
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
      let body = "";
      for await (const chunk of request) { body += chunk; assert.ok(Buffer.byteLength(body) < 2_097_152); }
      const value = JSON.parse(body);
      if (request.url === "/v1/chat/completions") {
        assert.equal(request.headers.authorization, "Bearer simulated-peer-not-a-credential");
        assert.equal(value.model, selectedModel);
        const system = value.messages.find(message => message.role === "system")?.content;
        assert.equal(typeof system, "string");
        assert.ok(system.endsWith(`\n\n${instructions}`), "exact literal instructions reached native HTTP request");
        const ack = nativeMessages.map(entry => entry.message.result?._meta?.paperclipKimiInstructions).filter(Boolean).at(-1);
        assert.equal(ack?.digest, binding.digest);
        assert.equal(ack?.effectiveDigest, `sha256:${sha(system)}`, "native instruction receipt matches the full actual model-request prompt");
        modelRequests.push({ scenario, value });
        assert.ok(modelRequests.length <= 9, "bounded simulated model requests");
        modelStep++;
        if (scenario === "error") {
          response.writeHead(418, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { type: "simulated_provider_error", message: "private-peer-error-canary" } }));
          return;
        }
        if (modelStep === 1) {
          const tools = scenario === "echo"
            ? [{ id: "peer-echo", name: "mcp__peer__echo_peer", args: argumentsObject }, { id: "peer-empty", name: "mcp__peer__empty_peer", args: {} }]
            : scenario === "bash" ? [{ id: "peer-bash", name: "Bash", args: bashArguments }]
              : [{ id: `peer-${scenario}`, name: "Write", args: { path: permissionGate?.path ?? deniedPath, content: "must never be written" } }];
          for (const tool of tools) assert.ok(value.tools.some(declared => declared.function?.name === tool.name), `native request discloses ${tool.name}`);
          complete(response, [
            { choices: [{ index: 0, delta: { content: "Before tool café." } }] },
            { choices: [{ index: 0, delta: { tool_calls: tools.map((tool, index) => ({ index, id: tool.id, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args).slice(0, 1) } })) } }] },
            ...tools.map((tool, index) => ({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: JSON.stringify(tool.args).slice(1) } }] } }] })),
            { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          ]);
        } else {
          const result = value.messages.find(message => message.role === "tool" && message.tool_call_id === `peer-${scenario}`);
          assert.ok(result, "the exact native tool result returned to the model");
          if (scenario === "echo") {
            assert.ok(JSON.stringify(result).includes(toolReceipt), `MCP receiver result reached the next native request: ${JSON.stringify({ result, mcpCalls: mcpCalls.length, permissions })}`);
            assert.ok(value.messages.some(message => message.role === "tool" && message.tool_call_id === "peer-empty" && JSON.stringify(message).includes("EMPTY_TOOL_ACCEPTED")), "zero-argument MCP result returned to the native model");
          }
          else if (scenario === "bash") assert.match(result.content, /^(?:Wall time: [0-9.]+ seconds\n)?KIMI_CHILD_CREDENTIAL_FENCE_OK\n?$/, "native Bash excluded provider/private credentials and retained the assigned task variable plus owned Runner notification discovery");
          else assert.match(JSON.stringify(result), /denied|rejected|approval/i);
          complete(response, [{ choices: [{ index: 0, delta: { content: scenario === "echo" ? "PEER_ECHO_OK café" : scenario === "bash" ? "PEER_BASH_OK" : "PEER_DENIED_OK" } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }]);
        }
        return;
      }
      assert.equal(request.url, "/mcp");
      if (value.id === undefined) { response.writeHead(202); response.end(); return; }
      if (value.method === "tools/call") {
        assert.ok(["echo_peer", "empty_peer"].includes(value.params.name));
        assert.deepEqual(value.params.arguments, value.params.name === "echo_peer" ? argumentsObject : {});
        mcpCalls.push(value.params);
      }
      const result = value.method === "initialize"
        ? { protocolVersion: value.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "simulated-peer", version: "1" } }
        : value.method === "tools/list" ? { tools: [{ name: "echo_peer", description: "Echo the supplied JSON through the controlled peer.",
          inputSchema: { type: "object", properties: { payload: { type: "string" }, nested: { type: "object", additionalProperties: true } }, required: ["payload", "nested"] } },
          { name: "empty_peer", description: "Return a receipt from an empty object argument.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] }
          : { content: [{ type: "text", text: value.params.name === "empty_peer" ? "EMPTY_TOOL_ACCEPTED" : JSON.stringify({ echoed: argumentsObject, receipt: toolReceipt }) }] };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: value.id, result }));
    } catch (error) {
      peerFailure ??= error;
      if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { type: "peer_assertion_failed", message: "simulated peer assertion failed" } }));
    }
  });
  const keys = ["PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT", "PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST"];
  const previous = keys.map(key => process.env[key]);
  const closeOwner = async owner => {
    if (owner.closed) return;
    owner.closed = true;
    const started = Date.now();
    const terminate = setTimeout(() => { for (const child of owner.children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); }, 2_000);
    const kill = setTimeout(() => { for (const child of owner.children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 3_000);
    try {
      if (owner.handle) await owner.runtime.close({ handle: owner.handle, reason: "simulated peer cleanup" });
    } finally {
      try {
        await Promise.all(owner.completions);
        assert.ok(Date.now() - started < 5_000, "native process cleanup is bounded");
      } finally { clearTimeout(terminate); clearTimeout(kill); await owner.lease.close(); await owner.fence?.close(); }
    }
  };
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const config = kimiManagedConfiguration(selectedModel).replace(/^base_url = .+$/m, `base_url = ${JSON.stringify(`${endpoint}/v1`)}`)
      + "\n[loop_control]\nmax_attempts_per_step = 1\n";
    await writeFile(join(home, "config.toml"), config, { mode: 0o600 });
    process.env[keys[0]] = packageRoot; process.env[keys[1]] = join(packageRoot, "package.json");
    const installation = compiledFactory
      ? await compiledFactory.verifyKimiInstallation(compiledFactory.QUALIFIED_ACPX_PROFILES.kimi)
      : await verifyKimiInstallation(QUALIFIED_ACPX_PROFILES.kimi);
    const store = createFileSessionStore({ stateDir: join(root, "acpx-state") });
    const taskEnvironment = configuredEnvironmentProjection({ PAPERCLIP_TASK_SCOPED: "assigned-task-canary",
      ...Object.fromEntries(Object.keys(notificationEnvironment).map(key => [key, "forged-task-override"])) });
    for (const key of Object.keys(notificationEnvironment)) assert.ok(!Object.hasOwn(taskEnvironment, key));
    const explicitEnvironment = { ...taskEnvironment, ...notificationEnvironment, PATH: "/usr/bin:/bin", LANG: "C.UTF-8", KIMI_API_KEY: "simulated-peer-not-a-credential" };
    const sessionId = "controlled-native-environment";
    const compose = compiledFactory ?? environmentModule;
    const sidecarEnvironment = compose.createAcpxSidecarHostEnvironment({ ...explicitEnvironment,
      [environmentModule.ACPX_CREDENTIAL_BINDING_ENV]: environmentModule.createAcpxCredentialBinding(explicitEnvironment, "kimi", sessionId) }, "kimi", sessionId);
    const launchEnvironment = compose.createSanitizedAcpxSpawnInput(sidecarEnvironment, "kimi").env;
    for (const [key, value] of Object.entries(notificationEnvironment)) {
      assert.equal(launchEnvironment[key], value);
      assert.throws(() => compose.createSanitizedAcpxSpawnInput({ ...sidecarEnvironment,
        [CONFIGURED_ENVIRONMENT_KEYS]: JSON.stringify([key]), [key]: "forged-task-override" }, "kimi"), /configured environment projection/);
    }
    assert.equal(launchEnvironment.PAPERCLIP_TASK_SCOPED, "assigned-task-canary");
    assert.equal(launchEnvironment.KIMI_API_KEY, "simulated-peer-not-a-credential");
    const spawnNative = (lease, owner) => {
      const child = lease.spawn([], { cwd: workspace, stdio: "pipe", env: { ...launchEnvironment, HOME: home,
        CI: "1", NO_COLOR: "1", TERM: "dumb", KIMI_CODE_HOME: home,
        KIMI_CODE_NO_AUTO_UPDATE: "1", KIMI_DISABLE_TELEMETRY: "1",
        KIMI_CODE_WATCH: "0", KIMI_DISABLE_CRON: "1", PAPERCLIP_KIMI_INSTRUCTIONS: binding.payload,
        ...(selectorPeer ? { PAPERCLIP_FAULT_ENV_CANARY: "must-not-appear-in-observed-argv" } : {}) } },
      owner.fence ? { credentialFenceFds: owner.fence.lifetimeFenceFds, activateCredentialFenceOwner: pid => owner.fence.activateLifetimeOwner(pid) } : undefined);
      owner.children.push(child);
      owner.completions.push(new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); }));
      return child;
    };
    const connect = async (resumeSessionId, sessionKey = "scripted-kimi-peer") => {
      const lease = await installation.openCommand();
      const admission = instructionModule.createKimiInstructionAdmission(instructions);
      const fence = compiledFactory ? await compiledFactory.acquireAcpxProviderLifetimeLease({ agentHomeDirectory: home }) : undefined;
      const owner = { lease, fence, children: [], completions: [], handle: undefined, runtime: undefined, closed: false };
      owners.push(owner);
      owner.runtime = createAcpRuntime({ cwd: workspace, sessionStore: store,
        agentRegistry: { resolve: () => "paperclip-verified-kimi-command", list: () => ["kimi"] },
        mcpServers: [{ type: "http", name: "peer", url: `${endpoint}/mcp`, headers: [] }],
        permissionMode: "approve-all", permissionPolicy: { defaultAction: "escalate" }, timeoutMs: 15_000,
        protocolGuardFactory: () => admission.createGuard(),
        onAcpMessage: (direction, message) => nativeMessages.push({ owner, direction, message }),
        onPermissionRequest: async (request, context) => {
          permissions.push(request.raw);
          assert.ok(context.responseDelivery instanceof Promise);
          assert.ok(request.raw.options.every(option => option.kind !== "allow_always"));
          const normalized = normalizeAcpxPermission(request, { provider: "kimi", workingDirectory: workspace });
          if (request.raw.toolCall.title === "Write") {
            assert.equal(request.raw.toolCall.kind, "edit", "native approval carries the actual tool's canonical kind");
            const path = request.raw.toolCall.rawInput.path;
            assert.equal(normalized.title, `Change file: ${path.slice(workspace.length + 1)}`);
            assert.equal(normalized.kind, "edit");
            assert.deepEqual(normalized.choices.map(choice => choice.key), ["accept", "decline", "cancel"]);
            for (const workingDirectory of [undefined, home]) {
              const unsafe = normalizeAcpxPermission(request, { provider: "kimi", workingDirectory });
              assert.equal(unsafe.title, "File change requested; target unavailable. Deny or cancel this request.");
              assert.deepEqual(unsafe.choices.map(choice => choice.key), ["decline", "cancel"]);
              assert.throws(() => unsafe.resolve({ action: "accept" }), /not an offered choice/);
            }
          }
          if (permissionGate) {
            assert.equal(request.raw.toolCall.title, "Write");
            assert.deepEqual(request.raw.toolCall.rawInput, { path: permissionGate.path, content: "must never be written" });
            permissionGate.context = context;
            permissionGate.delivery = context.responseDelivery.then(() => "delivered", () => "suppressed");
            permissionGate.requestId = nativeMessages.findLast(entry => entry.owner === owner && entry.direction === "inbound"
              && entry.message.method === "session/request_permission"
              && entry.message.params.toolCall.rawInput?.path === permissionGate.path)?.message.id;
            assert.ok(permissionGate.requestId !== undefined);
            permissionGate.markSeen();
            return permissionGate.decision;
          }
          deliveries.push(context.responseDelivery);
          if (request.raw.toolCall.title === "Write") {
            assert.deepEqual(request.raw.toolCall.rawInput, { path: deniedPath, content: "must never be written" });
            await assert.rejects(access(deniedPath), { code: "ENOENT" });
            return { outcome: "reject_once" };
          }
          if (request.raw.toolCall.title === "Bash") {
            assert.deepEqual(request.raw.toolCall.rawInput, bashArguments);
            return { outcome: "allow_once" };
          }
          assert.ok(["mcp__peer__echo_peer", "mcp__peer__empty_peer"].includes(request.raw.toolCall.title));
          assert.deepEqual(request.raw.toolCall.rawInput, request.raw.toolCall.title === "mcp__peer__echo_peer" ? argumentsObject : {});
          return { outcome: "allow_once" };
        },
        spawnAgent: () => spawnNative(lease, owner),
      });
      owner.handle = await owner.runtime.ensureSession({ sessionKey, agent: "kimi", mode: "persistent", cwd: workspace,
        ...(resumeSessionId ? { resumeSessionId } : {}),
        sessionOptions: { model: selectedModel } });
      return owner;
    };
    const prompt = async (owner, name) => {
      scenario = name; modelStep = 0;
      const turn = owner.runtime.startTurn({ handle: owner.handle, mode: "prompt", text: `Controlled ${name} boundary.`, requestId: `peer-${name}` });
      const events = [];
      const drained = (async () => { for await (const event of turn.events) events.push(event); })();
      const result = await turn.result;
      await drained;
      if (peerFailure) throw peerFailure;
      if (name !== "error") {
        const chunks = events.filter(event => event.type === "text_delta" && event.stream === "output");
        assert.deepEqual(chunks.map(event => event.meta?.kind), ["start", "delta", "end:tool_use", "start", "delta", "end:end_turn"]);
        assert.ok(chunks.every(event => /^kimi-message-[a-f0-9]{64}$/.test(event.messageId)
          && event.meta.origin === "kimi-native-assistant" && event.meta.source === "kimi-turn-step-v1"));
        assert.equal(new Set(chunks.map(event => event.messageId)).size, 2);
        assert.equal(chunks[0].messageId, chunks[2].messageId);
        assert.equal(chunks[3].messageId, chunks[5].messageId);
        assert.notEqual(chunks[0].messageId, chunks[3].messageId);
        assert.equal(chunks[1].text, "Before tool café.");
        assert.ok(chunks.filter(event => event.meta.kind !== "delta").every(event => event.text === ""));
        const projection = createKimiMessageProjection();
        const projected = events.map(event => projection.normalize(event));
        projection.settle();
        assert.deepEqual(projected.filter(event => event.assistantMessageBoundary).map(event => event.assistantMessageBoundary), [
          { phase: "start" }, { phase: "end", stopReason: "toolUse" },
          { phase: "start" }, { phase: "end", stopReason: "stop" },
        ]);
      }
      return { result, events };
    };
    const first = await connect();
    const echoed = await prompt(first, "echo");
    assert.equal(echoed.result.status, "completed");
    assert.equal(mcpCalls.length, 2);
    assert.ok(echoed.events.some(event => event.type === "text_delta" && event.text.includes("PEER_ECHO_OK")));
    const shell = await prompt(first, "bash");
    assert.equal(shell.result.status, "completed");
    assert.ok(shell.events.some(event => event.type === "text_delta" && event.text.includes("PEER_BASH_OK")));
    assert.ok(nativeMessages.some(entry => entry.direction === "outbound" && entry.message.method === "initialize" && entry.message.params.clientCapabilities.terminal === true), "actual ACPX offered its mandatory client terminal");
    assert.ok(!nativeMessages.some(entry => entry.direction === "inbound" && entry.message.method === "terminal/create"), "Kimi kept Bash in its native fenced process service despite ACPX client terminal capability");
    await closeOwner(first);
    const second = await connect(first.handle.backendSessionId);
    const denied = await prompt(second, "deny");
    assert.equal(denied.result.status, "completed");
    await assert.rejects(access(deniedPath), { code: "ENOENT" });
    const failed = await prompt(second, "error");
    assert.equal(failed.result.status, "failed");
    assert.match(JSON.stringify(failed.result), /Kimi provider turn failed/);
    assert.ok(!JSON.stringify(failed.result).includes("private-peer-error-canary"));
    assert.ok(nativeMessages.some(entry => entry.direction === "outbound" && ["session/load", "session/resume"].includes(entry.message.method)), "ACPX restored the native session before the second model turn");
    assert.ok(permissions.some(request => request.toolCall.title === "Write"));
    assert.equal(permissions.length, 4);
    await Promise.all(deliveries);
    assert.equal(modelRequests.length, 7);
    await closeOwner(second);
    assert.ok(owners.every(owner => owner.children.every(child => child.exitCode !== null || child.signalCode !== null)));
    await assert.rejects(access(deniedPath), { code: "ENOENT" });
    t.diagnostic("SIMULATED provider service; real pinned Kimi 2.3.3 + ACPX manager: 7 native model requests with provider auth intact, exact create/resume instruction suffix, native UUID start/end separates pre-tool commentary from final text despite reused model response IDs, actual provider projection yields toolUse/stop boundaries, two MCP JSON/result round trips including terminal {}, native Bash excludes provider/private credentials and retains the assigned task variable and exact owned Runner notification paths after actual configured-environment projection rejected forged task overrides, rejected Write with no file, typed provider failure, owned process closure; zero external model calls");
    if (process.env.PAPERCLIP_TEST_KIMI_LIFECYCLE_PEER === "1") {
      const { readProcessTable, observeDescendantProcessTree } = await tsImport("../../../tests/runner-e2e/process-tree.ts", import.meta.url);
      const bounded = async (promise, label, milliseconds = 5_000) => {
        let timer;
        try {
          return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} exceeded its bound`)), milliseconds);
          })]);
        } finally { clearTimeout(timer); }
      };
      const nativeWorker = async owner => {
        assert.equal(owner.children.length, 1);
        if (selectorPeer) {
          const { readKimiLocalProcesses, selectKimiLocalTarget } = await tsImport("../../../tests/runner-e2e/kimi-local-provider-fault.ts", import.meta.url);
          const { kimiFaultRuntimeContract } = await tsImport("../../../tests/runner-e2e/kimi-provider-fault-contract.ts", import.meta.url);
          const table = await readProcessTable(); assert.ok(table);
          const root = table.find(row => row.pid === process.pid); assert.ok(root && root.processGroupId === process.pid);
          const tree = observeDescendantProcessTree(table, process.pid);
          const observed = tree.members.map(row => row.process);
          const processes = readKimiLocalProcesses(observed.map(row => row.pid));
          assert.ok(!JSON.stringify(processes).includes("must-not-appear-in-observed-argv"));
          const runId = process.argv[process.argv.indexOf("--run-id") + 1];
          const input = { authority: { pid: root.pid, groupId: root.processGroupId, startedAt: root.started, runId },
            journal: observed.map(row => ({ pid: row.pid, parent: row.parentPid, start: row.started })), processes,
            workspacePath: workspace, guardLoaderSha256: kimiFaultRuntimeContract("darwin-arm64").guardLoaderSha256 };
          const selected = selectKimiLocalTarget(input);
          assert.equal(selected.target.command, "kimi-code");
          assert.equal(selected.target.argv[0], "kimi-code");
          assert.ok(selected.ancestry.some(row => row.pid === owner.children[0].pid));
          for (const kind of ["missing", "foreign", "ambiguous"]) {
            const wrong = structuredClone(input);
            if (kind === "missing") wrong.processes = wrong.processes.filter(row => row.pid !== selected.target.pid);
            if (kind === "foreign") wrong.processes.find(row => row.pid === selected.target.ppid).argv[2] = "foreign loader";
            if (kind === "ambiguous") { const extra = { ...selected.target, pid: 2147483000 }; wrong.processes.push(extra); wrong.journal.push({ pid: extra.pid, parent: extra.ppid, start: new Date(Number(extra.startUs) / 1000).toISOString() }); }
            assert.throws(() => selectKimiLocalTarget(wrong), /kimi_local_provider_fault:/);
          }
          owner.selectorInput = input;
          return table.find(row => row.pid === selected.target.pid);
        }
        const rootPid = owner.children[0].pid;
        const table = await readProcessTable();
        assert.ok(table);
        const tree = observeDescendantProcessTree(table, rootPid);
        const candidates = tree.members.filter(member => member.depth === 1);
        assert.equal(candidates.length, 1, `one native Kimi worker belongs directly to the verified command root: ${JSON.stringify(tree.members.map(member => ({ depth: member.depth, kind: member.process.kind })))}`);
        const rootProcess = table.find(row => row.pid === rootPid);
        const worker = candidates[0].process;
        assert.ok(rootProcess && worker.pid > 1 && worker.pid !== rootPid && worker.pid !== process.pid);
        const fresh = await readProcessTable();
        assert.ok(fresh?.some(row => row.pid === rootPid && row.started === rootProcess.started && row.processGroupId === rootProcess.processGroupId));
        assert.ok(fresh?.some(row => row.pid === worker.pid && row.started === worker.started
          && row.parentPid === rootPid && row.processGroupId === worker.processGroupId));
        return worker;
      };
      const assertRetired = async worker => {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const table = await readProcessTable();
          assert.ok(table);
          if (!table.some(row => row.pid === worker.pid && row.started === worker.started)) return;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.fail("the observed native worker survived owned cleanup");
      };
      for (const boundary of ["stop", "loss"]) {
        const path = join(workspace, `${boundary}-must-not-exist.txt`);
        let markSeen, decide;
        const seen = new Promise(resolve => { markSeen = resolve; });
        const decision = new Promise(resolve => { decide = resolve; });
        permissionGate = { path, markSeen, decision, decide };
        const owner = await connect(undefined, `scripted-kimi-peer-${boundary}`);
        scenario = boundary; modelStep = 0;
        const turn = owner.runtime.startTurn({ handle: owner.handle, mode: "prompt", text: `Controlled pending permission ${boundary}.`, requestId: `peer-${boundary}` });
        const drained = (async () => { for await (const _event of turn.events) {} })();
        try {
          await bounded(seen, `${boundary} native permission observation`);
          await assert.rejects(access(path), { code: "ENOENT" });
          const worker = await nativeWorker(owner);
          if (boundary === "stop") await bounded(turn.cancel({ reason: "controlled pending permission Stop" }), "native Stop");
          else if (selectorPeer) {
            const { terminateKimiLocalProvider } = await tsImport("../../../tests/runner-e2e/kimi-local-provider-fault.ts", import.meta.url);
            const receipt = terminateKimiLocalProvider(owner.selectorInput);
            assert.equal(receipt.target.pid, worker.pid); assert.equal(receipt.workerSignalled, false);
          } else process.kill(worker.pid, "SIGKILL");
          const result = await bounded(turn.result, `${boundary} terminal result`);
          await bounded(drained, `${boundary} event drain`);
          if (peerFailure) throw peerFailure;
          assert.equal(result.status, boundary === "stop" ? "cancelled" : "failed");
          if (boundary === "loss") assert.equal(typeof result.error?.code, "string");
          assert.equal(permissionGate.context.signal.aborted, true, "pending host callback was revoked at settlement");
          const countAtSettlement = modelRequests.length;
          permissionGate.decide({ outcome: "allow_once" });
          assert.equal(await bounded(permissionGate.delivery, `${boundary} stale permission suppression`), "suppressed");
          await new Promise(resolve => setTimeout(resolve, 100));
          assert.equal(modelRequests.length, countAtSettlement, "a stale callback cannot restart provider inference");
          assert.ok(!nativeMessages.some(entry => entry.owner === owner && entry.direction === "outbound" && entry.message.id === permissionGate.requestId && entry.message.result?.outcome?.outcome === "selected"), "no stale allow response crossed the provider connection");
          await assert.rejects(access(path), { code: "ENOENT" });
          await closeOwner(owner);
          await assertRetired(worker);
          await assert.rejects(access(path), { code: "ENOENT" });
        } finally { permissionGate.decide({ outcome: "reject_once" }); permissionGate = undefined; }
      }
      assert.equal(modelRequests.length, 9);
      assert.equal(permissions.length, 6);
      if (selectorPeer) t.diagnostic("Compiled production factories and real lifetime fences selected the exact native Kimi child despite ps rendering; actual title mutation and environment exclusion passed, missing/foreign/ambiguous targets were refused, and sealed-byte/inode/run-bound fault injection retired only the owned native tree");
      t.diagnostic("SIMULATED provider service; pending native Write permission Stop and exact observed native-worker SIGKILL both revoked host callbacks, suppressed stale allow responses, produced no file/model continuation, settled typed results and retired owned native processes; zero external model calls");
    }
  } finally {
    try { await Promise.all(owners.map(closeOwner)); }
    finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
      await rm(root, { recursive: true, force: true });
    }
  }
});
