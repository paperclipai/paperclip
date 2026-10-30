import { subscribeDatabaseWork } from "@paperclipai/db";
import { DELIVERY_QUEUES } from "../../../services/delivery-work-notifications.js";
import { resolveExternalTestDatabaseUrl } from "../../../__tests__/helpers/external-test-database.js";
import { createAgentLifecycle as createLifecycleCommands } from "../index.js";
import { createAgentLifecycleEffects } from "../../../services/agent-lifecycle.js";
import { deleteCompany } from "../../../services/company-deletion.js";
import { agentLifecycleCompanyDeletion } from "../company-deletion.js";
import { requireServerAdapter } from "../../../adapters/index.js";
import { agentExecutionsHaveStopped } from "../../../services/agent-execution-stop.js";
import { remoteTerminationReceipt } from "../../../services/remote-execution-termination.js";
import { approvalService } from "../../../services/approvals.js";
import { updateAgentConfigurationInTransaction } from "../../../services/agent-configuration-transaction.js";
import { agentService as agentConfiguration } from "../../../services/agents.js";
import { readFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import { agentRoutes } from "../../../routes/agents.js";
import { errorHandler } from "../../../middleware/error-handler.js";
import { createLifecycleDriver } from "../../../services/agent-lifecycle-driver.js";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { agents, approvals, projects, issues, heartbeatRuns, nativeRunFinalizations, budgetPolicies, environmentLeases, environments, agentApiKeys, activityLog, agentConfigRevisions, userCompanyPreferences, companies, companyMemberships, principalPermissionGrants, plugins, pluginCompanySettings, applyPendingMigrations, closeRegisteredClients, createDb, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { createAgentLifecycle, configureAgentLifecycle, startAgentLifecycle } from "../../../services/agent-lifecycle.js";
import { projectCompanyHolds } from "../adapters/company-policy.js";
import { createLifecycleStore as createStore } from "../adapters/postgres.js";
import { transition } from "../domain/policy.js";
import type { LifecycleAgent } from "../application/ports.js";
import { budgetService } from "../../../services/budgets.js";
import { agentConfigurationRevision } from "../../../lib/agent-configuration-revision.js";

const createLifecycleStore = (db: Db) => createStore(db, createAgentLifecycleEffects());

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_AGENT_LIFECYCLE_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("agent lifecycle commands", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  let companyId: string;
  const workers: ReturnType<typeof configureAgentLifecycle>[] = [];
  beforeAll(async () => {
    if (external) { await applyPendingMigrations(external); db = createDb(external); }
    else { database = await startEmbeddedPostgresTestDatabase("paperclip-agent-lifecycle-"); db = createDb(database.connectionString); }
  }, 90_000);
  afterAll(async () => {
    for (const worker of workers) await worker.stop();
    if (external) await closeRegisteredClients(external);
    else await database?.cleanup();
  });
  beforeEach(async () => {
    for (const work of workers) await work.stop();
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Lifecycle test", issuePrefix: `L${companyId.slice(0, 7)}` });
  });
  function worker(runHost: (agent: LifecycleAgent) => Promise<"complete" | "pending"> = async () => "complete") {
    const value = configureAgentLifecycle(db, { requiredPluginIds: async () => [], runPlugin: async () => "complete", runHost });
    workers.push(value); return value;
  }
  async function hire(status = "idle") { return createAgentLifecycle(db).requestHire(companyId, { name: "Agent", status, adapterType: "process" }); }
  async function current(id: string) { return (await db.select().from(agents).where(eq(agents.id, id)))[0]!; }

  it.each((["codex", "claude"] as const).flatMap(provider => ["direct", "setup", "approval"].map(path => [provider, path] as const)))("defaults a newly hired %s agent on a warm task environment to warm execution through %s", async (provider, path) => {
    const pluginId = randomUUID(), environmentId = randomUUID();
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "warm-hire-fixture", version: "1.0.0", status: "ready",
      manifestJson: { capabilities: ["environment.drivers.register"], environmentDrivers: [{ driverKey: "tasks", supportsTasks: true, warmTaskVersion: 1 }] } as never });
    await db.insert(environments).values({ id: environmentId, name: `Warm computer ${environmentId}`, driver: "plugin",
      config: { pluginKey: pluginId, driverKey: "tasks", driverConfig: {} } });
    const adapterConfig = provider === "claude" ? { provider: "acpx", acpxAgent: "claude", model: "claude-sonnet-4-6", lifecycleMode: "per_turn" }
      : { provider: "codex", model: "gpt-5.6-luna", lifecycleMode: "per_turn" };
    const lifecycle = createAgentLifecycle(db);
    const input = { name: "Warm hire", adapterType: "paperclip_runner", adapterConfig, defaultEnvironmentId: environmentId };
    const draft = path === "setup" ? await lifecycle.requestHire(companyId, input, { setupOnly: true }) : null;
    const hired = await lifecycle.requestHire(companyId, { ...input, ...(path === "approval" ? { status: "pending_approval" } : {}) }, draft ? { setupAgentId: draft.id } : undefined);
    if (path === "approval") await lifecycle.approveHire(hired.id, "board");
    expect((await current(hired.id)).adapterConfig).toMatchObject({ ...adapterConfig, lifecycleMode: "warm" });
    await createAgentLifecycle(db).updateConfiguration(hired.id, { adapterConfig: { ...(await current(hired.id)).adapterConfig, lifecycleMode: "per_turn" } });
    expect((await current(hired.id)).adapterConfig.lifecycleMode).toBe("per_turn");
  });

  it("rejects an outdated configuration snapshot under the write lock", async () => {
    const agent = await hire();
    const snapshot = await current(agent.id);
    const expectedConfiguration = { adapterType: snapshot.adapterType, adapterConfig: snapshot.adapterConfig, runtimeConfig: snapshot.runtimeConfig, defaultEnvironmentId: snapshot.defaultEnvironmentId };
    await createAgentLifecycle(db).updateConfiguration(agent.id, { runtimeConfig: { heartbeat: { intervalSec: 42 } } });
    await expect(createAgentLifecycle(db).updateConfiguration(agent.id, { runtimeConfig: { aiConnection: {} } }, { expectedConfiguration })).rejects.toThrow("configuration changed while saving");
    expect((await current(agent.id)).runtimeConfig).toEqual({ heartbeat: { intervalSec: 42 } });
  });

  it("fences YAML saves under the write lock without treating runtime bookkeeping as an edit", async () => {
    const agent = await hire();
    const revision = agentConfigurationRevision(await current(agent.id));
    await db.update(agents).set({ lastHeartbeatAt: new Date(), updatedAt: new Date() }).where(eq(agents.id, agent.id));
    await createAgentLifecycle(db).updateConfiguration(agent.id, { title: "New title" }, { expectedConfigurationRevision: revision });
    await expect(createAgentLifecycle(db).updateConfiguration(agent.id, { name: "Stale overwrite" }, { expectedConfigurationRevision: revision }))
      .rejects.toThrow("configuration changed while you were editing");
    expect(await current(agent.id)).toMatchObject({ name: agent.name, title: "New title" });
  });

  it("saves YAML configuration through the normal route with redaction, revisions, and access checks", async () => {
    const [agent] = await db.insert(agents).values({ companyId, name: "YAML test", adapterType: "process",
      adapterConfig: { command: "echo", removeMe: true, env: { DEMO_VALUE: "private-fixture" }, apiKey: "private-api-fixture" },
      runtimeConfig: { heartbeat: { enabled: false } }, metadata: { token: "private-metadata-fixture" },
    }).returning();
    function app(actor: Express.Request["actor"]) {
      const app = express(); app.use(express.json());
      app.use((req, _res, next) => { req.actor = actor; next(); });
      app.use("/api", agentRoutes(db)); app.use(errorHandler); return app;
    }
    const board = app({ type: "board", source: "local_implicit", userId: "board", companyIds: [companyId] });
    const response = await request(board).get(`/api/agents/${agent.id}/configuration`).expect(200);
    expect(response.body).toMatchObject({ capabilities: null, budgetMonthlyCents: 0, defaultEnvironmentId: null });
    expect(JSON.stringify(response.body)).not.toContain("private-fixture");
    expect(JSON.stringify(response.body)).not.toContain("private-api-fixture");
    expect(JSON.stringify(response.body)).not.toContain("private-metadata-fixture");
    const adapterConfig = { ...response.body.adapterConfig, command: "printf" };
    delete adapterConfig.removeMe;
    const saved = await request(board).patch(`/api/agents/${agent.id}`).send({
      adapterConfig, replaceAdapterConfig: true, title: "Updated using YAML",
      expectedConfigurationRevision: response.body.configurationRevision,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.configurationRevision).not.toBe(response.body.configurationRevision);
    const persisted = await current(agent.id);
    expect(persisted.adapterConfig).toMatchObject({ command: "printf", env: { DEMO_VALUE: { type: "plain", value: "private-fixture" } }, apiKey: "private-api-fixture" });
    expect(persisted.adapterConfig).not.toHaveProperty("removeMe");
    expect(persisted.runtimeConfig).toEqual(agent.runtimeConfig);
    expect(persisted.metadata).toEqual(agent.metadata);
    expect(await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, agent.id))).toHaveLength(1);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, agent.id), eq(activityLog.action, "agent.updated")))).toHaveLength(1);
    await request(board).patch(`/api/agents/${agent.id}`).send({ name: "Stale", expectedConfigurationRevision: response.body.configurationRevision }).expect(409);
    const foreign = app({ type: "board", source: "session", userId: "outsider", companyIds: [], memberships: [] });
    await request(foreign).get(`/api/agents/${agent.id}/configuration`).expect(403);
    await request(foreign).patch(`/api/agents/${agent.id}`).send({ title: "Denied", expectedConfigurationRevision: saved.body.configurationRevision }).expect(404);
  });

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
      expect(mapped.lifecycleRequiredPluginIds).toBeNull();
      expect(mapped.lifecycleHolds).toEqual(row.status === "paused" ? ["budget"] : []);
    }
  });

  it("records the human creator from options and ignores a creator in the insert data", async () => {
    const lifecycle = createAgentLifecycle(db);
    const created = await lifecycle.requestHire(companyId, { name: "Created by member", createdByUserId: "spoofed-user" }, { createdByUserId: "member-1" });
    expect(created.createdByUserId).toBe("member-1");
    expect((await current(created.id)).createdByUserId).toBe("member-1");
    const system = await lifecycle.requestHire(companyId, { name: "System hire", createdByUserId: "spoofed-user" });
    expect((await current(system.id)).createdByUserId).toBeNull();
  });

  it("backfills the creator from the earliest user creation activity in the same company", async () => {
    const [byUser, byAgent, foreign] = await db.insert(agents).values(["By user", "By agent", "Foreign log"].map(name => ({ companyId, name }))).returning();
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Other", issuePrefix: `O${otherCompanyId.slice(0, 7)}` });
    await db.insert(activityLog).values([
      { companyId, actorType: "user", actorId: "first-user", action: "agent.hire_created", entityType: "agent", entityId: byUser.id, createdAt: new Date("2026-01-01T00:00:00Z") },
      { companyId, actorType: "user", actorId: "later-user", action: "agent.created", entityType: "agent", entityId: byUser.id, createdAt: new Date("2026-01-02T00:00:00Z") },
      { companyId, actorType: "agent", actorId: randomUUID(), action: "agent.hire_created", entityType: "agent", entityId: byAgent.id },
      { companyId: otherCompanyId, actorType: "user", actorId: "foreign-user", action: "agent.created", entityType: "agent", entityId: foreign.id },
    ]);
    const migration = readFileSync(new URL("../../../../../packages/db/src/migrations/0343_new_mentor.sql", import.meta.url), "utf8");
    for (let pass = 0; pass < 2; pass++) {
      for (const statement of migration.split("--> statement-breakpoint")) {
        await db.execute(sql.raw(statement));
      }
    }
    expect((await current(byUser.id)).createdByUserId).toBe("first-user");
    expect((await current(byAgent.id)).createdByUserId).toBeNull();
    expect((await current(foreign.id)).createdByUserId).toBeNull();
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




  it("freezes the final setup configuration for hire approval", async () => {
    const lifecycle = createAgentLifecycle(db);
    const id = randomUUID();
    await lifecycle.requestHire(companyId, { id, name: "Approval setup", status: "paused", pauseReason: "setup", adapterType: "process" }, { setupOnly: true });
    await lifecycle.requestHire(companyId, { id, name: "Approval setup", status: "pending_approval", adapterType: "process", adapterConfig: { command: "verified-command" } }, { setupAgentId: id });
    expect(await current(id)).toMatchObject({ lifecycleState: "pending_approval", lifecycleHolds: [], adapterConfig: { command: "verified-command" } });
    await expect(lifecycle.updateConfiguration(id, { adapterConfig: { command: "changed" } })).rejects.toThrow("cannot be changed before board approval");
  });

  it("rejects completing a foreign setup or adopting an ordinary paused agent", async () => {
    const lifecycle = createAgentLifecycle(db);
    const setup = await lifecycle.requestHire(companyId, { name: "Scoped setup", status: "paused", pauseReason: "setup" }, { setupOnly: true });
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Other", issuePrefix: `S${otherCompanyId.slice(0, 7)}` });
    await expect(lifecycle.requestHire(otherCompanyId, { name: "Foreign" }, { setupAgentId: setup.id })).rejects.toThrow("no longer available");
    const paused = await hire("paused");
    await expect(lifecycle.requestHire(companyId, { name: "Paused" }, { setupAgentId: paused.id })).rejects.toThrow("no longer available");
    expect((await current(setup.id)).lifecycleHolds).toEqual(["setup"]);
  });


  it("creates a board-owned setup before requesting approval for its final configuration", async () => {
    await db.update(companies).set({ requireBoardApprovalForNewAgents: true }).where(eq(companies.id, companyId));
    await db.insert(companyMemberships).values(["board", "other-creator"].map(principalId => ({ companyId, principalType: "user", principalId, membershipRole: "member" })));
    await db.insert(principalPermissionGrants).values(["board", "other-creator"].map(principalId => ({ companyId, principalType: "user", principalId, permissionKey: "agents:create" })));
    function app(actor: Express.Request["actor"]) {
      const value = express(); value.use(express.json());
      value.use((req, _res, next) => { req.actor = actor; next(); });
      value.use("/api", agentRoutes(db)); value.use(errorHandler); return value;
    }
    const board: Express.Request["actor"] = { type: "board", source: "session", userId: "board", companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "member", status: "active" }] };
    const setupId = randomUUID();
    const body = { setupId, name: "Wizard agent", adapterType: "process" };
    const url = `/api/companies/${companyId}/agents`;
    const attempts = await Promise.all(Array.from({ length: 4 }, () => request(app(board)).post(url).send(body)));
    for (const attempt of attempts) {
      expect(attempt.status, JSON.stringify(attempt.body)).toBe(201);
      expect(attempt.body).toMatchObject({ id: setupId, pauseReason: "setup", lifecycleState: "paused" });
    }
    expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(1);
    expect(await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "agent")))).toHaveLength(0);
    await request(app({ ...board, userId: "other-creator" })).post(url).send(body).expect(404);
    const other = await createAgentLifecycle(db).requestHire(companyId, {
      name: "Other creator", adapterType: "process", status: "paused", adapterConfig: { command: "private-command" },
      runtimeConfig: { privateSetting: "private-value" },
    }, { createdByUserId: "other-creator" });
    const configProbe = await request(app(board)).post(url).send({ ...body, setupId: other.id });
    expect(configProbe.status).toBe(404);
    expect(configProbe.body).not.toHaveProperty("adapterConfig");
    expect(configProbe.body).not.toHaveProperty("runtimeConfig");
    expect(await db.select().from(approvals).where(eq(approvals.companyId, companyId))).toHaveLength(0);
    const saved = await request(app(board)).patch(`/api/agents/${setupId}`).send({ adapterConfig: { command: "draft-command", env: { SETUP_LABEL: { type: "plain", value: "saved-value" } } } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const probe = vi.spyOn(requireServerAdapter("process"), "testEnvironment").mockResolvedValue({ adapterType: "process", status: "pass", checks: [], testedAt: new Date().toISOString() });
    try {
      const probeBody = { agentId: setupId, adapterConfig: saved.body.adapterConfig };
      const testUrl = `/api/companies/${companyId}/adapters/process/test-environment`;
      const tested = await request(app(board)).post(testUrl).send(probeBody);
      expect(tested.status, JSON.stringify(tested.body)).toBe(200);
      expect(probe).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ env: { SETUP_LABEL: "saved-value" } }) }));
      await request(app({ ...board, userId: "other-creator" })).post(testUrl).send(probeBody).expect(403);
      expect(probe).toHaveBeenCalledTimes(1);
    } finally { probe.mockRestore(); }
    await request(app({ ...board, userId: "other-creator" })).patch(`/api/agents/${setupId}`).send({ adapterConfig: { command: "foreign-command" } }).expect(403);
    const denied = await request(app({ ...board, companyIds: [], memberships: [] })).post(url).send({ ...body, setupId: randomUUID() });
    expect([403, 404]).toContain(denied.status);
    await request(app({ type: "agent", source: "agent_key", companyId, agentId: setupId })).post(url).send({ ...body, setupId: randomUUID() }).expect(403);
    const finished = await request(app(board)).post(`/api/companies/${companyId}/agent-hires`).send({
      setupAgentId: setupId, name: "Wizard agent", adapterType: "process", adapterConfig: { command: "verified-command", env: { SETUP_LABEL: { type: "plain", value: "***REDACTED***" } } },
    });
    expect(finished.status, JSON.stringify(finished.body)).toBe(201);
    expect(finished.body.agent).toMatchObject({ id: setupId, name: "Wizard agent", lifecycleState: "pending_approval" });
    expect(finished.body.approval.payload).toMatchObject({ agentId: setupId, adapterConfig: { command: "verified-command" } });
    expect((await current(setupId)).adapterConfig.env).toEqual({ SETUP_LABEL: { type: "plain", value: "saved-value" } });
    expect(await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, setupId)))).toHaveLength(1);
    const finishBody = { setupAgentId: setupId, name: "Changed on retry", adapterType: "process", adapterConfig: { command: "unapproved-command" } };
    const hireUrl = `/api/companies/${companyId}/agent-hires`;
    const retries = await Promise.all(Array.from({ length: 3 }, () => request(app(board)).post(hireUrl).send(finishBody)));
    for (const retry of retries) {
      expect(retry.status, JSON.stringify(retry.body)).toBe(200);
      expect(retry.body.agent).toMatchObject({ id: setupId, name: "Wizard agent", adapterConfig: { command: "verified-command" } });
      expect(retry.body.approval.id).toBe(finished.body.approval.id);
    }
    await request(app({ ...board, userId: "other-creator" })).post(hireUrl).send(finishBody).expect(403);
    const reopened = await request(app(board)).post(url).send(body);
    expect(reopened.status).toBe(201);
    expect(reopened.body).toMatchObject({ id: setupId, status: "pending_approval" });
    await request(app({ ...board, userId: "other-creator" })).post(url).send(body).expect(404);
    await db.delete(approvals).where(eq(approvals.id, finished.body.approval.id));
    const recovered = await request(app(board)).post(hireUrl).send(finishBody);
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
    expect(recovered.body.approval.payload).toMatchObject({ name: "Wizard agent", adapterConfig: { command: "verified-command" } });
    await approvalService(db).approve(recovered.body.approval.id, "board");
    const approvedRetry = await request(app(board)).post(hireUrl).send(finishBody);
    expect(approvedRetry.status).toBe(200);
    expect(approvedRetry.body.approval.status).toBe("approved");
    expect(await db.select().from(approvals).where(eq(approvals.companyId, companyId))).toHaveLength(1);
  });

  it("restores hidden setup values when a native Codex record uses the Codex onboarding choice", async () => {
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board", membershipRole: "owner" });
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: "board", companyIds: [companyId] }; next(); });
    app.use("/api", agentRoutes(db)); app.use(errorHandler);
    const setupId = randomUUID();
    const created = await request(app).post(`/api/companies/${companyId}/agents`).send({ setupId, name: "Native saved setup",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex", env: { SETUP_LABEL: { type: "plain", value: "saved-native-value" } } },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.adapterConfig.env.SETUP_LABEL).toEqual({ type: "plain", value: "***REDACTED***" });
    const probe = vi.spyOn(requireServerAdapter("paperclip_runner"), "testEnvironment").mockResolvedValue({ adapterType: "paperclip_runner", status: "pass", checks: [], testedAt: new Date().toISOString() });
    try {
      const tested = await request(app).post(`/api/companies/${companyId}/adapters/codex_local/test-environment`).send({
        agentId: setupId, runner: "paperclip", adapterConfig: created.body.adapterConfig,
      });
      expect(tested.status, JSON.stringify(tested.body)).toBe(200);
      expect(probe).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ env: { SETUP_LABEL: "saved-native-value" } }) }));
    } finally { probe.mockRestore(); }
    const finished = await request(app).post(`/api/companies/${companyId}/agent-hires`).send({ setupAgentId: setupId, name: "Native saved setup",
      adapterType: "codex_local", runner: "paperclip", adapterConfig: created.body.adapterConfig,
    });
    expect(finished.status, JSON.stringify(finished.body)).toBe(201);
    expect((await current(setupId)).adapterConfig.env).toEqual({ SETUP_LABEL: { type: "plain", value: "saved-native-value" } });
  });

  it("holds an incomplete Copilot setup but still requires a model at final hire", async () => {
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board", membershipRole: "owner" });
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: "board", companyIds: [companyId] }; next(); });
    app.use("/api", agentRoutes(db)); app.use(errorHandler);
    const setupId = randomUUID();
    const body = { name: "Copilot setup", adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "copilot" } };
    const created = await request(app).post(`/api/companies/${companyId}/agents`).send({ ...body, setupId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ id: setupId, pauseReason: "setup", lifecycleState: "paused" });
    const finished = await request(app).post(`/api/companies/${companyId}/agent-hires`).send({ ...body, setupAgentId: setupId });
    expect(finished.status, JSON.stringify(finished.body)).toBe(422);
    expect(finished.body.details?.code ?? finished.body.code).toBe("paperclip_runner_acpx_model_required");
    expect((await current(setupId)).lifecycleHolds).toContain("setup");
    await request(app).post(`/api/companies/${companyId}/agents`).send(body).expect(422);
  });

  it("lets a held name-only record choose Copilot before connecting an account", async () => {
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board", membershipRole: "owner" });
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: "board", companyIds: [companyId] }; next(); });
    app.use("/api", agentRoutes(db)); app.use(errorHandler);
    const setupId = randomUUID();
    await request(app).post(`/api/companies/${companyId}/agents`).send({ setupId, name: "Name-only Copilot", adapterType: "process", metadata: { setupAdapterPending: true } }).expect(201);
    const config = { provider: "acpx", acpxAgent: "copilot" };
    const saved = await request(app).patch(`/api/agents/${setupId}`).send({ adapterType: "paperclip_runner", adapterConfig: config, metadata: { setupAdapterPending: false } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ id: setupId, pauseReason: "setup", adapterConfig: config });
    expect(saved.body.runtimeConfig.aiConnection).toBeUndefined();
    const finished = await request(app).post(`/api/companies/${companyId}/agent-hires`).send({ setupAgentId: setupId, name: "Name-only Copilot", adapterType: "paperclip_runner", adapterConfig: { ...config, model: "gpt-5.6-luna" } });
    expect(finished.status, JSON.stringify(finished.body)).toBe(422);
    expect(finished.body.error).toMatch(/connection|account/i);
    expect((await current(setupId)).lifecycleHolds).toContain("setup");
  });

  it("rolls back a hire and its grants when hire initialization fails", async () => {
    const effects = createAgentLifecycleEffects();
    const lifecycle = createLifecycleCommands(db, { ...effects,
      initializeHire: async (tx, agent, options) => {
        await effects.initializeHire(tx, agent, options);
        throw new Error("Hire initialization failed");
      },
    });
    await expect(lifecycle.requestHire(companyId, { name: "Rollback hire", adapterType: "process" }))
      .rejects.toThrow("Hire initialization failed");
    expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(0);
    expect(await db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, companyId))).toHaveLength(0);
  });

  it("runs the saved harness test and keeps a failed configuration out of ready", async () => {
    const driver = createLifecycleDriver(db, {} as never);
    const work = worker(driver.runHost);
    const agent = await hire();
    await work.process(agent.id);
    expect(await current(agent.id)).toMatchObject({ lifecycleState: "verifying", status: "paused" });
    await agentConfiguration(db).update(agent.id, { adapterConfig: { command: process.execPath } });
    await work.process(agent.id);
    expect(await current(agent.id)).toMatchObject({ lifecycleState: "ready", status: "idle", lifecycleError: null });
  });

  it.each(["claude_local", "gemini_local"])("keeps %s authentication warnings out of ready", async adapterType => {
    const adapter = requireServerAdapter(adapterType);
    const probe = vi.spyOn(adapter, "testEnvironment").mockResolvedValue({ adapterType, status: "warn",
      testedAt: new Date().toISOString(), checks: [{ code: `${adapterType.split("_")[0]}_hello_probe_auth_required`, level: "warn", message: "Login required" }] });
    try {
      const agent = await createAgentLifecycle(db).requestHire(companyId, { name: "Login test", adapterType, runner: "legacy" });
      const work = worker(createLifecycleDriver(db, {} as never).runHost);
      await work.process(agent.id);
      expect(probe).toHaveBeenCalled();
      expect(await current(agent.id)).toMatchObject({ lifecycleState: "verifying", lifecycleError: expect.stringContaining("Execution configuration check failed. Authentication failed.") });
    } finally { probe.mockRestore(); }
  });

  it("recovers an expired native owner only after the cancelled run and controller stop", async () => {
    const agent = await hire();
    const [issue] = await db.insert(issues).values({ companyId, title: "Cancelled native run" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, nativeIssueId: issue.id,
      status: "cancelled", invocationSource: "on_demand", runtimeMode: "native",
      startedAt: new Date(), finishedAt: new Date(), processPid: process.pid }).returning();
    await db.insert(nativeRunFinalizations).values({ companyId, issueId: issue.id, runId: run.id,
      phase: "executing", leaseOwner: "stopped-server", leaseExpiresAt: new Date(0), controllerPid: process.pid });
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(false);
    await db.update(nativeRunFinalizations).set({ controllerPid: null }).where(eq(nativeRunFinalizations.runId, run.id));
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(false);
    await db.update(heartbeatRuns).set({ processPid: 2_000_000_000 }).where(eq(heartbeatRuns.id, run.id));
    await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, run.id));
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(false);
    await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, run.id));
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(true);
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, run.id)))[0]).toMatchObject({ leaseOwner: null, leaseExpiresAt: null });
  });

  it("releases an expired native owner whose stored expiry carries sub-millisecond precision", async () => {
    const agent = await hire();
    const [issue] = await db.insert(issues).values({ companyId, title: "Cancelled native run" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, nativeIssueId: issue.id,
      status: "cancelled", invocationSource: "on_demand", runtimeMode: "native",
      startedAt: new Date(), finishedAt: new Date(), processPid: 2_000_000_000 }).returning();
    await db.insert(nativeRunFinalizations).values({ companyId, issueId: issue.id, runId: run.id,
      phase: "executing", leaseOwner: "stopped-server", leaseExpiresAt: new Date(0), controllerPid: null });
    await db.execute(sql`update native_run_finalizations
      set lease_expires_at = date_trunc('milliseconds', now() - interval '1 hour') + interval '456 microseconds'
      where run_id = ${run.id}`);
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(true);
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, run.id)))[0]).toMatchObject({ leaseOwner: null, leaseExpiresAt: null });
  });

  it("does not advance termination while a cancelled process still runs", async () => {
    const agent = await hire();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id,
      status: "cancelled", invocationSource: "on_demand", runtimeMode: "legacy",
      startedAt: new Date(), finishedAt: new Date(), processPid: process.pid }).returning();
    const driver = createLifecycleDriver(db, {} as never);
    const work = worker(driver.runHost);
    await createAgentLifecycle(db).terminateAgent(agent.id);
    await work.process(agent.id);
    expect((await current(agent.id)).lifecycleState).toBe("terminating");
    await db.update(heartbeatRuns).set({ processPid: null,
      resultJson: { executionCancellation: { state: "acknowledged" } } }).where(eq(heartbeatRuns.id, run.id));
    await createAgentLifecycle(db).retry(agent.id);
    await work.process(agent.id);
    expect((await current(agent.id)).lifecycleState).toBe("terminated");
  });

  it("does not cancel a reporting agent when its manager pauses", async () => {
    const parent = await hire();
    const [child] = await db.insert(agents).values({ companyId, name: "Report", reportsTo: parent.id,
      status: "idle", lifecycleState: "ready" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: child.id,
      status: "queued", invocationSource: "on_demand" }).returning();
    const work = worker(createLifecycleDriver(db, {} as never).runHost);
    await createAgentLifecycle(db).pauseAgent(parent.id);
    await work.process(parent.id);
    expect((await current(parent.id)).lifecycleState).toBe("paused");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]!.status).toBe("queued");
  });

  it("retains company data until every agent finishes termination", async () => {
    const agent = await hire();
    const [project] = await db.insert(projects).values({ companyId, name: "Keep until cleanup", leadAgentId: agent.id }).returning();
    await db.insert(issues).values({ companyId, projectId: project.id, title: "Keep this task", assigneeAgentId: agent.id });
    const pending = worker(async () => "pending");
    await expect(deleteCompany(db, companyId)).rejects.toThrow("Complete termination");
    expect(await db.select().from(projects).where(eq(projects.id, project.id))).toHaveLength(1);
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(1);
    await pending.stop();
    const complete = worker();
    await createAgentLifecycle(db).retry(agent.id);
    await complete.process(agent.id);
    await deleteCompany(db, companyId);
    expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(0);
    expect(await db.select().from(companies).where(eq(companies.id, companyId))).toHaveLength(0);
  });

  it("awaits only the deleted company's agents when a coordinator owns lifecycle wakeups", async () => {
    const agent = await hire();
    const [otherCompany] = await db.insert(companies).values({ name: "Unaffected", issuePrefix: `U${companyId.slice(0, 7)}` }).returning();
    const [otherAgent] = await db.insert(agents).values({ companyId: otherCompany.id, name: "Pending elsewhere",
      lifecycleState: "preparing", lifecycleOperation: { id: randomUUID(), hostComplete: false, completedPluginIds: [], attempts: 0 } }).returning();
    const phases: string[] = [];
    const work = startAgentLifecycle(db, { requiredPluginIds: async () => [], runPlugin: async () => "complete",
      runHost: async snapshot => { expect(snapshot.id).toBe(agent.id); phases.push(snapshot.lifecycleState); return "complete"; } }, () => true);
    const wake = vi.fn();
    work.setWake(wake);
    try {
      await deleteCompany(db, companyId);
      expect(phases).toEqual(["terminating", "cleaning_up"]);
      expect(wake).toHaveBeenCalled();
      expect(await db.select().from(companies).where(eq(companies.id, companyId))).toHaveLength(0);
      expect((await current(otherAgent.id)).lifecycleState).toBe("preparing");
    } finally { await work.stop(); }
  });

  it("requires a transaction for the company deletion integration", async () => {
    await expect(agentLifecycleCompanyDeletion.deleteCompanyData(db as never, companyId))
      .rejects.toThrow("Company deletion requires a database transaction");
  });

  it("rejects individual deletion before cleanup and rolls back failed cleanup", async () => {
    const agent = await hire();
    const effects = createAgentLifecycleEffects();
    const cleanup = vi.fn(effects.deleteDependencies);
    const lifecycle = createLifecycleCommands(db, { ...effects, deleteDependencies: cleanup });
    await expect(lifecycle.purgeAgent(agent.id)).rejects.toThrow("Complete termination");
    expect(cleanup).not.toHaveBeenCalled();

    await db.update(agents).set({ lifecycleState: "terminated", status: "terminated" }).where(eq(agents.id, agent.id));
    const [key] = await db.insert(agentApiKeys).values({ companyId, agentId: agent.id, name: "Keep on rollback", keyHash: randomUUID() }).returning();
    cleanup.mockImplementation(async (tx, companyId, id) => {
      await effects.deleteDependencies(tx, companyId, id);
      throw new Error("Dependency cleanup failed");
    });
    await expect(lifecycle.purgeAgent(agent.id)).rejects.toThrow("Dependency cleanup failed");
    expect(await current(agent.id)).toMatchObject({ lifecycleState: "terminated" });
    expect(await db.select().from(agentApiKeys).where(eq(agentApiKeys.id, key.id))).toHaveLength(1);
  });

  it("deletes terminated and rejected agents only in the requested company", async () => {
    await db.insert(agents).values((["terminated", "rejected"] as const).map(lifecycleState => ({
      companyId, name: lifecycleState, status: "terminated", lifecycleState,
    })));
    const [otherCompany] = await db.insert(companies).values({ name: "Keep this company", issuePrefix: `K${companyId.slice(0, 7)}` }).returning();
    const [otherAgent] = await db.insert(agents).values({ companyId: otherCompany.id, name: "Keep this agent",
      status: "terminated", lifecycleState: "terminated" }).returning();

    await deleteCompany(db, companyId);

    expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(0);
    expect(await current(otherAgent.id)).toMatchObject({ companyId: otherCompany.id });
    expect(await db.select().from(companies).where(eq(companies.id, otherCompany.id))).toHaveLength(1);
  });

  it("rolls back agent and company data deletion when a later operation fails", async () => {
    const agent = await hire("terminated");
    const [project] = await db.insert(projects).values({ companyId, name: "Keep on rollback" }).returning();
    const removeAgents = agentLifecycleCompanyDeletion.deleteCompanyData;
    const failure = vi.spyOn(agentLifecycleCompanyDeletion, "deleteCompanyData").mockImplementation(async (tx, id) => {
      await removeAgents(tx, id);
      expect(await tx.select().from(agents).where(eq(agents.companyId, id))).toHaveLength(0);
      throw new Error("Later deletion failed");
    });
    try {
      await expect(deleteCompany(db, companyId)).rejects.toThrow("Later deletion failed");
      expect(await current(agent.id)).toMatchObject({ lifecycleState: "terminated" });
      expect(await db.select().from(projects).where(eq(projects.id, project.id))).toHaveLength(1);
      expect(await db.select().from(companies).where(eq(companies.id, companyId))).toHaveLength(1);
    } finally { failure.mockRestore(); }
  });

  it("blocks a concurrent hire until company deletion commits", async () => {
    let reportLock!: (pid: number) => void;
    let rejectLock!: (error: unknown) => void;
    const locked = new Promise<number>((resolve, reject) => { reportLock = resolve; rejectLock = reject; });
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const removeAgents = agentLifecycleCompanyDeletion.deleteCompanyData;
    const pause = vi.spyOn(agentLifecycleCompanyDeletion, "deleteCompanyData").mockImplementation(async (tx, id) => {
      const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      reportLock(backend!.pid);
      await released;
      await removeAgents(tx, id);
    });
    const deletion = deleteCompany(db, companyId);
    void deletion.catch(rejectLock);
    let hiring: Promise<unknown> | undefined;
    try {
      const pid = await locked;
      hiring = hire().then(() => "created", error => error.message);
      await vi.waitFor(async () => {
        const blocked = await db.execute(sql`select 1 from pg_stat_activity
          where datname = current_database() and ${pid} = any(pg_blocking_pids(pid))`);
        expect(blocked).toHaveLength(1);
      });
      release();
      await deletion;
      expect(await hiring).toBe("Company not found");
      expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(0);
    } finally {
      release();
      await Promise.allSettled([deletion, hiring]);
      pause.mockRestore();
    }
  });

  it("requires cleanup proof after a remote run is already cancelled", async () => {
    const agent = await hire();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id,
      status: "cancelled", invocationSource: "on_demand", runtimeMode: "native",
      startedAt: new Date(), finishedAt: new Date() }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, heartbeatRunId: run.id,
      provider: "test", providerLeaseId: "test-lease", status: "pending_cleanup",
      cleanupStatus: "failed", releasedAt: new Date() }).returning();
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(false);
    await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success" })
      .where(eq(environmentLeases.id, lease.id));
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(false);
    await db.update(environmentLeases).set({ metadata: {
      remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "destroyed" }),
    } }).where(eq(environmentLeases.id, lease.id));
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(true);
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

  it.each(["approved", "rejected"] as const)("uses the same %s hire decision for an agent and its approval", async decision => {
    const agent = await hire("pending_approval");
    const approval = await approvalService(db).create(companyId, { type: "hire_agent",
      requestedByUserId: "requester", payload: { agentId: agent.id }, status: "pending" });
    const lifecycle = createAgentLifecycle(db);
    const decide = decision === "approved" ? lifecycle.approveHire : lifecycle.rejectHire;
    const first = await decide(agent.id, "board");
    expect(first).toMatchObject({ applied: true, approval: { id: approval.id, status: decision },
      agent: { lifecycleState: decision === "approved" ? "preparing" : "rejected" } });
    const version = (await current(agent.id)).lifecycleVersion;
    expect(await decide({ approvalId: approval.id }, "board")).toMatchObject({ applied: false, hireApprovedAgentId: null });
    expect((await current(agent.id)).lifecycleVersion).toBe(version);
  });

  it("rolls back the approval and agent together when activation fails", async () => {
    const agent = await hire("pending_approval");
    const approval = await approvalService(db).create(companyId, { type: "hire_agent",
      payload: { agentId: agent.id }, status: "pending" });
    const lifecycle = createLifecycleCommands(db, { ...createAgentLifecycleEffects(),
      recordCreation: async () => { throw new Error("Creation event failed"); } });
    await expect(lifecycle.approveHire(agent.id, "board")).rejects.toThrow("Creation event failed");
    expect((await current(agent.id)).lifecycleState).toBe("pending_approval");
    expect((await db.select().from(approvals).where(eq(approvals.id, approval.id)))[0].status).toBe("pending");
  });

  it("keeps the hire credential owner and recovers it for migrated approvals", async () => {
    for (const savedOwner of [null, "original-owner"]) {
      const [agent] = await db.insert(agents).values({ companyId, name: "Migrated hire", status: "pending_approval",
        lifecycleState: "pending_approval", lifecycleOperation: savedOwner ? {
          id: randomUUID(), hostComplete: false, completedPluginIds: [], attempts: 0, responsibleUserId: savedOwner,
        } : null }).returning();
      const approval = await approvalService(db).create(companyId, { type: "hire_agent",
        requestedByUserId: "requesting-member", payload: { agentId: agent.id }, status: "pending" });
      await approvalService(db).approve(approval.id, "approving-member");
      expect((await current(agent.id)).lifecycleOperation?.responsibleUserId).toBe(savedOwner ?? "requesting-member");
    }
  });

  it("settles notice reactivation only with the outer lifecycle transaction", async () => {
    const work = worker();
    const agent = await hire();
    await work.process(agent.id);
    await createAgentLifecycle(db).pauseAgent(agent.id);
    await work.process(agent.id);
    await work.stop();
    await createAgentLifecycle(db).resumeAgent(agent.id);
    const store = createLifecycleStore(db);
    const owner = "resume-notice-test";
    const claimed = await store.claim(agent.id, owner, new Date());
    expect(claimed).not.toBeNull();
    await store.setRequiredPlugins(claimed!, owner, []);
    await store.completeHost(claimed!, owner);
    const events: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.chatFailedRetryNotices, (event, scopes) => {
      if ([...scopes ?? []].some(scope => JSON.parse(scope).companyId === companyId)) events.push(event);
    });
    try {
      await expect(db.transaction(async tx => {
        expect(await createLifecycleStore(tx as unknown as Db).change(agent.id, "complete", { owner }))
          .toMatchObject({ status: "idle", lifecycleState: "ready" });
        expect(events).toEqual(["intent"]);
        expect(await current(agent.id)).toMatchObject({ status: "paused", lifecycleState: "resuming" });
        throw new Error("rollback resumed agent");
      })).rejects.toThrow("rollback resumed agent");
      expect(events).toEqual(["intent", "settled"]);
      expect(await current(agent.id)).toMatchObject({ status: "paused", lifecycleState: "resuming" });
      events.length = 0;
      await db.transaction(async tx => {
        await createLifecycleStore(tx as unknown as Db).change(agent.id, "complete", { owner });
        expect(events).toEqual(["intent"]);
        expect((await current(agent.id)).status).toBe("paused");
      });
      expect(events).toEqual(["intent", "settled"]);
      expect(await current(agent.id)).toMatchObject({ status: "idle", lifecycleState: "ready" });
      events.length = 0;
      await store.change(agent.id, "reconcile");
      expect(events).toEqual([]);
    } finally { unsubscribe(); }
  });

  it("rejects transaction injection and generic state writes", async () => {
    const agent = await hire("pending_approval");
    await expect(db.transaction(async tx => createAgentLifecycle(tx as unknown as Db))).rejects.toThrow("root database");
    await expect(agentConfiguration(db).update(agent.id, { status: "idle" } as never)).rejects.toThrow("lifecycle command");
    await expect(createAgentLifecycle(db).requestHire(companyId, { name: "Bypass", lifecycleRequiredPluginIds: [] } as never)).rejects.toThrow("Lifecycle fields");
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

  it("preserves a disabled positive budget at approval and applies explicit configuration changes", async () => {
    const agent = await hire("pending_approval");
    const budgets = budgetService(db);
    await budgets.upsertPolicy(companyId, { scopeType: "agent", scopeId: agent.id, amount: 1000, isActive: false }, null);
    const approval = await approvalService(db).create(companyId, { type: "hire_agent",
      payload: { agentId: agent.id, budgetMonthlyCents: 1000 }, status: "pending" });
    const policy = async () => (await db.select().from(budgetPolicies).where(eq(budgetPolicies.scopeId, agent.id)))[0]!;
    await approvalService(db).approve(approval.id, "board");
    expect(await policy()).toMatchObject({ amount: 1000, isActive: false });
    await agentConfiguration(db).update(agent.id, { budgetMonthlyCents: 2000 });
    expect(await policy()).toMatchObject({ amount: 2000, isActive: true });
    await agentConfiguration(db).update(agent.id, { budgetMonthlyCents: 0 });
    expect(await policy()).toMatchObject({ amount: 0, isActive: false });
  });

  it.each(["updateConfiguration", "updateAndTransition"] as const)("limits %s budget reconciliation to the edited agent", async command => {
    const lifecycle = createAgentLifecycle(db);
    const one = await hire();
    const two = await lifecycle.requestHire(companyId, { name: "Other budget target" });
    await db.update(companies).set({ status: "paused" }).where(eq(companies.id, companyId));
    if (command === "updateConfiguration") await lifecycle.updateConfiguration(one.id, { budgetMonthlyCents: 1000 });
    else await lifecycle.updateAndTransition(one.id, "pause", { budgetMonthlyCents: 1000 });
    // Company state blocks admission; its inherited holds project separately.
    expect((await current(one.id)).lifecycleHolds).not.toContain("company_paused");
    expect((await current(two.id)).lifecycleHolds).toEqual([]);
  });

  it("blocks invocation without synchronously projecting inherited company holds", async () => {
    const one = await hire();
    const two = await createAgentLifecycle(db).requestHire(companyId, { name: "Another agent" });
    await db.update(companies).set({ status: "paused" }).where(eq(companies.id, companyId));
    expect(await budgetService(db).getInvocationBlock(companyId, one.id)).not.toBeNull();
    expect((await current(one.id)).lifecycleHolds).toEqual([]);
    expect((await current(two.id)).lifecycleHolds).toEqual([]);
  });

  it("keeps a manual hold when company policy changes", async () => {
    const work = worker(); const lifecycle = createAgentLifecycle(db); const agent = await hire(); await work.process(agent.id);
    await lifecycle.pauseAgent(agent.id); await work.process(agent.id);
    await db.update(companies).set({ status: "archived" }).where(eq(companies.id, companyId));
    await projectCompanyHolds(db, createAgentLifecycleEffects(), companyId); await work.process(agent.id);
    await db.update(companies).set({ status: "active" }).where(eq(companies.id, companyId));
    await projectCompanyHolds(db, createAgentLifecycleEffects(), companyId); await work.process(agent.id);
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
    await store.setRequiredPlugins(claimed!, "old", []);
    await createAgentLifecycle(db).terminateAgent(agent.id);
    expect(await store.completeHost(claimed!, "old")).toBe(false);
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
    await expect(agentConfiguration(db).remove(agent.id)).rejects.toThrow("Complete termination");
    pending = false; await lifecycle.retry(agent.id); await work.process(agent.id);
    expect(phases).toContain("terminating");
    expect((await current(agent.id)).lifecycleState).toBe("terminated");
    await agentConfiguration(db).remove(agent.id);
    expect(await current(agent.id)).toBeUndefined();
  });

  it("retains required plugin IDs and checks the operation and company on each reply", async () => {
    const agent = await hire("paused");
    const pluginId = randomUUID();
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "lifecycle-test", version: "1.0.0", status: "ready",
      manifestJson: { agentLifecycle: true, capabilities: ["agents.lifecycle.manage"] } as never });
    const call = vi.fn(async (_id, _method, input) => ({ operationId: input.operationId, version: input.version, status: "complete" }));
    const driver = createLifecycleDriver(db, { call } as never);
    const snapshot = (await createLifecycleStore(db).get(agent.id))!;
    expect(await driver.requiredPluginIds(snapshot)).toContain(pluginId);
    await db.insert(pluginCompanySettings).values({ companyId, pluginId, enabled: false });
    expect(await driver.requiredPluginIds(snapshot)).not.toContain(pluginId);
    expect(await driver.requiredPluginIds({ ...snapshot, lifecycleRequiredPluginIds: [pluginId] })).toContain(pluginId);
    await expect(driver.runPlugin(snapshot, pluginId)).rejects.toThrow("unavailable");
    await db.update(pluginCompanySettings).set({ enabled: true }).where(eq(pluginCompanySettings.pluginId, pluginId));
    expect(await driver.runPlugin(snapshot, pluginId)).toBe("complete");
    expect(call).toHaveBeenCalledWith(pluginId, "agentLifecycle", { companyId, agentId: agent.id,
      operationId: snapshot.lifecycleOperation!.id, version: snapshot.lifecycleVersion, phase: "paused", instanceSecrets: {} }, 30_000);
    call.mockResolvedValueOnce({ operationId: "stale", version: snapshot.lifecycleVersion, status: "complete" });
    await expect(driver.runPlugin(snapshot, pluginId)).rejects.toThrow("Invalid lifecycle result");
  });

  it("drives required resource work through setup, pause, resume, and confirmed cleanup", async () => {
    const pluginId = randomUUID();
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "resource-lifecycle-test", version: "1.0.0", status: "ready",
      manifestJson: { agentLifecycle: true, capabilities: ["agents.lifecycle.manage"] } as never });
    let resourcesReady = false;
    let resourcesRemoved = false;
    const requests: import("@paperclipai/shared").AgentLifecycleRequest[] = [];
    const call = async (id: string, method: string, input: import("@paperclipai/shared").AgentLifecycleRequest) => {
      expect(id).toBe(pluginId);
      expect(method).toBe("agentLifecycle");
      expect(input.companyId).toBe(companyId);
      expect((await current(input.agentId)).lifecycleOperation?.hostComplete).toBe(true);
      requests.push(input);
      const pending = (input.phase === "preparing" && !resourcesReady) || (input.phase === "cleaning_up" && !resourcesRemoved);
      return { operationId: input.operationId, version: input.version, status: pending ? "pending" : "complete" };
    };
    const driver = createLifecycleDriver(db, { call } as never);
    // Provider/harness execution is stubbed; plugin dispatch and durable transitions are real.
    const work = configureAgentLifecycle(db, { ...driver, requiredPluginIds: async () => [pluginId], runHost: async () => "complete" });
    workers.push(work);
    const lifecycle = createAgentLifecycle(db);
    const agent = await hire();
    await work.process(agent.id);
    expect(await current(agent.id)).toMatchObject({ lifecycleState: "preparing", status: "paused", lifecycleError: null });
    const preparation = requests[0];
    resourcesReady = true;
    await lifecycle.retry(agent.id); await work.process(agent.id);
    expect(requests[1]).toEqual(preparation);
    expect((await current(agent.id)).lifecycleState).toBe("ready");
    await lifecycle.pauseAgent(agent.id); await work.process(agent.id);
    expect((await current(agent.id)).lifecycleState).toBe("paused");
    await lifecycle.resumeAgent(agent.id); await work.process(agent.id);
    expect((await current(agent.id)).lifecycleState).toBe("ready");
    await lifecycle.terminateAgent(agent.id); await work.process(agent.id);
    expect((await current(agent.id)).lifecycleState).toBe("cleaning_up");
    await expect(lifecycle.purgeAgent(agent.id)).rejects.toThrow("Complete termination");
    resourcesRemoved = true;
    await lifecycle.retry(agent.id); await work.process(agent.id);
    expect((await current(agent.id)).lifecycleState).toBe("terminated");
    expect(requests.map(request => request.phase)).toEqual([
      "preparing", "preparing", "verifying", "pausing", "resuming", "terminating", "cleaning_up", "cleaning_up",
    ]);
    expect(requests.every(request => request.agentId === agent.id)).toBe(true);
  });

  it("keeps host completion and required plugin results across a worker restart", async () => {
    const pluginIds = [randomUUID(), randomUUID()];
    const runHost = vi.fn(async () => "complete" as const);
    const firstPlugin = vi.fn(async (_agent: LifecycleAgent, pluginId: string) =>
      pluginId === pluginIds[0] ? "complete" as const : "pending" as const);
    const first = configureAgentLifecycle(db, { requiredPluginIds: async () => pluginIds, runHost, runPlugin: firstPlugin });
    workers.push(first);
    const agent = await hire();
    await first.process(agent.id);
    expect(await current(agent.id)).toMatchObject({ lifecycleState: "preparing", lifecycleRequiredPluginIds: pluginIds,
      lifecycleOperation: { hostComplete: true, completedPluginIds: [pluginIds[0]] } });
    await first.stop();

    const discover = vi.fn(async () => []);
    const resumedPlugin = vi.fn(async (_agent: LifecycleAgent, _pluginId: string) => "complete" as const);
    const resumed = configureAgentLifecycle(db, { requiredPluginIds: discover, runHost, runPlugin: resumedPlugin });
    workers.push(resumed);
    await createAgentLifecycle(db).retry(agent.id);
    await resumed.process(agent.id);
    expect((await current(agent.id)).lifecycleState).toBe("ready");
    expect(discover).not.toHaveBeenCalled();
    expect(runHost).toHaveBeenCalledTimes(2);
    expect(resumedPlugin.mock.calls.map(call => call[1])).toEqual([pluginIds[1], ...pluginIds]);
  });

  it("requires host and plugin completion and freezes the selected plugin IDs", async () => {
    const agent = await hire();
    const store = createLifecycleStore(db);
    const claimed = (await store.claim(agent.id, "test", new Date()))!;
    const pluginId = randomUUID();
    expect(await store.setRequiredPlugins(claimed, "test", [pluginId])).toBe(true);
    expect(await store.setRequiredPlugins(claimed, "test", [])).toBe(false);
    expect(await store.completePlugin(claimed, "test", randomUUID())).toBe(false);
    const complete = () => store.change(agent.id, "complete", { owner: "test", version: claimed.lifecycleVersion });
    expect(await complete()).toBeNull();
    expect(await store.completePlugin(claimed, "test", pluginId)).toBe(true);
    expect(await complete()).toBeNull();
    expect(await store.completeHost(claimed, "test")).toBe(true);
    expect(await complete()).toMatchObject({ lifecycleState: "verifying" });
    expect(await store.completePlugin(claimed, "test", pluginId)).toBe(false);
  });

  it("fences verification when the saved configuration changes", async () => {
    const lifecycle = createAgentLifecycle(db); const store = createLifecycleStore(db);
    const agent = await hire();
    const claimed = (await store.claim(agent.id, "configuration-test", new Date()))!;
    await store.setRequiredPlugins(claimed, "configuration-test", []);
    await agentConfiguration(db).update(agent.id, { adapterConfig: { command: "echo" } });
    expect(await store.completeHost(claimed, "configuration-test")).toBe(false);
    expect((await lifecycle.get(agent.id))!.lifecycleVersion).toBeGreaterThan(claimed.lifecycleVersion);
  });

  it("invalidates only changed execution configuration during setup", async () => {
    const lifecycle = createAgentLifecycle(db);
    const agent = await hire();
    const before = await current(agent.id);
    await lifecycle.updateConfiguration(agent.id, { name: "Profile only" });
    await lifecycle.updateConfiguration(agent.id, { adapterConfig: before.adapterConfig });
    expect((await current(agent.id)).lifecycleVersion).toBe(before.lifecycleVersion);
    await lifecycle.updateConfiguration(agent.id, { runtimeConfig: { heartbeat: { enabled: false } } });
    expect((await current(agent.id)).lifecycleVersion).toBe(before.lifecycleVersion + 1);
    const work = worker();
    await work.process(agent.id);
    const ready = await current(agent.id);
    expect(ready.lifecycleState).toBe("ready");
    await lifecycle.updateConfiguration(agent.id, { adapterConfig: { command: "echo" } });
    expect(await current(agent.id)).toMatchObject({ lifecycleState: "ready", lifecycleVersion: ready.lifecycleVersion });
  });

  it("rejects identity, accounting, and unknown fields through every configuration entry point", async () => {
    const agent = await hire();
    const lifecycle = createAgentLifecycle(db);
    const before = await current(agent.id);
    for (const patch of [{ id: randomUUID() }, { companyId: randomUUID() }, { spentMonthlyCents: 0 },
      { spendMonthUtc: "2099-01" }, { lastHeartbeatAt: new Date() }, { errorReason: null },
      { createdAt: new Date() }, { updatedAt: new Date() }, { lifecycleState: "ready" }, { futureColumn: true }]) {
      await expect(lifecycle.updateConfiguration(agent.id, patch as never)).rejects.toThrow("Unsupported configuration field");
      await expect(lifecycle.updateAndTransition(agent.id, "pause", patch as never)).rejects.toThrow("Unsupported configuration field");
      await expect(db.transaction(tx => updateAgentConfigurationInTransaction(tx as unknown as Db, agent.id, patch as never)))
        .rejects.toThrow("Unsupported configuration field");
    }
    expect(await current(agent.id)).toEqual(before);
    const effects = createAgentLifecycleEffects();
    const malformed = createLifecycleCommands(db, { ...effects, prepareConfiguration: async () => ({ id: randomUUID() }) as never });
    await expect(malformed.updateConfiguration(agent.id, { name: "Changed" })).rejects.toThrow("Unsupported configuration field");
    expect(await current(agent.id)).toEqual(before);
  });

  it("records only the changed configuration fields for a legacy appearance", async () => {
    const [agent] = await db.insert(agents).values({ companyId, name: "Legacy", appearance: null }).returning();
    await createAgentLifecycle(db).updateConfiguration(agent.id, { name: "Renamed" },
      { recordRevision: { source: "test", createdByUserId: "board" } });
    const revisions = await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, agent.id));
    expect(revisions).toHaveLength(1);
    expect(revisions[0].changedKeys).toEqual(["name"]);
    expect(revisions[0].beforeConfig.appearance).toEqual(revisions[0].afterConfig.appearance);
  });

  it("accepts the unchanged resolved appearance of a pending hire", async () => {
    const [agent] = await db.insert(agents).values({ companyId, name: "Pending legacy", status: "pending_approval", appearance: null }).returning();
    const resolved = await agentConfiguration(db).getById(agent.id);
    await expect(createAgentLifecycle(db).updateConfiguration(agent.id, { appearance: resolved!.appearance }))
      .resolves.toMatchObject({ id: agent.id });
    await expect(createAgentLifecycle(db).updateConfiguration(agent.id, { name: "Changed" }))
      .rejects.toThrow("Pending approval agent configuration cannot be changed");
  });

  it("rolls back a root configuration command when dependent records fail", async () => {
    const agent = await hire();
    const before = await current(agent.id);
    const effects = createAgentLifecycleEffects();
    const lifecycle = createLifecycleCommands(db, { ...effects, completeConfiguration: async (...args) => {
      await effects.completeConfiguration(...args);
      throw new Error("Configuration completion failed");
    } });
    await expect(lifecycle.updateConfiguration(agent.id, { adapterConfig: { command: "echo" } },
      { recordRevision: { source: "test", createdByUserId: "board" } })).rejects.toThrow("Configuration completion failed");
    expect(await current(agent.id)).toMatchObject({ adapterConfig: before.adapterConfig,
      lifecycleVersion: before.lifecycleVersion, lifecycleOperation: before.lifecycleOperation });
    expect(await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, agent.id))).toHaveLength(0);
  });

  it("rolls back configuration and verification invalidation in the binding transaction", async () => {
    const agent = await hire();
    const before = await current(agent.id);
    await expect(updateAgentConfigurationInTransaction(db, agent.id, { name: "Uncommitted" }))
      .rejects.toThrow("requires a database transaction");
    expect(() => updateAgentConfigurationInTransaction(db, agent.id, { budgetMonthlyCents: 100 } as never))
      .toThrow("Budget changes require a root lifecycle command");
    await expect(db.transaction(async tx => agentConfiguration(tx as unknown as Db).update(agent.id, { name: "Uncommitted" })))
      .rejects.toThrow("root database");
    await expect(db.transaction(async tx => {
      await updateAgentConfigurationInTransaction(tx as unknown as Db, agent.id, { adapterConfig: { command: "echo" } });
      expect((await tx.select().from(agents).where(eq(agents.id, agent.id)))[0].lifecycleVersion).toBe(before.lifecycleVersion + 1);
      throw new Error("Binding change failed");
    })).rejects.toThrow("Binding change failed");
    expect(await current(agent.id)).toMatchObject({ adapterConfig: before.adapterConfig,
      lifecycleVersion: before.lifecycleVersion, lifecycleOperation: before.lifecycleOperation });
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
    await store.setRequiredPlugins(claim!, "first", []);
    await store.completeHost(claim!, "first");
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
