import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  instanceSettings,
  smokeRuns,
  smokeRunSteps,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { smokeLabRoutes } from "../routes/smoke-lab.js";
import { SMOKE_LAB_OAUTH_SCOPE } from "../services/smoke-lab.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

async function createCompany(db: TestDb) {
  return db.insert(companies).values({
    name: `Smoke Lab ${randomUUID()}`,
    issuePrefix: `SL${randomUUID().slice(0, 6).toUpperCase()}`,
  }).returning().then((rows) => rows[0]!);
}

async function enableSmokeLab(db: TestDb) {
  await db.insert(instanceSettings).values({
    singletonKey: "default",
    experimental: { enableSmokeLab: true },
  }).onConflictDoUpdate({
    target: [instanceSettings.singletonKey],
    set: { experimental: { enableSmokeLab: true }, updatedAt: new Date() },
  });
}

async function createAgent(db: TestDb, companyId: string) {
  return db.insert(agents).values({
    companyId,
    name: `Smoke Agent ${randomUUID()}`,
    role: "qa",
    status: "active",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
  }).returning().then((rows) => rows[0]!);
}

function boardActor(companyId?: string): Express.Request["actor"] {
  return {
    type: "board",
    userId: "board-user",
    userName: "Board User",
    userEmail: null,
    isInstanceAdmin: true,
    source: "local_implicit",
    companyIds: companyId ? [companyId] : [],
  };
}

function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
  return {
    type: "agent",
    companyId,
    agentId,
    runId,
    source: "agent_jwt",
  };
}

