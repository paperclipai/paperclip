import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { request } from "node:http";
import { CursorCloudCheckpointStore } from "./checkpoint.js";
import { RUNNER_TOOL_SCOPE_TOKEN_HEADER } from "../runner-tool-bridge.js";
import { CursorCloudDriver, type CursorCloudSessionHandle } from "./cursor-cloud-driver.js";
import { startCursorCloudAppServerProxy } from "../../cli/cursor-cloud-app-server-proxy.js";

const roots: string[] = [];
const proxies: Array<ReturnType<typeof startCursorCloudAppServerProxy>> = [];
afterEach(async () => {
  for (const proxy of proxies.splice(0)) await proxy.shutdown();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function peer() {
  const root = await mkdtemp("/tmp/cc-proxy-"); roots.push(root);
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ schema: "paperclip.cursor-cloud.config.v1", repos: [{ url: "https://github.com/example/repo" }], binding: { companyId: "company", agentId: "agent", issueId: "issue", normalizedSessionId: "session" } }), { mode: 0o600 });
  const input = new PassThrough(); const output = new PassThrough(); const diagnostic = new PassThrough();
  const frames: any[] = []; let buffer = "";
  output.on("data", chunk => { buffer += chunk.toString(); let index; while ((index = buffer.indexOf("\n")) >= 0) { frames.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1); } });
  const proxy = startCursorCloudAppServerProxy({ input, output, diagnostic, environment: { CURSOR_API_KEY: "private-key", PAPERCLIP_CURSOR_CLOUD_CONFIG_PATH: configPath, PAPERCLIP_NORMALIZED_SESSION_ID: "session", PAPERCLIP_RUN_ID: "run", PAPERCLIP_CURSOR_CLOUD_RELAY_URL: "https://relay.example.test/mcp", PAPERCLIP_CURSOR_CLOUD_RELAY_TOKEN: "private-relay-token", PAPERCLIP_CURSOR_CLOUD_RELAY_SOCKET_PATH: join(root, "mcp.sock"), PAPERCLIP_CURSOR_CLOUD_RELAY_EXPIRES_AT: String(Date.now() + 600_000) } });
  proxies.push(proxy);
  async function rpc(id: number, method: string, params: unknown = {}) { input.write(`${JSON.stringify({ id, method, params })}\n`); await vi.waitFor(() => expect(frames.some(frame => frame.id === id)).toBe(true), { timeout: 5_000 }); return frames.find(frame => frame.id === id); }
  return { root, input, output, frames, proxy, rpc, socketPath: join(root, "mcp.sock") };
}
function mcp(socketPath: string, body: Record<string, unknown>, headers: Record<string, string>, sessionId?: string): Promise<{ headers: Record<string, unknown>; value: any }> {
  return new Promise((accept, reject) => {
    const req = request({ socketPath, path: "/mcp", method: "POST", headers: { ...headers, "content-type": "application/json", ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) } }, response => {
      let text = ""; response.on("data", chunk => { text += chunk; }); response.on("end", () => { try { accept({ headers: response.headers, value: JSON.parse(text) }); } catch (error) { reject(error); } });
    });
    req.on("error", reject); req.end(JSON.stringify({ jsonrpc: "2.0", ...body }));
  });
}
describe("Cursor Cloud bounded stdio proxy", () => {
  it("initializes/opens without provider work and returns an explicit empty remote shutdown receipt", async () => {
    const nativeFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected paid call"));
    const f = await peer();
    try {
      expect(await f.rpc(1, "initialize")).toMatchObject({ result: { serverInfo: { name: "cursor-cloud" } } });
      const opened = await f.rpc(2, "thread/start", { model: "explicit-model", cwd: f.root, baseInstructions: "Exact instructions" });
      expect(opened).toMatchObject({ result: { thread: { id: "session" }, submittedModel: "explicit-model", effectiveModelAcknowledged: false, instructionsAcknowledged: false } });
      expect(opened.result).not.toHaveProperty("model"); expect(opened.result.thread).not.toHaveProperty("model");
      expect(await f.rpc(3, "turn/start", { input: [{ type: "image", url: "https://example.com/image.png" }] })).toHaveProperty("error");
      for (const [id, override] of [[4, { collaborationMode: { mode: "plan" } }], [5, { reasoningMode: "high" }]] as const) {
        expect(await f.rpc(id, "turn/start", { ...override, input: [{ type: "text", text: "Create the plan." }] }))
          .toMatchObject({ error: { message: "Cursor Cloud native plan/reasoning override is unsupported" } });
      }
      expect(await f.rpc(6, "collaborationMode/list")).toMatchObject({ result: { data: [{ mode: "default" }] } });
      expect(await f.rpc(7, "paperclip/shutdown", { threadId: "session", turnId: null })).toMatchObject({ result: { remoteStopped: true, threadId: "session", turnId: null, remoteRunId: null } });
      expect(nativeFetch).not.toHaveBeenCalled();
    } finally { f.input.end(); await f.proxy.done; }
  });
  it("bounds an unterminated input frame and finishes instead of retaining unbounded input", async () => {
    const f = await peer(); f.input.write("x".repeat(2_097_153)); await f.proxy.done;
    expect(f.frames).toEqual([]);
  });
  it("preserves native tool identity, status and bounded redacted output without assuming MCP transport", async () => {
    const remoteRunId = "run-22222222-2222-4222-8222-222222222222";
    const now = "2026-10-28T00:00:00Z";
    let remoteAgentId = "";
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    const nativeFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const target = new URL(String(url));
      expect(target.origin).toBe("https://api.cursor.com");
      if (target.pathname === "/v1/agents" && init?.method === "POST") {
        remoteAgentId = JSON.parse(String(init.body)).agentId;
        return json({ agent: { id: remoteAgentId, status: "ACTIVE", env: { type: "cloud" }, url: `https://cursor.com/agents/${remoteAgentId}`, createdAt: now, updatedAt: now, latestRunId: remoteRunId }, run: { id: remoteRunId, agentId: remoteAgentId, status: "RUNNING", createdAt: now, updatedAt: now } });
      }
      if (target.pathname.endsWith("/stream")) {
        const records = [
          { callId: "native-discovery", name: "get_mcp_tools", status: "running", args: { toolCallId: "synthetic-private-argument" }, result: { error: "native failure private-key private-relay-token" } },
          { callId: "native-discovery", name: "get_mcp_tools", status: "error", args: { toolCallId: "synthetic-private-argument" }, result: { error: "native failure private-key private-relay-token" } },
          { callId: "native-read", name: "read_file", status: "completed", args: { path: "synthetic-private-path" }, result: "x".repeat(65_536) },
        ];
        const body = records.map((data, index) => `id: ${index + 1}\nevent: tool_call\ndata: ${JSON.stringify(data)}\n\n`).join("")
          + `id: 4\nevent: result\ndata: ${JSON.stringify({ runId: remoteRunId, status: "FINISHED" })}\n\n`;
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      if (target.pathname.endsWith(`/${remoteRunId}`)) return json({ id: remoteRunId, agentId: remoteAgentId, status: "FINISHED", createdAt: now, updatedAt: now });
      throw new Error("Unexpected controlled provider request");
    });
    let releaseTerminalWrites!: () => void;
    const terminalGate = new Promise<void>(resolve => { releaseTerminalWrites = resolve; });
    let pausedTerminalWrites = 0;
    const write = CursorCloudCheckpointStore.prototype.write;
    vi.spyOn(CursorCloudCheckpointStore.prototype, "write").mockImplementation(async function(value) {
      if (value.phase === "terminal" && value.pendingTerminalDelivery) {
        pausedTerminalWrites += 1;
        await terminalGate;
      }
      await write.call(this, value);
    });
    const f = await peer();
    try {
      await f.rpc(1, "initialize");
      expect(await f.rpc(2, "thread/start", { model: "explicit-model", cwd: f.root })).toMatchObject({ result: { thread: { id: "session" } } });
      await f.rpc(3, "turn/start", { input: [{ type: "text", text: "Inspect native tool event delivery" }] });
      await vi.waitFor(() => expect(f.frames.filter(frame => frame.params?.item?.name === "get_mcp_tools" || frame.params?.item?.name === "read_file")).toHaveLength(3), { timeout: 1_000 });
      await vi.waitFor(() => expect(pausedTerminalWrites).toBe(1), { timeout: 5_000 });
      const pendingRead = f.rpc(9, "thread/read");
      await vi.waitFor(() => expect(pausedTerminalWrites).toBe(2), { timeout: 5_000 });
      expect(f.frames.some(frame => frame.id === 9)).toBe(false);
      const checkpointPath = join(f.root, (await readdir(f.root)).find(name => /^checkpoint-.*\.json$/.test(name))!);
      expect(JSON.parse(await readFile(checkpointPath, "utf8")).phase).toBe("running");
      releaseTerminalWrites();
      const committed = await pendingRead;
      expect(JSON.parse(await readFile(checkpointPath, "utf8")).pendingTerminalDelivery.receiptId).toBe(committed.result.cursorCloudTerminalDelivery.receiptId);
      await vi.waitFor(() => expect(f.frames.some(frame => frame.method === "turn/completed")).toBe(true), { timeout: 5_000 });
      const tools = f.frames.filter(frame => frame.params?.item?.name === "get_mcp_tools" || frame.params?.item?.name === "read_file");
      expect(tools.map(frame => ({ method: frame.method, type: frame.params.item.type, tool: frame.params.item.tool, status: frame.params.item.status }))).toEqual([
        { method: "item/started", type: "builtinToolCall", tool: "get_mcp_tools", status: "running" },
        { method: "item/completed", type: "builtinToolCall", tool: "get_mcp_tools", status: "error" },
        { method: "item/completed", type: "builtinToolCall", tool: "read_file", status: "completed" },
      ]);
      expect(JSON.parse(tools[0].params.item.output)).toEqual({ error: "native failure [redacted] [redacted]" });
      expect(JSON.parse(tools[1].params.item.output)).toEqual({ error: "native failure [redacted] [redacted]" });
      expect(JSON.parse(tools[2].params.item.output)).toEqual({ omitted: true, reason: "payload_limit" });
      expect(JSON.stringify(tools)).not.toContain("private-key");
      expect(JSON.stringify(tools)).not.toContain("private-relay-token");
      const retained = await f.rpc(4, "thread/read");
      expect(retained.result.thread.turns).toEqual([]);
      expect(retained.result.cursorCloudTerminalDelivery).toMatchObject({ status: "FINISHED", receiptId: expect.any(String) });
      const receipt = retained.result.cursorCloudTerminalDelivery;
      expect(await f.rpc(10, "paperclip/shutdown")).toMatchObject({ result: { cursorCloudTerminalDelivery: retained.result.cursorCloudTerminalDelivery } });
      expect(await f.rpc(5, "paperclip/ackTerminal", { turnId: receipt.turnId, receiptId: "wrong" })).toHaveProperty("error");
      expect(await f.rpc(6, "paperclip/ackTerminal", { turnId: receipt.turnId, receiptId: receipt.receiptId })).toMatchObject({ result: { acknowledged: true } });
      expect((await f.rpc(7, "thread/read")).result.cursorCloudTerminalDelivery).toBeNull();
      expect(await f.rpc(8, "paperclip/shutdown", { turnId: null })).toMatchObject({ result: { remoteStopped: true, turnId: null } });
      expect(nativeFetch.mock.calls.filter(([url, init]) => new URL(String(url)).pathname === "/v1/agents" && init?.method === "POST")).toHaveLength(1);
    } finally { releaseTerminalWrites(); f.input.end(); await f.proxy.done; }
  });
  it("round-trips a semantic completion over stdio and certifies shutdown only after native terminal lookup", async () => {
    const remoteRunId = "run-22222222-2222-4222-8222-222222222222";
    let remoteAgentId = ""; let status = "RUNNING"; let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    let mcpHeaders!: Record<string, string>;
    const now = "2026-10-28T00:00:00Z";
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    const nativeFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v1/agents" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)); remoteAgentId = body.agentId; mcpHeaders = body.mcpServers[0].headers;
        return json({ agent: { id: remoteAgentId, status: "ACTIVE", env: { type: "cloud" }, url: `https://cursor.com/agents/${remoteAgentId}`, createdAt: now, updatedAt: now, latestRunId: remoteRunId }, run: { id: remoteRunId, agentId: remoteAgentId, status, createdAt: now, updatedAt: now } });
      }
      if (path.endsWith("/stream")) return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; controller.enqueue(new TextEncoder().encode(`id: 1\nevent: assistant\ndata: {"text":"Working"}\n\n`)); } }), { headers: { "content-type": "text/event-stream" } });
      if (path.endsWith(`/${remoteRunId}`)) return json({ id: remoteRunId, agentId: remoteAgentId, status, createdAt: now, updatedAt: now });
      throw new Error("Unexpected controlled provider request");
    });
    let openedSession!: CursorCloudSessionHandle;
    const openSession = CursorCloudDriver.prototype.openSession;
    vi.spyOn(CursorCloudDriver.prototype, "openSession").mockImplementation(async function(input) {
      openedSession = await openSession.call(this, input);
      return openedSession;
    });
    const f = await peer();
    try {
      await f.rpc(1, "initialize"); await f.rpc(2, "thread/start", { model: "explicit-model", cwd: f.root, baseInstructions: "Use semantic completion." });
      const started = await f.rpc(3, "turn/start", { input: [{ type: "text", text: "Do the task" }] });
      await vi.waitFor(() => expect(stream).toBeDefined(), { timeout: 5_000 });
      expect(mcpHeaders).toMatchObject({ Authorization: "Bearer private-relay-token", [RUNNER_TOOL_SCOPE_TOKEN_HEADER]: expect.stringMatching(/^Bearer [A-Za-z0-9_-]{43}$/) });
      await expect(mcp(f.socketPath, { id: -1, method: "initialize" }, { Authorization: "Bearer private-relay-token" })).rejects.toBeInstanceOf(SyntaxError);
      const initialized = await mcp(f.socketPath, { id: 0, method: "initialize" }, mcpHeaders);
      const input = { reportedWorkDisposition: "done", summary: "Completed.", evidence: [], verification: [], completionClaim: { contractRevision: "1", objectiveSatisfied: true, criteria: [], remainingWork: [] } };
      const response = mcp(f.socketPath, { id: 1, method: "tools/call", params: { name: "paperclip_finish", arguments: input } }, mcpHeaders, initialized.headers["mcp-session-id"] as string);
      await vi.waitFor(() => expect(f.frames.some(frame => frame.method === "item/tool/call")).toBe(true), { timeout: 5_000 });
      const call = f.frames.find(frame => frame.method === "item/tool/call");
      expect(call.params).toMatchObject({ threadId: "session", turnId: started.result.turn.id, tool: "paperclip_finish", arguments: input });
      f.input.write(`${JSON.stringify({ id: call.id, result: { success: true, contentItems: [{ type: "inputText", text: "Exact accepted completion receipt" }] } })}\n`);
      expect((await response).value.result.content[0].text).toContain("Exact accepted completion receipt");
      expect(f.frames.some(frame => frame.method === "paperclip/runResult" || frame.method === "turn/completed")).toBe(false);
      const snapshot = openedSession.snapshot.bind(openedSession);
      let settleDuringRead = true;
      vi.spyOn(openedSession, "snapshot").mockImplementation(async () => {
        const value = await snapshot();
        if (settleDuringRead) {
          settleDuringRead = false;
          status = "FINISHED"; stream!.enqueue(new TextEncoder().encode(`id: 2\nevent: result\ndata: ${JSON.stringify({ runId: remoteRunId, status })}\n\n`));
          await vi.waitFor(() => expect(f.frames.some(frame => frame.method === "turn/completed")).toBe(true), { timeout: 5_000 });
        }
        return value;
      });
      const racing = await f.rpc(5, "thread/read");
      expect(Boolean(racing.result.thread.turns.length && racing.result.cursorCloudTerminalDelivery)).toBe(false);
      expect(await f.rpc(4, "paperclip/shutdown", { threadId: "session", turnId: started.result.turn.id })).toMatchObject({ result: { remoteStopped: true, threadId: "session", turnId: started.result.turn.id, remoteAgentId, remoteRunId, status: "FINISHED" } });
      expect(nativeFetch.mock.calls.filter(([url, init]) => new URL(String(url)).pathname === "/v1/agents" && init?.method === "POST")).toHaveLength(1);
    } finally { f.input.end(); await f.proxy.done; }
  });
});
