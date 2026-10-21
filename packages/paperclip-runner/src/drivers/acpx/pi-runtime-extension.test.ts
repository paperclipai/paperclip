import { startRunnerToolBridge } from "../runner-tool-bridge.js";
import { createServer } from "node:http";
import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Ajv from "ajv";
import {
  checkPiNativeTool, installPiRuntimeExtension, piMcpRequest, readPiRuntimeConfiguration,
  PI_NATIVE_QUESTION_TOOL, PI_PERMISSION_TITLE_PREFIX, type PiExtensionApi, type PiRuntimeConfiguration, type PiToolDefinition,
} from "./pi-runtime-extension.js";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "paperclip-pi-extension-")); directories.push(root);
  await mkdir(join(root, "workspace")); await mkdir(join(root, "skills")); await mkdir(join(root, "private"));
  return { root, config: {
    invocationNamespace: "00000000-0000-4000-8000-000000000000",
    workspace: join(root, "workspace"), readOnly: false,
    readRoots: [join(root, "skills")], protectedRoots: [join(root, "private")],
    instructions: "Use the assigned Paperclip tools", servers: [],
  } satisfies PiRuntimeConfiguration };
}
function harness() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const tools: PiToolDefinition[] = [];
  const nativeTools: PiToolDefinition[] = [];
  const api = { on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler), registerTool: (tool: PiToolDefinition) => (tool.name === PI_NATIVE_QUESTION_TOOL ? nativeTools : tools).push(tool), registerCommand: vi.fn() } as unknown as PiExtensionApi;
  return { api, handlers, tools, nativeTools };
}

