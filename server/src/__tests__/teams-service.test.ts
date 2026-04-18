import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  departments,
  teamMemberships,
  teams,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { departmentService } from "../services/departments.ts";
import { teamService } from "../services/teams.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres team service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("teamService", () => {
  let db!: ReturnType<typeof createDb>;
  let teamsSvc!: ReturnType<typeof teamService>;
  let departmentsSvc!: ReturnType<typeof departmentService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-teams-service-");
    db = createDb(tempDb.connectionString);
    teamsSvc = teamService(db);
    departmentsSvc = departmentService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(teamMemberships);
    await db.delete(teams);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(departments);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertCompany(companyId = randomUUID()) {
    await db.insert(companies).values({
      id: companyId,
      name: `Paperclip ${companyId.slice(0, 6)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("rejects users who are not active company members", async () => {
    const companyId = await insertCompany();
    const department = await departmentsSvc.create(companyId, { name: "Support" });
    const team = await teamsSvc.create(companyId, { name: "Tier 1", departmentId: department.id });

    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "user-2",
      status: "suspended",
      membershipRole: "member",
    });

    await expect(
      teamsSvc.addMember(team.id, companyId, {
        principalType: "user",
        principalId: "user-2",
      }),
    ).rejects.toThrow(/active member/i);
  });

  it("allows active company agents to join a team", async () => {
    const companyId = await insertCompany();
    const department = await departmentsSvc.create(companyId, { name: "Product" });
    const team = await teamsSvc.create(companyId, { name: "Growth", departmentId: department.id });
    const agentId = randomUUID();

    await db.insert(agents).values({
      id: agentId,
      companyId,
      departmentId: department.id,
      name: "Agent Growth",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const membership = await teamsSvc.addMember(team.id, companyId, {
      principalType: "agent",
      principalId: agentId,
      role: "lead",
    });

    expect(membership.principalType).toBe("agent");
    expect(membership.principalId).toBe(agentId);
    expect(membership.role).toBe("lead");
  });

  it("creates a team with department", async () => {
    const companyId = await insertCompany();
    const dept = await departmentsSvc.create(companyId, { name: "Engineering" });
    const team = await teamsSvc.create(companyId, { name: "Backend", departmentId: dept.id });

    expect(team.name).toBe("Backend");
    expect(team.companyId).toBe(companyId);
    expect(team.departmentId).toBe(dept.id);
    expect(team.status).toBe("active");
  });

  it("creates a team without department", async () => {
    const companyId = await insertCompany();
    const team = await teamsSvc.create(companyId, { name: "Standalone Team" });

    expect(team.name).toBe("Standalone Team");
    expect(team.companyId).toBe(companyId);
    expect(team.departmentId).toBeNull();
    expect(team.status).toBe("active");
  });

  it("rejects duplicate team names within the same company", async () => {
    const companyId = await insertCompany();
    await teamsSvc.create(companyId, { name: "Alpha" });

    await expect(teamsSvc.create(companyId, { name: "Alpha" })).rejects.toThrow(/already exists/i);
  });

  it("updates team name and department", async () => {
    const companyId = await insertCompany();
    const deptA = await departmentsSvc.create(companyId, { name: "Dept A" });
    const deptB = await departmentsSvc.create(companyId, { name: "Dept B" });
    const team = await teamsSvc.create(companyId, { name: "Old Team", departmentId: deptA.id });

    const updated = await teamsSvc.update(team.id, { name: "New Team", departmentId: deptB.id });

    expect(updated.name).toBe("New Team");
    expect(updated.departmentId).toBe(deptB.id);
  });

  it("archives a team", async () => {
    const companyId = await insertCompany();
    const team = await teamsSvc.create(companyId, { name: "Temp Team" });

    const archived = await teamsSvc.archive(team.id);

    expect(archived.status).toBe("archived");
  });

  it("removes a team member", async () => {
    const companyId = await insertCompany();
    const dept = await departmentsSvc.create(companyId, { name: "Support" });
    const team = await teamsSvc.create(companyId, { name: "Tier 2", departmentId: dept.id });
    const agentId = randomUUID();

    await db.insert(agents).values({
      id: agentId,
      companyId,
      departmentId: dept.id,
      name: "Agent Support",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await teamsSvc.addMember(team.id, companyId, { principalType: "agent", principalId: agentId });
    await teamsSvc.removeMember(team.id, "agent", agentId);

    const members = await teamsSvc.listMembers(team.id);
    expect(members).toHaveLength(0);
  });

  it("rejects duplicate team membership", async () => {
    const companyId = await insertCompany();
    const dept = await departmentsSvc.create(companyId, { name: "Sales" });
    const team = await teamsSvc.create(companyId, { name: "Outbound", departmentId: dept.id });
    const agentId = randomUUID();

    await db.insert(agents).values({
      id: agentId,
      companyId,
      departmentId: dept.id,
      name: "Agent Sales",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await teamsSvc.addMember(team.id, companyId, { principalType: "agent", principalId: agentId });

    await expect(
      teamsSvc.addMember(team.id, companyId, { principalType: "agent", principalId: agentId }),
    ).rejects.toThrow(/already a member/i);
  });

  it("lists teams for a company", async () => {
    const companyId = await insertCompany();
    await teamsSvc.create(companyId, { name: "Team One" });
    await teamsSvc.create(companyId, { name: "Team Two" });

    const all = await teamsSvc.list(companyId);

    expect(all).toHaveLength(2);
  });
});
