import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import express from "express";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issues, projects, runtimeServices, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { RUNTIME_SERVICE_TOOL_NAMES, type RuntimeService } from "@paperclipai/shared";
import { buildRuntimeServicesEnv, redactEnvForLogs } from "@paperclipai/adapter-utils/server-utils";
import { PaperclipRunnerToolAuthority } from "../native-runtime/paperclip-runner-tool-authority.js";
import { createRuntimeServiceManager } from "./manager.js";
import { createLocalRuntimeServiceProvider } from "./local-provider.js";
import { createRuntimeServicePlacementResolver } from "./placement.js";
import { createRuntimeServiceOperations } from "./operations.js";
import { createRuntimeServiceToolAccess } from "./tool-access.js";
import { runtimeServiceToolRoutes } from "../../routes/runtime-service-tools.js";
import { runtimeServiceRoutes } from "../../routes/runtime-services.js";
import { createRuntimeToolsToken, verifyRuntimeToolsToken } from "../../runtime-tools-token.js";
import { readProcessStartedAt } from "../hot-restart.js";
import { errorHandler } from "../../middleware/error-handler.js";

describe("native and MCP service tools with durable records and real supervised processes", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  let manager: ReturnType<typeof createRuntimeServiceManager>;
  let provider: ReturnType<typeof createLocalRuntimeServiceProvider>;
  let operations: ReturnType<typeof createRuntimeServiceOperations>;
  let server: http.Server;
  let origin: string;
  const companiesToClean: string[] = [];
  const sourceCommands: ChildProcess[] = [];
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "runtime-service-tools-test-secret-only");
    database = await startEmbeddedPostgresTestDatabase("paperclip-service-tools-");
    db = createDb(database.connectionString);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-service-tools-"));
    provider = createLocalRuntimeServiceProvider({ root: path.join(root, "supervisors") });
    manager = createRuntimeServiceManager(db, { providers: [provider] });
    const dependencies = { manager, resolvePlacement: createRuntimeServicePlacementResolver(db, { allowLocal: true }) };
    operations = createRuntimeServiceOperations(db, dependencies);
    const app = express(); app.use(express.json());
    app.use(runtimeServiceToolRoutes(db, operations));
    app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: "test-board", isInstanceAdmin: true }; next(); });
    app.use("/api", runtimeServiceRoutes(db, dependencies)); app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  }, 30_000);
  afterEach(async () => {
    for (const companyId of companiesToClean.splice(0)) for (const service of await manager.list(companyId)) {
      await manager.control(companyId, service.id, { type: "board", id: "cleanup" }, { requestId: randomUUID(), expectedRevision: service.revision, action: "stop" });
      await manager.reconcile(companyId, service.id);
    }
    for (const source of sourceCommands.splice(0)) if (source.exitCode === null && source.signalCode === null) {
      const exited = once(source, "exit"); source.kill("SIGKILL"); await exited;
    }
  });
  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await database?.cleanup(); if (root) await fs.rm(root, { recursive: true, force: true }); vi.unstubAllEnvs();
  });
  async function fixture() {
    const companyId = randomUUID(); companiesToClean.push(companyId);
    const cwd = path.join(root, companyId); await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, "content.txt"), "first dirty edit");
    await fs.writeFile(path.join(cwd, "app.cjs"), "const fs=require('node:fs'); fs.appendFileSync('boots.txt','boot\\n'); console.log('App listening'); const server=require('node:http').createServer((q,s)=>{s.setHeader('x-run-credential',process.env.OLD_RUN_SECRET?'present':'absent');s.end(fs.readFileSync('content.txt'));});server.listen(Number(process.env.PORT),'127.0.0.1',()=>console.log('SOURCE '+JSON.stringify({pid:process.pid,port:server.address().port})));" );
    await db.insert(companies).values({ id: companyId, name: "Service tools", issuePrefix: `T${companyId.slice(0, 6)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Developer", status: "active" }).returning();
    const [project] = await db.insert(projects).values({ companyId, name: "Web app" }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId: project!.id, name: "App", mode: "isolated_workspace", strategyType: "git_worktree", cwd }).returning();
    const [task] = await db.insert(issues).values({ companyId, title: "Iterate", status: "in_progress", executionWorkspaceId: workspace!.id, assigneeAgentId: agent!.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, status: "running", runtimeMode: "native", nativeIssueId: task!.id, contextSnapshot: { issueId: task!.id } }).returning();
    await db.update(issues).set({ executionRunId: run!.id }).where(eq(issues.id, task!.id));
    const [environment] = await db.insert(environments).values({ name: companyId, driver: "sandbox", config: { provider: "local" } }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, environmentId: environment!.id, executionWorkspaceId: workspace!.id, heartbeatRunId: run!.id, provider: "local", metadata: { runtimeServiceBoundary: { version: 1, provider: "local", workspaceRoot: cwd, executionWorkspaceId: workspace!.id, network: "enabled" } } }).returning();
    const binding = { companyId, agentId: agent!.id, issueId: task!.id, runId: run!.id, runtimeServices: operations };
    const authority = new PaperclipRunnerToolAuthority(db, binding);
    const access = createRuntimeServiceToolAccess({ ...binding, responsibleUserId: null, baseUrl: origin })!;
    const input = { name: "App", command: "node app.cjs", requestId: randomUUID(), endpoints: [{ name: "web" }] };
    return { companyId, cwd, task: task!, run: run!, lease: lease!, agent: agent!, binding, authority, access, input };
  }
  async function startOriginal(f: Awaited<ReturnType<typeof fixture>>) {
    const source = spawn(process.execPath, ["app.cjs"], { cwd: f.cwd, detached: true, env: { PATH: process.env.PATH, PORT: "0", OLD_RUN_SECRET: "synthetic-original-run-only" }, stdio: ["ignore", "pipe", "ignore"] });
    sourceCommands.push(source);
    const address = await new Promise<{ pid: number; port: number }>((resolve, reject) => {
      let output = "";
      source.on("error", reject);
      source.stdout!.on("data", (chunk) => { output += String(chunk); const match = /SOURCE (.+)\n/.exec(output); if (match) resolve(JSON.parse(match[1]!)); });
    });
    await db.update(heartbeatRuns).set({ processPid: process.pid, processStartedAt: new Date((await readProcessStartedAt(process.pid))!) }).where(eq(heartbeatRuns.id, f.run.id));
    return { source, ...address, url: `http://127.0.0.1:${address.port}` };
  }

  function native(f: Awaited<ReturnType<typeof fixture>>, tool: string, args: unknown = {}) {
    return f.authority.execute({ tool, callId: randomUUID(), arguments: args });
  }
  async function mcp(token: string, method: string, params?: unknown, extraHeaders = {}) {
    const response = await fetch(`${origin}/mcp/runtime-services`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extraHeaders }, body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }) });
    return { status: response.status, body: await response.json() };
  }
  async function ready(companyId: string, id: string) {
    for (let attempt = 0; attempt < 60; attempt++) {
      await manager.reconcile(companyId, id);
      const current = await manager.get(companyId, id);
      if (current.state === "ready") return current;
      if (current.state === "failed") throw new Error(current.error ?? "Failed");
      await delay(50);
    }
    throw new Error("App not ready");
  }

  it("relaunches a verified command through native tools, retries through MCP and survives run completion", async () => {
    const f = await fixture(); const original = await startOriginal(f);
    expect((await fetch(original.url)).headers.get("x-run-credential")).toBe("present");
    const input = { ...f.input, sourcePid: original.pid, endpoints: [{ name: "web", port: original.port }] };
    const service = await native(f, "services_register", input) as RuntimeService;
    expect(service).toMatchObject({ handoff: { mode: "relaunch", phase: "pending" }, startedByRunId: f.run.id, state: "pending" });
    expect(service).not.toHaveProperty("processHandoff");
    expect(await (await fetch(original.url)).text()).toBe("first dirty edit");
    await expect(native(f, "services_register", { ...input, requestId: randomUUID() })).rejects.toMatchObject({ status: 409 });
    const exited = once(original.source, "exit");
    const running = await ready(f.companyId, service.id); await exited;
    expect(running.handoff).toEqual({ mode: "relaunch", phase: "complete" });
    expect((await fetch(original.url)).headers.get("x-run-credential")).toBe("absent");
    const replay = await mcp(f.access.bearerToken, "tools/call", { name: "services_register", arguments: input });
    expect(replay.body.result.structuredContent.result.id).toBe(service.id);
    expect(await fs.readFile(path.join(f.cwd, "boots.txt"), "utf8")).toBe("boot\nboot\n");
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id));
    await db.update(environmentLeases).set({ status: "released" }).where(eq(environmentLeases.id, f.lease.id));
    await fs.writeFile(path.join(f.cwd, "content.txt"), "edit after original run ended");
    expect(await (await fetch(original.url)).text()).toBe("edit after original run ended");
    const record = await manager.getRecord(f.companyId, service.id);
    expect(record.service.processHandoff?.phase).toBe("complete");
    expect((await manager.list(f.companyId))).toHaveLength(1);
  });

  it("recovers a controller lost after stopping the original without a second managed launch", async () => {
    const f = await fixture(); const original = await startOriginal(f);
    const input = { ...f.input, sourcePid: original.pid, endpoints: [{ name: "web", port: original.port }] };
    const service = await native(f, "services_register", input) as RuntimeService;
    const stopOriginal = provider.stopExistingProcess!.bind(provider);
    const spy = vi.spyOn(provider, "stopExistingProcess").mockImplementationOnce(async (receipt) => {
      await stopOriginal(receipt);
      // Simulate loss of the controller's lease before the receipt is persisted.
      await db.update(runtimeServices).set({ controllerId: "replacement", controllerExpiresAt: new Date(0) }).where(eq(runtimeServices.id, service.id));
      throw new Error("controller lost before acknowledging handoff");
    });
    try { await manager.reconcile(f.companyId, service.id); }
    finally { spy.mockRestore(); }
    expect((await manager.getRecord(f.companyId, service.id)).service.processHandoff?.phase).toBe("pending");
    const replacement = createRuntimeServiceManager(db, { providers: [provider] });
    await replacement.reconcile(f.companyId, service.id);
    const running = await ready(f.companyId, service.id);
    expect(running.handoff?.phase).toBe("complete");
    expect(await fs.readFile(path.join(f.cwd, "boots.txt"), "utf8")).toBe("boot\nboot\n");
    const replay = await native(f, "services_register", input) as RuntimeService;
    expect(replay.id).toBe(service.id);
  });

  it("keeps a concurrent Stop authoritative during handoff and never launches the replacement", async () => {
    const f = await fixture(); const original = await startOriginal(f);
    const service = await native(f, "services_register", { ...f.input, sourcePid: original.pid, endpoints: [{ name: "web", port: original.port }] }) as RuntimeService;
    const stopOriginal = provider.stopExistingProcess!.bind(provider);
    let entered!: () => void; const began = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void; const hold = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(provider, "stopExistingProcess").mockImplementationOnce(async (receipt) => { entered(); await hold; await stopOriginal(receipt); });
    const working = manager.reconcile(f.companyId, service.id);
    try {
      await began;
      await manager.control(f.companyId, service.id, { type: "board", id: "operator" }, { requestId: randomUUID(), expectedRevision: (await manager.get(f.companyId, service.id)).revision, action: "stop" });
      expect((await manager.companyPolicy(f.companyId)).usage.runningServices).toBe(1);
    } finally { release(); await working; spy.mockRestore(); }
    expect(await manager.get(f.companyId, service.id)).toMatchObject({ state: "stopped", desiredState: "stopped", handoff: { phase: "stopped" } });
    expect((await manager.companyPolicy(f.companyId)).usage.runningServices).toBe(0);
    expect(await fs.readFile(path.join(f.cwd, "boots.txt"), "utf8")).toBe("boot\n");
    await expect(fetch(original.url)).rejects.toThrow();
  });

  it("does not stop an original command when capacity or ownership denies registration", async () => {
    const f = await fixture();
    const other = await native(f, "services_start", f.input) as RuntimeService;
    await ready(f.companyId, other.id);
    await manager.updateCompanyPolicy(f.companyId, { type: "board", id: "operator" }, { requestId: randomUUID(), expectedRevision: 0, config: { maxRunningServices: 1 } });
    const original = await startOriginal(f);
    const input = { ...f.input, requestId: randomUUID(), sourcePid: original.pid, endpoints: [{ name: "web", port: original.port }] };
    await expect(native(f, "services_register", input)).rejects.toMatchObject({ status: 409 });
    expect(await (await fetch(original.url)).text()).toBe("first dirty edit");
    expect((await manager.list(f.companyId))).toHaveLength(1);
    await expect(native(f, "services_register", { ...input, sourcePid: process.pid })).rejects.toMatchObject({ status: 422 });
    expect(original.source.signalCode).toBeNull();
  });

  it("advertises typed tools and converges native, MCP, and HTTP retries onto one launch", async () => {
    const f = await fixture();
    expect(f.authority.definitions().filter((x) => String(x.name).startsWith("services_")).map((x) => x.name)).toEqual(RUNTIME_SERVICE_TOOL_NAMES);
    expect((await mcp(f.access.bearerToken, "initialize", {})).body.result.serverInfo.name).toBe("paperclip-services");
    const list = await mcp(f.access.bearerToken, "tools/list");
    expect(list.body.result.tools.map((x: { name: string }) => x.name)).toEqual(RUNTIME_SERVICE_TOOL_NAMES);
    const created = await native(f, "services_start", f.input) as RuntimeService;
    expect(created).toMatchObject({ issueId: f.task.id, startedByRunId: f.run.id, createdByAgentId: f.agent.id });
    const retry = await mcp(f.access.bearerToken, "tools/call", { name: "services_start", arguments: f.input });
    expect(retry.body.result.structuredContent.result.id).toBe(created.id);
    const running = await ready(f.companyId, created.id);
    const api = await fetch(`${origin}/api/companies/${f.companyId}/runtime-services/${created.id}`);
    expect(await api.json()).toMatchObject({ id: created.id, state: "ready" });
    expect(await fs.readFile(path.join(f.cwd, "boots.txt"), "utf8")).toBe("boot\n");
    const action = { serviceId: created.id, requestId: randomUUID(), expectedRevision: running.revision, action: "restart" };
    await native(f, "services_control", action);
    await mcp(f.access.bearerToken, "tools/call", { name: "services_control", arguments: action });
    await ready(f.companyId, created.id);
    expect(await fs.readFile(path.join(f.cwd, "boots.txt"), "utf8")).toBe("boot\nboot\n");
    expect(await native(f, "services_logs", { serviceId: created.id })).toEqual({ text: expect.stringContaining("App listening") });
    const inspected = await native(f, "services_inspect", { serviceId: created.id }) as RuntimeService;
    const policy = { serviceId: created.id, requestId: randomUUID(), expectedRevision: inspected.revision, policy: { idleSeconds: 5400, maxRunningSeconds: 7200 } };
    const changed = await mcp(f.access.bearerToken, "tools/call", { name: "services_update_policy", arguments: policy });
    expect(changed.body.result.structuredContent.result.policy).toMatchObject(policy.policy);
    const repeated = await native(f, "services_update_policy", policy) as RuntimeService;
    expect(repeated.revision).toBe(changed.body.result.structuredContent.result.revision);
    const rest = await fetch(f.access.callEndpoint, { method: "POST", headers: { authorization: `Bearer ${f.access.bearerToken}`, "content-type": "application/json" }, body: JSON.stringify({ name: "services_inspect", arguments: { serviceId: created.id } }) });
    expect(await rest.json()).toMatchObject({ id: created.id, policy: policy.policy });
  });

  it("revokes the ended run's tools while its service keeps serving files to the next authorized run", async () => {
    const f = await fixture();
    const service = await native(f, "services_start", f.input) as RuntimeService;
    const running = await ready(f.companyId, service.id);
    const url = `http://127.0.0.1:${running.endpoints[0]!.port}`;
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await (await fetch(url)).text()).toBe("first dirty edit");
    expect((await mcp(f.access.bearerToken, "tools/list")).status).toBe(403);
    await expect(native(f, "services_control", { serviceId: service.id, requestId: randomUUID(), expectedRevision: running.revision, action: "stop" })).rejects.toThrow();
    const [nextAgent] = await db.insert(agents).values({ companyId: f.companyId, name: "Next developer", status: "active" }).returning();
    const [nextRun] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: nextAgent!.id, status: "running", runtimeMode: "native", nativeIssueId: f.task.id, contextSnapshot: { issueId: f.task.id } }).returning();
    await db.update(issues).set({ assigneeAgentId: nextAgent!.id, executionRunId: nextRun!.id }).where(eq(issues.id, f.task.id));
    const authority = new PaperclipRunnerToolAuthority(db, { ...f.binding, agentId: nextAgent!.id, runId: nextRun!.id });
    const found = await authority.execute({ tool: "services_list", callId: randomUUID(), arguments: {} }) as RuntimeService[];
    expect(found.map((s) => s.id)).toEqual([service.id]);
    await fs.writeFile(path.join(f.cwd, "content.txt"), "next run dirty edit");
    expect(await (await fetch(url)).text()).toBe("next run dirty edit");
    await authority.execute({ tool: "services_control", callId: randomUUID(), arguments: { serviceId: service.id, requestId: randomUUID(), expectedRevision: running.revision, action: "stop" } });
    await manager.reconcile(f.companyId, service.id);
    await expect(fetch(url)).rejects.toThrow();
  });

  it("keeps capability scopes distinct, refuses browser credentials and spoofed provenance", async () => {
    const f = await fixture();
    expect(verifyRuntimeToolsToken(f.access.bearerToken)).toBeNull();
    expect(verifyRuntimeToolsToken(f.access.bearerToken, "runtime_services")?.run_id).toBe(f.run.id);
    const connectionToken = createRuntimeToolsToken({ ...f.binding, responsibleUserId: "test" })!.token;
    expect((await mcp(connectionToken, "tools/list")).status).toBe(401);
    expect((await mcp(f.access.bearerToken, "tools/list", undefined, { origin: "https://untrusted.example" })).status).toBe(403);
    expect((await mcp(f.access.bearerToken, "tools/list", undefined, { cookie: "session=board" })).status).toBe(403);
    const unknown = await mcp(f.access.bearerToken, "tools/call", { name: "services_start", arguments: { ...f.input, companyId: randomUUID() } });
    expect(unknown.body.error.code).toBe(-32602);
    await expect(native(f, "services_start", { ...f.input, issueId: randomUUID() })).rejects.toMatchObject({ status: 403 });
    const foreign = await fixture();
    const foreignService = await native(foreign, "services_start", { ...foreign.input, start: false }) as RuntimeService;
    const denied = await mcp(f.access.bearerToken, "tools/call", { name: "services_inspect", arguments: { serviceId: foreignService.id } });
    expect(denied.body.result).toMatchObject({ isError: true, structuredContent: { result: { status: 404 } } });
    const env = buildRuntimeServicesEnv(f.access);
    expect(env.PAPERCLIP_RUNTIME_SERVICES_CALL_URL).toBe(`${origin}/runtime-tools/services/call`);
    expect(JSON.stringify(redactEnvForLogs(env))).not.toContain(f.access.bearerToken);
  });

  it("honors planning mode, revision conflicts, and invalid launch boundaries", async () => {
    const f = await fixture();
    await db.update(issues).set({ workMode: "planning" }).where(eq(issues.id, f.task.id));
    const listed = await mcp(f.access.bearerToken, "tools/list");
    expect(listed.body.result.tools.map((t: { name: string }) => t.name)).toEqual(["services_list", "services_inspect", "services_logs"]);
    await expect(native(f, "services_start", f.input)).rejects.toMatchObject({ status: 403 });
    await db.update(issues).set({ workMode: "standard" }).where(eq(issues.id, f.task.id));
    const service = await native(f, "services_start", { ...f.input, start: false }) as RuntimeService;
    const conflict = await mcp(f.access.bearerToken, "tools/call", { name: "services_control", arguments: { serviceId: service.id, expectedRevision: service.revision + 1, requestId: randomUUID(), action: "start" } });
    expect(conflict.body.result).toMatchObject({ isError: true, structuredContent: { result: { status: 409 } } });
    await db.update(environmentLeases).set({ metadata: {} }).where(eq(environmentLeases.id, f.lease.id));
    await expect(native(f, "services_start", { ...f.input, requestId: randomUUID() })).rejects.toMatchObject({ status: 422 });
  });
});
