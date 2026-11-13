import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, TASKS_EXTENSION_ID, createTasksDemoHttpServer, type TasksDemoHttpServer } from "./http.js";
import { DemoTaskStore } from "./store.js";

let clock = Date.parse("2026-11-13T12:00:00Z");
const now = () => clock;
const servers: TasksDemoHttpServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(store = new DemoTaskStore({ now })) {
  const server = createTasksDemoHttpServer({ store });
  servers.push(server);
  const port = await server.listen(0);
  return { server, url: `http://127.0.0.1:${port}` };
}

/** Send one request the way Paperclip's stateless client does. */
async function rpc(url: string, method: string, params: Record<string, unknown> = {}, options: { tasks?: boolean; name?: string; version?: string } = {}) {
  const name = options.name ?? (typeof params.taskId === "string" ? params.taskId : typeof params.name === "string" ? params.name : undefined);
  const response = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": options.version ?? PROTOCOL_VERSION,
      "mcp-method": method,
      ...(name !== undefined ? { "mcp-name": name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": options.version ?? PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientCapabilities": { extensions: options.tasks === false ? {} : { [TASKS_EXTENSION_ID]: {} } },
        },
      },
    }),
  });
  return { status: response.status, body: await response.json() as { result?: Record<string, any>; error?: { code: number; message: string; data?: any } } };
}

const call = (url: string, name: string, args: Record<string, unknown> = {}, tasks = true) => rpc(url, "tools/call", { name, arguments: args }, { tasks });
const get = (url: string, taskId: string) => rpc(url, "tasks/get", { taskId });

