import { randomUUID } from "node:crypto";
import http from "node:http";
import { and, eq } from "drizzle-orm";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, companies, createDb, heartbeatRuns, issues, principalPermissionGrants,
  runtimeServiceEvents, startEmbeddedPostgresTestDatabase, authUsers, companyMemberships,
} from "@paperclipai/db";
import { runtimeServiceRoutes } from "../../routes/runtime-services.js";
import { errorHandler } from "../../middleware/error-handler.js";
import { createRuntimeServiceManager } from "./manager.js";
import type { RuntimeServiceProvider } from "./provider.js";

describe("service HTTP contract and authorization", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let server: http.Server;
  let origin: string;
  let companyId: string;
  let otherCompanyId: string;
  let taskId: string;
  let unrelatedTaskId: string;
  let agentId: string;
  let otherAgentId: string;
  let runId: string;
  const actorTokens = new Map<string, express.Request["actor"]>();
  const provider: RuntimeServiceProvider = {
    key: "fixture", capabilities: { dynamicPorts: true, preview: true, logs: true, preservesDataOnStop: true },
    async start(ctx) { return ctx.process; }, async inspect() { return { state: "running", endpoints: [] }; },
    async stop() {}, async logs() { return "Ready"; },
  };

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-service-http-");
    db = createDb(database.connectionString);
    companyId = randomUUID(); otherCompanyId = randomUUID();
    agentId = randomUUID(); otherAgentId = randomUUID();
    taskId = randomUUID(); unrelatedTaskId = randomUUID(); runId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Service company", issuePrefix: "SVC" },
      { id: otherCompanyId, name: "Other company", issuePrefix: "OTHER" },
    ]);
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Author", role: "engineer" },
      { id: otherAgentId, companyId, name: "Continuing agent", role: "engineer" },
    ]);
    await db.insert(issues).values([
      { id: taskId, companyId, title: "Build preview", status: "in_progress", assigneeAgentId: otherAgentId },
      { id: unrelatedTaskId, companyId, title: "Unrelated work", status: "in_progress" },
    ]);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId: taskId } });
    await db.insert(authUsers).values({ id: "viewer", name: "Viewer", email: "viewer@example.test", createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "viewer", status: "active", membershipRole: "viewer" });
    actorTokens.set("board", { type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: true });
    actorTokens.set("author", { type: "agent", agentId, companyId, runId, source: "agent_jwt" });
    actorTokens.set("continuing", { type: "agent", agentId: otherAgentId, companyId, source: "agent_key" });
    actorTokens.set("foreign", { type: "agent", agentId: randomUUID(), companyId: otherCompanyId, source: "agent_key" });
    actorTokens.set("viewer", { type: "board", userId: "viewer", companyIds: [companyId], source: "session", isInstanceAdmin: false,
      memberships: [{ companyId, membershipRole: "viewer", status: "active" }] } as express.Request["actor"]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actorTokens.get(req.get("x-test-actor") ?? "") ?? { type: "none" }; next(); });
    app.use("/api", runtimeServiceRoutes(db, {
      manager: createRuntimeServiceManager(db, { providers: [provider] }),
      // Tests resolve location on the server. The public body cannot select a
      // host provider or inject allocation metadata.
      resolvePlacement: async () => ({ provider: "fixture", cwd: "/service-fixture", reuseKey: "fixture" }),
    }));
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/companies/${companyId}/runtime-services`;
  }, 30_000);
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await database?.cleanup(); });

  async function request(actor: string, suffix = "", body?: unknown, method = body === undefined ? "GET" : "POST") {
    return fetch(origin + suffix, { method, headers: { "x-test-actor": actor, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  async function create(actor = "author", extra = {}) {
    return request(actor, "", { requestId: randomUUID(), name: "My service", command: "node service.cjs", start: false, ...extra });
  }
  it("company-scopes storage and keeps refresh controls operator-only", async () => {
    const service = await (await create("board")).json(), suffix = `/${service.id}/storage`;
    expect((await request("", suffix)).status).toBe(401);
    expect((await request("author", suffix)).status).toBe(403);
    expect((await request("foreign", suffix)).status).toBe(403);
    expect((await request("viewer", suffix)).status).toBe(200);
    expect((await request("viewer", `${suffix}/refresh`, {})).status).toBe(403);
    const refreshed = await request("board", `${suffix}/refresh`, {});
    expect(refreshed.status).toBe(200);
    expect((await refreshed.json()).usage).toMatchObject({ status: "unavailable", reason: "unsupported", bytes: null });
    expect((await request("board", `${suffix}/refresh`, { cwd: "/private" })).status).toBe(400);
  });

  it("restricts data deletion review and confirmation to the correct board permissions", async () => {
    const service = await (await create("board")).json(), suffix = `/${service.id}/data-deletion`;
    expect((await request("", suffix)).status).toBe(401);
    expect((await request("author", suffix)).status).toBe(403);
    expect((await request("foreign", suffix)).status).toBe(403);
    const response = await request("viewer", suffix); expect(response.status).toBe(200);
    const plan = await response.json(); expect(plan.scope).toBe("external_workspace");
    const input = { requestId: randomUUID(), planToken: plan.planToken, confirmedAllocationId: plan.allocationId, confirm: true };
    expect((await request("viewer", suffix, input)).status).toBe(403);
    expect((await request("author", suffix, input)).status).toBe(403);
    expect((await request("board", suffix, { ...input, confirm: false })).status).toBe(400);
    expect((await request("board", suffix, { ...input, cwd: "/private" })).status).toBe(400);
    expect((await request("board", suffix, input)).status).toBe(409);
    expect((await request("board", `/${randomUUID()}/data-deletion`)).status).toBe(404);
  });

  it.each(["attach-task", "detach-task"])("restricts %s to authorized board actors with validated task IDs", async (action) => {
    const service = await (await create("board")).json();
    const input = { requestId: randomUUID(), expectedRevision: service.revision, issueId: taskId };
    const suffix = `/${service.id}/${action}`;
    expect((await request("", suffix, input)).status).toBe(401);
    expect((await request("author", suffix, input)).status).toBe(403);
    expect((await request("viewer", suffix, input)).status).toBe(403);
    expect((await request("board", suffix, { ...input, issueId: "invalid" })).status).toBe(400);
    expect((await request("board", suffix, input)).status).toBe(action === "attach-task" ? 422 : 409);
    expect((await request("board", suffix, { ...input, issueId: randomUUID() })).status).toBe(404);
  });

  it("derives provenance from the run and allows the next assigned agent to control its service", async () => {
    const response = await create();
    expect(response.status).toBe(202);
    const service = await response.json();
    expect(service).toMatchObject({ issueId: taskId, createdByAgentId: agentId, startedByRunId: runId, state: "stopped" });
    const controlled = await request("continuing", `/${service.id}/control`, { requestId: randomUUID(), expectedRevision: service.revision, action: "start" });
    expect(controlled.status).toBe(202);
    expect(await controlled.json()).toMatchObject({ state: "pending", desiredState: "running" });
    const events = await db.select().from(runtimeServiceEvents).where(and(eq(runtimeServiceEvents.companyId, companyId), eq(runtimeServiceEvents.serviceId, service.id)));
    expect(events.map((event) => event.actor.id)).toEqual([agentId, otherAgentId]);
  });

  it("does not allow spoofed task provenance, provider metadata, or run IDs", async () => {
    expect((await create("author", { issueId: unrelatedTaskId })).status).toBe(403);
    expect((await create("author", { startedByRunId: randomUUID() })).status).toBe(400);
    expect((await create("author", { provider: "local", metadata: { cwd: "/" } })).status).toBe(400);
  });

  it("requires an active agent run and a capable provider before accepting process registration", async () => {
    const input = { requestId: randomUUID(), name: "Original app", command: "node app.cjs", sourcePid: 2, issueId: taskId };
    const before = await (await request("board")).json();
    expect((await request("none", "/register", input)).status).toBe(401);
    for (const actor of ["board", "viewer", "foreign", "continuing"]) {
      expect((await request(actor, "/register", input)).status).toBe(403);
    }
    expect((await request("author", "/register", { ...input, start: false })).status).toBe(400);
    expect((await request("author", "/register", { ...input, sourcePid: "opaque-command-handle" })).status).toBe(400);
    const unavailable = await request("author", "/register", input);
    expect(unavailable.status).toBe(422);
    expect(await unavailable.json()).toMatchObject({ error: expect.stringContaining("cannot verify an existing process") });
    expect(await (await request("board")).json()).toHaveLength(before.length);
  });

  it("requires an explicit grant for company-wide agent access", async () => {
    const taskService = await (await create("author")).json();
    const taskList = await request("author");
    expect(taskList.status).toBe(200);
    const listed = await taskList.json();
    expect(listed.some((item: { id: string }) => item.id === taskService.id)).toBe(true);
    expect(listed.every((item: { issueId: string }) => item.issueId === taskId)).toBe(true);
    expect((await request("continuing")).status).toBe(403);
    expect((await request("continuing", `?issueId=${taskId}`)).status).toBe(200);
    const detached = await (await create("board")).json();
    expect((await request("author", `/${detached.id}`)).status).toBe(403);
    expect((await request("continuing", `/${detached.id}`)).status).toBe(403);
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "agent", principalId: otherAgentId, permissionKey: "services:manage" });
    expect((await request("continuing", `/${detached.id}`)).status).toBe(200);
    expect((await request("continuing")).status).toBe(200);
    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, otherAgentId));
  });

  it("rejects anonymous, cross-company, viewer-write, and unrelated-task requests", async () => {
    const service = await (await create()).json();
    expect((await request("none", `/${service.id}`)).status).toBe(401);
    const existing = await request("foreign", `/${service.id}`);
    const absent = await request("foreign", `/${randomUUID()}`);
    expect(existing.status).toBe(absent.status);
    expect(existing.status).toBe(403);
    expect((await request("viewer", `/${service.id}/control`, { requestId: randomUUID(), expectedRevision: service.revision, action: "stop" })).status).toBe(403);
    const unrelated = await (await create("board", { issueId: unrelatedTaskId })).json();
    expect((await request("author", `/${unrelated.id}`)).status).toBe(403);
  });

  it("keeps environment disclosure and binding changes under operator authority", async () => {
    const service = await (await create("author", { env: { PUBLIC_MODE: { type: "plain", value: "development" } } })).json();
    expect(service).not.toHaveProperty("env"); expect(service).not.toHaveProperty("spec");
    expect((await request("author", `/${service.id}/environment`)).status).toBe(403);
    expect((await request("viewer", `/${service.id}/environment`)).status).toBe(403);
    expect((await request("board", `/${service.id}/environment`)).status).toBe(200);
    const update = { requestId: randomUUID(), expectedRevision: service.revision, env: { PUBLIC_MODE: { type: "plain", value: "test" } } };
    expect((await request("author", `/${service.id}/environment`, update, "PATCH")).status).toBe(403);
    expect((await request("board", `/${service.id}/environment`, update, "PATCH")).status).toBe(200);
    expect(await (await request("board", `/${service.id}/environment`)).json()).toMatchObject({ env: update.env });
    expect((await create("author", { env: { API_KEY: { type: "secret_ref", secretId: randomUUID() } } })).status).toBe(403);
    expect((await request("board", `/${service.id}/environment`, { ...update, requestId: randomUUID(), env: { NODE_OPTIONS: { type: "plain", value: "--inspect" } } }, "PATCH")).status).toBe(400);
  });

  it("restricts company policy to board access and never accepts an agent or foreign-company update", async () => {
    const policyUrl = origin.replace(/runtime-services$/, "runtime-service-policy");
    const call = (actor: string, body?: unknown, url = policyUrl) => fetch(url, { method: body ? "PATCH" : "GET", headers: { "x-test-actor": actor, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const original = await (await call("board")).json();
    const input = { requestId: randomUUID(), expectedRevision: original.revision, config: { previewIdleSeconds: 120 } };
    expect((await call("author", input)).status).toBe(403);
    expect((await call("foreign", input)).status).toBe(403);
    expect((await call("viewer", input)).status).toBe(403);
    expect((await call("none", input)).status).toBe(401);
    expect((await call("viewer", undefined, policyUrl.replace(companyId, otherCompanyId))).status).toBe(403);
    expect((await call("author")).status).toBe(403);
    expect((await call("board", { ...input, config: { maxRunningServices: 0 } })).status).toBe(400);
    expect((await call("board", input)).status).toBe(200);
    expect((await call("board", input)).status).toBe(200);
    expect(await (await call("board")).json()).toMatchObject({ revision: original.revision + 1, config: { previewIdleSeconds: 120 } });
    // API parsing must preserve the hold when an agent changes only idle time.
    const service = await (await create("board", { policy: { keepRunningUntil: "2099-01-01T00:00:00.000Z", maxRunningSeconds: 300 } })).json();
    const updated = await request("board", `/${service.id}/policy`, { requestId: randomUUID(), expectedRevision: service.revision, policy: { idleSeconds: 90 } }, "PATCH");
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ policy: { idleSeconds: 90, maxRunningSeconds: 300, keepRunningUntil: "2099-01-01T00:00:00.000Z" } });
  });

  it("rejects controls from a completed run and returns an explicit stale-state conflict", async () => {
    const service = await (await create()).json();
    const stale = await request("board", `/${service.id}/control`, { requestId: randomUUID(), expectedRevision: service.revision + 1, action: "stop" });
    expect(stale.status).toBe(409);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
    expect((await request("author", `/${service.id}/control`, { requestId: randomUUID(), expectedRevision: service.revision, action: "start" })).status).toBe(403);
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, runId));
  });
});
