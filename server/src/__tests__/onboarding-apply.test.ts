import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  adapterReadinessProbes,
  companyOnboardingSetups,
  companySecrets,
  companies,
  createDb,
  environments,
  goals,
  issues,
  pluginCompanySettings,
  plugins,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import type { OnboardingApplyRequest, OnboardingScanResponse, PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { DEFAULT_CODEX_LOCAL_MODEL } from "@paperclipai/adapter-codex-local";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { companyRoutes } from "../routes/companies.js";
import { onboardingRoutes } from "../routes/onboarding.js";
import { recommendOnboardingSetup } from "../services/onboarding-recommend.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres onboarding apply tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function scan(overrides: Partial<OnboardingScanResponse> = {}): OnboardingScanResponse {
  return {
    displayPath: "/Users/example/projects/my-app",
    repoKind: "brownfield",
    counts: {
      directories: 3,
      files: 10,
      ignoredDirectories: 1,
      symlinks: 0,
    },
    detectedStacks: ["node", "typescript", "react"],
    packageManagers: ["pnpm"],
    safeManifestIndicators: ["package.json", "tsconfig.json"],
    warnings: [],
    boundedSanitizedSummary: {
      projectName: "my-app",
      dependencies: ["express", "react"],
      devDependencies: ["typescript", "vite"],
      hasReadme: true,
      directoryStructure: ["package.json", "src/"],
    },
    ...overrides,
  };
}

function createApplyRequest(): OnboardingApplyRequest {
  return recommendOnboardingSetup({
    scanSummary: scan(),
    userGoals: "Prepare this repo for an MVP demo",
  });
}

