import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  connectionGrants,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
  issueThreadInteractions,
  projects,
  toolInvocations,
  toolMcpTasks,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { MCP_MODERN_PROTOCOL_VERSION, forgetMcpHttpSessions, mcpHttpRequestInit } from "../services/mcp-http.js";
import {
  MCP_TASKS_EXTENSION_ID,
  backgroundPollDelayMs,
  mcpCreatedTask,
  mcpTaskExpiresAt,
  mcpTaskIdIndex,
  openMcpTaskId,
  parseMcpTask,
  sealMcpTaskId,
  sendMcpTaskRequest,
} from "../services/mcp-tasks.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { toolAccessService } from "../services/tool-access.js";
import { adapterExecutionControls, createAdapterExecutionControl } from "../services/adapter-execution-control.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

describe("MCP Tasks protocol", () => {
  it("declares the tasks extension only where Paperclip can wait on a task", () => {
    const headers = { "MCP-Protocol-Version": MCP_MODERN_PROTOCOL_VERSION };
    const call = JSON.parse(mcpHttpRequestInit(headers, { id: 1, method: "tools/call", params: { name: "x" } }, { declareTasks: true }).body);
    expect(call.params._meta[META_CAPABILITIES].extensions[MCP_TASKS_EXTENSION_ID]).toEqual({});
    const list = JSON.parse(mcpHttpRequestInit(headers, { id: 2, method: "tools/list" }).body);
    expect(list.params._meta[META_CAPABILITIES].extensions).not.toHaveProperty(MCP_TASKS_EXTENSION_ID);
    // Older servers never see it: they get no per-request metadata at all.
    const legacy = JSON.parse(mcpHttpRequestInit({ "MCP-Protocol-Version": "2025-11-25" }, { id: 3, method: "tools/call", params: { name: "x" } }, { declareTasks: true }).body);
    expect(legacy.params).not.toHaveProperty("_meta");
  });

  it("routes task requests by task ID in Mcp-Name", () => {
    const init = mcpHttpRequestInit({ "MCP-Protocol-Version": MCP_MODERN_PROTOCOL_VERSION }, { id: 1, method: "tasks/get", params: { taskId: "task-é" } }, { declareTasks: true });
    const headers = new Headers(init.headers);
    expect(headers.get("mcp-method")).toBe("tasks/get");
    expect(headers.get("mcp-name")).toBe(`=?base64?${Buffer.from("task-é").toString("base64")}?=`);
  });

  it("reads task handles and states, and rejects malformed ones", () => {
    const created = mcpCreatedTask({ resultType: "task", taskId: "t1", status: "working", ttlMs: 60_000, pollIntervalMs: 500, createdAt: "2026-11-12T00:00:00Z", lastUpdatedAt: "2026-11-12T00:00:00Z" });
    expect(created).toMatchObject({ taskId: "t1", status: "working", ttlMs: 60_000, pollIntervalMs: 500 });
    expect(mcpCreatedTask({ resultType: "complete", taskId: "t1", status: "working" })).toBeNull();
    expect(parseMcpTask({ taskId: "t1", status: "completed" })).toBeNull();
    expect(parseMcpTask({ taskId: "t1", status: "done", result: {} })).toBeNull();
    expect(parseMcpTask({ taskId: "", status: "working" })).toBeNull();
    expect(parseMcpTask({ taskId: "t1", status: "failed", error: { code: -32603, message: "boom" } })).toMatchObject({ error: { code: -32603, message: "boom" } });
    expect(parseMcpTask({ taskId: "t1", status: "input_required", inputRequests: { a: { method: "elicitation/create", params: { mode: "url" } } } }))
      .toMatchObject({ inputRequests: { a: { method: "elicitation/create" } } });
  });

  it("bounds the server's timing hints and caps the task's life", () => {
    expect(backgroundPollDelayMs({ pollIntervalMs: 1, status: "working" })).toBe(5_000);
    expect(backgroundPollDelayMs({ pollIntervalMs: 99_999_999, status: "working" })).toBe(5 * 60_000);
    expect(backgroundPollDelayMs({ pollIntervalMs: 5_000, status: "input_required" })).toBe(5 * 60_000);
    expect(backgroundPollDelayMs({ pollIntervalMs: 5_000, status: "working", failures: 2 })).toBe(20_000);
    const now = Date.parse("2026-11-12T00:00:00Z");
    expect(mcpTaskExpiresAt({ createdAt: new Date(now - 1_000), ttlMs: 10_000 }, now).getTime()).toBe(now + 9_000);
    expect(mcpTaskExpiresAt({ createdAt: null, ttlMs: null }, now).getTime()).toBe(now + 7 * 24 * 60 * 60_000);
    // A TTL extended days later never moves the cap past seven days from when Paperclip first saw the task.
    const firstSeen = new Date(now - 6 * 24 * 60 * 60_000);
    expect(mcpTaskExpiresAt({ createdAt: firstSeen, ttlMs: 30 * 24 * 60 * 60_000 }, now, firstSeen).getTime()).toBe(firstSeen.getTime() + 7 * 24 * 60 * 60_000);
  });

  it("reads at most 64 KiB of a provider's error body", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulled += 16 * 1024; controller.enqueue(new Uint8Array(16 * 1024).fill(32)); },
    });
    const transport = { headers: async () => ({ "MCP-Protocol-Version": MCP_MODERN_PROTOCOL_VERSION }), maxBytes: 1_000_000,
      send: async () => new Response(body, { status: 500 }) };
    await expect(sendMcpTaskRequest(transport, "tasks/get", { taskId: "t1" })).rejects.toMatchObject({ kind: "http", httpStatus: 500 });
    expect(pulled).toBeLessThanOrEqual(128 * 1024);
  });

  it("seals task IDs at rest and binds them to their company and connection", () => {
    const scope = { companyId: "c1", connectionId: "k1" };
    const sealed = sealMcpTaskId("secret", scope, "task-123");
    expect(sealed).not.toContain("task-123");
    expect(openMcpTaskId("secret", scope, sealed)).toBe("task-123");
    expect(openMcpTaskId("secret", { ...scope, companyId: "c2" }, sealed)).toBeNull();
    expect(openMcpTaskId("other", scope, sealed)).toBeNull();
    expect(mcpTaskIdIndex("secret", scope, "task-123")).toBe(mcpTaskIdIndex("secret", scope, "task-123"));
    expect(mcpTaskIdIndex("secret", { ...scope, connectionId: "k2" }, "task-123")).not.toBe(mcpTaskIdIndex("secret", scope, "task-123"));
  });
});

