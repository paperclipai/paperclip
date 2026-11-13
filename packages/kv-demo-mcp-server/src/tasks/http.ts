import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DemoTaskStore, type DemoTask } from "./store.js";
import { DEMO_TOOLS, advanceDemoTask, answerDemoTask, callDemoTool, statusMessageFor } from "./tools.js";
import { renderTasksPage } from "./render.js";

/**
 * A stateless MCP server (protocol 2026-07-28) that supports the MCP Tasks
 * extension. It speaks JSON-RPC over plain HTTP POST: no session, no SSE, and
 * every request carries its protocol version and client capabilities in
 * `params._meta`, as the 2026-07-28 revision requires.
 */
export const PROTOCOL_VERSION = "2026-07-28";
export const TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

const HEADER_MISMATCH = -32020;
const MISSING_CAPABILITY = -32021;
const UNSUPPORTED_VERSION = -32022;
const INVALID_PARAMS = -32602;
const METHOD_NOT_FOUND = -32601;

export interface TasksDemoHttpOptions {
  store?: DemoTaskStore;
  /** Optional shared secret required on every route except the status page. */
  token?: string | null;
}

export interface TasksDemoHttpServer {
  server: Server;
  store: DemoTaskStore;
  listen: (port: number, host?: string) => Promise<number>;
  close: () => Promise<void>;
}

type RpcRequest = { jsonrpc?: string; id?: string | number | null; method?: unknown; params?: Record<string, unknown> };
type Reply = { status: number; body: unknown } | null;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function ok(id: unknown, result: Record<string, unknown>): Reply {
  return { status: 200, body: { jsonrpc: "2.0", id, result: { resultType: "complete", ...result } } };
}

function fail(status: number, id: unknown, code: number, message: string, data?: unknown): Reply {
  return { status, body: { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } } };
}

/** `Mcp-Name` may be RFC 2047-style base64 (`=?base64?...?=`) for non-ASCII values. */
function decodeHeaderValue(value: string | undefined): string | null {
  if (value === undefined) return null;
  const match = /^=\?base64\?(.*)\?=$/i.exec(value);
  return match ? Buffer.from(match[1]!, "base64").toString("utf8") : value;
}

function taskView(store: DemoTaskStore, task: DemoTask): Record<string, unknown> {
  const statusMessage = statusMessageFor(store, task);
  return {
    taskId: task.taskId,
    status: task.status,
    ...(statusMessage ? { statusMessage } : {}),
    createdAt: new Date(task.createdAt).toISOString(),
    lastUpdatedAt: new Date(task.lastUpdatedAt).toISOString(),
    ttlMs: task.ttlMs,
    pollIntervalMs: task.pollIntervalMs,
    ...(task.status === "completed" ? { result: task.result } : {}),
    ...(task.status === "failed" ? { error: task.error } : {}),
    ...(task.status === "input_required" ? { inputRequests: task.inputRequests } : {}),
  };
}

