import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, agentConfigRevisions, builtInManagedResources, companies, companyMemberships, createDb, environments, plugins } from "@paperclipai/db";
import { agentRoutes } from "../routes/agents.js";
import { aiConnectionService } from "../services/ai-connections.js";
import * as environmentTests from "../services/agent-environment-test.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { readFileSync } from "node:fs";
import { QUALIFIED_ACPX_PROFILES } from "../vendor/paperclip-runner/index.js";
import { ANTIGRAVITY_CANDIDATE_ADMISSION_ENV } from "../services/native-runtime/acpx-qualification.js";
import { prepareAntigravityRunnerCredentials } from "../services/native-runtime/antigravity-runner-credentials.js";
import { resolveHeartbeatNativeLifecyclePolicy } from "../services/heartbeat/native-lifecycle.js";
import { resolveRunnerEnvironmentForRun } from "../services/runner-environment-lifecycle.js";

const distributions = JSON.parse(readFileSync(new URL("../../../packages/paperclip-runner/antigravity-distributions.json", import.meta.url), "utf8"));
/** The operator's pending grant for one company, model and platform. */
const grant = (companyId: string, target: string) => {
  const [platform, architecture] = target.split("-");
  return JSON.stringify({ schema: "paperclip.acpx-candidate-admission.v1", companyId, agent: "antigravity", model: "gemini-3.8-flash-high",
    profileDigest: QUALIFIED_ACPX_PROFILES.antigravity.commandDigest, nativeClosureDigest: `sha256:${distributions.platforms[target].closureSha256}`,
    platform, architecture, expiresAt: Date.now() + 60_000 });
};

const release = vi.hoisted(() => ({ pending: false, remoteCandidateAdmitted: false }));
vi.mock("../services/native-runtime/antigravity-release.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/native-runtime/antigravity-release.js")>(),
  antigravityReleasePending: () => release.pending,
}));
vi.mock("../services/native-runtime/acpx-qualification.js", async importOriginal => {
  const original = await importOriginal<typeof import("../services/native-runtime/acpx-qualification.js")>();
  return {
    ...original,
    resolveAntigravityCandidateAdmission: (...args: Parameters<typeof original.resolveAntigravityCandidateAdmission>) =>
      release.remoteCandidateAdmitted && args[0]?.target?.platform === "linux"
        ? { schema: "paperclip.acpx-candidate-admission.v1", companyId: args[0].companyId ?? "", agent: "antigravity",
          model: args[0].model ?? "gemini-3.8-flash-high", profileDigest: "", nativeClosureDigest: "",
          platform: "linux", architecture: "x64", expiresAt: Date.now() + 60_000 }
        : original.resolveAntigravityCandidateAdmission(...args),
    antigravityRemoteCandidateAdmitted: (...args: Parameters<typeof original.antigravityRemoteCandidateAdmitted>) =>
      release.remoteCandidateAdmitted || original.antigravityRemoteCandidateAdmitted(...args),
  };
});

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const realEnvironmentTests = environmentTests.agentEnvironmentTestService;

/**
 * An Antigravity connection its environment cannot run is refused when the
 * agent is saved, in plain language, never later as a failed run.
 */