describe("MCP Tasks demo server", () => {
  it("advertises the Tasks extension on a stateless server and refuses the old handshake", async () => {
    const { url } = await start();
    const discover = await rpc(url, "server/discover");
    expect(discover.body.result).toMatchObject({ resultType: "complete", supportedVersions: [PROTOCOL_VERSION], capabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } } });
    const legacy = await rpc(url, "initialize", {}, { version: "2025-11-25" });
    expect(legacy.status).toBe(400);
    expect(legacy.body.error).toMatchObject({ code: -32022, data: { supported: [PROTOCOL_VERSION] } });
    const tools = await rpc(url, "tools/list");
    expect(tools.body.result!.tools.map((tool: { name: string }) => tool.name)).toEqual(["slow_report", "needs_approval", "will_fail", "cancellable", "expires", "quick_echo"]);
  });

  it("returns a task only to a request that declared the extension", async () => {
    const { url } = await start();
    const plain = await call(url, "slow_report", {}, false);
    expect(plain.body.result).toMatchObject({ resultType: "complete", isError: true });
    const quick = await call(url, "quick_echo", { text: "hi" });
    expect(quick.body.result).toMatchObject({ resultType: "complete", content: [{ type: "text", text: "echo: hi" }] });
    const tasks = await rpc(url, "tasks/get", { taskId: "anything" }, { tasks: false });
    expect(tasks.body.error?.code).toBe(-32021);
  });

  it("slow_report: works, then completes with its result after the delay", async () => {
    const { url, server } = await start();
    const created = await call(url, "slow_report", { topic: "uptime", seconds: 30 });
    expect(created.body.result).toMatchObject({ resultType: "task", status: "working", ttlMs: 3_600_000, pollIntervalMs: 2_000 });
    const taskId = created.body.result!.taskId as string;
    clock += 15_000;
    expect((await get(url, taskId)).body.result).toMatchObject({ resultType: "complete", status: "working", statusMessage: "50% done (15 of 30 s)" });
    clock += 15_000;
    const done = await get(url, taskId);
    expect(done.body.result).toMatchObject({ status: "completed", result: { isError: false, structuredContent: { topic: "uptime", seconds: 30 } } });
    expect(server.store.snapshot().toolCalls).toEqual({ slow_report: 1 });
  });

  it("requires Mcp-Name to carry the task ID", async () => {
    const { url } = await start();
    const taskId = (await call(url, "slow_report")).body.result!.taskId as string;
    const wrong = await rpc(url, "tasks/get", { taskId }, { name: "other" });
    expect(wrong.body.error?.code).toBe(-32020);
  });

  it("needs_approval: asks a form question, then finishes after tasks/update", async () => {
    const { url } = await start();
    const created = await call(url, "needs_approval", { action: "deploy" });
    const taskId = created.body.result!.taskId as string;
    const waiting = await get(url, taskId);
    expect(waiting.body.result).toMatchObject({
      status: "input_required",
      inputRequests: { approval: { method: "elicitation/create", params: { mode: "form", requestedSchema: { required: ["decision"] } } } },
    });
    // An answer the form does not allow asks again.
    await rpc(url, "tasks/update", { taskId, inputResponses: { approval: { action: "accept", content: { decision: "maybe" } } } });
    expect((await get(url, taskId)).body.result).toMatchObject({ status: "input_required", inputRequests: { approval: { params: { message: "Please choose approve or reject." } } } });
    await rpc(url, "tasks/update", { taskId, inputResponses: { approval: { action: "accept", content: { decision: "approve", note: "ship it" } } } });
    expect((await get(url, taskId)).body.result).toMatchObject({ status: "working" });
    clock += 3_000;
    expect((await get(url, taskId)).body.result).toMatchObject({ status: "completed", result: { structuredContent: { approved: true, action: "deploy", note: "ship it" } } });
  });

  it("needs_approval: a rejection or decline completes without doing anything", async () => {
    const { url } = await start();
    for (const response of [{ action: "accept", content: { decision: "reject" } }, { action: "decline" }]) {
      const taskId = (await call(url, "needs_approval")).body.result!.taskId as string;
      await rpc(url, "tasks/update", { taskId, inputResponses: { approval: response } });
      expect((await get(url, taskId)).body.result).toMatchObject({ status: "completed", result: { structuredContent: { approved: false } } });
    }
  });

  it("will_fail: ends failed with a JSON-RPC error", async () => {
    const { url } = await start();
    const taskId = (await call(url, "will_fail", { seconds: 2 })).body.result!.taskId as string;
    clock += 2_000;
    expect((await get(url, taskId)).body.result).toMatchObject({ status: "failed", error: { code: -32603, message: expect.stringContaining("on purpose") } });
  });

  it("cancellable: tasks/cancel stops it, and a second cancel is refused", async () => {
    const { url } = await start();
    const taskId = (await call(url, "cancellable")).body.result!.taskId as string;
    expect((await rpc(url, "tasks/cancel", { taskId })).body.result).toEqual({ resultType: "complete" });
    // Past when the work would have finished: it stays cancelled.
    clock += 600_000;
    expect((await get(url, taskId)).body.result).toMatchObject({ status: "cancelled" });
    expect((await rpc(url, "tasks/cancel", { taskId })).body.error?.code).toBe(-32602);
  });

  it("expires: is forgotten once its TTL passes, before it finishes", async () => {
    const { url } = await start();
    const created = await call(url, "expires", { ttlSeconds: 5 });
    expect(created.body.result).toMatchObject({ ttlMs: 5_000 });
    const taskId = created.body.result!.taskId as string;
    clock += 4_000;
    expect((await get(url, taskId)).body.result).toMatchObject({ status: "working" });
    clock += 1_000;
    expect((await get(url, taskId)).body.error).toMatchObject({ code: -32602, message: expect.stringContaining("not found") });
  });

  it("keeps tasks across a restart when given a state file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tasks-demo-"));
    dirs.push(dir);
    const file = join(dir, "state.json");
    const first = await start(new DemoTaskStore({ file, now }));
    const taskId = (await call(first.url, "slow_report", { seconds: 10 })).body.result!.taskId as string;
    await first.server.close();
    servers.splice(servers.indexOf(first.server), 1);
    clock += 10_000;
    const second = await start(new DemoTaskStore({ file, now }));
    expect((await get(second.url, taskId)).body.result).toMatchObject({ status: "completed" });
    expect(second.server.store.snapshot().toolCalls).toEqual({ slow_report: 1 });
  });

  it("shows tasks on its status page", async () => {
    const { url } = await start();
    await call(url, "slow_report");
    const html = await (await fetch(url)).text();
    expect(html).toContain("slow_report");
    expect(html).toContain("working");
  });
});