/** Handle one JSON-RPC request. Exported for tests. */
export function handleTasksDemoRpc(store: DemoTaskStore, message: RpcRequest, headers: IncomingMessage["headers"]): Reply {
  if (!record(message) || typeof message.method !== "string") return fail(400, null, -32600, "Invalid JSON-RPC request.");
  const { id, method } = message;
  if (id === undefined) return null; // A notification: nothing to answer.
  const params = record(message.params) ?? {};
  const meta = record(params._meta) ?? {};
  const headerVersion = typeof headers["mcp-protocol-version"] === "string" ? headers["mcp-protocol-version"] : null;

  // A handshake-era client: tell it which version this server speaks.
  if (method === "initialize") return fail(400, id, UNSUPPORTED_VERSION, "This server speaks only stateless MCP.", { supported: [PROTOCOL_VERSION] });
  if (headerVersion !== PROTOCOL_VERSION || meta[META_VERSION] !== PROTOCOL_VERSION) {
    if (headerVersion && headerVersion !== PROTOCOL_VERSION) return fail(400, id, UNSUPPORTED_VERSION, `Unsupported protocol version ${headerVersion}.`, { supported: [PROTOCOL_VERSION] });
    return fail(400, id, HEADER_MISMATCH, "MCP-Protocol-Version header and params._meta protocolVersion must both be 2026-07-28.");
  }
  const mcpMethod = headers["mcp-method"];
  if (typeof mcpMethod === "string" && mcpMethod !== method) return fail(400, id, HEADER_MISMATCH, "Mcp-Method does not match the request.");
  const declaredTasks = Boolean(record(record(record(meta[META_CAPABILITIES])?.extensions)?.[TASKS_EXTENSION_ID]));
  const clientInfo = record(meta["io.modelcontextprotocol/clientInfo"]);
  const client = typeof clientInfo?.name === "string" ? clientInfo.name : "unknown client";

  switch (method) {
    case "server/discover":
      return ok(id, {
        supportedVersions: [PROTOCOL_VERSION],
        capabilities: { tools: {}, extensions: { [TASKS_EXTENSION_ID]: {} } },
        serverInfo: { name: "paperclip-tasks-demo", version: "0.1.0" },
        instructions: "Demo tools for MCP Tasks. Each long tool returns a task; nothing here touches real systems.",
      });
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: DEMO_TOOLS });
    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string") return fail(200, id, INVALID_PARAMS, "tools/call needs a tool name.");
      const mcpName = decodeHeaderValue(headers["mcp-name"] as string | undefined);
      if (mcpName !== null && mcpName !== name) return fail(400, id, HEADER_MISMATCH, "Mcp-Name does not match the tool name.");
      // Only known tools are counted, so made-up names cannot grow the saved state.
      if (!DEMO_TOOLS.some((tool) => tool.name === name)) return fail(200, id, INVALID_PARAMS, `Unknown tool: ${name.slice(0, 64)}`);
      store.countToolCall(name);
      const outcome = callDemoTool(store, name, record(params.arguments) ?? {}, declaredTasks);
      if (!outcome) return fail(200, id, INVALID_PARAMS, `Unknown tool: ${name.slice(0, 64)}`);
      if (outcome.kind === "result") {
        store.log({ method, tool: name, detail: declaredTasks ? "answered without a task" : `answered without a task: ${client} did not declare ${TASKS_EXTENSION_ID}` });
        return ok(id, outcome.result);
      }
      store.log({ method, tool: name, taskId: outcome.task.taskId, detail: `returned task (${outcome.task.status}) to ${client}` });
      const view = taskView(store, outcome.task);
      return { status: 200, body: { jsonrpc: "2.0", id, result: { resultType: "task", ...view } } };
    }
    case "tasks/get":
    case "tasks/update":
    case "tasks/cancel": {
      if (!declaredTasks) return fail(400, id, MISSING_CAPABILITY, `${method} requires the ${TASKS_EXTENSION_ID} extension.`);
      const taskId = params.taskId;
      if (typeof taskId !== "string") return fail(200, id, INVALID_PARAMS, `${method} needs a taskId.`);
      if (decodeHeaderValue(headers["mcp-name"] as string | undefined) !== taskId) return fail(400, id, HEADER_MISMATCH, "Mcp-Name must carry the task ID.");
      const found = store.get(taskId);
      if (!found) {
        store.log({ method, taskId, detail: "task not found" });
        return fail(200, id, INVALID_PARAMS, "Failed to retrieve task: Task not found");
      }
      const task = advanceDemoTask(store, found);
      if (method === "tasks/get") {
        task.polls += 1;
        store.touch();
        store.log({ method, tool: task.tool, taskId, detail: task.status });
        return ok(id, taskView(store, task));
      }
      if (method === "tasks/update") {
        answerDemoTask(store, task, record(params.inputResponses) ?? {});
        store.log({ method, tool: task.tool, taskId, detail: `now ${task.status}` });
        return ok(id, {});
      }
      if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
        store.log({ method, tool: task.tool, taskId, detail: `already ${task.status}` });
        return fail(200, id, INVALID_PARAMS, `Cannot cancel a task that is already ${task.status}.`);
      }
      store.update(task, { status: "cancelled", inputRequests: undefined, settlesAt: null });
      store.log({ method, tool: task.tool, taskId, detail: "cancelled; work stopped" });
      return ok(id, {});
    }
    default:
      return fail(404, id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

/**
 * State as of now: settle tasks whose time has come and forget expired ones,
 * so the views show what finished while no client was polling.
 */
function refreshedSnapshot(store: DemoTaskStore) {
  for (const { taskId } of store.snapshot().tasks) {
    const task = store.get(taskId);
    if (task) advanceDemoTask(store, task);
  }
  return store.snapshot();
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json"): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new Error("Request body too large.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createTasksDemoHttpServer(options: TasksDemoHttpOptions = {}): TasksDemoHttpServer {
  const store = options.store ?? new DemoTaskStore();
  const token = options.token?.trim() || null;

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
          send(res, 200, renderTasksPage(token ? null : refreshedSnapshot(store), store.now()), "text/html; charset=utf-8");
          return;
        }
        if (token && req.headers.authorization !== `Bearer ${token}`) {
          send(res, 401, { error: "Unauthorized. Provide the TASKS_DEMO_TOKEN as a Bearer token." });
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/state") {
          send(res, 200, refreshedSnapshot(store));
          return;
        }
        if (url.pathname === "/mcp") {
          if (req.method !== "POST") {
            res.writeHead(405, { allow: "POST" }).end();
            return;
          }
          let message: RpcRequest;
          try {
            message = JSON.parse(await readBody(req)) as RpcRequest;
          } catch {
            send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
            return;
          }
          const reply = handleTasksDemoRpc(store, message, req.headers);
          if (!reply) {
            res.writeHead(202).end();
            return;
          }
          send(res, reply.status, reply.body);
          return;
        }
        send(res, 404, { error: "Not found." });
      } catch (error) {
        if (!res.headersSent) send(res, 500, { error: error instanceof Error ? error.message : "Internal error." });
        else res.end();
      }
    })();
  });

  return {
    server,
    store,
    listen: (port, host = "127.0.0.1") =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          const address = server.address();
          resolve(typeof address === "object" && address ? address.port : port);
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