function createRouteApp(
  db: TestDb,
  actor?: Express.Request["actor"],
  options: Parameters<typeof smokeLabRoutes>[1] = { nodeEnv: "test" },
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor ?? { type: "none", source: "none" };
    next();
  });
  app.use("/api", smokeLabRoutes(db, { nodeEnv: "test", ...options }));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("smoke lab service pack and results API", () => {
  let db: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-smoke-lab-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.delete(activityLog);
    await db.delete(smokeRunSteps);
    await db.delete(smokeRuns);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfiles);
    await db.delete(toolCatalogEntries);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("gates smoke lab behind the experimental flag and public exposure, not auth mode or NODE_ENV", async () => {
    const company = await createCompany(db);

    // Flag off -> hidden (404) regardless of deployment.
    await request(createRouteApp(db, boardActor(company.id)))
      .get(`/api/companies/${company.id}/smoke-lab/services`)
      .expect(404);

    await enableSmokeLab(db);

    // Public exposure is the only disallowed deployment -> 403.
    await request(createRouteApp(db, boardActor(company.id), { deploymentMode: "authenticated", deploymentExposure: "public" }))
      .get(`/api/companies/${company.id}/smoke-lab/services`)
      .expect(403);

    // Authenticated + private (e.g. a Tailscale dev box) is allowed, even when the
    // instance runs a production Node build.
    await request(createRouteApp(db, boardActor(company.id), { deploymentMode: "authenticated", deploymentExposure: "private", nodeEnv: "production" }))
      .get(`/api/companies/${company.id}/smoke-lab/services`)
      .expect(200);
  });

  it("runs the deterministic fake OAuth code, refresh, userinfo, and revoke flow", async () => {
    const company = await createCompany(db);
    await enableSmokeLab(db);
    const app = createRouteApp(db);
    const redirectUri = "http://127.0.0.1/callback";

    const page = await request(app)
      .get(`/api/companies/${company.id}/smoke-lab/oauth/authorize`)
      .query({ client_id: "smoke-client", redirect_uri: redirectUri, state: "state-1", response_type: "code" })
      .expect(200);
    expect(page.text).toContain("SMOKE TEST - not a real provider");
    expect(page.text).toContain("smoke@paperclip.test");
    expect(page.text).toContain(SMOKE_LAB_OAUTH_SCOPE);

    const authorizeBody = {
      client_id: "smoke-client",
      redirect_uri: redirectUri,
      state: "state-1",
      response_type: "code",
      scope: SMOKE_LAB_OAUTH_SCOPE,
      email: "smoke@paperclip.test",
      password: "smoke-password",
    };
    const authorize = await request(app)
      .post(`/api/companies/${company.id}/smoke-lab/oauth/authorize`)
      .type("form")
      .send(authorizeBody)
      .expect(302);
    const redirected = new URL(authorize.headers.location);
    const code = redirected.searchParams.get("code");
    expect(code).toMatch(/^smoke_code_/);
    expect(redirected.searchParams.get("state")).toBe("state-1");

    const token = await request(app)
      .post(`/api/companies/${company.id}/smoke-lab/oauth/token`)
      .type("form")
      .send({ grant_type: "authorization_code", code, client_id: "smoke-client", redirect_uri: redirectUri })
      .expect(200);
    expect(token.body.access_token).toMatch(/^smoke_access_/);
    expect(token.body.refresh_token).toMatch(/^smoke_refresh_/);
    expect(token.body.scope).toBe(SMOKE_LAB_OAUTH_SCOPE);

    const repeatAuthorize = await request(app)
      .post(`/api/companies/${company.id}/smoke-lab/oauth/authorize`)
      .type("form")
      .send(authorizeBody)
      .expect(302);
    const repeatCode = new URL(repeatAuthorize.headers.location).searchParams.get("code");
    expect(repeatCode).toBe(code);
    const repeatToken = await request(app)
      .post(`/api/companies/${company.id}/smoke-lab/oauth/token`)
      .type("form")
      .send({ grant_type: "authorization_code", code: repeatCode, client_id: "smoke-client", redirect_uri: redirectUri })
      .expect(200);
    expect(repeatToken.body.access_token).toBe(token.body.access_token);
    expect(repeatToken.body.refresh_token).toBe(token.body.refresh_token);

    const refreshed = await request(app)
      .post(`/api/companies/${company.id}/smoke-lab/oauth/token`)
      .type("form")
      .send({ grant_type: "refresh_token", refresh_token: token.body.refresh_token })
      .expect(200);
    expect(refreshed.body.access_token).toMatch(/^smoke_access_/);
    expect(refreshed.body.scope).toBe(SMOKE_LAB_OAUTH_SCOPE);

    const userinfo = await request(app)
      .get(`/api/companies/${company.id}/smoke-lab/oauth/userinfo`)
      .set("Authorization", `Bearer ${refreshed.body.access_token}`)
      .expect(200);
    expect(userinfo.body).toMatchObject({ sub: "smoke-user-1", email: "smoke@paperclip.test" });

    await request(app)
      .post(`/api/companies/${company.id}/smoke-lab/oauth/revoke`)
      .type("form")
      .send({ token: refreshed.body.access_token })
      .expect(200);

    await request(app)
      .get(`/api/companies/${company.id}/smoke-lab/oauth/userinfo`)
      .set("Authorization", `Bearer ${refreshed.body.access_token}`)
      .expect(403);
  });

  it("rejects real-looking vendor scopes at the fake OAuth provider", async () => {
    const company = await createCompany(db);
    await enableSmokeLab(db);
    const app = createRouteApp(db);
    const redirectUri = "http://127.0.0.1/callback";

    await request(app)
      .get(`/api/companies/${company.id}/smoke-lab/oauth/authorize`)
      .query({ client_id: "smoke-client", redirect_uri: redirectUri, scope: "repo user:email offline_access", response_type: "code" })
      .expect(400);

    await request(app)
      .post(`/api/companies/${company.id}/smoke-lab/oauth/authorize`)
      .type("form")
      .send({
        client_id: "smoke-client",
        redirect_uri: redirectUri,
        scope: "repo user:email offline_access",
        email: "smoke@paperclip.test",
        password: "smoke-password",
      })
      .expect(400);
  });

  it("requires a loopback or same-origin HTTP(S) redirect URI before rendering or completing consent", async () => {
    const company = await createCompany(db);
    await enableSmokeLab(db);
    const app = createRouteApp(db);
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "http://paperclip-dev:45439");

    // A redirect host that is neither loopback nor the instance's own origin
    // could leak fixture authorization codes off the gated deployment.
    await request(app)
      .get(`/api/companies/${company.id}/smoke-lab/oauth/authorize`)
      .query({ client_id: "smoke-client", redirect_uri: "http://other-host:45439/callback", response_type: "code" })
      .expect(403);

    // The instance's own (non-loopback) origin is fine — the smoke lab runs on
    // any private instance, e.g. an authenticated Tailscale host.
    await request(app)
      .get(`/api/companies/${company.id}/smoke-lab/oauth/authorize`)
      .query({ client_id: "smoke-client", redirect_uri: "http://paperclip-dev:45439/callback", response_type: "code" })
      .expect(200);

    await request(app)
      .post(`/api/companies/${company.id}/smoke-lab/oauth/authorize`)
      .type("form")
      .send({
        client_id: "smoke-client",
        redirect_uri: "http://paperclip-dev:45439/api/tools/oauth/callback",
        email: "smoke@paperclip.test",
        password: "smoke-password",
      })
      .expect(302);

    await request(app)
      .post(`/api/companies/${company.id}/smoke-lab/oauth/authorize`)
      .type("form")
      .send({
        client_id: "smoke-client",
        redirect_uri: "http://127.0.0.2/callback",
        email: "smoke@paperclip.test",
        password: "smoke-password",
      })
      .expect(302);

    await request(app)
      .post(`/api/companies/${company.id}/smoke-lab/oauth/authorize`)
      .type("form")
      .send({
        client_id: "smoke-client",
        redirect_uri: "ftp://localhost/callback",
        email: "smoke@paperclip.test",
        password: "smoke-password",
      })
      .expect(400);
  });

  it("does not trust the Host header as the OAuth redirect origin", async () => {
    const company = await createCompany(db);
    await enableSmokeLab(db);
    const app = createRouteApp(db);
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "");
    vi.stubEnv("PAPERCLIP_AUTH_PUBLIC_BASE_URL", "");
    vi.stubEnv("BETTER_AUTH_URL", "");
    vi.stubEnv("BETTER_AUTH_BASE_URL", "");

    await request(app)
      .get(`/api/companies/${company.id}/smoke-lab/oauth/authorize`)
      .set("Host", "attacker.example")
      .query({
        client_id: "smoke-client",
        redirect_uri: "http://attacker.example/callback",
        response_type: "code",
      })
      .expect(403);
  });

  it("installs smoke fixtures idempotently into tool access tables", async () => {
    const company = await createCompany(db);
    await enableSmokeLab(db);
    const app = createRouteApp(db, boardActor(company.id));

    const first = await request(app)
      .post(`/api/companies/${company.id}/smoke-lab/install-fixtures`)
      .expect(201);
    const second = await request(app)
      .post(`/api/companies/${company.id}/smoke-lab/install-fixtures`)
      .expect(200);

    expect(first.body.created).toBe(true);
    expect(second.body.created).toBe(false);
    expect(first.body.applications).toHaveLength(2);
    expect(first.body.connections).toHaveLength(2);
    expect(first.body.catalog.length).toBeGreaterThanOrEqual(6);
    expect(first.body.profileEntries.every((entry: { toolName: string }) => entry.toolName.includes(".") || entry.toolName)).toBe(true);

    const applications = await db.select().from(toolApplications).where(eq(toolApplications.companyId, company.id));
    const connections = await db.select().from(toolConnections).where(eq(toolConnections.companyId, company.id));
    const catalog = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.companyId, company.id));
    const profiles = await db.select().from(toolProfiles).where(eq(toolProfiles.companyId, company.id));
    expect(applications).toHaveLength(2);
    expect(connections).toHaveLength(2);
    expect(catalog.some((entry) => entry.toolName === "todo.add" && entry.riskLevel === "write")).toBe(true);
    expect(catalog.some((entry) => entry.toolName === "time.now" && entry.riskLevel === "read")).toBe(true);
    expect(profiles).toHaveLength(1);
  });

  it("creates runs and lets an agent JWT actor record step results", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    await enableSmokeLab(db);

    const boardApp = createRouteApp(db, boardActor(company.id));
    const created = await request(boardApp)
      .post(`/api/companies/${company.id}/smoke-lab/runs`)
      .send({ trigger: "manual", summary: { scenario: "P1" } })
      .expect(201);
    const runId = created.body.run.id;

    const [heartbeatRun] = await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: agent.id,
      invocationSource: "manual",
      status: "running",
    }).returning();
    const agentApp = createRouteApp(db, agentActor(company.id, agent.id, heartbeatRun!.id));
    const step = await request(agentApp)
      .post(`/api/companies/${company.id}/smoke-lab/runs/${runId}/steps`)
      .send({
        path: "P1",
        scenarioStep: "oauth-login",
        status: "pass",
        detail: "OAuth login completed",
        screenshotArtifactRef: { provider: "paperclip", attachmentId: randomUUID() },
        durationMs: 42,
      })
      .expect(201);
    expect(step.body.step).toMatchObject({ path: "P1", scenarioStep: "oauth-login", status: "pass" });
    expect(step.body.summary).toMatchObject({ totalSteps: 1, passedSteps: 1, failedSteps: 0 });

    const fetched = await request(boardApp)
      .get(`/api/companies/${company.id}/smoke-lab/runs/${runId}`)
      .expect(200);
    expect(fetched.body.steps).toHaveLength(1);

    await request(boardApp)
      .patch(`/api/companies/${company.id}/smoke-lab/runs/${runId}`)
      .send({ status: "passed", summary: { totalSteps: 1, passedSteps: 1 } })
      .expect(200);

    await request(agentApp)
      .post(`/api/companies/${company.id}/smoke-lab/runs/${runId}/steps`)
      .send({ path: "P1", scenarioStep: "late", status: "pass" })
      .expect(409);
  });
});
