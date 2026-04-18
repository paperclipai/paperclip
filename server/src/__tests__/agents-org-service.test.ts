import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, departments } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres org grouping tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type OrgNodeLike = { id: string; reports: OrgNodeLike[] };
type DepartmentGroupLike = {
  department: { id: string; name: string } | null;
  memberCount: number;
  roots: OrgNodeLike[];
};

describeEmbeddedPostgres("agentService.orgByDepartmentForCompany", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof agentService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-org-service-");
    db = createDb(tempDb.connectionString);
    svc = agentService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(departments);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("builds per-department forests and resets cross-department managers to local roots", async () => {
    const companyId = randomUUID();
    const engineeringId = randomUUID();
    const financeId = randomUUID();
    const engineeringLeadId = randomUUID();
    const platformId = randomUUID();
    const financeLeadId = randomUUID();
    const analystId = randomUUID();
    const unassignedId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "ORG01",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(departments).values([
      { id: engineeringId, companyId, name: "Engineering", status: "active", sortOrder: 0 },
      { id: financeId, companyId, name: "Finance", status: "active", sortOrder: 1 },
    ]);

    await db.insert(agents).values([
      {
        id: engineeringLeadId,
        companyId,
        departmentId: engineeringId,
        name: "Engineering Lead",
        role: "ceo",
        status: "active",
        reportsTo: null,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: platformId,
        companyId,
        departmentId: engineeringId,
        name: "Platform Engineer",
        role: "engineer",
        status: "active",
        reportsTo: engineeringLeadId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: financeLeadId,
        companyId,
        departmentId: financeId,
        name: "Finance Lead",
        role: "manager",
        status: "active",
        reportsTo: engineeringLeadId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: analystId,
        companyId,
        departmentId: financeId,
        name: "Finance Analyst",
        role: "analyst",
        status: "active",
        reportsTo: financeLeadId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: unassignedId,
        companyId,
        departmentId: null,
        name: "Floating Agent",
        role: "engineer",
        status: "active",
        reportsTo: financeLeadId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const groups = await svc.orgByDepartmentForCompany(companyId) as unknown as DepartmentGroupLike[];

    expect(groups.map((group) => group.department?.name ?? "Unassigned")).toEqual([
      "Engineering",
      "Finance",
      "Unassigned",
    ]);

    const engineering = groups[0]!;
    expect(engineering.memberCount).toBe(2);
    expect(engineering.roots[0]?.id).toBe(engineeringLeadId);
    expect(engineering.roots[0]?.reports[0]?.id).toBe(platformId);

    const finance = groups[1]!;
    expect(finance.memberCount).toBe(2);
    expect(finance.roots[0]?.id).toBe(financeLeadId);
    expect(finance.roots[0]?.reports[0]?.id).toBe(analystId);

    const unassigned = groups[2]!;
    expect(unassigned.department).toBeNull();
    expect(unassigned.memberCount).toBe(1);
    expect(unassigned.roots[0]?.id).toBe(unassignedId);
    expect(unassigned.roots[0]?.reports).toHaveLength(0);
  });

  it("filters org trees to the requested department scope", async () => {
    const companyId = randomUUID();
    const engineeringId = randomUUID();
    const financeId = randomUUID();
    const engineeringLeadId = randomUUID();
    const financeLeadId = randomUUID();
    const unassignedId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "ORG02",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(departments).values([
      { id: engineeringId, companyId, name: "Engineering", status: "active", sortOrder: 0 },
      { id: financeId, companyId, name: "Finance", status: "active", sortOrder: 1 },
    ]);

    await db.insert(agents).values([
      {
        id: engineeringLeadId,
        companyId,
        departmentId: engineeringId,
        name: "Engineering Lead",
        role: "ceo",
        status: "active",
        reportsTo: null,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: financeLeadId,
        companyId,
        departmentId: financeId,
        name: "Finance Lead",
        role: "manager",
        status: "active",
        reportsTo: engineeringLeadId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: unassignedId,
        companyId,
        departmentId: null,
        name: "Floating Agent",
        role: "engineer",
        status: "active",
        reportsTo: financeLeadId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const tree = await svc.orgForCompany(companyId, { departmentIds: [financeId] }) as unknown as OrgNodeLike[];
    const grouped = await svc.orgByDepartmentForCompany(companyId, { departmentIds: [financeId] }) as unknown as DepartmentGroupLike[];

    expect(tree.map((node) => node.id)).toEqual([financeLeadId]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.department?.name).toBe("Finance");
    expect(grouped[0]?.roots[0]?.id).toBe(financeLeadId);
  });
});