describePostgres("Google Antigravity connection refusal at agent save", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  let app: express.Express;
  let agent: typeof agents.$inferSelect;
  let cloud: typeof environments.$inferSelect;
  let fixtureNumber = 0;
  const userId = randomUUID();
  const allocate = vi.fn();
  const probe = vi.fn();
  const readAgent = async () => (await db.select().from(agents).where(eq(agents.id, agent.id)))[0];

  beforeAll(async () => {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-antigravity-save-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "antigravity-save-fixture");
    database = await startEmbeddedPostgresTestDatabase("paperclip-antigravity-save-db-");
    db = createDb(database.connectionString);
  }, 90_000);

  beforeEach(async () => {
    release.pending = false;
    release.remoteCandidateAdmitted = false;
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Antigravity save", issuePrefix: `AS${++fixtureNumber}` });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    [agent] = await db.insert(agents).values({ companyId, name: "Antigravity agent", adapterType: "paperclip_runner",
      adapterConfig: { provider: "acpx", acpxAgent: "antigravity", model: "gemini-3.8-flash-high" } }).returning();
    [cloud] = await db.insert(environments).values({ name: `Cloud ${companyId}`, driver: "sandbox", config: { provider: "daytona" } }).returning();
    await db.insert(builtInManagedResources).values({ companyId, bundleKey: "managed-environment", resourceKind: "environment",
      resourceKey: "managed-sandbox", resourceId: cloud.id, stockVersion: "1", stockHash: "fixture" });
    allocate.mockReset().mockRejectedValue(new Error("A save must not allocate a remote computer"));
    probe.mockReset().mockRejectedValue(new Error("A save must not probe the runtime"));
    vi.spyOn(environmentTests, "agentEnvironmentTestService").mockImplementation((database, manager) => ({
      ...realEnvironmentTests(database, manager), resolveAdapterTestExecutionContext: allocate, testManagedEnvironment: probe,
    }));
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("A save must not contact the provider"));
    app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId, companyIds: [companyId] }; next(); });
    app.use("/api", agentRoutes(db));
    app.use((error: { status?: number; message: string; details?: unknown }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.status ?? 500).json({ error: error.message, details: error.details });
    });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, undefined); });
  afterAll(async () => {
    await database?.cleanup(); vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  async function saveGoogleConnection(method: "api_key" | "subscription") {
    const connection = method === "api_key"
      ? await aiConnectionService(db).save(agent.companyId, userId, { provider: "google", method: "api_key", ownership: "personal",
        name: "Gemini key", apiKey: "fixture-gemini-key", agentIds: [agent.id], allAgents: false }, "fixture-gemini-key")
      : await aiConnectionService(db).save(agent.companyId, userId, { provider: "google", method: "subscription", ownership: "personal",
        name: "Google account", agentIds: [agent.id], allAgents: false }, "fixture-google-sign-in");
    await aiConnectionService(db).setDefault(agent.companyId, userId, connection.grantId);
    return { provider: "google", method, mode: "responsible_user" } as const;
  }

  async function insertPluginTaskEnvironment() {
    const pluginId = randomUUID();
    const pluginKey = `fixture-tasks-${pluginId}`;
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey,
      packageName: pluginKey,
      version: "1.0.0",
      status: "ready",
      manifestJson: {
        capabilities: ["environment.drivers.register"],
        environmentDrivers: [{ driverKey: "tasks", supportsTasks: true }],
      } as never,
    });
    const [pluginEnv] = await db.insert(environments).values({
      name: `Plugin tasks ${agent.companyId}`,
      driver: "plugin",
      config: { pluginKey, driverKey: "tasks", driverConfig: {} },
    }).returning();
    return pluginEnv!;
  }

  it("refuses Google sign-in on a cloud environment while pending even with a linux-x64 grant", async () => {
    release.pending = true;
    release.remoteCandidateAdmitted = true;
    vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, grant(agent.companyId, "linux-x64"));
    const binding = await saveGoogleConnection("subscription");
    const response = await request(app).patch(`/api/agents/${agent.id}`).send({ defaultEnvironmentId: cloud.id, runtimeConfig: { aiConnection: binding } });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error).toBe("Google sign-in for Google Antigravity works only on the Paperclip host. To run this agent in a cloud environment, connect a Google API key instead.");
    expect(response.body.details).toMatchObject({ code: "antigravity_remote_sign_in_unsupported" });
    const saved = await readAgent();
    expect(saved.defaultEnvironmentId).toBeNull();
    expect(saved.runtimeConfig.aiConnection).toBeUndefined();
    expect(await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, agent.id))).toHaveLength(0);
    expect(allocate).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
  });

  it("refuses a plugin Runner-task environment while pending even with a linux-x64 grant", async () => {
    release.pending = true;
    vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, grant(agent.companyId, "linux-x64"));
    const pluginEnv = await insertPluginTaskEnvironment();
    const binding = await saveGoogleConnection("api_key");
    const response = await request(app).patch(`/api/agents/${agent.id}`).send({ defaultEnvironmentId: pluginEnv.id, runtimeConfig: { aiConnection: binding } });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.details).toMatchObject({ code: "antigravity_remote_unavailable" });
    expect((await readAgent()).defaultEnvironmentId).toBeNull();
  });

  it("refuses any cloud environment when releasePending is forced true", async () => {
    release.pending = true;
    const binding = await saveGoogleConnection("api_key");
    const response = await request(app).patch(`/api/agents/${agent.id}`).send({ defaultEnvironmentId: cloud.id, runtimeConfig: { aiConnection: binding } });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error).toBe("Google Antigravity runs only on the Paperclip host for now. Choose the Paperclip host as this agent's environment.");
    expect(JSON.stringify(response.body)).not.toContain("fixture-gemini-key");
    expect((await readAgent()).defaultEnvironmentId).toBeNull();
  });

  it("ignores stale candidate grants and saves a host agent normally once released", async () => {
    vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, grant(agent.companyId, "linux-x64"));
    const response = await request(app).patch(`/api/agents/${agent.id}`)
      .send({ adapterConfig: { provider: "acpx", acpxAgent: "antigravity", model: "gemini-3.8-flash-high" } });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(allocate).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
  });

  it("saves a Gemini API key and Google sign-in on a Core sandbox once released", async () => {
    for (const method of ["api_key", "subscription"] as const) {
      const binding = await saveGoogleConnection(method);
      const response = await request(app).patch(`/api/agents/${agent.id}`).send({ defaultEnvironmentId: cloud.id, runtimeConfig: { aiConnection: binding } });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const saved = await readAgent();
      expect(saved.defaultEnvironmentId).toBe(cloud.id);
      expect(saved.runtimeConfig.aiConnection).toEqual(binding);
    }
    expect(allocate).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
  });

  it("saves a Gemini API key and Google sign-in on a plugin Runner-task environment once released", async () => {
    const pluginEnv = await insertPluginTaskEnvironment();
    for (const method of ["api_key", "subscription"] as const) {
      const binding = await saveGoogleConnection(method);
      const response = await request(app).patch(`/api/agents/${agent.id}`).send({ defaultEnvironmentId: pluginEnv.id, runtimeConfig: { aiConnection: binding } });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const saved = await readAgent();
      expect(saved.defaultEnvironmentId).toBe(pluginEnv.id);
      expect(saved.runtimeConfig.aiConnection).toEqual(binding);
    }
    expect(allocate).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
  });

  it("creates a released Antigravity agent on a plugin Runner-task environment without enableNativeRunner", async () => {
    const pluginEnv = await insertPluginTaskEnvironment();
    const binding = await saveGoogleConnection("subscription");
    const response = await request(app).post(`/api/companies/${agent.companyId}/agents`).send({
      name: "Released Antigravity agent",
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "acpx", acpxAgent: "antigravity", model: "gemini-3.8-flash-high" },
      defaultEnvironmentId: pluginEnv.id,
      runtimeConfig: { aiConnection: binding },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.defaultEnvironmentId).toBe(pluginEnv.id);
    expect(response.body.adapterConfig).toMatchObject({ provider: "acpx", acpxAgent: "antigravity", model: "gemini-3.8-flash-high" });
    expect(allocate).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
  });

  it("saves an agent on a warm cloud task environment that then runs every turn per-turn", async () => {
    release.pending = false;
    const [warmTasks] = await db.insert(environments).values({ name: `Warm tasks ${agent.companyId}`, driver: "plugin",
      config: { pluginKey: "fixture", driverKey: "tasks", driverConfig: {}, runnerLifecycleMode: "warm" } }).returning();
    await db.update(agents).set({ adapterConfig: { ...agent.adapterConfig, lifecycleMode: "warm" } }).where(eq(agents.id, agent.id));
    const binding = await saveGoogleConnection("api_key");
    const response = await request(app).patch(`/api/agents/${agent.id}`).send({ defaultEnvironmentId: warmTasks.id, runtimeConfig: { aiConnection: binding } });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const saved = await readAgent();
    expect(saved.defaultEnvironmentId).toBe(warmTasks.id);

    const runEnvironment = resolveRunnerEnvironmentForRun({ ...warmTasks, driver: "plugin" as const }, saved.adapterType, saved.adapterConfig, undefined, "google:api-key:1");
    expect(runEnvironment.config.runnerLifecycleMode).toBe("per_turn");
    const session = resolveHeartbeatNativeLifecyclePolicy({ adapterType: saved.adapterType, backend: "acpx_runtime", acpxAgent: "antigravity",
      agentMode: saved.adapterConfig.lifecycleMode, agentIdleTimeoutMs: undefined, managedAiSelected: true, taskOwned: true,
      environmentPolicy: runEnvironment.config.runnerLifecycleMode === "warm" ? { mode: "warm", idleTimeoutMs: 300_000 } : { mode: "per_turn", idleTimeoutMs: null } });
    expect(session.mode).toBe("per_turn");
    for (const lifecycleMode of [runEnvironment.config.runnerLifecycleMode as "warm" | "per_turn", session.mode]) {
      await expect(prepareAntigravityRunnerCredentials({ environment: { GEMINI_API_KEY: "fixture-gemini-key" }, remote: true, lifecycleMode }))
        .resolves.toMatchObject({ home: null });
    }
  });
});
