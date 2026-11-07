import { afterEach, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nativeRunMcpRoutes } from "../../server/src/routes/native-run-mcp.js";
import { createRemoteMcpRelayToken, registerRemoteMcpRelay } from "../../server/src/services/native-runtime/remote-mcp-relay.js";
import { RUNNER_TOOL_SCOPE_TOKEN_HEADER, startRunnerToolBridge } from "../../packages/paperclip-runner/src/drivers/runner-tool-bridge.js";
import { assertCursorCloudCallbackIngress, startCursorCloudCallbackProxy } from "./cursor-cloud-callback-proxy.js";

const require = createRequire(resolve(import.meta.dirname, "../../server/package.json"));
const { Client } = await import(require.resolve("@modelcontextprotocol/sdk/client/index.js"));
const { StreamableHTTPClientTransport } = await import(require.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"));
const { default: express } = await import(require.resolve("express"));
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const listen = async (server: Server) => {
  await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", accept); });
  return (server.address() as { port: number }).port;
};
const close = (server: Server) => new Promise<void>((accept, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : accept()); });

it("serves the strict MCP SDK through the Cloud callback with isolated sessions and fenced tools", async () => {
  const root = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "cloud-sdk-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const token = createRemoteMcpRelayToken();
  const runId = "00000000-0000-4000-8000-000000000762";
  let active = true, scope: string | null = "turn-one";
  let scopeToken = createRemoteMcpRelayToken();
  const calls: Array<{ tool: string; callId: string }> = [];
  const task = { taskId: "fixture-task", completionContractRevision: "fixture-revision" };
  const artifacts = { items: [{ path: "fixture.txt", sizeBytes: 12 }] };
  const schema = { type: "object", properties: {}, additionalProperties: false };
  const bridge = await startRunnerToolBridge({ socketPath: join(root, "mcp.sock"), secret: token, preserveToolNames: true,
    sessionScope: () => scope,
    scopeToken: () => scopeToken,
    tools: [{ name: "get_task_context", inputSchema: schema }, { name: "list_cursor_cloud_artifacts", inputSchema: schema }],
    handler: async call => { calls.push({ tool: call.tool, callId: call.callId }); return call.tool === "get_task_context" ? task : artifacts; },
  });
  cleanup.push(() => bridge.close());
  const binding = { runId, socketPath: join(root, "mcp.sock"), token, expiresAt: Date.now() + 60_000, authorized: async () => active };
  cleanup.push(registerRemoteMcpRelay(binding));
  const app = express(); app.use(express.json()); app.use(nativeRunMcpRoutes());
  const server = createServer(app); const appPort = await listen(server); cleanup.push(() => close(server));
  const reservation = createServer(); const port = await listen(reservation); await close(reservation);
  cleanup.push(await startCursorCloudCallbackProxy({ port, appPort }));
  const origin = `http://127.0.0.1:${port}`;
  await assertCursorCloudCallbackIngress(origin);
  const requests: Array<{ http: string; rpc: unknown; method?: string; tool?: string; session?: string | null; status: number }> = [];
  const errors: string[] = [];
  const connect = async (suppliedScopeToken = scopeToken) => {
    const client = new Client({ name: "controlled-cloud-qualification", version: "1" });
    client.onerror = (error: unknown) => errors.push(error instanceof Error ? error.message : String(error));
    const transport = new StreamableHTTPClientTransport(new URL(`/mcp/native-runs/${runId}`, origin), {
      requestInit: { headers: { Authorization: `Bearer ${token}`, [RUNNER_TOOL_SCOPE_TOKEN_HEADER]: `Bearer ${suppliedScopeToken}` } },
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        expect(new URL(url instanceof Request ? url.url : String(url)).origin).toBe(origin);
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const response = await fetch(url, init);
        requests.push({ http: init?.method ?? "GET", rpc: body.id, method: body.method, tool: body.params?.name,
          session: new Headers(init?.headers).get("mcp-session-id"), status: response.status });
        return response;
      },
    });
    cleanup.push(() => client.close());
    await client.connect(transport);
    return { client, transport };
  };
  const first = await connect().catch(error => { throw new Error("First scoped MCP initialize returned HTTP " + String(requests.at(-1)?.status), { cause: error }); });
  const tools = await first.client.listTools();
  expect(tools.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(["get_task_context", "list_cursor_cloud_artifacts", "paperclip_finish", "paperclip_block"]));
  expect(tools.tools.find((tool: { name: string }) => tool.name === "get_task_context").inputSchema).toEqual(schema);
  expect(JSON.parse((await first.client.callTool({ name: "get_task_context", arguments: {} })).content[0].text)).toEqual(task);
  expect(JSON.parse((await first.client.callTool({ name: "list_cursor_cloud_artifacts", arguments: {} })).content[0].text)).toEqual(artifacts);
  const second = await connect(); await second.client.listTools();
  expect(JSON.parse((await second.client.callTool({ name: "get_task_context", arguments: {} })).content[0].text)).toEqual(task);
  const contextCalls = calls.filter(call => call.tool === "get_task_context");
  expect(contextCalls).toHaveLength(2);
  expect(contextCalls[0].callId).not.toBe(contextCalls[1].callId);
  expect(first.transport.sessionId).not.toBe(second.transport.sessionId);
  expect(requests.filter(request => request.method === "initialize").map(request => request.rpc)).toEqual([0, 0]);
  const contextRequests = requests.filter(request => request.tool === "get_task_context");
  expect(contextRequests).toHaveLength(2); expect(contextRequests[0].rpc).toBe(contextRequests[1].rpc);
  await expect.poll(() => requests.filter(request => request.http === "GET").length).toBe(2);
  expect(requests.filter(request => request.http === "GET").map(request => request.status)).toEqual([405, 405]);
  const methodProbe = await fetch(`${origin}/mcp/native-runs/${runId}`);
  expect(methodProbe.status).toBe(405); expect(methodProbe.headers.get("allow")).toBe("POST");
  expect(errors).toEqual([]);
  scope = "turn-two";
  await expect(first.client.callTool({ name: "get_task_context", arguments: {} })).rejects.toHaveProperty("code", 404);
  const oldScopeToken = scopeToken;
  scopeToken = createRemoteMcpRelayToken();
  await expect(connect(oldScopeToken)).rejects.toHaveProperty("code", 401);
  const current = await connect();
  await expect(current.client.listTools()).resolves.toHaveProperty("tools");
  active = false;
  await expect(second.client.callTool({ name: "get_task_context", arguments: {} })).rejects.toHaveProperty("code", 403);
  binding.expiresAt = Date.now() - 1;
  await expect(second.client.callTool({ name: "get_task_context", arguments: {} })).rejects.toHaveProperty("code", 401);
  expect(calls).toHaveLength(3);
});
