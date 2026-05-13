import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  issues,
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
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(principalPermissionGrants);
    await db.delete(instanceUserRoles);
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

  it("archives members, clears grants, and reassigns open issues without deleting history", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    const member = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: `member-${randomUUID()}`,
        status: "active",
        membershipRole: "operator",
      })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "user",
      principalId: member.principalId,
      permissionKey: "tasks:assign",
      grantedByUserId: owner.principalId,
    });
    const openIssue = await db
      .insert(issues)
      .values({
        companyId: company.id,
        title: "Open assigned issue",
        status: "in_progress",
        assigneeUserId: member.principalId,
      })
      .returning()
      .then((rows) => rows[0]!);
    const doneIssue = await db
      .insert(issues)
      .values({
        companyId: company.id,
        title: "Historical assigned issue",
        status: "done",
        assigneeUserId: member.principalId,
      })
      .returning()
      .then((rows) => rows[0]!);

    const access = accessService(db);
    const result = await access.archiveMember(company.id, member.id, {
      reassignment: { assigneeUserId: owner.principalId },
    });

    expect(result?.reassignedIssueCount).toBe(1);
    const archived = await db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.id, member.id))
      .then((rows) => rows[0]!);
    expect(archived.status).toBe("archived");

    const remainingGrants = await db
      .select()
      .from(principalPermissionGrants)
      .where(eq(principalPermissionGrants.principalId, member.principalId));
    expect(remainingGrants).toHaveLength(0);

    const reassignedIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, openIssue.id))
      .then((rows) => rows[0]!);
    expect(reassignedIssue.assigneeUserId).toBe(owner.principalId);
    expect(reassignedIssue.status).toBe("todo");

    const historicalIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, doneIssue.id))
      .then((rows) => rows[0]!);
    expect(historicalIssue.assigneeUserId).toBe(member.principalId);
  });

  it("rejects instance-level company access removal for self and protected users", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    const access = accessService(db);

    await expect(
      access.setUserCompanyAccess(owner.principalId, [], { actorUserId: owner.principalId }),
    ).rejects.toThrow("You cannot remove yourself");

    const admin = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: `admin-${randomUUID()}`,
        status: "active",
        membershipRole: "admin",
      })
      .returning()
      .then((rows) => rows[0]!);

    await expect(
      access.setUserCompanyAccess(admin.principalId, [], { actorUserId: owner.principalId }),
    ).rejects.toThrow("Owners and admins cannot be removed from company access");

    const operator = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: `operator-${randomUUID()}`,
        status: "active",
        membershipRole: "operator",
      })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(instanceUserRoles).values({
      userId: operator.principalId,
      role: "instance_admin",
    });

    await expect(
      access.setUserCompanyAccess(operator.principalId, [], { actorUserId: owner.principalId }),
    ).rejects.toThrow("Instance admins cannot be removed from company access");
  });
});
