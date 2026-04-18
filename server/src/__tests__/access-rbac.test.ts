import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  companyRolePermissions,
  companyRoles,
  createDb,
  departments,
  instanceUserRoles,
  principalPermissionGrants,
  principalRoleAssignments,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { accessService } from "../services/access.ts";
import { rolesService } from "../services/roles.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres RBAC service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("department-scoped RBAC services", () => {
  let db!: ReturnType<typeof createDb>;
  let access!: ReturnType<typeof accessService>;
  let roles!: ReturnType<typeof rolesService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-access-rbac-");
    db = createDb(tempDb.connectionString);
    access = accessService(db);
    roles = rolesService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(principalRoleAssignments);
    await db.delete(companyRolePermissions);
    await db.delete(companyRoles);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(authUsers);
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
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function insertMembership(
    companyId: string,
    principalId: string,
    principalType: "user" | "agent" = "user",
  ) {
    await db.insert(companyMemberships).values({
      companyId,
      principalType,
      principalId,
      status: "active",
      membershipRole: "member",
    });
  }

  it("seeds system roles with their permission bundles", async () => {
    const companyId = await insertCompany();

    const seeded = await roles.seedSystemRoles(companyId);

    expect(seeded.map((role) => role.key).sort()).toEqual([
      "company_admin",
      "department_manager",
      "department_member",
      "viewer",
    ]);

    const companyAdmin = seeded.find((role) => role.key === "company_admin");
    expect(companyAdmin?.isSystem).toBe(true);
    expect(companyAdmin?.permissionKeys).toContain("roles:manage");
    expect(companyAdmin?.permissionKeys).toContain("departments:manage");
    expect(companyAdmin?.permissionKeys).toContain("issues:manage");
  });

  it("resolves department-scoped role permissions including descendants", async () => {
    const companyId = await insertCompany();
    const principalId = "user-1";
    await insertMembership(companyId, principalId);

    const [engineering] = await db
      .insert(departments)
      .values({
        companyId,
        name: "Engineering",
      })
      .returning();
    const [platform] = await db
      .insert(departments)
      .values({
        companyId,
        name: "Platform",
        parentId: engineering.id,
      })
      .returning();
    const [sales] = await db
      .insert(departments)
      .values({
        companyId,
        name: "Sales",
      })
      .returning();

    const seeded = await roles.seedSystemRoles(companyId);
    const departmentManager = seeded.find((role) => role.key === "department_manager");
    expect(departmentManager).toBeTruthy();

    await roles.assignRole(
      companyId,
      "user",
      principalId,
      departmentManager!.id,
      {
        kind: "departments",
        departmentIds: [engineering.id],
        includeDescendants: true,
      },
      "admin-1",
    );

    const assignmentList = await roles.listRoleAssignments(companyId, "user", principalId);
    expect(assignmentList).toHaveLength(1);
    expect(assignmentList[0]?.scope).toEqual({
      kind: "departments",
      departmentIds: [engineering.id],
      includeDescendants: true,
    });
    expect(assignmentList[0]?.role?.key).toBe("department_manager");

    const scopedAccess = await access.resolveAccessibleDepartmentIds(
      companyId,
      "user",
      principalId,
      "projects:manage",
    );
    expect(scopedAccess.companyWide).toBe(false);
    expect(scopedAccess.departmentIds).toEqual([engineering.id, platform.id].sort());

    const allowedChild = await access.evaluatePermission(
      companyId,
      "user",
      principalId,
      "projects:manage",
      { departmentId: platform.id },
    );
    expect(allowedChild.allowed).toBe(true);

    const deniedOutsideScope = await access.evaluatePermission(
      companyId,
      "user",
      principalId,
      "projects:manage",
      { departmentId: sales.id },
    );
    expect(deniedOutsideScope.allowed).toBe(false);

    expect(await access.canUser(companyId, principalId, "projects:manage")).toBe(false);
  });

  it("keeps direct company-wide grants compatible with scoped roles", async () => {
    const companyId = await insertCompany();
    const principalId = "user-2";
    await insertMembership(companyId, principalId);

    await access.setPrincipalPermission(
      companyId,
      "user",
      principalId,
      "tasks:assign",
      true,
      "admin-1",
      null,
    );

    const effective = await access.resolveEffectivePermissions(companyId, "user", principalId);
    const assignTasks = effective.find((permission) => permission.permissionKey === "tasks:assign");

    expect(assignTasks).toEqual({
      permissionKey: "tasks:assign",
      companyWide: true,
      departmentIds: [],
    });
    expect(await access.canUser(companyId, principalId, "tasks:assign")).toBe(true);
  });

  it("rejects role scopes that point outside the company", async () => {
    const companyId = await insertCompany();
    const principalId = "user-3";
    await insertMembership(companyId, principalId);

    const foreignCompanyId = await insertCompany();
    const [foreignDepartment] = await db
      .insert(departments)
      .values({
        companyId: foreignCompanyId,
        name: "Foreign Department",
      })
      .returning();

    const seeded = await roles.seedSystemRoles(companyId);
    const viewer = seeded.find((role) => role.key === "viewer");
    expect(viewer).toBeTruthy();

    await expect(
      roles.assignRole(
        companyId,
        "user",
        principalId,
        viewer!.id,
        {
          kind: "departments",
          departmentIds: [foreignDepartment.id],
          includeDescendants: false,
        },
        "admin-1",
      ),
    ).rejects.toThrow(/same company/i);
  });

  it("keeps agent-scoped role access inside the assigned department boundary", async () => {
    const companyId = await insertCompany();
    const agentId = randomUUID();

    const [engineering] = await db
      .insert(departments)
      .values({
        companyId,
        name: "Engineering",
      })
      .returning();
    const [hr] = await db
      .insert(departments)
      .values({
        companyId,
        name: "HR",
      })
      .returning();

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "HR Bot",
      title: "HR Assistant",
      role: "general",
      status: "active",
      departmentId: hr.id,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await insertMembership(companyId, agentId, "agent");

    const seeded = await roles.seedSystemRoles(companyId);
    const departmentMember = seeded.find((role) => role.key === "department_member");
    expect(departmentMember).toBeTruthy();

    await roles.assignRole(
      companyId,
      "agent",
      agentId,
      departmentMember!.id,
      {
        kind: "departments",
        departmentIds: [hr.id],
        includeDescendants: false,
      },
      "admin-1",
    );

    expect(
      await access.evaluatePermission(companyId, "agent", agentId, "issues:view", { departmentId: hr.id }),
    ).toMatchObject({ allowed: true, companyWide: false, departmentIds: [hr.id] });

    expect(
      await access.evaluatePermission(companyId, "agent", agentId, "issues:view", { departmentId: engineering.id }),
    ).toMatchObject({ allowed: false, companyWide: false, departmentIds: [hr.id] });
  });

  it("lets instance admins bypass membership and department scope checks", async () => {
    const companyId = await insertCompany();
    const userId = "instance-admin-1";

    await db.insert(authUsers).values({
      id: userId,
      name: "Instance Admin",
      email: "instance-admin@example.com",
      emailVerified: true,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(instanceUserRoles).values({
      userId,
      role: "instance_admin",
    });

    expect(await access.canUser(companyId, userId, "users:manage_permissions")).toBe(true);
    expect(
      await access.evaluatePermission(companyId, "user", userId, "issues:view", { departmentId: randomUUID() }),
    ).toMatchObject({ allowed: true, companyWide: true });
    expect(
      await access.resolveAccessibleDepartmentIds(companyId, "user", userId, "projects:manage"),
    ).toEqual({
      companyWide: true,
      departmentIds: [],
    });
  });

  it("allows direct grants to widen access beyond a scoped role assignment", async () => {
    const companyId = await insertCompany();
    const principalId = "user-5";
    await insertMembership(companyId, principalId);

    const [engineering] = await db
      .insert(departments)
      .values({
        companyId,
        name: "Engineering",
      })
      .returning();
    const [sales] = await db
      .insert(departments)
      .values({
        companyId,
        name: "Sales",
      })
      .returning();

    const seeded = await roles.seedSystemRoles(companyId);
    const viewer = seeded.find((role) => role.key === "viewer");
    expect(viewer).toBeTruthy();

    await roles.assignRole(
      companyId,
      "user",
      principalId,
      viewer!.id,
      {
        kind: "departments",
        departmentIds: [engineering.id],
        includeDescendants: false,
      },
      "admin-1",
    );

    await access.setPrincipalPermission(
      companyId,
      "user",
      principalId,
      "issues:view",
      true,
      "admin-1",
      null,
    );

    await expect(
      access.resolveAccessibleDepartmentIds(companyId, "user", principalId, "issues:view"),
    ).resolves.toMatchObject({
      companyWide: true,
    });
    expect(
      await access.evaluatePermission(companyId, "user", principalId, "issues:view", { departmentId: sales.id }),
    ).toMatchObject({ allowed: true, companyWide: true });
  });

  it("revokes access immediately when a role assignment is removed", async () => {
    const companyId = await insertCompany();
    const principalId = "user-6";
    await insertMembership(companyId, principalId);

    const [finance] = await db
      .insert(departments)
      .values({
        companyId,
        name: "Finance",
      })
      .returning();

    const seeded = await roles.seedSystemRoles(companyId);
    const departmentManager = seeded.find((role) => role.key === "department_manager");
    expect(departmentManager).toBeTruthy();

    const assignment = await roles.assignRole(
      companyId,
      "user",
      principalId,
      departmentManager!.id,
      {
        kind: "departments",
        departmentIds: [finance.id],
        includeDescendants: false,
      },
      "admin-1",
    );

    expect(
      await access.evaluatePermission(companyId, "user", principalId, "projects:manage", { departmentId: finance.id }),
    ).toMatchObject({ allowed: true });

    await roles.removeRoleAssignment(companyId, assignment.id);

    expect(
      await access.evaluatePermission(companyId, "user", principalId, "projects:manage", { departmentId: finance.id }),
    ).toMatchObject({ allowed: false, companyWide: false, departmentIds: [] });
    expect(await roles.listRoleAssignments(companyId, "user", principalId)).toEqual([]);
  });

  it("prevents department-scoped agent roles from escalating into admin permissions", async () => {
    const companyId = await insertCompany();
    const agentId = randomUUID();

    const [finance] = await db
      .insert(departments)
      .values({
        companyId,
        name: "Finance",
      })
      .returning();

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Finance Ops Bot",
      title: "Finance Ops",
      role: "pm",
      status: "active",
      departmentId: finance.id,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await insertMembership(companyId, agentId, "agent");

    const seeded = await roles.seedSystemRoles(companyId);
    const departmentManager = seeded.find((role) => role.key === "department_manager");
    expect(departmentManager).toBeTruthy();

    await roles.assignRole(
      companyId,
      "agent",
      agentId,
      departmentManager!.id,
      {
        kind: "departments",
        departmentIds: [finance.id],
        includeDescendants: false,
      },
      "admin-1",
    );

    expect(
      await access.evaluatePermission(companyId, "agent", agentId, "projects:manage", { departmentId: finance.id }),
    ).toMatchObject({ allowed: true });
    expect(
      await access.evaluatePermission(companyId, "agent", agentId, "roles:manage"),
    ).toMatchObject({ allowed: false, companyWide: false, departmentIds: [] });
    expect(
      await access.evaluatePermission(companyId, "agent", agentId, "users:manage_permissions"),
    ).toMatchObject({ allowed: false, companyWide: false, departmentIds: [] });
  });

  it("supports direct-grant-only compatibility without any roles configured", async () => {
    const companyId = await insertCompany();
    const principalId = "user-7";
    await insertMembership(companyId, principalId);

    const [engineering] = await db
      .insert(departments)
      .values({
        companyId,
        name: "Engineering",
      })
      .returning();
    const [sales] = await db
      .insert(departments)
      .values({
        companyId,
        name: "Sales",
      })
      .returning();

    await access.setPrincipalPermission(
      companyId,
      "user",
      principalId,
      "issues:view",
      true,
      "admin-1",
      {
        kind: "departments",
        departmentIds: [engineering.id],
        includeDescendants: false,
      },
    );

    expect(
      await access.resolveAccessibleDepartmentIds(companyId, "user", principalId, "issues:view"),
    ).toEqual({
      companyWide: false,
      departmentIds: [engineering.id],
    });
    expect(
      await access.evaluatePermission(companyId, "user", principalId, "issues:view", { departmentId: engineering.id }),
    ).toMatchObject({ allowed: true, companyWide: false, departmentIds: [engineering.id] });
    expect(
      await access.evaluatePermission(companyId, "user", principalId, "issues:view", { departmentId: sales.id }),
    ).toMatchObject({ allowed: false, companyWide: false, departmentIds: [engineering.id] });
  });

  it("builds member access summaries with direct grants, role assignments, and principal metadata", async () => {
    const companyId = await insertCompany();
    const userId = "user-4";
    const agentId = randomUUID();

    await db.insert(authUsers).values({
      id: userId,
      name: "Rita Reviewer",
      email: "rita@example.com",
      emailVerified: true,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Finance Bot",
      title: "Finance Analyst",
      role: "researcher",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(companyMemberships).values([
      {
        companyId,
        principalType: "user",
        principalId: userId,
        status: "active",
        membershipRole: "member",
      },
      {
        companyId,
        principalType: "agent",
        principalId: agentId,
        status: "active",
        membershipRole: "member",
      },
    ]);

    const [finance] = await db
      .insert(departments)
      .values({
        companyId,
        name: "Finance",
      })
      .returning();

    await access.setPrincipalPermission(
      companyId,
      "user",
      userId,
      "tasks:assign",
      true,
      "admin-1",
      null,
    );

    const seeded = await roles.seedSystemRoles(companyId);
    const departmentManager = seeded.find((role) => role.key === "department_manager");
    expect(departmentManager).toBeTruthy();

    await roles.assignRole(
      companyId,
      "user",
      userId,
      departmentManager!.id,
      {
        kind: "departments",
        departmentIds: [finance.id],
        includeDescendants: false,
      },
      "admin-1",
    );

    const summaries = await access.listMemberAccessSummaries(companyId);
    const userSummary = summaries.find((summary) => summary.principalId === userId);
    const agentSummary = summaries.find((summary) => summary.principalId === agentId);

    expect(userSummary?.principal.name).toBe("Rita Reviewer");
    expect(userSummary?.principal.email).toBe("rita@example.com");
    expect(userSummary?.directGrants.map((grant) => grant.permissionKey)).toEqual(["tasks:assign"]);
    expect(userSummary?.roleAssignments[0]?.role.key).toBe("department_manager");
    expect(userSummary?.effectivePermissions.some((permission) => permission.permissionKey === "projects:manage")).toBe(true);

    expect(agentSummary?.principal.name).toBe("Finance Bot");
    expect(agentSummary?.principal.title).toBe("Finance Analyst");
    expect(agentSummary?.roleAssignments).toHaveLength(0);
  });
});