function app(db: ReturnType<typeof createDb>, actor: Partial<Express.Request["actor"]> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      source: "local_implicit",
      userId: "11111111-1111-4111-8111-111111111111",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: true,
      ...actor,
    } as typeof req.actor;
    next();
  });
  app.use("/api", onboardingRoutes(db));
  app.use("/api/companies", companyRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("onboarding apply", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-onboarding-apply-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(adapterReadinessProbes);
    await db.delete(companyOnboardingSetups);
    await db.delete(companySecrets);
    await db.delete(pluginCompanySettings);
    await db.delete(plugins);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("transactionally creates a first-run company workspace and starter issue", async () => {
    const res = await request(app(db))
      .post("/api/onboarding/apply")
      .send(createApplyRequest());

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.company).toMatchObject({
      name: "My App Company",
      issuePrefix: "MYA",
    });
    expect(res.body.agents.map((agent: { adapterType: string }) => agent.adapterType)).toEqual([
      "claude_local",
      "codex_local",
      "agy_local",
    ]);
    expect(res.body.projectWorkspace).toMatchObject({
      name: "my-app-core",
      cwd: "/Users/example/projects/my-app",
    });
    expect(res.body.starterIssue).toMatchObject({
      identifier: "MYA-1",
      title: "Run Codebase Health Audit and Diagnostics",
    });

    const companyRows = await db.select().from(companies);
    const agentRows = await db.select().from(agents).where(eq(agents.companyId, res.body.company.id));
    const goalRows = await db.select().from(goals).where(eq(goals.companyId, res.body.company.id));
    const projectRows = await db.select().from(projects).where(eq(projects.companyId, res.body.company.id));
    const workspaceRows = await db
      .select()
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.companyId, res.body.company.id));
    const issueRows = await db.select().from(issues).where(eq(issues.companyId, res.body.company.id));
    const environmentRows = await db.select().from(environments).where(eq(environments.companyId, res.body.company.id));
    const activityRows = await db.select().from(activityLog).where(eq(activityLog.companyId, res.body.company.id));

    expect(companyRows).toHaveLength(1);
    expect(agentRows).toHaveLength(3);
    expect(agentRows.find((agent) => agent.adapterType === "codex_local")?.adapterConfig).toEqual({
      model: DEFAULT_CODEX_LOCAL_MODEL,
    });
    expect(agentRows.find((agent) => agent.adapterType === "agy_local")?.adapterConfig).toEqual({
      model: "gemini-3.5-flash",
    });
    expect(goalRows).toHaveLength(1);
    expect(projectRows).toHaveLength(1);
    expect(workspaceRows).toHaveLength(1);
    expect(workspaceRows[0]).toMatchObject({ cwd: "/Users/example/projects/my-app", isPrimary: true });
    expect(issueRows).toHaveLength(1);
    expect(issueRows[0]).toMatchObject({
      identifier: "MYA-1",
      status: "backlog",
      priority: "high",
      originKind: "onboarding",
      projectWorkspaceId: workspaceRows[0].id,
    });
    expect(issueRows[0].checkoutRunId).toBeNull();
    expect(issueRows[0].executionRunId).toBeNull();
    expect(environmentRows).toHaveLength(1);
    expect(environmentRows[0]).toMatchObject({ driver: "local", status: "active" });
    expect(activityRows.map((row) => row.action)).toEqual(
      expect.arrayContaining(["onboarding.applied", "issue.created"]),
    );
  });

  it("exposes pending deferred setup state for the created company", async () => {
    const applyRes = await request(app(db))
      .post("/api/onboarding/apply")
      .send(createApplyRequest());

    expect(applyRes.status, JSON.stringify(applyRes.body)).toBe(201);

    const setupRes = await request(app(db))
      .get(`/api/companies/${applyRes.body.company.id}/onboarding-setup`);

    expect(setupRes.status, JSON.stringify(setupRes.body)).toBe(200);
    expect(setupRes.body).toMatchObject({
      companyId: applyRes.body.company.id,
      status: "pending",
      starterIssueId: applyRes.body.starterIssue.id,
      items: expect.arrayContaining([
        expect.objectContaining({ key: "local_auth", status: "pending" }),
        expect.objectContaining({ key: "optional_secrets", status: "deferred" }),
        expect.objectContaining({ key: "mcps", status: "deferred" }),
      ]),
    });
  });

  it("allows board users to dismiss deferred onboarding setup state", async () => {
    const applyRes = await request(app(db))
      .post("/api/onboarding/apply")
      .send(createApplyRequest());

    expect(applyRes.status, JSON.stringify(applyRes.body)).toBe(201);

    const dismissRes = await request(app(db))
      .patch(`/api/companies/${applyRes.body.company.id}/onboarding-setup`)
      .send({ status: "dismissed" });

    expect(dismissRes.status, JSON.stringify(dismissRes.body)).toBe(200);
    expect(dismissRes.body).toMatchObject({
      companyId: applyRes.body.company.id,
      status: "dismissed",
    });

    const setupRes = await request(app(db))
      .get(`/api/companies/${applyRes.body.company.id}/onboarding-setup`);
    expect(setupRes.body).toMatchObject({ status: "dismissed" });
  });

  it("updates individual deferred setup checklist items", async () => {
    const applyRes = await request(app(db))
      .post("/api/onboarding/apply")
      .send(createApplyRequest());

    expect(applyRes.status, JSON.stringify(applyRes.body)).toBe(201);

    const updateRes = await request(app(db))
      .patch(`/api/companies/${applyRes.body.company.id}/onboarding-setup`)
      .send({ itemKey: "local_auth", itemStatus: "completed" });

    expect(updateRes.status, JSON.stringify(updateRes.body)).toBe(200);
    expect(updateRes.body).toMatchObject({
      companyId: applyRes.body.company.id,
      status: "pending",
      items: expect.arrayContaining([
        expect.objectContaining({ key: "local_auth", status: "completed" }),
        expect.objectContaining({ key: "optional_secrets", status: "deferred" }),
      ]),
    });
  });

  it("refreshes setup checklist items from adapter readiness and secret evidence", async () => {
    const applyRes = await request(app(db))
      .post("/api/onboarding/apply")
      .send(createApplyRequest());

    expect(applyRes.status, JSON.stringify(applyRes.body)).toBe(201);
    const companyId = applyRes.body.company.id;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60_000);

    await db.insert(adapterReadinessProbes).values(
      applyRes.body.agents.map((agent: { id: string; adapterType: string }) => ({
        companyId,
        agentId: agent.id,
        adapterType: agent.adapterType,
        status: "warning",
        basicReady: true,
        operationalReady: true,
        fixtureReady: false,
        reasonCodesJson: ["fixture_run_missing"],
        modelSource: "agent_config",
        modelAvailable: true,
        modelRunnable: true,
        modelPolicyStatus: "ok",
        roleFit: "ok",
        checkedAt: now,
        expiresAt,
        createdAt: now,
      })),
    );
    await db.insert(companySecrets).values({
      companyId,
      key: "PROJECT_RUNTIME_ENV",
      name: "PROJECT_RUNTIME_ENV",
      provider: "local_encrypted",
      status: "active",
      latestVersion: 1,
      createdAt: now,
      updatedAt: now,
    });

    const refreshRes = await request(app(db))
      .post(`/api/companies/${companyId}/onboarding-setup/refresh`)
      .send({});

    expect(refreshRes.status, JSON.stringify(refreshRes.body)).toBe(200);
    expect(refreshRes.body).toMatchObject({
      companyId,
      status: "pending",
      items: expect.arrayContaining([
        expect.objectContaining({ key: "local_auth", status: "completed" }),
        expect.objectContaining({ key: "optional_secrets", status: "completed" }),
        expect.objectContaining({ key: "mcps", status: "deferred" }),
      ]),
    });
  });

  it("refreshes the MCP setup item from ready tool plugins enabled for the company", async () => {
    const applyRes = await request(app(db))
      .post("/api/onboarding/apply")
      .send(createApplyRequest());

    expect(applyRes.status, JSON.stringify(applyRes.body)).toBe(201);
    const companyId = applyRes.body.company.id;
    const now = new Date();
    const manifest: PaperclipPluginManifestV1 = {
      id: "acme.repo-tools",
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Repo Tools",
      description: "Repository helper tools",
      author: "Acme",
      categories: [],
      capabilities: ["agent.tools.register"],
      entrypoints: { worker: "dist/worker.js" },
      tools: [
        {
          name: "search-repo",
          displayName: "Search repo",
          description: "Search repository files",
          parametersSchema: { type: "object", properties: {} },
        },
      ],
    };

    const [plugin] = await db.insert(plugins).values({
      pluginKey: manifest.id,
      packageName: "@acme/repo-tools",
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      categories: manifest.categories,
      manifestJson: manifest,
      status: "ready",
      installOrder: 1,
      installedAt: now,
      updatedAt: now,
    }).returning();

    await db.insert(pluginCompanySettings).values({
      companyId,
      pluginId: plugin.id,
      enabled: true,
      settingsJson: {},
      createdAt: now,
      updatedAt: now,
    });

    const refreshRes = await request(app(db))
      .post(`/api/companies/${companyId}/onboarding-setup/refresh`)
      .send({});

    expect(refreshRes.status, JSON.stringify(refreshRes.body)).toBe(200);
    expect(refreshRes.body).toMatchObject({
      companyId,
      status: "pending",
      items: expect.arrayContaining([
        expect.objectContaining({ key: "mcps", status: "completed" }),
      ]),
    });
  });

  it("does not complete the MCP setup item from ready tool plugins disabled for the company", async () => {
    const applyRes = await request(app(db))
      .post("/api/onboarding/apply")
      .send(createApplyRequest());

    expect(applyRes.status, JSON.stringify(applyRes.body)).toBe(201);
    const companyId = applyRes.body.company.id;
    const now = new Date();
    const manifest: PaperclipPluginManifestV1 = {
      id: "acme.disabled-tools",
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Disabled Tools",
      description: "Repository helper tools",
      author: "Acme",
      categories: [],
      capabilities: ["agent.tools.register"],
      entrypoints: { worker: "dist/worker.js" },
      tools: [
        {
          name: "search-repo",
          displayName: "Search repo",
          description: "Search repository files",
          parametersSchema: { type: "object", properties: {} },
        },
      ],
    };

    const [plugin] = await db.insert(plugins).values({
      pluginKey: manifest.id,
      packageName: "@acme/disabled-tools",
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      categories: manifest.categories,
      manifestJson: manifest,
      status: "ready",
      installOrder: 1,
      installedAt: now,
      updatedAt: now,
    }).returning();

    await db.insert(pluginCompanySettings).values({
      companyId,
      pluginId: plugin.id,
      enabled: false,
      settingsJson: {},
      createdAt: now,
      updatedAt: now,
    });

    const refreshRes = await request(app(db))
      .post(`/api/companies/${companyId}/onboarding-setup/refresh`)
      .send({});

    expect(refreshRes.status, JSON.stringify(refreshRes.body)).toBe(200);
    expect(refreshRes.body).toMatchObject({
      companyId,
      status: "pending",
      items: expect.arrayContaining([
        expect.objectContaining({ key: "mcps", status: "deferred" }),
      ]),
    });
  });

  it("rejects stale codex_local Gemini model payloads before writing", async () => {
    const payload = createApplyRequest();
    payload.proposedSquads = payload.proposedSquads.map((squad) =>
      squad.adapterType === "codex_local"
        ? { ...squad, model: "gemini-3.5-flash" }
        : squad,
    );

    const res = await request(app(db))
      .post("/api/onboarding/apply")
      .send(payload);

    expect(res.status).toBe(400);
    expect(await db.select().from(companies)).toHaveLength(0);
  });

  it("rejects agent actors", async () => {
    const res = await request(app(db, {
      type: "agent",
      companyId: "company-1",
      agentId: "agent-1",
      runId: null,
    } as Partial<Express.Request["actor"]>))
      .post("/api/onboarding/apply")
      .send(createApplyRequest());

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Board access required" });
    expect(await db.select().from(companies)).toHaveLength(0);
  });

  it("initializes git in a non-git project workspace so the starter audit can launch", async () => {
    const execFileAsync = promisify(execFile);
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pc-apply-greenfield-"));
    try {
      const applyRequest = createApplyRequest();
      applyRequest.proposedProjectWorkspace.cwd = workspaceDir;

      const res = await request(app(db)).post("/api/onboarding/apply").send(applyRequest);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.projectWorkspace.cwd).toBe(workspaceDir);

      // The local adapter git-repo-check now passes because onboarding made the
      // workspace a real git work tree.
      const inside = await execFileAsync("git", ["-C", workspaceDir, "rev-parse", "--is-inside-work-tree"]);
      expect(inside.stdout.trim()).toBe("true");

      const activityRows = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.companyId, res.body.company.id));
      expect(activityRows.map((row) => row.action)).toContain("onboarding.workspace_git_initialized");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
