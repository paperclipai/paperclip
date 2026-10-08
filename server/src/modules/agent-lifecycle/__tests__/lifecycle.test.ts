import { readFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import { agentRoutes } from "../../../routes/agents.js";
import { errorHandler } from "../../../middleware/error-handler.js";
import { createLifecycleDriver } from "../adapters/driver.js";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { agents, agentApiKeys, activityLog, agentConfigRevisions, userCompanyPreferences, companies, companyMemberships, principalPermissionGrants, plugins, pluginCompanySettings, createDb, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { createAgentLifecycle, configureAgentLifecycle, agentConfiguration, reconcileAgentPolicyHolds, approvalService } from "../index.js";
import { createLifecycleStore } from "../adapters/postgres.js";
import { transition } from "../domain/policy.js";
import type { LifecycleAgent } from "../application/ports.js";
import { budgetService } from "../../../services/budgets.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("agent lifecycle commands", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  const workers: ReturnType<typeof configureAgentLifecycle>[] = [];
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-agent-lifecycle-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => { for (const worker of workers) await worker.stop(); await database?.cleanup(); });
  beforeEach(async () => {
    for (const work of workers) await work.stop();
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Lifecycle test", issuePrefix: `L${companyId.slice(0, 7)}` });
  });
  function worker(run: (agent: LifecycleAgent, participant: string) => Promise<"complete" | "pending"> = async () => "complete", participants = ["host"]) {
    const value = configureAgentLifecycle(db, { participants: async () => participants, run }); workers.push(value); return value;
  }
  async function hire(status = "idle") { return createAgentLifecycle(db).requestHire(companyId, { name: "Agent", status, adapterType: "process" }); }
  async function current(id: string) { return (await db.select().from(agents).where(eq(agents.id, id)))[0]!; }

  it("maps existing states without starting setup or clearing pause reasons", async () => {
    const rows = await db.insert(agents).values(["idle", "running", "error", "paused", "pending_approval", "terminated"].map(status => ({
      companyId, name: status, status, pauseReason: status === "paused" ? "budget" : null,
    }))).returning();
    const migration = readFileSync(new URL("../../../../../packages/db/src/migrations/0320_daily_onslaught.sql", import.meta.url), "utf8");
    await db.execute(sql.raw(migration.slice(migration.indexOf('UPDATE "agents"'))));
    for (const row of rows) {
      const mapped = await current(row.id);
      expect(mapped.lifecycleState).toBe(["paused", "pending_approval", "terminated"].includes(row.status) ? row.status : "ready");
      expect(mapped.lifecycleOperation).toBeNull();
      expect(mapped.lifecycleParticipants).toBeNull();
      expect(mapped.lifecycleHolds).toEqual(row.status === "paused" ? ["budget"] : []);
    }
  });

  it("commits the record before preparation and verifies before admission", async () => {
    const observed: string[] = [];
    const work = worker(async agent => {
      expect((await current(agent.id)).lifecycleState).toBe(agent.lifecycleState);
      observed.push(agent.lifecycleState); return "complete";
    });
    const agent = await hire();
    expect(agent).toMatchObject({ lifecycleState: "preparing", status: "paused" });
    await work.process(agent.id);
    expect(observed).toEqual(["preparing", "verifying"]);
    expect(await current(agent.id)).toMatchObject({ lifecycleState: "ready", status: "idle" });
    expect(agent).not.toHaveProperty("lifecycleOperation");
  });

  it("runs the saved harness test and keeps a failed configuration out of ready", async () => {
    const driver = createLifecycleDriver(db, {} as never);
    const work = worker(driver.run);
    const agent = await hire();
    await work.process(agent.id);
    expect(await current(agent.id)).toMatchObject({ lifecycleState: "verifying", status: "paused" });
    await agentConfiguration(db).update(agent.id, { adapterConfig: { command: process.execPath } });
    await work.process(agent.id);
    expect(await current(agent.id)).toMatchObject({ lifecycleState: "ready", status: "idle", lifecycleError: null });
  });

  it("does not prepare a proposed hire until approval", async () => {
    const observed: string[] = [];
    const work = worker(async agent => { observed.push(agent.lifecycleState); return "complete"; });
    const agent = await hire("pending_approval");
    await work.process(agent.id);
    expect(observed).toEqual([]);
    const approval = await approvalService(db).create(companyId, { type: "hire_agent", payload: { agentId: agent.id }, status: "pending" });
    await approvalService(db).approve(approval.id, "board");
    await vi.waitFor(async () => expect((await current(agent.id)).lifecycleState).toBe("ready"));
    expect(observed).toEqual(["preparing", "verifying"]);
  });

  it("rejects transaction injection and generic state writes", async () => {
    const agent = await hire("pending_approval");
    await expect(db.transaction(async tx => createAgentLifecycle(tx as unknown as Db))).rejects.toThrow("root database");
    await expect(agentConfiguration(db).update(agent.id, { status: "idle" } as never)).rejects.toThrow("lifecycle command");
    await expect(createAgentLifecycle(db).requestHire(companyId, { name: "Bypass", lifecycleParticipants: [] } as never)).rejects.toThrow("Lifecycle fields");
  });

  it("clears a rejected hire from the user's primary selection", async () => {
    const agent = await createAgentLifecycle(db).requestHire(companyId, { name: "Proposed", status: "pending_approval" }, { createdByUserId: "board" });
    const preference = () => db.select().from(userCompanyPreferences).where(eq(userCompanyPreferences.companyId, companyId));
    expect((await preference())[0]!.primaryAgentId).toBe(agent.id);
    const approval = await approvalService(db).create(companyId, { type: "hire_agent", payload: { agentId: agent.id }, status: "pending" });
    await approvalService(db).reject(approval.id, "board");
    expect((await preference())[0]!.primaryAgentId).toBeNull();
    expect((await current(agent.id)).lifecycleState).toBe("rejected");
  });

  it("rolls back configuration and its revision when the requested transition fails", async () => {
    const lifecycle = createAgentLifecycle(db);
    const agent = await hire("terminated");
    await expect(lifecycle.updateAndTransition(agent.id, "resume", { name: "Must not persist" },
      { recordRevision: { createdByUserId: "board", source: "patch" } })).rejects.toThrow("Cannot resume");
    expect((await current(agent.id)).name).toBe("Agent");
    expect(await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, agent.id))).toEqual([]);
    const active = await hire();
    expect(await lifecycle.updateAndTransition(active.id, "pause", { name: "Paused agent" })).toMatchObject({ name: "Paused agent", lifecycleState: "pausing" });
  });

  it("limits invocation policy checks to the requested agent", async () => {
    const one = await hire();
    const two = await createAgentLifecycle(db).requestHire(companyId, { name: "Another agent" });
    await db.update(companies).set({ status: "paused" }).where(eq(companies.id, companyId));
    await budgetService(db).getInvocationBlock(companyId, one.id);
    expect((await current(one.id)).lifecycleHolds).toContain("company_paused");
    expect((await current(two.id)).lifecycleHolds).toEqual([]);
  });

  it("keeps a manual hold when company policy changes", async () => {
    const work = worker(); const lifecycle = createAgentLifecycle(db); const agent = await hire(); await work.process(agent.id);
    await lifecycle.pauseAgent(agent.id); await work.process(agent.id);
    await db.update(companies).set({ status: "archived" }).where(eq(companies.id, companyId));
    await reconcileAgentPolicyHolds(db, companyId); await work.process(agent.id);
    await db.update(companies).set({ status: "active" }).where(eq(companies.id, companyId));
    await reconcileAgentPolicyHolds(db, companyId); await work.process(agent.id);
    expect(await current(agent.id)).toMatchObject({ lifecycleState: "paused", lifecycleHolds: ["manual"] });
    await lifecycle.resumeAgent(agent.id); await work.process(agent.id);
    expect((await current(agent.id)).lifecycleState).toBe("ready");
  });

  it("defers automatic policy changes while a task holds the agent lock", async () => {
    const agent = await hire("paused");
    await db.transaction(async tx => {
      await tx.select().from(agents).where(eq(agents.id, agent.id)).for("update");
      expect(await createLifecycleStore(db).change(agent.id, "reconcile")).toBeNull();
    });
    expect(await createLifecycleStore(db).change(agent.id, "reconcile")).not.toBeNull();
  });

  it("retains the failed phase and the same operation for retry", async () => {
    let fail = true;
    const work = worker(async agent => { if (agent.lifecycleState === "verifying" && fail) throw new Error("private detail"); return "complete"; });
    const agent = await hire(); await work.process(agent.id);
    const failed = await current(agent.id);
    expect(failed.lifecycleState).toBe("verifying");
    expect(failed.lifecycleError).not.toContain("private detail");
    fail = false;
    await createAgentLifecycle(db).retry(agent.id); await work.process(agent.id);
    expect((await current(agent.id)).lifecycleState).toBe("ready");
  });

  it("fences a late completion when termination replaces preparation", async () => {
    const agent = await hire("paused");
    const store = createLifecycleStore(db);
    await createAgentLifecycle(db).resumeAgent(agent.id);
    const claimed = await store.claim(agent.id, "old", new Date());
    expect(claimed).not.toBeNull();
    await store.setParticipants(claimed!, "old", ["host"]);
    await createAgentLifecycle(db).terminateAgent(agent.id);
    expect(await store.recordResult(claimed!, "old", "host", null, new Date())).toBe(false);
    expect(await store.change(agent.id, "complete", { owner: "old", version: claimed!.lifecycleVersion })).toBeNull();
    expect((await current(agent.id)).lifecycleState).toBe("terminating");
  });

  it("revokes keys at termination and waits for cleanup before deletion", async () => {
    let pending = true;
    const phases: string[] = [];
    const work = worker(async agent => { phases.push(agent.lifecycleState); return agent.lifecycleState === "cleaning_up" && pending ? "pending" : "complete"; });
    const lifecycle = createAgentLifecycle(db); const agent = await hire(); await work.process(agent.id);
    await db.insert(agentApiKeys).values({ agentId: agent.id, companyId, name: "Test", keyHash: randomUUID() });
    await lifecycle.terminateAgent(agent.id); await work.process(agent.id);
    expect((await current(agent.id)).lifecycleState).toBe("cleaning_up");
    expect((await db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, agent.id)))[0].revokedAt).not.toBeNull();
    await expect(lifecycle.purgeAgent(agent.id)).rejects.toThrow("Complete termination");
    pending = false; await lifecycle.retry(agent.id); await work.process(agent.id);
    expect(phases).toContain("terminating");
    expect((await current(agent.id)).lifecycleState).toBe("terminated");
    await lifecycle.purgeAgent(agent.id);
    expect(await current(agent.id)).toBeUndefined();
  });

  it("retains participants and checks the operation and company on each reply", async () => {
    const agent = await hire("paused");
    const pluginId = randomUUID();
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "lifecycle-test", version: "1.0.0", status: "ready",
      manifestJson: { agentLifecycle: true, capabilities: ["agents.lifecycle.manage"] } as never });
    const call = vi.fn(async (_id, _method, input) => ({ operationId: input.operationId, version: input.version, status: "complete" }));
    const driver = createLifecycleDriver(db, { call } as never);
    const snapshot = (await createLifecycleStore(db).get(agent.id))!;
    expect(await driver.participants(snapshot)).toContain(pluginId);
    await db.insert(pluginCompanySettings).values({ companyId, pluginId, enabled: false });
    expect(await driver.participants(snapshot)).not.toContain(pluginId);
    expect(await driver.participants({ ...snapshot, lifecycleParticipants: [pluginId] })).toContain(pluginId);
    await expect(driver.run(snapshot, pluginId)).rejects.toThrow("unavailable");
    await db.update(pluginCompanySettings).set({ enabled: true }).where(eq(pluginCompanySettings.pluginId, pluginId));
    expect(await driver.run(snapshot, pluginId)).toBe("complete");
    expect(call).toHaveBeenCalledWith(pluginId, "agentLifecycle", { companyId, agentId: agent.id,
      operationId: snapshot.lifecycleOperation!.id, version: snapshot.lifecycleVersion, phase: "paused" }, 30_000);
    call.mockResolvedValueOnce({ operationId: "stale", version: snapshot.lifecycleVersion, status: "complete" });
    await expect(driver.run(snapshot, pluginId)).rejects.toThrow("Invalid lifecycle result");
  });

  it("fences verification when the saved configuration changes", async () => {
    const lifecycle = createAgentLifecycle(db); const store = createLifecycleStore(db);
    const agent = await hire();
    const claimed = (await store.claim(agent.id, "configuration-test", new Date()))!;
    await store.setParticipants(claimed, "configuration-test", ["host"]);
    await agentConfiguration(db).update(agent.id, { adapterConfig: { command: "echo" } });
    expect(await store.recordResult(claimed, "configuration-test", "host", null, new Date())).toBe(false);
    expect((await lifecycle.get(agent.id))!.lifecycleVersion).toBeGreaterThan(claimed.lifecycleVersion);
  });

  it("permits a board retry and rejects an agent or a different company", async () => {
    const agent = await hire();
    function app(actor: Express.Request["actor"]) {
      const app = express(); app.use(express.json());
      app.use((req, _res, next) => { req.actor = actor; next(); });
      app.use("/api", agentRoutes(db)); app.use(errorHandler); return app;
    }
    const board: Express.Request["actor"] = { type: "board", source: "session", userId: "board", companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }] };
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board", membershipRole: "admin" });
    await db.insert(principalPermissionGrants).values(["agents:create", "agents:configure"].map(permissionKey => ({ companyId, principalType: "user", principalId: "board", permissionKey })));
    const url = `/api/agents/${agent.id}/lifecycle/retry`;
    const response = await request(app(board)).post(url).send({});
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.lifecycleState).toBe("preparing");
    expect(response.body).not.toHaveProperty("lifecycleOperation");
    expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, agent.id), eq(activityLog.action, "agent.lifecycle_retried"))))
      .toEqual([expect.objectContaining({ actorType: "user", actorId: "board" })]);
    await request(app({ type: "agent", source: "agent_key", companyId, agentId: agent.id })).post(url).send({}).expect(403);
    const denied = await request(app({ ...board, companyIds: [], memberships: [] })).post(url).send({});
    expect([403, 404]).toContain(denied.status);
  });

  it("recovers an expired lease and never accepts an expired completion", async () => {
    const agent = await hire("paused"); const store = createLifecycleStore(db);
    await createAgentLifecycle(db).resumeAgent(agent.id);
    const claim = await store.claim(agent.id, "first", new Date(Date.now() - 180_000));
    expect(claim).not.toBeNull();
    await store.setParticipants(claim!, "first", ["host"]);
    await store.recordResult(claim!, "first", "host", null, new Date());
    expect(await store.change(agent.id, "complete", { owner: "first", version: claim!.lifecycleVersion })).toBeNull();
    expect(await store.claim(agent.id, "second", new Date())).not.toBeNull();
  });
});

describe("lifecycle transition rules", () => {
  it("does not bypass authorization, verification, or cleanup", () => {
    expect(() => transition("pending_approval", "resume")).toThrow();
    expect(transition("preparing", "complete")).toBe("verifying");
    expect(transition("terminating", "complete")).toBe("cleaning_up");
    expect(transition("cleaning_up", "complete")).toBe("terminated");
    expect(() => transition("terminated", "resume")).toThrow();
    expect(transition("terminating", "terminate")).toBe("terminating");
  });
});
