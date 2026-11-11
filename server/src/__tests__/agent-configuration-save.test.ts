import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, agentConfigRevisions, activityLog, builtInManagedResources, companies, companyMemberships, connectionGrants, createDb, environments, toolConnections, toolConnectionInstalls } from "@paperclipai/db";
import { agentRoutes } from "../routes/agents.js";
import { aiConnectionService } from "../services/ai-connections.js";
import * as environmentTests from "../services/agent-environment-test.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const realEnvironmentTests = environmentTests.agentEnvironmentTestService;

describePostgres("agent configuration save latency", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  let app: express.Express;
  let agent: typeof agents.$inferSelect;
  let account: { connectionId: string; grantId: string };
  let fixtureNumber = 0;
  const userId = randomUUID();
  const binding = { provider: "openai", method: "api_key", mode: "responsible_user" } as const;
  const allocate = vi.fn<ReturnType<typeof realEnvironmentTests>["resolveAdapterTestExecutionContext"]>();
  const probe = vi.fn<ReturnType<typeof realEnvironmentTests>["testManagedEnvironment"]>();
  const release = vi.fn(async () => undefined);
  const readAgent = async () => (await db.select().from(agents).where(eq(agents.id, agent.id)))[0];

  beforeAll(async () => {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-config-save-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "configuration-save-fixture");
    database = await startEmbeddedPostgresTestDatabase("paperclip-config-save-db-");
    db = createDb(database.connectionString);
  }, 90_000);

  beforeEach(async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Configuration save", issuePrefix: `CS${++fixtureNumber}` });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    [agent] = await db.insert(agents).values({ companyId, name: "Configuration agent", adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex", model: "gpt-5.6-sol" } }).returning();
    account = await aiConnectionService(db).save(companyId, userId, {
      provider: "openai", method: "api_key", ownership: "personal", name: "Saved account", apiKey: "fixture-save-key", agentIds: [agent.id], allAgents: false,
    }, "fixture-save-key");
    await aiConnectionService(db).setDefault(companyId, userId, account.grantId);
    allocate.mockReset().mockRejectedValue(new Error("A save must not allocate a remote computer"));
    probe.mockReset().mockResolvedValue({ adapterType: "paperclip_runner", status: "pass", testedAt: new Date().toISOString(),
      checks: [{ code: "codex_hello_probe_passed", level: "info", message: "Fixture probe passed" }] });
    release.mockClear();
    vi.spyOn(environmentTests, "agentEnvironmentTestService").mockImplementation((database, manager) => ({
      ...realEnvironmentTests(database, manager), resolveAdapterTestExecutionContext: allocate, testManagedEnvironment: probe,
    }));
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("A save must not contact the provider"));
    app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId, companyIds: [companyId] }; next(); });
    app.use("/api", agentRoutes(db));
    app.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.status ?? 500).json({ error: error.message });
    });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await database?.cleanup(); vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  it("saves an installed healthy account without allocating a computer or sending a prompt", async () => {
    const response = await request(app).patch(`/api/agents/${agent.id}`).send({ runtimeConfig: { aiConnection: binding } });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await readAgent()).runtimeConfig.aiConnection).toEqual(binding);
    expect(allocate).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled(); expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toContain("fixture-save-key");
    expect(await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, agent.id))).toHaveLength(1);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, agent.id), eq(activityLog.action, "agent.updated")))).toHaveLength(1);
  });

  it("saves model edits against an existing healthy account without a runtime probe", async () => {
    await db.update(agents).set({ runtimeConfig: { aiConnection: binding } }).where(eq(agents.id, agent.id));
    const response = await request(app).patch(`/api/agents/${agent.id}`).send({ adapterConfig: { model: "gpt-5.6-luna" } });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await readAgent()).adapterConfig.model).toBe("gpt-5.6-luna");
    expect(allocate).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled(); expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("saves a roster connection edit without a runtime probe and rejects a stale retry", async () => {
    const patch = { runtimeSettings: { harness: "codex_local", aiConnection: binding,
      expected: { model: "gpt-5.6-sol", aiConnection: null } } };
    const response = await request(app).patch(`/api/agents/${agent.id}`).send(patch);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await readAgent()).runtimeConfig.aiConnection).toEqual(binding);
    expect((await request(app).patch(`/api/agents/${agent.id}`).send(patch)).status).toBe(409);
    expect(allocate).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
  });

  it("rejects an account without an installation for this agent", async () => {
    await db.delete(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, account.connectionId));
    const response = await request(app).patch(`/api/agents/${agent.id}`).send({ runtimeConfig: { aiConnection: binding } });
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect((await readAgent()).runtimeConfig.aiConnection).toBeUndefined();
    expect(allocate).not.toHaveBeenCalled();
  });

  it("rejects a revoked account before saving or allocating a computer", async () => {
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, account.grantId));
    const response = await request(app).patch(`/api/agents/${agent.id}`).send({ runtimeConfig: { aiConnection: binding } });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect((await readAgent()).runtimeConfig.aiConnection).toBeUndefined();
    expect(await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, agent.id))).toHaveLength(0);
    expect(allocate).not.toHaveBeenCalled();
  });

  it.each(["foreign", "same-company", "global"])("checks %s environment ownership without a runtime probe", async ownership => {
    const [environment] = await db.insert(environments).values({ name: `Save target ${agent.companyId}`, driver: "sandbox", config: { provider: "daytona" } }).returning();
    if (ownership !== "global") {
      const companyId = ownership === "foreign" ? randomUUID() : agent.companyId;
      if (ownership === "foreign") await db.insert(companies).values({ id: companyId, name: "Foreign company", issuePrefix: `FC${++fixtureNumber}` });
      await db.insert(builtInManagedResources).values({ companyId, bundleKey: "managed-environment", resourceKind: "environment",
        resourceKey: "managed-sandbox", resourceId: environment.id, stockVersion: "1", stockHash: "fixture" });
    }
    const response = await request(app).patch(`/api/agents/${agent.id}`).send({ defaultEnvironmentId: environment.id, runtimeConfig: { aiConnection: binding } });
    expect(response.status, JSON.stringify(response.body)).toBe(ownership === "foreign" ? 403 : 200);
    const saved = await readAgent();
    expect(saved.defaultEnvironmentId).toBe(ownership === "foreign" ? null : environment.id);
    expect(saved.runtimeConfig.aiConnection).toEqual(ownership === "foreign" ? undefined : binding);
    expect(await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, agent.id))).toHaveLength(ownership === "foreign" ? 0 : 1);
    expect(allocate).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
  });

  it.each(["inherited", "existing-binding"])("rejects a foreign environment with %s settings", async mode => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Foreign company", issuePrefix: `FC${++fixtureNumber}` });
    const [environment] = await db.insert(environments).values({ name: `Foreign target ${companyId}`, driver: "sandbox", config: { provider: "daytona" } }).returning();
    await db.insert(builtInManagedResources).values({ companyId, bundleKey: "managed-environment", resourceKind: "environment",
      resourceKey: "managed-sandbox", resourceId: environment.id, stockVersion: "1", stockHash: "fixture" });
    const settings = instanceSettingsService(db);
    const previousDefault = (await settings.get()).defaultEnvironmentId;
    try {
      if (mode === "inherited") await settings.update({ defaultEnvironmentId: environment.id });
      else await db.update(agents).set({ runtimeConfig: { aiConnection: binding } }).where(eq(agents.id, agent.id));
      const response = await request(app).patch(`/api/agents/${agent.id}`).send(mode === "inherited"
        ? { runtimeConfig: { aiConnection: binding } } : { defaultEnvironmentId: environment.id });
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect((await readAgent()).defaultEnvironmentId).toBeNull();
      expect(await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, agent.id))).toHaveLength(0);
      expect(allocate).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
    } finally { if (mode === "inherited") await settings.update({ defaultEnvironmentId: previousDefault }); }
  });

  it("keeps live validation for an unverified legacy account", async () => {
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, account.connectionId));
    await db.update(toolConnections).set({ healthStatus: "unknown", config: { ...connection.config, aiLegacyAdoption: true } }).where(eq(toolConnections.id, account.connectionId));
    allocate.mockResolvedValue({ executionTarget: null, environmentName: "Fixture computer", fallbackChecks: [], release });
    probe.mockResolvedValueOnce({ adapterType: "paperclip_runner", status: "fail", testedAt: new Date().toISOString(),
      checks: [{ code: "codex_hello_probe_auth_required", level: "error", message: "Fixture login rejected" }] });
    const failed = await request(app).patch(`/api/agents/${agent.id}`).send({ runtimeConfig: { aiConnection: binding } });
    expect(failed.status, JSON.stringify(failed.body)).toBe(422);
    expect((await readAgent()).runtimeConfig.aiConnection).toBeUndefined();
    const saved = await request(app).patch(`/api/agents/${agent.id}`).send({ runtimeConfig: { aiConnection: binding } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(probe).toHaveBeenCalledTimes(2); expect(release).toHaveBeenCalledTimes(2);
    const [verified] = await db.select().from(toolConnections).where(eq(toolConnections.id, account.connectionId));
    expect(verified.healthStatus).toBe("ok"); expect(verified.config.aiLegacyAdoption).toBe(false);
  });

  it("profiles a save with controlled remote allocation latency", async () => {
    const delayMs = Number(process.env.PAPERCLIP_CONFIG_SAVE_PROFILE_DELAY_MS ?? 50);
    allocate.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      return { executionTarget: null, environmentName: "Delayed fixture computer", fallbackChecks: [], release };
    });
    const startedAt = performance.now();
    const response = await request(app).patch(`/api/agents/${agent.id}`).send({ runtimeConfig: { aiConnection: binding } });
    const elapsedMs = performance.now() - startedAt;
    if (process.env.PAPERCLIP_CONFIG_SAVE_PROFILE_DELAY_MS) {
      process.stdout.write(`${JSON.stringify({ profile: "agent-configuration-save", remoteAllocationDelayMs: delayMs, elapsedMs,
        allocations: allocate.mock.calls.length, probes: probe.mock.calls.length, status: response.status })}\n`);
    }
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(allocate).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
  }, 60_000);
});
