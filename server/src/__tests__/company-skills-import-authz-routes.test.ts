import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  companySkills,
  createDb,
  heartbeatRuns,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { companySkillRoutes } from "../routes/company-skills.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company skill import auth route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("company skill import authorization routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let paperclipHome: string | null = null;
  const cleanupDirs = new Set<string>();
  const previousAgentJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const previousPaperclipHome = process.env.PAPERCLIP_HOME;
  const previousPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "company-skills-import-authz-test-secret";
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-company-skills-import-authz-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-skills-import-authz-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companySkills);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
    await Promise.all(Array.from(cleanupDirs, (dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (paperclipHome) {
      await fs.rm(paperclipHome, { recursive: true, force: true });
    }
    if (previousAgentJwtSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousAgentJwtSecret;
    if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousPaperclipHome;
    if (previousPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = previousPaperclipInstanceId;
  });

  function authenticatedApp() {
    const instance = express();
    instance.use(express.json());
    instance.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    instance.use("/api", companySkillRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  async function writeSkillFixture(companyId: string) {
    if (!paperclipHome) throw new Error("Expected Paperclip test home");
    // Local imports must originate from an approved root (managed-skill
    // directory or a configured workspace); a bare tmpdir is rejected with
    // skill_workspace_boundary_denied.
    const managedRoot = path.join(paperclipHome, "instances", "default", "skills", companyId);
    await fs.mkdir(managedRoot, { recursive: true });
    const skillDir = await fs.mkdtemp(path.join(managedRoot, "paperclip-import-authz-skill-"));
    cleanupDirs.add(skillDir);
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: Import Authz Fixture",
        "description: Route-level import authorization fixture.",
        "---",
        "",
        "# Import Authz Fixture",
        "",
      ].join("\n"),
      "utf8",
    );
    return skillDir;
  }

  async function seedGrantedAgentWithResponsibleUser() {
    const [company] = await db.insert(companies).values({
      name: "Company Skill Import Authz",
      issuePrefix: `IA${randomUUID().replace(/-/g, "").slice(0, 6)}`,
    }).returning();
    const companyId = company!.id;

    const [agent] = await db.insert(agents).values({
      companyId,
      name: "Skill Import Agent",
      role: "ceo",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: { canCreateSkills: false },
    }).returning();
    const agentId = agent!.id;

    const responsibleUserId = `user-${randomUUID()}`;
    await db.insert(authUsers).values({
      id: responsibleUserId,
      name: "Responsible User",
      email: `${responsibleUserId}@example.com`,
      emailVerified: true,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(companyMemberships).values([
      {
        companyId,
        principalType: "agent",
        principalId: agentId,
        status: "active",
        membershipRole: "member",
      },
      {
        companyId,
        principalType: "user",
        principalId: responsibleUserId,
        status: "active",
        membershipRole: "operator",
      },
    ]);
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "agent",
      principalId: agentId,
      permissionKey: "skills:create",
      scope: null,
      grantedByUserId: null,
    });

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      responsibleUserId,
    });
    return { companyId, agent: agent!, responsibleUserId, runId };
  }

  it("lets a standard responsible-user agent JWT with skills:create import a company skill", async () => {
    const { companyId, agent, responsibleUserId, runId } = await seedGrantedAgentWithResponsibleUser();
    const skillDir = await writeSkillFixture(companyId);
    const token = createLocalAgentJwt(agent.id, companyId, agent.adapterType, runId, responsibleUserId);
    expect(token).toBeTruthy();

    const res = await request(authenticatedApp())
      .post(`/api/companies/${companyId}/skills/import`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ source: skillDir });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.imported).toHaveLength(1);
    expect(res.body.imported[0]).toMatchObject({
      slug: "import-authz-fixture",
      name: "Import Authz Fixture",
      sourceType: "local_path",
    });

    const [importActivity] = await db.select().from(activityLog);
    expect(importActivity).toMatchObject({
      companyId,
      actorType: "agent",
      actorId: agent.id,
      agentId: agent.id,
      runId,
      action: "company.skills_imported",
      entityType: "company",
      entityId: companyId,
    });
  });
});
