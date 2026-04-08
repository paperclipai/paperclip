import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, companyMemberships, departments, departmentMemberships } from "@paperclipai/db";
import { notFound, unprocessable, conflict } from "../errors.js";

export interface CreateDepartmentPayload {
  name: string;
  description?: string | null;
  parentId?: string | null;
  sortOrder?: number;
}

export interface UpdateDepartmentPayload {
  name?: string;
  description?: string | null;
  parentId?: string | null;
  sortOrder?: number;
}

export interface AddMemberPayload {
  principalType: string;
  principalId: string;
  role?: string;
}

export function departmentService(db: Db) {
  async function assertCompanyPrincipalExists(
    companyId: string,
    principalType: string,
    principalId: string,
  ) {
    if (principalType === "agent") {
      const agent = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.id, principalId),
            eq(agents.companyId, companyId),
            ne(agents.status, "terminated"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!agent) throw unprocessable("Agent must belong to the same company");
      return;
    }

    if (principalType === "user") {
      const membership = await db
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, principalId),
            eq(companyMemberships.status, "active"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!membership) throw unprocessable("User must be an active member of the same company");
      return;
    }

    throw unprocessable("Unsupported principal type");
  }

  async function list(companyId: string) {
    return db
      .select()
      .from(departments)
      .where(and(eq(departments.companyId, companyId), eq(departments.status, "active")))
      .orderBy(departments.sortOrder, departments.name);
  }

  async function getById(id: string) {
    const rows = await db.select().from(departments).where(eq(departments.id, id));
    return rows[0] ?? null;
  }

  async function tree(companyId: string) {
    const allDepts = await list(companyId);

    const memberCounts = await db
      .select({
        departmentId: departmentMemberships.departmentId,
        count: sql<number>`count(*)::int`.as("count"),
      })
      .from(departmentMemberships)
      .where(eq(departmentMemberships.companyId, companyId))
      .groupBy(departmentMemberships.departmentId);

    const countMap = new Map(memberCounts.map((r) => [r.departmentId, r.count]));

    type TreeNode = (typeof allDepts)[0] & { children: TreeNode[]; memberCount: number };

    const nodeMap = new Map<string, TreeNode>();
    for (const dept of allDepts) {
      nodeMap.set(dept.id, { ...dept, children: [], memberCount: countMap.get(dept.id) ?? 0 });
    }

    const roots: TreeNode[] = [];
    for (const node of nodeMap.values()) {
      if (node.parentId && nodeMap.has(node.parentId)) {
        nodeMap.get(node.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }

  async function create(companyId: string, data: CreateDepartmentPayload) {
    if (!data.name?.trim()) {
      throw unprocessable("Department name is required");
    }

    const company = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId));
    if (!company.length) throw notFound("Company not found");

    if (data.parentId) {
      const parent = await getById(data.parentId);
      if (!parent) throw notFound("Parent department not found");
      if (parent.companyId !== companyId) throw unprocessable("Parent department must belong to the same company");
    }

    try {
      const [result] = await db
        .insert(departments)
        .values({
          companyId,
          name: data.name.trim(),
          description: data.description ?? null,
          parentId: data.parentId ?? null,
          sortOrder: data.sortOrder ?? 0,
        })
        .returning();
      return result;
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("departments_company_name_uq")) {
        throw conflict(`Department "${data.name}" already exists in this company`);
      }
      throw err;
    }
  }

  async function update(id: string, data: UpdateDepartmentPayload) {
    const existing = await getById(id);
    if (!existing) throw notFound("Department not found");

    if (data.parentId !== undefined && data.parentId !== null) {
      if (data.parentId === id) throw unprocessable("Department cannot be its own parent");
      const parent = await getById(data.parentId);
      if (!parent) throw notFound("Parent department not found");
      if (parent.companyId !== existing.companyId) {
        throw unprocessable("Parent department must belong to the same company");
      }
      await assertNoCycle(id, data.parentId);
    }

    try {
      const [result] = await db
        .update(departments)
        .set({
          ...(data.name !== undefined && { name: data.name.trim() }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.parentId !== undefined && { parentId: data.parentId }),
          ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
          updatedAt: new Date(),
        })
        .where(eq(departments.id, id))
        .returning();
      return result;
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("departments_company_name_uq")) {
        throw conflict(`Department "${data.name}" already exists in this company`);
      }
      throw err;
    }
  }

  async function archive(id: string) {
    const existing = await getById(id);
    if (!existing) throw notFound("Department not found");

    const activeChildren = await db
      .select({ id: departments.id })
      .from(departments)
      .where(and(eq(departments.parentId, id), eq(departments.status, "active")));

    if (activeChildren.length > 0) {
      throw unprocessable("Cannot archive department with active sub-departments. Archive or reparent children first.");
    }

    const [result] = await db
      .update(departments)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(departments.id, id))
      .returning();
    return result;
  }

  async function addMember(departmentId: string, companyId: string, data: AddMemberPayload) {
    const dept = await getById(departmentId);
    if (!dept) throw notFound("Department not found");
    if (dept.companyId !== companyId) throw unprocessable("Department does not belong to this company");
    await assertCompanyPrincipalExists(companyId, data.principalType, data.principalId);

    try {
      const [result] = await db
        .insert(departmentMemberships)
        .values({
          companyId,
          departmentId,
          principalType: data.principalType,
          principalId: data.principalId,
          role: data.role ?? "member",
        })
        .returning();
      return result;
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("dept_memberships_dept_principal_uq")) {
        throw conflict("This principal is already a member of this department");
      }
      throw err;
    }
  }

  async function removeMember(departmentId: string, principalType: string, principalId: string) {
    const result = await db
      .delete(departmentMemberships)
      .where(
        and(
          eq(departmentMemberships.departmentId, departmentId),
          eq(departmentMemberships.principalType, principalType),
          eq(departmentMemberships.principalId, principalId),
        ),
      )
      .returning();

    if (!result.length) throw notFound("Membership not found");
  }

  async function listMembers(departmentId: string) {
    return db
      .select()
      .from(departmentMemberships)
      .where(eq(departmentMemberships.departmentId, departmentId));
  }

  async function assertNoCycle(departmentId: string, newParentId: string) {
    let cursor: string | null = newParentId;
    for (let i = 0; i < 100; i++) {
      if (!cursor) break;
      if (cursor === departmentId) throw unprocessable("Circular parent relationship detected");
      const parent = await getById(cursor);
      if (!parent) break;
      cursor = parent.parentId;
    }
  }

  return { list, tree, getById, create, update, archive, addMember, removeMember, listMembers };
}
