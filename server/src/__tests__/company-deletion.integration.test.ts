import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, boardApiKeys, companies, companyMemberships, createDb, goals, issueComments, issues, projects } from "@paperclipai/db";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { createBoardApiToken, hashBearerToken } from "../services/board-auth.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping company deletion integration tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

describeEmbeddedPostgres("company deletion through the configured server and real database", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-company-deletion-");
    db = createDb(temporary.connectionString);
  }, 90_000);

  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { await temporary?.cleanup(); });

  it.each([
    { mode: "local_trusted", setting: "false", enabled: false },
    { mode: "local_trusted", setting: undefined, enabled: true },
    { mode: "local_trusted", setting: "true", enabled: true },
    { mode: "authenticated", setting: "false", enabled: false },
    { mode: "authenticated", setting: undefined, enabled: false },
    { mode: "authenticated", setting: "true", enabled: true },
  ])("enforces $mode deletion=$setting without harming another company", async ({ mode, setting, enabled }) => {
    vi.stubEnv("PAPERCLIP_DEPLOYMENT_MODE", mode);
    vi.stubEnv("PAPERCLIP_DEPLOYMENT_EXPOSURE", "private");
    vi.stubEnv("PAPERCLIP_ENABLE_COMPANY_DELETION", setting);
    const config = loadConfig();
    expect(config.companyDeletionEnabled).toBe(enabled);

    const root = await mkdtemp(join(tmpdir(), "paperclip-delete-storage-"));
    async function seedCompany(name: string) {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const projectId = randomUUID();
      const goalId = randomUUID();
      const issueId = randomUUID();
      await db.insert(companies).values({ id: companyId, name, issuePrefix: "T" + companyId.slice(0, 8) });
      await db.insert(agents).values({
        id: agentId, companyId, name: "Synthetic idle agent", status: "idle",
        adapterType: "process", runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      });
      await db.insert(projects).values({ id: projectId, companyId, name: "Synthetic project" });
      await db.insert(goals).values({ id: goalId, companyId, title: "Synthetic goal", level: "company", status: "active" });
      await db.insert(issues).values({
        id: issueId, companyId, projectId, goalId, assigneeAgentId: agentId, title: "Synthetic task", status: "todo",
      });
      await db.insert(issueComments).values({ companyId, issueId, authorAgentId: agentId, body: "Synthetic comment" });
      return companyId;
    }
    async function snapshot(companyId: string) {
      return {
        companies: await db.select().from(companies).where(eq(companies.id, companyId)),
        agents: await db.select().from(agents).where(eq(agents.companyId, companyId)),
        projects: await db.select().from(projects).where(eq(projects.companyId, companyId)),
        goals: await db.select().from(goals).where(eq(goals.companyId, companyId)),
        issues: await db.select().from(issues).where(eq(issues.companyId, companyId)),
        comments: await db.select().from(issueComments).where(eq(issueComments.companyId, companyId)),
        memberships: await db.select().from(companyMemberships).where(eq(companyMemberships.companyId, companyId)),
      };
    }
    const companyId = await seedCompany("Synthetic deletion target");
    const controlId = await seedCompany("Synthetic retained control");
    const userId = randomUUID();
    const token = createBoardApiToken();
    await db.insert(authUsers).values({
      id: userId, name: "Deletion test board", email: `${userId}@fixture.invalid`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
    });
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: userId,
      status: "active", membershipRole: "member",
    });
    await db.insert(boardApiKeys).values({
      userId, name: "Ephemeral deletion test", keyHash: hashBearerToken(token),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const app = await createApp(db, {
      uiMode: "none", serverPort: 0,
      storageService: createStorageService(createLocalDiskStorageProvider(join(root, "storage"))),
      deploymentMode: config.deploymentMode, deploymentExposure: "private",
      allowedHostnames: ["127.0.0.1"], bindHost: "127.0.0.1", authReady: true,
      companyDeletionEnabled: config.companyDeletionEnabled,
      instanceId: `deletion-test-${randomUUID()}`,
      localPluginDir: join(root, "plugins"), managedPluginAutoInstall: [],
      decisionServiceOptions: { wakeOriginAgent: async () => undefined },
    });
    const server = createServer(app);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const health = await request(server).get("/api/health").auth(token, { type: "bearer" });
      expect(health.status).toBe(200);
      expect(health.body.features.companyDeletionEnabled).toBe(enabled);
      const beforeTarget = await snapshot(companyId);
      const beforeControl = await snapshot(controlId);
      if (mode === "authenticated") {
        expect((await request(server).delete(`/api/companies/${companyId}`)).status).toBe(401);
        expect(await snapshot(companyId)).toEqual(beforeTarget);
        expect((await request(server).delete(`/api/companies/${controlId}`).auth(token, { type: "bearer" })).status).toBe(403);
        expect(await snapshot(controlId)).toEqual(beforeControl);
      }
      const response = await request(server).delete(`/api/companies/${companyId}`).auth(token, { type: "bearer" });
      expect(response.status).toBe(enabled ? 200 : 403);
      expect(response.body).toEqual(enabled ? { ok: true } : { error: "Company deletion is disabled" });

      const afterTarget = await snapshot(companyId);
      if (enabled) {
        for (const rows of Object.values(afterTarget)) expect(rows).toHaveLength(0);
      } else {
        expect(afterTarget).toEqual(beforeTarget);
      }
      expect(await snapshot(controlId)).toEqual(beforeControl);
    } finally {
      await app.locals.bundledPluginsStartup;
      await app.locals.paperclipShutdown();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);
});
