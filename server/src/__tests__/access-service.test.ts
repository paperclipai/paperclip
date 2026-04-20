import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
  projectAgents,
  projectMembers,
  projectPermissionGrants,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { accessService } from "../services/access.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createCompanyWithOwner(db: ReturnType<typeof createDb>) {
  const company = await db
    .insert(companies)
    .values({
      name: `Access Service ${randomUUID()}`,
      issuePrefix: `AS${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);

  const owner = await db
    .insert(companyMemberships)
    .values({
      companyId: company.id,
      principalType: "user",
      principalId: `owner-${randomUUID()}`,
      status: "active",
      membershipRole: "owner",
    })
    .returning()
    .then((rows) => rows[0]!);

  return { company, owner };
}

describeEmbeddedPostgres("access service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-access-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(projectAgents);
    await db.delete(projectMembers);
    await db.delete(projectPermissionGrants);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("rejects combined access updates that would demote the last active owner", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    const access = accessService(db);

    await expect(
      access.updateMemberAndPermissions(
        company.id,
        owner.id,
        { membershipRole: "admin", grants: [] },
        "admin-user",
      ),
    ).rejects.toThrow("Cannot remove the last active owner");

    const unchanged = await db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.id, owner.id))
      .then((rows) => rows[0]!);
    expect(unchanged.membershipRole).toBe("owner");
  });

  it("rejects role-only updates that would suspend the last active owner", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    const access = accessService(db);

    await expect(
      access.updateMember(company.id, owner.id, { status: "suspended" }),
    ).rejects.toThrow("Cannot remove the last active owner");

    const unchanged = await db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.id, owner.id))
      .then((rows) => rows[0]!);
    expect(unchanged.status).toBe("active");
  });

  describe("canAgentAccessProject (owner ∩ invites rule)", () => {
    async function seedOwnerWithTwoProjectsAndAgent() {
      const { company, owner } = await createCompanyWithOwner(db);
      const ownerUserId = owner.principalId;

      const [projectA, projectB] = await db
        .insert(projects)
        .values([
          { companyId: company.id, name: `Project A ${randomUUID()}` },
          { companyId: company.id, name: `Project B ${randomUUID()}` },
        ])
        .returning();

      const agent = await db
        .insert(agents)
        .values({
          companyId: company.id,
          ownerUserId,
          name: `Agent ${randomUUID()}`,
        })
        .returning()
        .then((rows) => rows[0]!);

      return { company, ownerUserId, projectA: projectA!, projectB: projectB!, agent };
    }

    it("grants access when agent is invited to a project its owner can access", async () => {
      const { company, projectA, agent } = await seedOwnerWithTwoProjectsAndAgent();
      const access = accessService(db);

      await db.insert(projectAgents).values({
        projectId: projectA.id,
        companyId: company.id,
        agentId: agent.id,
      });

      const allowed = await access.canAgentAccessProject(agent.id, projectA.id);
      expect(allowed).toBe(true);
    });

    it("denies access to a sibling project in the same company when the agent is not invited", async () => {
      const { company, projectA, projectB, agent } = await seedOwnerWithTwoProjectsAndAgent();
      const access = accessService(db);

      await db.insert(projectAgents).values({
        projectId: projectA.id,
        companyId: company.id,
        agentId: agent.id,
      });

      const leaked = await access.canAgentAccessProject(agent.id, projectB.id);
      expect(leaked).toBe(false);
    });

    it("denies access to a project in a company the agent's owner cannot reach", async () => {
      const { agent } = await seedOwnerWithTwoProjectsAndAgent();

      const foreign = await createCompanyWithOwner(db);
      const [foreignProject] = await db
        .insert(projects)
        .values({ companyId: foreign.company.id, name: `Foreign ${randomUUID()}` })
        .returning();

      await db.insert(projectAgents).values({
        projectId: foreignProject!.id,
        companyId: foreign.company.id,
        agentId: agent.id,
      });

      const access = accessService(db);
      const leaked = await access.canAgentAccessProject(agent.id, foreignProject!.id);
      expect(leaked).toBe(false);
    });

    it("denies access when the agent has no owner set", async () => {
      const { company, projectA, agent } = await seedOwnerWithTwoProjectsAndAgent();
      await db.update(agents).set({ ownerUserId: null }).where(eq(agents.id, agent.id));

      await db.insert(projectAgents).values({
        projectId: projectA.id,
        companyId: company.id,
        agentId: agent.id,
      });

      const access = accessService(db);
      const allowed = await access.canAgentAccessProject(agent.id, projectA.id);
      expect(allowed).toBe(false);
    });
  });
});
