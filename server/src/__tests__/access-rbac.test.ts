import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  companyMemberships,
  companyRolePermissions,
  companyRoles,
  createDb,
  departments,
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

  async function insertMembership(companyId: string, principalId: string) {
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
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
});