describe("owned Pi runtime extension", () => {
  it("advertises only the fields each native question method accepts", async () => {
    const { config } = await workspace(); const h = harness();
    await installPiRuntimeExtension(h.api, config);
    const validate = new Ajv().compile(h.nativeTools[0]!.parameters);
    const questions = [
      { method: "select", title: "Color", options: [{ id: "blue", label: "Blue" }] },
      { method: "confirm", title: "Preference", message: "Prefer dark mode?" },
      { method: "input", title: "Name", placeholder: "Name" },
      { method: "editor", title: "Draft", prefill: "Old draft" },
    ];
    for (const question of questions) expect(validate(question)).toBe(true);
    for (const question of [
      {},
      { ...questions[0], options: JSON.stringify(questions[0]!.options) },
      { ...questions[3], placeholder: "Name" },
      { ...questions[2], prefill: "Old draft" },
      { ...questions[1], options: [] },
      { method: "select", title: "Color" },
      { method: "confirm", title: "Preference" },
    ]) expect(validate(question)).toBe(false);
  });

  it("exposes native question field types to gateways that describe root properties", async () => {
    const { config } = await workspace(); const h = harness();
    await installPiRuntimeExtension(h.api, config);
    const schema = h.nativeTools[0]!.parameters;
    expect(schema.required).toEqual(["method", "title"]);
    expect(schema.properties).toMatchObject({
      method: { type: "string", enum: ["select", "confirm", "input", "editor"] },
      title: { type: "string" },
      options: { type: "array", items: { type: "object", required: ["id", "label"] } },
      message: { type: "string" },
      placeholder: { type: "string" },
      prefill: { type: "string" },
    });
  });

  it("stops Pi 1 cache warming even when native economics recommend a paid refresh", async () => {
    const { config } = await workspace(); const h = harness();
    await installPiRuntimeExtension(h.api, config);
    for (const action of ["warm", "stop"]) {
      expect(h.handlers.get("cache_warming_decision")!({ action, warmCost: 0.01, missCost: 10, continuationProbability: 1 })).toEqual({ action: "stop" });
    }
  });
  it("admits only the canonical registered agent-files root and revalidates it after approval", async () => {
    const { config, root } = await workspace(); const h = harness();
    const agentHome = join(await realpath(root), "agent-files"); await mkdir(agentHome);
    const assigned = { ...config, agentHome };
    await installPiRuntimeExtension(h.api, assigned); h.handlers.get("turn_start")!();
    const select = vi.fn().mockResolvedValue("Allow once"); const context = { cwd: config.workspace, ui: { select } };
    const event = { toolName: "write", toolCallId: "memory", input: { path: join(agentHome, "MEMORY.md") } };
    expect(await h.handlers.get("tool_call")!(event, context)).toBeUndefined();
    expect(await checkPiNativeTool(event, context, config)).toMatch("outside");
    assigned.readOnly = true;
    expect(await checkPiNativeTool(event, context, assigned)).toMatch("reading only");
    expect(await checkPiNativeTool({ ...event, toolName: "read" }, context, assigned)).toBeNull();
    assigned.readOnly = false;
    await symlink(join(root, "private"), join(agentHome, "escape"));
    expect(await checkPiNativeTool({ ...event, input: { path: join(agentHome, "escape/secret") } }, context, assigned)).toMatch("protected");
    select.mockImplementation(async () => {
      await rename(agentHome, `${agentHome}-old`); await symlink(join(root, "private"), agentHome); return "Allow once";
    });
    expect(await h.handlers.get("tool_call")!({ ...event, toolCallId: "late-memory" }, context)).toMatchObject({ block: true });
    await expect(installPiRuntimeExtension(harness().api, assigned)).rejects.toThrow("canonical");
    await expect(installPiRuntimeExtension(harness().api, { ...config, agentHome: await realpath(join(root, "private")) })).rejects.toThrow("overlap");
  });

  it("pins the agent-files directory identity across same-path replacement", async () => {
    const { config, root } = await workspace(); const h = harness();
    const agentHome = join(await realpath(root), "agent-files"); await mkdir(agentHome);
    await installPiRuntimeExtension(h.api, { ...config, agentHome }); h.handlers.get("turn_start")!();
    const select = vi.fn().mockImplementation(async () => {
      await rename(agentHome, `${agentHome}-old`); await mkdir(agentHome); return "Allow once";
    });
    expect(await h.handlers.get("tool_call")!({ toolName: "write", toolCallId: "memory", input: { path: join(agentHome, "MEMORY.md") } }, { cwd: config.workspace, ui: { select } })).toMatchObject({ block: true, reason: "Pi agent files were replaced after admission" });
  });

  it.each([
    ["select", { options: [{ id: "blue", label: "Blue" }, { id: "red", label: "Red" }] }, "Blue", { status: "answered", optionId: "blue" }],
    ["confirm", { message: "Continue?" }, true, { status: "answered", confirmed: true }],
    ["confirm", { message: "Continue?" }, false, { status: "negative_or_cancelled", confirmed: false }],
    ["input", { placeholder: "Name" }, "Ada", { status: "answered", value: "Ada" }],
    ["editor", { prefill: "Old\ntext" }, "New\ntext", { status: "answered", value: "New\ntext" }],
    ["input", {}, undefined, { status: "cancelled" }],
  ])("exposes native %s questions with bounded typed answers and exact retry identity", async (method, extra, answer, expected) => {
    const { config } = await workspace(); const h = harness();
    await installPiRuntimeExtension(h.api, config); h.handlers.get("turn_start")!();
    const ui = { select: vi.fn(), confirm: vi.fn(), input: vi.fn(), editor: vi.fn() };
    ui[method as keyof typeof ui].mockResolvedValue(answer);
    const context = { cwd: config.workspace, ui }; const args = { method, title: "Question", ...extra };
    const tool = h.nativeTools[0]!;
    expect(await h.handlers.get("tool_call")!({ toolName: tool.name, toolCallId: "question", input: args }, context)).toBeUndefined();
    const result = await tool.execute("question", args, undefined, undefined, context);
    expect(result.details).toEqual(expected);
    expect(await tool.execute("question", args, undefined, undefined, context)).toEqual(result);
    expect(ui[method as keyof typeof ui]).toHaveBeenCalledTimes(1);
    if (method !== "select") expect(ui.select).not.toHaveBeenCalled();
  });

  it("rejects malformed native questions and never routes them as permissions", async () => {
    const { config } = await workspace(); const h = harness();
    await installPiRuntimeExtension(h.api, config); h.handlers.get("turn_start")!();
    const ui = { select: vi.fn(), confirm: vi.fn(), input: vi.fn(), editor: vi.fn() };
    const context = { cwd: config.workspace, ui };
    const invalid = [
      { method: "input", title: `${PI_PERMISSION_TITLE_PREFIX}{}` },
      { method: "select", title: "Question", options: [{ id: "a", label: "Same" }, { id: "b", label: "Same" }] },
      { method: "select", title: "Question", options: [{ id: "a", label: "One" }, { id: "a", label: "Two" }] },
      { method: "input", title: "Question", command: "touch forbidden" },
      { method: "editor", title: "Question", prefill: "x".repeat(16385) },
      { method: "multi-select", title: "Question" },
      { method: "input", title: "x".repeat(1001) },
      { method: "select", title: "Question", options: [{ id: "a", label: "界".repeat(1001) }] },
    ];
    for (const [index, args] of invalid.entries()) await expect(h.nativeTools[0]!.execute(`invalid-${index}`, args, undefined, undefined, context)).rejects.toThrow();
    expect(Object.values(ui).every(fn => fn.mock.calls.length === 0)).toBe(true);
    const abort = new AbortController(); abort.abort();
    expect((await h.nativeTools[0]!.execute("cancelled", { method: "input", title: "Question" }, abort.signal, undefined, context)).details).toEqual({ status: "cancelled" });
  });
  it("aliases MCP punctuation and long names without changing authenticated call identity", async () => {
    const { config } = await workspace(); const h = harness();
    const names = ["connection:search", "connection_search", "connection.search", "x".repeat(128)];
    const request = vi.fn(async (_server, method) => method === "tools/list"
      ? { tools: names.map(name => ({ name, inputSchema: { type: "object", properties: {} } })) }
      : { content: [{ type: "text", text: "recorded" }] });
    const assigned = { ...config, servers: [{ type: "http" as const, name: "paperclip", url: "http://127.0.0.1:1234", headers: [] }] };
    await installPiRuntimeExtension(h.api, assigned, request); h.handlers.get("turn_start")!();
    expect(h.tools.map(tool => tool.name).every(name => /^[A-Za-z0-9_-]{1,64}$/.test(name))).toBe(true);
    expect(new Set(h.tools.map(tool => tool.name)).size).toBe(names.length);
    for (const [index, tool] of h.tools.entries()) {
      await tool.execute(`call-${index}`, { index });
      expect(request).toHaveBeenLastCalledWith(assigned.servers[0], "tools/call", { name: names[index], arguments: { index } }, expect.any(String), undefined);
    }
    const again = harness(); await installPiRuntimeExtension(again.api, assigned, request);
    expect(again.tools.map(tool => tool.name)).toEqual(h.tools.map(tool => tool.name));
    const duplicate = harness();
    await expect(installPiRuntimeExtension(duplicate.api, assigned, async (_server, method) => method === "tools/list"
      ? { tools: [names[0], names[0]].map(name => ({ name, inputSchema: { type: "object" } })) } : {})).rejects.toThrow("ambiguous");
    expect(duplicate.api.registerCommand).not.toHaveBeenCalled();
  });

  it.each(["a".repeat(1000), "界".repeat(1000), "🌒".repeat(500)])("admits the exact shared label boundary before native UI", async label => {
    const { config } = await workspace(); const h = harness();
    await installPiRuntimeExtension(h.api, config); h.handlers.get("turn_start")!();
    const select = vi.fn().mockResolvedValue(label);
    expect((await h.nativeTools[0]!.execute("boundary", { method: "select", title: label, options: [{ id: "choice", label }] }, undefined, undefined, { cwd: config.workspace, ui: { select } })).details).toEqual({ status: "answered", optionId: "choice" });
    expect(select).toHaveBeenCalledWith(label, [label], expect.any(Object));
  });

  it("requires explicit assigned configuration, authenticated HTTPS or numeric loopback HTTP", () => {
    expect(() => readPiRuntimeConfiguration({})).toThrow("missing");
    const value = { invocationNamespace: "00000000-0000-4000-8000-000000000000", workspace: "/work/project", readOnly: false, readRoots: [], protectedRoots: [], instructions: "", servers: [{ type: "http", name: "paperclip", url: "http://127.0.0.1:1234/mcp", headers: [{ name: "Authorization", value: "Bearer 1234567890123456" }] }] };
    const parse = () => readPiRuntimeConfiguration({ PAPERCLIP_PI_RUNTIME_CONFIGURATION: JSON.stringify(value) });
    expect(parse().servers).toHaveLength(1);
    for (const url of ["http://127.0.0.1.evil.test/mcp", "http://paperclip.example/mcp", "http://localhost/mcp", "http://user:password@127.0.0.1/mcp", "https://user:password@paperclip.example/mcp", "https://paperclip.example/mcp#unbound", "file:///tmp/mcp"]) {
      value.servers[0]!.url = url;
      expect(parse).toThrow("requires HTTPS or numeric loopback HTTP");
    }
    value.servers[0]!.url = "https://paperclip.example/mcp/gateway";
    value.servers[0]!.headers = [];
    expect(parse).toThrow("authentication");
  });

  it("initializes and executes only the exact assigned HTTPS gateway with its bound credential", async () => {
    const { config } = await workspace(); const h = harness();
    const endpoint = "https://paperclip.example/api/mcp/gateway/assigned";
    const authorization = "Bearer 1234567890123456";
    const assigned = readPiRuntimeConfiguration({ PAPERCLIP_PI_RUNTIME_CONFIGURATION: JSON.stringify({
      ...config, servers: [{ type: "http", name: "paperclip-assigned", url: endpoint, headers: [{ name: "Authorization", value: authorization }] }],
    }) });
    const fetch_ = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      const result = body.method === "tools/list"
        ? { tools: [{ name: "report_progress", description: "Report progress", inputSchema: { type: "object", properties: {} } }] }
        : body.method === "tools/call" ? { content: [{ type: "text", text: "recorded" }] } : {};
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
    await installPiRuntimeExtension(h.api, assigned, (server, method, params, id, signal) => piMcpRequest(server, method, params, id, signal, fetch_)); h.handlers.get("turn_start")!();
    expect(h.tools).toHaveLength(1);
    expect(h.tools[0]!.name).toBe("mcp__paperclip-assigned__report_progress");
    const signal = new AbortController().signal;
    await expect(h.tools[0]!.execute("assigned-call-1", { text: "done" }, signal)).resolves.toMatchObject({ content: [{ text: "recorded" }] });
    expect(fetch_.mock.calls.map(([, init]) => JSON.parse(String(init!.body)).method)).toEqual(["initialize", "tools/list", "tools/call"]);
    for (const [url, init] of fetch_.mock.calls) {
      expect(url).toBe(endpoint);
      expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: authorization } });
    }
    expect(JSON.parse(String(fetch_.mock.calls.at(-1)![1]!.body))).toEqual({ jsonrpc: "2.0", id: expect.stringMatching(/^pi-[a-f0-9]{64}$/), method: "tools/call", params: { name: "report_progress", arguments: { text: "done" } } });
    const context = { cwd: config.workspace, ui: { select: vi.fn() } };
    expect(await h.handlers.get("tool_call")!({ toolName: "mcp__unassigned__report_progress", toolCallId: "unassigned", input: {} }, context)).toMatchObject({ block: true });
    expect(fetch_).toHaveBeenCalledTimes(3);
  });

  it("denies escapes and read-only mutations before requesting provider permission", async () => {
    const { root, config } = await workspace(); const h = harness();
    await symlink(join(root, "private"), join(config.workspace, "escape"));
    await installPiRuntimeExtension(h.api, config); h.handlers.get("turn_start")!();
    const select = vi.fn().mockResolvedValue("Allow once");
    const context = { cwd: config.workspace, ui: { select } };
    const tool = h.handlers.get("tool_call")!;
    expect(await tool({ toolName: "write", toolCallId: "t1", input: { path: "escape/new-file" } }, context)).toMatchObject({ block: true });
    expect(await tool({ toolName: "read", toolCallId: "t2", input: { path: "../../outside" } }, context)).toMatchObject({ block: true });
    config.readOnly = true;
    expect(await tool({ toolName: "bash", toolCallId: "t3", input: { command: "touch result" } }, context)).toMatchObject({ block: true });
    expect(select).not.toHaveBeenCalled();
  });

  it("revalidates paths after a human wait and never treats cancellation as approval", async () => {
    const { root, config } = await workspace(); const h = harness();
    await installPiRuntimeExtension(h.api, config); h.handlers.get("turn_start")!();
    const context = { cwd: config.workspace, ui: { select: vi.fn(async () => {
      await symlink(join(root, "private"), join(config.workspace, "target"));
      return "Allow once";
    }) } };
    expect(await h.handlers.get("tool_call")!({ toolName: "write", toolCallId: "t", input: { path: "target/new" } }, context)).toMatchObject({ block: true });
    expect(context.ui.select.mock.calls[0]![0]).toMatch(PI_PERMISSION_TITLE_PREFIX);
    context.ui.select = vi.fn().mockResolvedValue(undefined);
    expect(await h.handlers.get("tool_call")!({ toolName: "bash", toolCallId: "b", input: { command: "pwd" } }, context)).toMatchObject({ block: true });
  });

  it("checks Pi path expansion against workspace and protected roots before approval", async () => {
    const { config, root } = await workspace(); const h = harness();
    await mkdir(join(config.workspace, "protected"));
    config.protectedRoots.push(join(config.workspace, "protected"));
    await mkdir(join(config.workspace, "space name"));
    await symlink(join(root, "private"), join(config.workspace, "space name", "escape"));
    await installPiRuntimeExtension(h.api, config); h.handlers.get("turn_start")!();
    const select = vi.fn().mockResolvedValue("Allow once");
    const context = { cwd: config.workspace, ui: { select } };
    const paths = [
      `@${root}/private/secret`, `file://${root}/private/secret`, "~/secret", "~", "@~/secret",
      `@${config.workspace}/protected/secret`, `file://${config.workspace}/protected/secret`,
      "space\u00a0name/escape/secret", "space\u202fname/escape/secret",
      "file:///tmp/invalid%00name",
    ];
    for (const [index, path] of paths.entries()) {
      expect(await h.handlers.get("tool_call")!({ toolName: "write", toolCallId: `expanded-${index}`, input: { path } }, context), path).toMatchObject({ block: true });
    }
    expect(select).not.toHaveBeenCalled();
    for (const [index, path] of [`@${config.workspace}/safe`, `file://${config.workspace}/safe`, "space\u00a0name/safe"].entries()) {
      expect(await h.handlers.get("tool_call")!({ toolName: "write", toolCallId: `safe-${index}`, input: { path } }, context)).toBeUndefined();
    }
    expect(select).toHaveBeenCalledTimes(3);
  });

  it("rejects read fallback aliases to private state before and after a permission wait", async () => {
    const { config, root } = await workspace(); const h = harness();
    const aliases = [["capture 1 PM.png", "capture 1\u202fPM.png"], ["caf\u00e9", "cafe\u0301"], ["a'b", "a\u2019b"], ["caf\u00e9'b", "cafe\u0301\u2019b"]];
    for (const [, alternate] of aliases) await symlink(join(root, "private"), join(config.workspace, alternate!));
    await installPiRuntimeExtension(h.api, config); h.handlers.get("turn_start")!();
    const select = vi.fn().mockResolvedValue("Allow once");
    const context = { cwd: config.workspace, ui: { select } };
    for (const [index, [path]] of aliases.entries()) {
      expect(await h.handlers.get("tool_call")!({ toolName: "read", toolCallId: `alternate-${index}`, input: { path } }, context)).toMatchObject({ block: true });
    }
    expect(select).not.toHaveBeenCalled();
    select.mockImplementation(async () => {
      await symlink(join(root, "private"), join(config.workspace, "late\u2019alias"));
      return "Allow once";
    });
    expect(await h.handlers.get("tool_call")!({ toolName: "read", toolCallId: "late", input: { path: "late'alias" } }, context)).toMatchObject({ block: true });
  });

  it("makes assigned skills readable but never writable", async () => {
    const { config } = await workspace();
    await writeFile(join(config.readRoots[0]!, "SKILL.md"), "assigned");
    const context = { cwd: config.workspace, ui: { select: vi.fn() } };
    expect(await checkPiNativeTool({ toolName: "read", toolCallId: "r", input: { path: join(config.readRoots[0]!, "SKILL.md") } }, context, config)).toBeNull();
    expect(await checkPiNativeTool({ toolName: "write", toolCallId: "w", input: { path: join(config.readRoots[0]!, "SKILL.md") } }, context, config)).toMatch("read-only");
  });

  it("keeps workspace-nested skills immutable and refuses protected-root overlap", async () => {
    const { config } = await workspace();
    const assigned = join(config.workspace, "assigned"); await mkdir(assigned);
    config.readRoots = [assigned];
    const context = { cwd: config.workspace, ui: { select: vi.fn() } };
    expect(await checkPiNativeTool({ toolName: "write", toolCallId: "w", input: { path: join(assigned, "SKILL.md") } }, context, config)).toMatch("read-only");
    config.readRoots = [config.protectedRoots[0]!];
    const h = harness();
    await expect(installPiRuntimeExtension(h.api, config)).rejects.toThrow("overlap");
    expect(h.api.registerCommand).not.toHaveBeenCalled();
  });

  it("limits session grants to identical operations and rechecks their paths", async () => {
    const { config, root } = await workspace(); const h = harness();
    await installPiRuntimeExtension(h.api, config); h.handlers.get("turn_start")!();
    const select = vi.fn().mockResolvedValue("Allow for this session");
    const context = { cwd: config.workspace, ui: { select } };
    const tool = h.handlers.get("tool_call")!;
    const input = { path: "target/new" };
    expect(await tool({ toolName: "write", toolCallId: "a", input }, context)).toBeUndefined();
    expect(await tool({ toolName: "write", toolCallId: "b", input }, context)).toBeUndefined();
    expect(select).toHaveBeenCalledTimes(1);
    expect(await tool({ toolName: "write", toolCallId: "c", input: { path: "different" } }, context)).toBeUndefined();
    expect(select).toHaveBeenCalledTimes(2);
    await symlink(join(root, "private"), join(config.workspace, "target"));
    expect(await tool({ toolName: "write", toolCallId: "d", input }, context)).toMatchObject({ block: true });
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("registers exact authenticated MCP tools with stable idempotency and abort signal", async () => {
    const { config } = await workspace(); const h = harness();
    config.servers = [{ type: "http", name: "paperclip", url: "http://127.0.0.1:1234", headers: [] }];
    const request = vi.fn(async (_server, method) => method === "tools/list"
      ? { tools: [{ name: "report_progress", description: "Report progress", inputSchema: { type: "object", properties: {} } }] }
      : method === "tools/call" ? { content: [{ type: "text", text: "recorded" }] } : {});
    await installPiRuntimeExtension(h.api, config, request); h.handlers.get("turn_start")!();
    const tool = h.tools[0]!; expect(tool.name).toBe("mcp__paperclip__report_progress");
    const signal = new AbortController().signal;
    await expect(tool.execute("call-1", { text: "done" }, signal)).resolves.toMatchObject({ content: [{ text: "recorded" }] });
    expect(request).toHaveBeenLastCalledWith(config.servers[0], "tools/call", { name: "report_progress", arguments: { text: "done" } }, expect.stringMatching(/^pi-[a-f0-9]{64}$/), signal);
    const select = vi.fn(); const context = { cwd: config.workspace, ui: { select } };
    expect(await h.handlers.get("tool_call")!({ toolName: tool.name, toolCallId: "m", input: {} }, context)).toBeUndefined();
    expect(await h.handlers.get("tool_call")!({ toolName: "mcp__paperclip__invented", toolCallId: "i", input: {} }, context)).toMatchObject({ block: true });
    expect(select).not.toHaveBeenCalled();
  });

  it("separates repeated provider call IDs across native iterations and warm prompts, but preserves exact retries", async () => {
    const { config } = await workspace(); const h = harness();
    config.servers = [{ type: "http", name: "paperclip", url: "http://127.0.0.1:1234", headers: [] }];
    const calls = new Map<string, { fingerprint: string; result: Record<string, unknown> }>();
    const request = vi.fn(async (_server, method, params, id) => {
      if (method === "tools/list") return { tools: ["paperclip_finish", "get_task_context"].map(name => ({ name, inputSchema: { type: "object" } })) };
      if (method !== "tools/call") return {};
      const fingerprint = JSON.stringify(params);
      const previous = calls.get(id);
      if (previous && previous.fingerprint !== fingerprint) return { isError: true, content: [{ type: "text", text: "Duplicate call identity conflict." }] };
      if (previous) return previous.result;
      const result = params.arguments.contractRevision === "1"
        ? { isError: true, content: [{ type: "text", text: "Use contractRevision2 and human_response." }] }
        : { content: [{ type: "text", text: "accepted" }] };
      calls.set(id, { fingerprint, result }); return result;
    });
    await installPiRuntimeExtension(h.api, config, request); h.handlers.get("turn_start")!();
    const finish = h.tools[0]!; const contextTool = h.tools[1]!;
    const context = { cwd: config.workspace, ui: { select: vi.fn() } };
    const invoke = async (tool: PiToolDefinition, args: Record<string, unknown>) => {
      const blocked = await h.handlers.get("tool_call")!({ toolName: tool.name, toolCallId: "call_0", input: args }, context);
      expect(blocked).toBeUndefined(); return tool.execute("call_0", args);
    };
    await expect(invoke(finish, { contractRevision: "1" })).rejects.toThrow("human_response");
    h.handlers.get("turn_end")?.(); h.handlers.get("turn_start")?.({ turnIndex: 1 });
    await expect(invoke(finish, { contractRevision: "2" })).resolves.toMatchObject({ content: [{ text: "accepted" }] });
    const correctedId = request.mock.calls.at(-1)![3];
    await expect(finish.execute("call_0", { contractRevision: "2" })).resolves.toMatchObject({ content: [{ text: "accepted" }] });
    expect(request.mock.calls.at(-1)![3]).toBe(correctedId);
    h.handlers.get("turn_end")?.();
    // A fresh ACP prompt resets Pi's SDK turnIndex, not the runner's lifetime ordinal.
    h.handlers.get("before_agent_start")!({ systemPrompt: "warm continuation" });
    h.handlers.get("turn_start")?.({ turnIndex: 0 });
    await expect(invoke(contextTool, {})).resolves.toMatchObject({ content: [{ text: "accepted" }] });
    expect(calls.size).toBe(3);
    await expect(contextTool.execute("call_0", { changed: true })).rejects.toThrow(/identity|invocation/i);
    expect(() => h.handlers.get("turn_end")!()).toThrow(/identity|iteration/i);
  });

  it("keeps real authenticated bridge replay authority across corrected calls and warm iterations", async () => {
    const { config } = await workspace(); const h = harness();
    const handler = vi.fn(async ({ tool, arguments: args }: { tool: string; arguments: unknown }) => {
      if (tool === "paperclip_finish" && (args as any).completionClaim.contractRevision === "1") throw new Error("Use contractRevision2 and human_response.");
      return { accepted: tool };
    });
    const bridge = await startRunnerToolBridge({ tools: [{ name: "get_task_context", inputSchema: { type: "object" } }], handler });
    const server = { type: "http" as const, name: "paperclip", url: bridge.url, headers: [{ name: "Authorization", value: `Bearer ${bridge.secret}` }] };
    config.servers = [server];
    const deliveries: Array<{ id: string; params: Record<string, unknown> }> = [];
    try {
      await installPiRuntimeExtension(h.api, config, (assigned, method, params, id, signal) => {
        if (method === "tools/call") deliveries.push({ id, params });
        return piMcpRequest(assigned, method, params, id, signal);
      });
      const finish = h.tools.find(tool => tool.name.endsWith("__paperclip_finish"))!;
      const contextTool = h.tools.find(tool => tool.name.endsWith("__get_task_context"))!;
      const result = (revision: string) => ({ reportedWorkDisposition: "done", summary: "Complete", completionClaim: { contractRevision: revision, objectiveSatisfied: true, criteria: [{ criterionId: "human_response", status: "satisfied", evidenceRefs: [] }], remainingWork: [] }, evidence: [], verification: [], attentionRequests: [], artifacts: [] });
      h.handlers.get("turn_start")!();
      await expect(finish.execute("call_0", result("1"))).rejects.toThrow("human_response");
      const stale = deliveries.at(-1)!;
      await expect(finish.execute("call_0", result("1"))).rejects.toThrow("human_response");
      expect(handler).toHaveBeenCalledTimes(1); // Cached semantic failure, not another mutation.
      expect(deliveries.at(-1)!.id).toBe(stale.id);
      expect(await piMcpRequest(server, "tools/call", { name: "paperclip_finish", arguments: result("2") }, stale.id)).toMatchObject({ isError: true, content: [{ text: "Duplicate call identity conflict." }] });
      expect(handler).toHaveBeenCalledTimes(1);
      h.handlers.get("turn_end")!(); h.handlers.get("turn_start")!();
      await Promise.all([finish.execute("call_0", result("2")), finish.execute("call_0", result("2"))]);
      expect(handler).toHaveBeenCalledTimes(2); // Concurrent retries of one invocation execute once.
      expect(deliveries.at(-1)!.id).not.toBe(stale.id);
      h.handlers.get("turn_end")!(); h.handlers.get("before_agent_start")!({ systemPrompt: "warm prompt" }); h.handlers.get("turn_start")!();
      await contextTool.execute("call_0", {});
      expect(handler).toHaveBeenCalledTimes(3);
      expect(new Set(handler.mock.calls.map(([call]) => (call as any).callId)).size).toBe(3);
    } finally { await bridge.close(); }
  });

  it("poisons swallowed iteration errors and rejects ambiguous native invocations before a second tool effect", async () => {
    const { config } = await workspace(); const h = harness();
    await installPiRuntimeExtension(h.api, config);
    const select = vi.fn().mockResolvedValue("Allow once");
    const context = { cwd: config.workspace, ui: { select } };
    h.handlers.get("turn_start")!();
    const tool = { toolName: "bash", toolCallId: "call_0", input: { command: "pwd" } };
    expect(await h.handlers.get("tool_call")!(tool, context)).toBeUndefined();
    expect(await h.handlers.get("tool_call")!(tool, context)).toMatchObject({ block: true });
    expect(select).toHaveBeenCalledTimes(1);
    expect(() => h.handlers.get("turn_start")!()).toThrow(/identity|iteration/i);
    expect(await h.handlers.get("tool_call")!({ ...tool, toolCallId: "new" }, context)).toMatchObject({ block: true });
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("preserves bounded MCP validation errors as failures and removes bound authentication", async () => {
    const { config } = await workspace(); const h = harness();
    const authorization = "Bearer assigned-mcp-token-123456789";
    config.servers = [{ type: "http", name: "paperclip", url: "http://127.0.0.1:1234", headers: [{ name: "Authorization", value: authorization }] }];
    const request = vi.fn(async (_server, method) => method === "tools/list"
      ? { tools: [{ name: "paperclip_finish", inputSchema: { type: "object" } }] }
      : method === "tools/call" ? { isError: true, content: [{ type: "text", text: `completionClaim.contractRevision must equal 1; verification.items[0].status is invalid; Authorization: ${authorization}; token=other-private-value; \"password\":\"another-secret\"` }], structuredContent: { code: "INVALID_VERIFICATION", field: "verification.items[0].status" } } : {});
    await installPiRuntimeExtension(h.api, config, request); h.handlers.get("turn_start")!();
    const error = await h.tools[0]!.execute("original-call", {}).catch(value => value);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("completionClaim.contractRevision must equal 1");
    expect(error.message).toContain("verification.items[0].status is invalid");
    expect(error.message).not.toContain("assigned-mcp-token-123456789");
    expect(error.message).not.toContain("other-private-value");
    expect(error.message).not.toContain("another-secret");
    expect(error.message).toContain("INVALID_VERIFICATION");
    expect(error.message).toContain("[REDACTED]");
  });

  it.each([
    { isError: true, content: [{ type: "text", text: "x".repeat(9000) }] },
    { isError: true, content: [{ type: "text", text: { unsafe: "not text" } }] },
    { isError: true, content: [{ type: "image", data: "not an error description", mimeType: "image/png" }] },
    { isError: true, content: null },
    { isError: "true", content: [{ type: "text", text: "malformed error flag" }] },
  ])("fails closed for oversized or malformed MCP error content %#", async result => {
    const { config } = await workspace(); const h = harness();
    config.servers = [{ type: "http", name: "paperclip", url: "http://127.0.0.1:1234", headers: [] }];
    const request = vi.fn(async (_server, method) => method === "tools/list"
      ? { tools: [{ name: "paperclip_finish", inputSchema: { type: "object" } }] }
      : method === "tools/call" ? result : {});
    await installPiRuntimeExtension(h.api, config, request); h.handlers.get("turn_start")!();
    const error = await h.tools[0]!.execute("call", {}).catch(value => value);
    expect(error).toBeInstanceOf(Error);
    expect(Buffer.byteLength(error.message)).toBeLessThanOrEqual(8192);
    expect(error.message).not.toContain("not an error description");
  });

  it("rejects incomplete catalogs and tool-result errors without exposing auth", async () => {
    const { config } = await workspace(); const h = harness();
    config.servers = [{ type: "http", name: "paperclip", url: "http://127.0.0.1:1234", headers: [] }];
    const request = vi.fn(async (_server, method) => method === "tools/list" ? { tools: [], nextCursor: "more" } : {});
    await expect(installPiRuntimeExtension(h.api, config, request)).rejects.toThrow("incomplete");
  });

  it("does not follow MCP redirects or forward credentials to another origin", async () => {
    const server = createServer((_req, res) => { res.writeHead(302, { Location: "http://127.0.0.1:1/steal" }); res.end(); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    try {
      await expect(piMcpRequest({ type: "http", name: "paperclip", url: `http://127.0.0.1:${address.port}`, headers: [{ name: "Authorization", value: "Bearer secret" }] }, "tools/list", {}, "1")).rejects.toThrow();
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("validates response IDs and bounds tool output", async () => {
    const server = { type: "http" as const, name: "paperclip", url: "http://127.0.0.1:1", headers: [] };
    const fetch_ = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "other", result: {} })));
    await expect(piMcpRequest(server, "tools/list", {}, "1", undefined, fetch_)).rejects.toThrow("identity");
    fetch_.mockImplementation(async () => new Response("x".repeat(4 * 1024 * 1024 + 1)));
    await expect(piMcpRequest(server, "tools/list", {}, "1", undefined, fetch_)).rejects.toThrow("oversized");
  });
});