type Recorded = { method: string; headers: Headers; body: Record<string, any> };
type FakeTask = {
  status: "working" | "input_required" | "completed" | "failed" | "cancelled";
  gets: number;
  /** Complete on its own after this many polls. */
  completeAfter?: number;
  inputRequests?: Record<string, unknown>;
  /** Move on once these input keys are answered with tasks/update. */
  awaiting?: string[];
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
  ttlMs: number;
  createdAt: string;
  failInstead?: boolean;
};

/**
 * A stateless (2026-07-28) server that answers long tools with a task. Like a
 * compliant server it returns a task only to a client that declared the
 * extension on that request, and requires `Mcp-Name` to match the task ID.
 */
function taskServer() {
  const requests: Recorded[] = [];
  const tasks = new Map<string, FakeTask>();
  let forgetAll = false;
  const tool = (name: string) => ({ name, description: name, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } });
  const ok = (id: unknown, result: Record<string, unknown>) => Response.json({ jsonrpc: "2.0", id, result: { resultType: "complete", ...result } });
  const fail = (status: number, id: unknown, code: number, message: string) => Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });
  const view = (taskId: string, task: FakeTask) => ({
    taskId, status: task.status, createdAt: task.createdAt, lastUpdatedAt: new Date().toISOString(), ttlMs: task.ttlMs, pollIntervalMs: 20,
    ...(task.status === "completed" ? { result: task.result } : {}),
    ...(task.status === "failed" ? { error: task.error } : {}),
    ...(task.status === "input_required" ? { inputRequests: task.inputRequests } : {}),
  });
  const handle = async (_url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body));
    const headers = new Headers(init.headers);
    requests.push({ method: body.method, headers, body });
    const meta = body.params?._meta ?? {};
    if (meta[META_VERSION] !== MCP_MODERN_PROTOCOL_VERSION || headers.get("mcp-protocol-version") !== MCP_MODERN_PROTOCOL_VERSION) return fail(400, body.id, -32020, "Header mismatch");
    const declared = Boolean(meta[META_CAPABILITIES]?.extensions?.[MCP_TASKS_EXTENSION_ID]);
    switch (body.method) {
      case "server/discover":
        return ok(body.id, { supportedVersions: [MCP_MODERN_PROTOCOL_VERSION], capabilities: { tools: {}, extensions: { [MCP_TASKS_EXTENSION_ID]: {} } } });
      case "tools/list":
        return ok(body.id, { tools: ["build", "quick", "authorize", "ask_name", "explode", "short_lived", "garbled"].map(tool) });
      case "tools/call": {
        const name = body.params.name;
        if (name === "quick" || !declared) return ok(body.id, { content: [{ type: "text", text: `${name} done synchronously` }] });
        const taskId = `task-${randomUUID()}`;
        const task: FakeTask = { status: "working", gets: 0, ttlMs: name === "short_lived" ? 300 : 3_600_000, createdAt: new Date().toISOString(),
          result: { content: [{ type: "text", text: `${name} finished` }], structuredContent: { name }, isError: false } };
        if (name === "authorize") Object.assign(task, { status: "input_required", awaiting: [], inputRequests: { consent: { method: "elicitation/create", params: { mode: "url", message: "Approve access", url: "https://auth.example.com/consent?flow=7" } } } });
        if (name === "ask_name") Object.assign(task, { status: "input_required", awaiting: ["who"], inputRequests: { who: { method: "elicitation/create", params: { mode: "form", message: "Who is deploying?", requestedSchema: { type: "object", required: ["name"], properties: { name: { type: "string", title: "Your name" } } } } } } });
        if (name === "explode") Object.assign(task, { completeAfter: 1, failInstead: true });
        // A result Paperclip cannot record, standing in for a crash before the result is saved.
        if (name === "garbled") Object.assign(task, { completeAfter: 1, result: { content: "not a content list" } });
        tasks.set(taskId, task);
        return ok(body.id, { resultType: "task", ...view(taskId, task), status: task.status === "input_required" ? "working" : task.status });
      }
      case "tasks/get":
      case "tasks/update":
      case "tasks/cancel": {
        if (!declared) return fail(400, body.id, -32021, "Missing required client capability");
        if (headers.get("mcp-name") !== body.params.taskId) return fail(400, body.id, -32020, "Mcp-Name does not match");
        const task = tasks.get(body.params.taskId);
        if (!task || forgetAll) return fail(200, body.id, -32602, "Failed to retrieve task: Task not found");
        if (body.method === "tasks/cancel") { task.status = "cancelled"; return ok(body.id, {}); }
        if (body.method === "tasks/update") {
          const answered = Object.keys(body.params.inputResponses ?? {});
          task.awaiting = (task.awaiting ?? []).filter((key) => !answered.includes(key));
          if (task.status === "input_required" && !task.awaiting.length && answered.length) {
            const response = body.params.inputResponses.who;
            task.status = "completed";
            task.result = { content: [{ type: "text", text: `deployed by ${response?.content?.name ?? "nobody"}` }], isError: false };
          }
          return ok(body.id, {});
        }
        task.gets += 1;
        if (task.status === "working" && task.completeAfter !== undefined && task.gets >= task.completeAfter) {
          if (task.failInstead) Object.assign(task, { status: "failed", error: { code: -32603, message: "Build runner crashed" } });
          else task.status = "completed";
        }
        return ok(body.id, view(body.params.taskId, task));
      }
      default:
        return fail(404, body.id, -32601, "Method not found");
    }
  };
  const only = () => {
    const ids = [...tasks.keys()];
    return { id: ids.at(-1)!, task: tasks.get(ids.at(-1)!)! };
  };
  return {
    requests, tasks, handle, only,
    count: (method: string) => requests.filter((request) => request.method === method).length,
    finish: () => { only().task.status = "completed"; },
    /** The running task now needs a person's answer. */
    ask: () => Object.assign(only().task, { status: "input_required", awaiting: ["who"], inputRequests: { who: { method: "elicitation/create", params: { mode: "form", message: "Who is deploying?", requestedSchema: { type: "object", properties: { name: { type: "string" } } } } } } }),
    forget: () => { forgetAll = true; },
  };
}

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("MCP Tasks end to end", () => {
  const actor = { actorType: "user" as const, actorId: "mcp-tasks-user", actorSource: "local_implicit" as const };
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let keyDir: string;
  beforeAll(async () => {
    keyDir = await mkdtemp(join(tmpdir(), "mcp-tasks-secrets-"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(keyDir, "key"));
    fixture = await startEmbeddedPostgresTestDatabase("mcp-tasks-");
    db = createDb(fixture.connectionString);
  }, 30_000);
  afterAll(async () => {
    await fixture?.cleanup();
    vi.unstubAllEnvs();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  async function setup(server: ReturnType<typeof taskServer>) {
    const [org] = await db.insert(companies).values({ name: `Tasks ${randomUUID()}`, issuePrefix: `T${randomUUID().slice(0, 5)}` }).returning();
    await db.insert(companyMemberships).values({ companyId: org.id, principalType: "user", principalId: actor.actorId, status: "active", membershipRole: "admin" });
    const [agent] = await db.insert(agents).values({ companyId: org.id, name: "Task agent", role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: {} }).returning();
    const [project] = await db.insert(projects).values({ companyId: org.id, name: "Tasks project" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: org.id, projectId: project.id, title: "Ship it", status: "in_progress", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: org.id, agentId: agent.id, invocationSource: "assignment", status: "running", contextSnapshot: { issueId: issue.id, projectId: project.id } }).returning();
    const options = { deploymentMode: "local_trusted" as const, deploymentExposure: "private" as const,
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 as const }], remoteHttpRequest: server.handle };
    const service = toolAccessService(db, options);
    const connected = await service.connectGalleryApp(org.id, { link: `https://tasks-${randomUUID().slice(0, 8)}.example.com/mcp`, name: "Builds" }, actor);
    await service.finishGalleryAppConnection(org.id, connected.connectionId, {
      enabledCatalogEntryIds: connected.catalog.map((entry) => entry.id), askFirstCatalogEntryIds: [], access: "all_agents",
    }, actor);
    const gatewayOptions = { ...options, toolActionSigningSecret: "tasks-signing-key" };
    let gateway = createToolGatewayService(db, gatewayOptions);
    const session = await gateway.createSession({ companyId: org.id, agentId: agent.id, runId: run.id });
    const names = (await gateway.listToolsForSession(session.token)).map((tool) => tool.name);
    const toolName = (name: string) => names.find((candidate) => candidate.endsWith(`:${name.replace(/_/g, "-")}`))!;
    const call = (name: string, extra: { timeoutMs?: number; idempotencyKey?: string; parameters?: Record<string, unknown> } = {}) =>
      gateway.executeTool({ sessionToken: session.token, tool: toolName(name), parameters: extra.parameters ?? { ref: "main" },
        timeoutMs: extra.timeoutMs ?? 5_000, idempotencyKey: extra.idempotencyKey });
    const rows = () => db.select().from(toolMcpTasks).where(eq(toolMcpTasks.companyId, org.id));
    return {
      org, agent, issue, run, session, connected, call, rows,
      gateway: () => gateway,
      /** A new process: no in-memory state survives, only the database. */
      restart: () => { forgetMcpHttpSessions(connected.connectionId); gateway = createToolGatewayService(db, gatewayOptions); return gateway; },
    };
  }

  it("waits on a task and returns the result exactly as a synchronous call would", async () => {
    const server = taskServer();
    const { call, rows } = await setup(server);
    const before = server.requests.length;
    const pending = call("build");
    // The server completes the task while the call waits.
    await vi.waitFor(() => expect(server.count("tasks/get")).toBeGreaterThan(0));
    server.finish();
    const result = await pending;
    expect(result).toMatchObject({ status: "completed", result: { content: "build finished", data: { structuredContent: { name: "build" }, isError: false } } });
    const sent = server.requests.slice(before);
    expect(sent.filter((request) => request.method === "tools/call")).toHaveLength(1);
    const toolCall = sent.find((request) => request.method === "tools/call")!;
    expect(toolCall.body.params._meta[META_CAPABILITIES].extensions[MCP_TASKS_EXTENSION_ID]).toEqual({});
    const [row] = await rows();
    expect(row).toMatchObject({ status: "completed", nextPollAt: null, leaseExpiresAt: null });
    expect(row!.deliveredAt).toBeInstanceOf(Date);
    // The provider's task ID is never stored in the clear.
    expect(JSON.stringify(row)).not.toContain(server.only().id);
  });

  it("leaves synchronous calls and older servers unchanged", async () => {
    const server = taskServer();
    const { call, rows } = await setup(server);
    expect(await call("quick")).toMatchObject({ status: "completed", result: { content: "quick done synchronously" } });
    expect(server.count("tasks/get")).toBe(0);
    expect(await rows()).toEqual([]);
  });

  it("keeps a task past the tool timeout, and the repeated call attaches instead of starting the work again", async () => {
    const server = taskServer();
    const { call, rows, gateway } = await setup(server);
    await expect(call("build", { timeoutMs: 400 })).rejects.toMatchObject({ reasonCode: "provider_task_pending" });
    const [held] = await rows();
    expect(held).toMatchObject({ status: "working", leaseExpiresAt: null });
    expect(held!.nextPollAt).toBeInstanceOf(Date);
    expect(await gateway().nextMcpTaskPollAt()).toBeLessThanOrEqual(held!.nextPollAt!.getTime());
    server.finish();
    expect(await call("build", { timeoutMs: 2_000 })).toMatchObject({ status: "completed", result: { content: "build finished" } });
    expect(server.count("tools/call")).toBe(1);
    // Different arguments are different work.
    expect(await call("build", { parameters: { ref: "other" }, timeoutMs: 300 }).catch((error) => error)).toMatchObject({ reasonCode: "provider_task_pending" });
    expect(server.count("tools/call")).toBe(2);
  });

  it("attaches a retry with the same idempotency key to its task", async () => {
    const server = taskServer();
    const { call, rows } = await setup(server);
    await expect(call("build", { timeoutMs: 400, idempotencyKey: "deploy-42" })).rejects.toMatchObject({ reasonCode: "provider_task_pending" });
    server.finish();
    expect(await call("build", { timeoutMs: 2_000, idempotencyKey: "deploy-42" })).toMatchObject({ status: "completed", result: { content: "build finished" } });
    expect(server.count("tools/call")).toBe(1);
    const [row] = await rows();
    expect(row!.lastInvocationId).toBe(row!.invocationId);
  });

  it("never starts different work under a key whose task is still open", async () => {
    const server = taskServer();
    const { call } = await setup(server);
    await expect(call("build", { timeoutMs: 400, idempotencyKey: "deploy-43" })).rejects.toMatchObject({ reasonCode: "provider_task_pending" });
    await expect(call("build", { timeoutMs: 400, idempotencyKey: "deploy-43", parameters: { ref: "other" } }))
      .rejects.toMatchObject({ reasonCode: "idempotency_key_conflict" });
    expect(server.count("tools/call")).toBe(1);
  });

  it("resumes after a restart and delivers the result once, with no second tools/call", async () => {
    const server = taskServer();
    const ctx = await setup(server);
    await expect(ctx.call("build", { timeoutMs: 400 })).rejects.toMatchObject({ reasonCode: "provider_task_pending" });
    // The process dies; the run that started the task was interrupted.
    const fresh = ctx.restart();
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, ctx.run.id));
    const [row] = await ctx.rows();
    await db.update(toolMcpTasks).set({ nextPollAt: new Date(Date.now() - 1_000), leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(toolMcpTasks.id, row!.id));
    server.finish();
    const wake = vi.fn(async () => undefined);
    expect((await fresh.pollDueMcpTasks({ wake })).processed).toBeGreaterThanOrEqual(1);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith(expect.objectContaining({ agentId: ctx.agent.id, issueId: ctx.issue.id, status: "completed" }));
    // Nothing is left to poll for this task.
    expect((await ctx.rows())[0]).toMatchObject({ status: "completed", nextPollAt: null, leaseExpiresAt: null });
    // Nothing is left to do: another pass is quiet and wakes nobody.
    await fresh.pollDueMcpTasks({ wake });
    expect(wake).toHaveBeenCalledTimes(1);

    // The recovered run repeats the call and collects the stored task's result.
    const [recovered] = await db.insert(heartbeatRuns).values({ companyId: ctx.org.id, agentId: ctx.agent.id, invocationSource: "assignment", status: "running", contextSnapshot: { issueId: ctx.issue.id } }).returning();
    const session = await fresh.createSession({ companyId: ctx.org.id, agentId: ctx.agent.id, runId: recovered!.id });
    const tool = (await fresh.listToolsForSession(session.token)).find((candidate) => candidate.name.endsWith(":build"))!;
    const result = await fresh.executeTool({ sessionToken: session.token, tool: tool.name, parameters: { ref: "main" }, timeoutMs: 2_000 });
    expect(result).toMatchObject({ status: "completed", result: { content: "build finished" } });
    expect(server.count("tools/call")).toBe(1);
    const [delivered] = await ctx.rows();
    expect(delivered!.deliveredAt).toBeInstanceOf(Date);
    expect(delivered!.runId).toBe(recovered!.id);
  });

  it("does not wake an agent whose run is still going; it re-checks after the run ends", async () => {
    const server = taskServer();
    const ctx = await setup(server);
    await expect(ctx.call("build", { timeoutMs: 400 })).rejects.toMatchObject({ reasonCode: "provider_task_pending" });
    const [row] = await ctx.rows();
    await db.update(toolMcpTasks).set({ nextPollAt: new Date(Date.now() - 1_000) }).where(eq(toolMcpTasks.id, row!.id));
    server.finish();
    const wake = vi.fn(async () => undefined);
    await ctx.gateway().pollDueMcpTasks({ wake });
    expect(wake).not.toHaveBeenCalled();
    const [deferred] = await ctx.rows();
    expect(deferred).toMatchObject({ status: "completed", wakeRequestedAt: null });
    expect(deferred!.nextPollAt!.getTime()).toBeGreaterThan(Date.now() + 60_000);
  });

  it("shows a URL input request as the provider link, never answers it, and continues once the app moves on", async () => {
    const server = taskServer();
    const { call } = await setup(server);
    const first = await call("authorize").catch((error) => error);
    expect(first).toMatchObject({ reasonCode: "provider_interaction_required", details: { upstreamPending: { links: [{ url: "https://auth.example.com/consent?flow=7" }] } } });
    expect(server.count("tasks/update")).toBe(0);
    // The person completes the step in the app; the app finishes on its own.
    server.finish();
    expect(await call("authorize")).toMatchObject({ status: "completed", result: { content: "authorize finished" } });
    expect(server.count("tools/call")).toBe(1);
    expect(server.count("tasks/update")).toBe(0);
  });

  it("asks a form input request on a question card and sends the person's answer with tasks/update", async () => {
    const server = taskServer();
    const { call, issue, org } = await setup(server);
    const first = await call("ask_name").catch((error) => error);
    expect(first).toMatchObject({ reasonCode: "elicitation_required" });
    const [card] = await db.select().from(issueThreadInteractions).where(and(eq(issueThreadInteractions.companyId, org.id), eq(issueThreadInteractions.issueId, issue.id)));
    expect(card).toMatchObject({ kind: "ask_user_questions", status: "pending" });
    // Asking again before anyone answers reuses the same card and sends nothing.
    expect(await call("ask_name").catch((error) => error)).toMatchObject({ reasonCode: "elicitation_required" });
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issue.id))).toHaveLength(1);
    expect(server.count("tasks/update")).toBe(0);
    await db.update(issueThreadInteractions).set({ status: "answered", result: { version: 1, answers: [{ questionId: "name", optionIds: [], otherText: "Ada" }] } })
      .where(eq(issueThreadInteractions.id, card!.id));
    expect(await call("ask_name")).toMatchObject({ status: "completed", result: { content: "deployed by Ada" } });
    const update = server.requests.find((request) => request.method === "tasks/update")!;
    expect(update.body.params.inputResponses).toEqual({ who: { action: "accept", content: { name: "Ada" } } });
    expect(server.count("tools/call")).toBe(1);
  });

  it("cancels the task when the run is stopped", async () => {
    const server = taskServer();
    const { call, run, rows } = await setup(server);
    const control = createAdapterExecutionControl();
    adapterExecutionControls.set(run.id, control);
    try {
      const pending = call("build", { timeoutMs: 10_000 }).catch((error) => error);
      await vi.waitFor(() => expect(server.count("tasks/get")).toBeGreaterThan(0));
      control.controller.abort();
      expect(await pending).toMatchObject({ reasonCode: "provider_task_cancelled" });
    } finally {
      adapterExecutionControls.delete(run.id);
    }
    expect(server.count("tasks/cancel")).toBe(1);
    expect(server.only().task.status).toBe("cancelled");
    expect((await rows())[0]).toMatchObject({ status: "cancelled", errorCode: "run_cancelled" });
  });

  it("keeps the task when only the caller goes away", async () => {
    const server = taskServer();
    const { session, gateway, rows } = await setup(server);
    const tool = (await gateway().listToolsForSession(session.token)).find((candidate) => candidate.name.endsWith(":build"))!;
    const caller = new AbortController();
    const pending = gateway().executeTool({ sessionToken: session.token, tool: tool.name, parameters: { ref: "main" }, timeoutMs: 10_000, signal: caller.signal }).catch((error) => error);
    await vi.waitFor(() => expect(server.count("tasks/get")).toBeGreaterThan(0));
    caller.abort();
    expect(await pending).toMatchObject({ reasonCode: "provider_task_pending" });
    expect(server.count("tasks/cancel")).toBe(0);
    expect((await rows())[0]).toMatchObject({ status: "working" });
  });

  it("cancels a background task once its issue is closed", async () => {
    const server = taskServer();
    const { call, issue, rows, gateway } = await setup(server);
    await expect(call("build", { timeoutMs: 400 })).rejects.toMatchObject({ reasonCode: "provider_task_pending" });
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, issue.id));
    await db.update(toolMcpTasks).set({ nextPollAt: new Date(Date.now() - 1_000) }).where(eq(toolMcpTasks.companyId, issue.companyId));
    await gateway().pollDueMcpTasks();
    expect(server.count("tasks/cancel")).toBe(1);
    expect((await rows())[0]).toMatchObject({ status: "cancelled", errorCode: "issue_closed", nextPollAt: null });
  });

  it("reports a failed task as a tool error", async () => {
    const server = taskServer();
    const { call, org } = await setup(server);
    const failure = await call("explode").catch((error) => error);
    expect(failure).toMatchObject({ reasonCode: "provider_task_failed" });
    expect(failure.message).toContain("Build runner crashed");
    const [invocation] = await db.select().from(toolInvocations).where(eq(toolInvocations.companyId, org.id));
    expect(invocation).toMatchObject({ status: "failed", errorCode: "provider_task_failed" });
  });

  it("ends with a clear error when the app forgets the task or its TTL passes, never a hang", async () => {
    const forgetting = taskServer();
    const one = await setup(forgetting);
    await expect(one.call("build", { timeoutMs: 400 })).rejects.toMatchObject({ reasonCode: "provider_task_pending" });
    forgetting.forget();
    await expect(one.call("build")).rejects.toMatchObject({ reasonCode: "provider_task_expired" });
    expect((await one.rows())[0]).toMatchObject({ status: "expired", errorCode: "provider_task_unknown" });
    // The next call is new work.
    await expect(one.call("build", { timeoutMs: 300 })).rejects.toBeTruthy();
    expect(forgetting.count("tools/call")).toBe(2);

    const shortLived = taskServer();
    const two = await setup(shortLived);
    const started = Date.now();
    await expect(two.call("short_lived", { timeoutMs: 5_000 })).rejects.toMatchObject({ reasonCode: "provider_task_expired" });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect((await two.rows())[0]).toMatchObject({ status: "expired", errorCode: "ttl_expired" });
  });

  it("lets a keyed retry collect its task after a crash mid-wait", async () => {
    const server = taskServer();
    const { call, org } = await setup(server);
    await expect(call("build", { timeoutMs: 400, idempotencyKey: "deploy-crash" })).rejects.toMatchObject({ reasonCode: "provider_task_pending" });
    // A crash mid-wait leaves the call executing, with no error recorded.
    await db.update(toolInvocations).set({ status: "executing", errorCode: null, errorMessage: null, completedAt: null })
      .where(eq(toolInvocations.companyId, org.id));
    await db.update(toolMcpTasks).set({ leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(toolMcpTasks.companyId, org.id));
    server.finish();
    expect(await call("build", { timeoutMs: 2_000, idempotencyKey: "deploy-crash" })).toMatchObject({ status: "completed", result: { content: "build finished" } });
    expect(server.count("tools/call")).toBe(1);
  });

  it("keeps a keyed retry intact when the same key is reused with other arguments", async () => {
    const server = taskServer();
    const { call, org } = await setup(server);
    await expect(call("build", { timeoutMs: 400, idempotencyKey: "deploy-a" })).rejects.toMatchObject({ reasonCode: "provider_task_pending" });
    // Separate pending work for the other arguments must not be collected under key A.
    await expect(call("build", { timeoutMs: 400, parameters: { ref: "other" } })).rejects.toMatchObject({ reasonCode: "provider_task_pending" });
    await expect(call("build", { timeoutMs: 400, idempotencyKey: "deploy-a", parameters: { ref: "other" } }))
      .rejects.toMatchObject({ reasonCode: "idempotency_key_conflict" });
    const keyed = (await db.select().from(toolInvocations).where(eq(toolInvocations.companyId, org.id)))
      .find((invocation) => invocation.idempotencyKey === "deploy-a");
    expect(keyed).toMatchObject({ errorCode: "provider_task_pending" });
    for (const id of [...server.tasks.keys()]) server.tasks.get(id)!.status = "completed";
    expect(await call("build", { timeoutMs: 2_000, idempotencyKey: "deploy-a" })).toMatchObject({ status: "completed" });
    expect(server.count("tools/call")).toBe(2);
  });

  it("hands a task to only one of two simultaneous callers", async () => {
    const server = taskServer();
    const { call } = await setup(server);
    await expect(call("build", { timeoutMs: 400 })).rejects.toMatchObject({ reasonCode: "provider_task_pending" });
    server.finish();
    const outcomes = await Promise.all([call("build", { timeoutMs: 1_500 }).catch((error) => error), call("build", { timeoutMs: 1_500 }).catch((error) => error)]);
    expect(outcomes.filter((outcome) => outcome?.status === "completed")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome?.reasonCode === "provider_task_pending")).toHaveLength(1);
    expect(server.count("tools/call")).toBe(1);
  });

  it("never revives a task it cancelled in the background", async () => {
    const server = taskServer();
    const { call, issue, gateway } = await setup(server);
    await expect(call("build", { timeoutMs: 400 })).rejects.toMatchObject({ reasonCode: "provider_task_pending" });
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, issue.id));
    await db.update(toolMcpTasks).set({ nextPollAt: new Date(Date.now() - 1_000) }).where(eq(toolMcpTasks.companyId, issue.companyId));
    await gateway().pollDueMcpTasks();
    // The app had not stopped yet, and the task is reopened.
    server.only().task.status = "working";
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issue.id));
    const gets = server.count("tasks/get");
    await expect(call("build", { timeoutMs: 1_000 })).rejects.toMatchObject({ reasonCode: "provider_task_cancelled" });
    expect(server.count("tasks/get")).toBe(gets);
  });

  it("wakes the agent when a background task asks a new question, and its next call shows it", async () => {
    const server = taskServer();
    const ctx = await setup(server);
    await expect(ctx.call("build", { timeoutMs: 400 })).rejects.toMatchObject({ reasonCode: "provider_task_pending" });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, ctx.run.id));
    server.ask();
    await db.update(toolMcpTasks).set({ nextPollAt: new Date(Date.now() - 1_000) }).where(eq(toolMcpTasks.companyId, ctx.org.id));
    const wake = vi.fn(async () => undefined);
    await ctx.gateway().pollDueMcpTasks({ wake });
    expect(wake).toHaveBeenCalledWith(expect.objectContaining({ status: "input_required", wakeKey: expect.stringContaining(":input:") }));
    // Asked once: the next background pass does not wake again.
    await db.update(toolMcpTasks).set({ nextPollAt: new Date(Date.now() - 1_000) }).where(eq(toolMcpTasks.companyId, ctx.org.id));
    await ctx.gateway().pollDueMcpTasks({ wake });
    expect(wake).toHaveBeenCalledTimes(1);
    const [woken] = await db.insert(heartbeatRuns).values({ companyId: ctx.org.id, agentId: ctx.agent.id, invocationSource: "assignment", status: "running", contextSnapshot: { issueId: ctx.issue.id } }).returning();
    const session = await ctx.gateway().createSession({ companyId: ctx.org.id, agentId: ctx.agent.id, runId: woken!.id });
    const tool = (await ctx.gateway().listToolsForSession(session.token)).find((candidate) => candidate.name.endsWith(":build"))!;
    expect(await ctx.gateway().executeTool({ sessionToken: session.token, tool: tool.name, parameters: { ref: "main" }, timeoutMs: 2_000 }).catch((error) => error))
      .toMatchObject({ reasonCode: "elicitation_required" });
  });

  it("caps wakes when a provider keeps asking new questions", async () => {
    const server = taskServer();
    const ctx = await setup(server);
    await expect(ctx.call("build", { timeoutMs: 400 })).rejects.toMatchObject({ reasonCode: "provider_task_pending" });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, ctx.run.id));
    const wake = vi.fn(async () => undefined);
    for (let round = 0; round < 6; round += 1) {
      // The provider rotates its input keys on every poll.
      Object.assign(server.only().task, { status: "input_required", inputRequests: { [`k${round}`]: { method: "elicitation/create", params: { mode: "form", message: "Again?", requestedSchema: { type: "object", properties: {} } } } } });
      await db.update(toolMcpTasks).set({ nextPollAt: new Date(Date.now() - 1_000), inputWakeAt: null }).where(eq(toolMcpTasks.companyId, ctx.org.id));
      await ctx.gateway().pollDueMcpTasks({ wake });
    }
    expect(wake).toHaveBeenCalledTimes(3);
    const [row] = await ctx.rows();
    expect(row!.inputWakeCount).toBe(3);
    expect(row!.surfacedInputKeys.length).toBeLessThanOrEqual(64);
  });

  it("stops background work once the grant is revoked", async () => {
    const server = taskServer();
    const ctx = await setup(server);
    await expect(ctx.call("build", { timeoutMs: 400 })).rejects.toMatchObject({ reasonCode: "provider_task_pending" });
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.connectionId, ctx.connected.connectionId));
    await db.update(toolMcpTasks).set({ nextPollAt: new Date(Date.now() - 1_000) }).where(eq(toolMcpTasks.companyId, ctx.org.id));
    const gets = server.count("tasks/get");
    await ctx.gateway().pollDueMcpTasks();
    expect(server.count("tasks/get")).toBe(gets);
    expect((await ctx.rows())[0]).toMatchObject({ status: "expired", errorCode: "access_removed", nextPollAt: null });
  });

  it("keeps a completed task recoverable until its result is recorded, then wakes the agent", async () => {
    const server = taskServer();
    const ctx = await setup(server);
    await expect(ctx.call("garbled")).rejects.toMatchObject({ reasonCode: "remote_mcp_malformed_response" });
    const [held] = await ctx.rows();
    expect(held).toMatchObject({ status: "completed", deliveredAt: null });
    // Background work still has a deadline for it: when the hold ends.
    expect(held!.nextPollAt).toBeInstanceOf(Date);
    expect(held!.nextPollAt!.getTime()).toBe(held!.leaseExpiresAt!.getTime());
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, ctx.run.id));
    await db.update(toolMcpTasks).set({ nextPollAt: new Date(Date.now() - 1_000), leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(toolMcpTasks.id, held!.id));
    const wake = vi.fn(async () => undefined);
    await ctx.gateway().pollDueMcpTasks({ wake });
    expect(wake).toHaveBeenCalledWith(expect.objectContaining({ taskRecordId: held!.id, status: "completed" }));
  });

  it("keeps the caller's identity with the task for background checks", async () => {
    const server = taskServer();
    const ctx = await setup(server);
    await db.update(heartbeatRuns).set({ responsibleUserId: actor.actorId }).where(eq(heartbeatRuns.id, ctx.run.id));
    const session = await ctx.gateway().createSession({ companyId: ctx.org.id, agentId: ctx.agent.id, runId: ctx.run.id });
    const tool = (await ctx.gateway().listToolsForSession(session.token)).find((candidate) => candidate.name.endsWith(":build"))!;
    await expect(ctx.gateway().executeTool({ sessionToken: session.token, tool: tool.name, parameters: { ref: "main" }, timeoutMs: 400 }))
      .rejects.toMatchObject({ reasonCode: "provider_task_pending" });
    expect((await ctx.rows())[0]).toMatchObject({ responsibleUserId: actor.actorId });
  });

  it("never lets another agent attach to a task", async () => {
    const server = taskServer();
    const ctx = await setup(server);
    await expect(ctx.call("build", { timeoutMs: 400 })).rejects.toMatchObject({ reasonCode: "provider_task_pending" });
    const [other] = await db.insert(agents).values({ companyId: ctx.org.id, name: "Other agent", role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: {} }).returning();
    await db.update(issues).set({ assigneeAgentId: other!.id }).where(eq(issues.id, ctx.issue.id));
    const [otherRun] = await db.insert(heartbeatRuns).values({ companyId: ctx.org.id, agentId: other!.id, invocationSource: "assignment", status: "running", contextSnapshot: { issueId: ctx.issue.id } }).returning();
    const session = await ctx.gateway().createSession({ companyId: ctx.org.id, agentId: other!.id, runId: otherRun!.id });
    const tool = (await ctx.gateway().listToolsForSession(session.token)).find((candidate) => candidate.name.endsWith(":build"))!;
    await ctx.gateway().executeTool({ sessionToken: session.token, tool: tool.name, parameters: { ref: "main" }, timeoutMs: 300 }).catch(() => undefined);
    expect(server.count("tools/call")).toBe(2);
  });
});
