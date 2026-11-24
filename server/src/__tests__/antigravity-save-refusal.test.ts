import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, agentConfigRevisions, builtInManagedResources, companies, companyMemberships, createDb, environments } from "@paperclipai/db";
import { agentRoutes } from "../routes/agents.js";
import { aiConnectionService } from "../services/ai-connections.js";
import * as environmentTests from "../services/agent-environment-test.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { readFileSync } from "node:fs";
import { QUALIFIED_ACPX_PROFILES } from "../vendor/paperclip-runner/index.js";
import { ANTIGRAVITY_CANDIDATE_ADMISSION_ENV } from "../services/native-runtime/acpx-qualification.js";

const distributions = JSON.parse(readFileSync(new URL("../../../packages/paperclip-runner/antigravity-distributions.json", import.meta.url), "utf8"));
/** The operator's pending grant for one company, model and platform. */
const grant = (companyId: string, target: string) => {
  const [platform, architecture] = target.split("-");
  return JSON.stringify({ schema: "paperclip.acpx-candidate-admission.v1", companyId, agent: "antigravity", model: "gemini-3.8-flash-high",
    profileDigest: QUALIFIED_ACPX_PROFILES.antigravity.commandDigest, nativeClosureDigest: `sha256:${distributions.platforms[target].closureSha256}`,
    platform, architecture, expiresAt: Date.now() + 60_000 });
};

const release = vi.hoisted(() => ({ pending: true }));
vi.mock("../services/native-runtime/antigravity-release.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/native-runtime/antigravity-release.js")>(),
  antigravityReleasePending: () => release.pending,
}));

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
    release.pending = true;
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

  it("refuses Google sign-in on a cloud environment with the plain-language fix", async () => {
    release.pending = false;
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

  it("refuses any cloud environment while the release is pending", async () => {
    const binding = await saveGoogleConnection("api_key");
    const response = await request(app).patch(`/api/agents/${agent.id}`).send({ defaultEnvironmentId: cloud.id, runtimeConfig: { aiConnection: binding } });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error).toBe("Google Antigravity runs only on the Paperclip host for now. Choose the Paperclip host as this agent's environment.");
    expect(JSON.stringify(response.body)).not.toContain("fixture-gemini-key");
    expect((await readAgent()).defaultEnvironmentId).toBeNull();
  });

  it("saves a Gemini API key on a cloud environment while pending when the operator granted linux-x64", async () => {
    vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, grant(agent.companyId, "linux-x64"));
    const binding = await saveGoogleConnection("api_key");
    const response = await request(app).patch(`/api/agents/${agent.id}`).send({ defaultEnvironmentId: cloud.id, runtimeConfig: { aiConnection: binding } });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await readAgent()).defaultEnvironmentId).toBe(cloud.id);
    expect(allocate).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
  });

  it("refuses a cloud environment when the grant is for another company or another platform", async () => {
    const binding = await saveGoogleConnection("api_key");
    for (const value of [grant(randomUUID(), "linux-x64"), grant(agent.companyId, "linux-arm64")]) {
      vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, value);
      const response = await request(app).patch(`/api/agents/${agent.id}`).send({ defaultEnvironmentId: cloud.id, runtimeConfig: { aiConnection: binding } });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(response.body.details).toMatchObject({ code: "antigravity_remote_unavailable" });
    }
    expect((await readAgent()).defaultEnvironmentId).toBeNull();
  });

  it.skipIf(process.platform === "linux" && process.arch === "x64")("refuses a host agent when the company holds only a cloud grant", async () => {
    vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, grant(agent.companyId, "linux-x64"));
    const response = await request(app).patch(`/api/agents/${agent.id}`)
      .send({ adapterConfig: { provider: "acpx", acpxAgent: "antigravity", model: "gemini-3.8-flash-high" } });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error).toBe("Google Antigravity is enabled only for cloud environments in this company for now. Choose a cloud environment for this agent.");
    expect(await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, agent.id))).toHaveLength(0);
  });

  it("saves a Gemini API key on a cloud environment once released", async () => {
    release.pending = false;
    const binding = await saveGoogleConnection("api_key");
    const response = await request(app).patch(`/api/agents/${agent.id}`).send({ defaultEnvironmentId: cloud.id, runtimeConfig: { aiConnection: binding } });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const saved = await readAgent();
    expect(saved.defaultEnvironmentId).toBe(cloud.id);
    expect(saved.runtimeConfig.aiConnection).toEqual(binding);
    expect(allocate).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
  });
});
