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
});
