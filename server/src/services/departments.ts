import { and, eq, inArray, sql } from "drizzle-orm";
import { agentDepartments, agents, departments, type Db } from "@paperclipai/db";
import {
  AGENT_DEPARTMENT_MAX_MEMBERSHIPS,
  normalizeDepartmentName,
  type Department,
} from "@paperclipai/shared";
import { isUniqueViolation } from "../db-errors.js";
import { badRequest, conflict, notFound } from "../errors.js";

const NAME_CONSTRAINT = "departments_company_name_key_uq";

function requireName(input: string): string {
  const name = normalizeDepartmentName(input);
  if (!name) throw badRequest("Enter a department name of 1 to 80 characters");
  return name;
}

// Fast path before the insert. Postgres `lower()` on the unique index is the
// authority: a race, or a character this comparison folds differently, comes
// back as a unique violation and is read again.
function sameName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

async function membershipsByDepartment(db: Db, companyId: string) {
  const links = await db
    .select({
      departmentId: agentDepartments.departmentId,
      agentId: agentDepartments.agentId,
    })
    .from(agentDepartments)
    .where(eq(agentDepartments.companyId, companyId));
  const byDepartment = new Map<string, string[]>();
  for (const link of links) {
    const agentIds = byDepartment.get(link.departmentId) ?? [];
    agentIds.push(link.agentId);
    byDepartment.set(link.departmentId, agentIds);
  }
  return byDepartment;
}

async function listDepartments(db: Db, companyId: string): Promise<Department[]> {
  const rows = await db
    .select({
      id: departments.id,
      companyId: departments.companyId,
      name: departments.name,
    })
    .from(departments)
    .where(eq(departments.companyId, companyId))
    .orderBy(departments.name);
  const members = await membershipsByDepartment(db, companyId);
  return rows.map((row) => ({
    ...row,
    agentIds: (members.get(row.id) ?? []).sort(),
  }));
}

async function readDepartment(db: Db, companyId: string, departmentId: string): Promise<Department> {
  const match = (await listDepartments(db, companyId)).find((row) => row.id === departmentId);
  if (!match) throw notFound("Department not found");
  return match;
}

export function departmentService(db: Db) {
  return {
    list: (companyId: string) => listDepartments(db, companyId),

    async create(companyId: string, input: string): Promise<{ department: Department; created: boolean }> {
      const name = requireName(input);
      const existing = (await listDepartments(db, companyId)).find((row) => sameName(row.name, name));
      // The chip control sends a typed name. Reuse the department when the
      // folded name already exists so a second click does not fork the catalog.
      if (existing) return { department: existing, created: false };
      try {
        const [inserted] = await db
          .insert(departments)
          .values({ companyId, name })
          .returning({ id: departments.id });
        if (!inserted) throw conflict("A department with this name already exists");
        return { department: await readDepartment(db, companyId, inserted.id), created: true };
      } catch (error) {
        if (!isUniqueViolation(error, NAME_CONSTRAINT)) throw error;
        const raced = (await listDepartments(db, companyId)).find((row) => sameName(row.name, name));
        if (!raced) throw error;
        return { department: raced, created: false };
      }
    },

    async rename(companyId: string, departmentId: string, input: string): Promise<Department> {
      const name = requireName(input);
      const current = await readDepartment(db, companyId, departmentId);
      if (current.name === name) return current;
      try {
        const [updated] = await db
          .update(departments)
          .set({ name, updatedAt: new Date() })
          .where(and(eq(departments.id, departmentId), eq(departments.companyId, companyId)))
          .returning({ id: departments.id });
        if (!updated) throw notFound("Department not found");
        return readDepartment(db, companyId, departmentId);
      } catch (error) {
        if (isUniqueViolation(error, NAME_CONSTRAINT)) {
          throw conflict("A department with this name already exists");
        }
        throw error;
      }
    },

    async remove(companyId: string, departmentId: string): Promise<Department> {
      const current = await readDepartment(db, companyId, departmentId);
      const [removed] = await db
        .delete(departments)
        .where(and(eq(departments.id, departmentId), eq(departments.companyId, companyId)))
        .returning({ id: departments.id });
      if (!removed) throw notFound("Department not found");
      // Membership rows cascade. Agents stay.
      return { ...current, agentIds: [] };
    },

    async setForAgent(
      companyId: string,
      agentId: string,
      departmentIds: readonly string[],
      names: readonly string[] = [],
    ): Promise<{ memberships: Department[]; created: Department[] }> {
      const requestedIds = [...new Set(departmentIds)];
      const requestedNames = names.map((input) => requireName(input));
      const { finalIds, createdIds } = await db.transaction(async (tx) => {
        const [agent] = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
          .for("update");
        if (!agent) throw notFound("Agent not found");
        const ids = [...requestedIds];
        const createdIds: string[] = [];
        for (const name of requestedNames) {
          const [existing] = await tx
            .select({ id: departments.id })
            .from(departments)
            .where(and(eq(departments.companyId, companyId), sql`lower(${departments.name}) = lower(${name})`))
            .limit(1);
          if (existing) {
            ids.push(existing.id);
            continue;
          }
          try {
            await tx.transaction(async (inner) => {
              const [inserted] = await inner
                .insert(departments)
                .values({ companyId, name })
                .returning({ id: departments.id });
              if (!inserted) throw conflict("A department with this name already exists");
              ids.push(inserted.id);
              createdIds.push(inserted.id);
            });
          } catch (error) {
            if (!isUniqueViolation(error, NAME_CONSTRAINT)) throw error;
            const [raced] = await tx
              .select({ id: departments.id })
              .from(departments)
              .where(and(eq(departments.companyId, companyId), sql`lower(${departments.name}) = lower(${name})`))
              .limit(1);
            if (!raced) throw error;
            ids.push(raced.id);
          }
        }
        const finalIds = [...new Set(ids)];
        if (finalIds.length > AGENT_DEPARTMENT_MAX_MEMBERSHIPS) {
          throw badRequest(`An agent can belong to at most ${AGENT_DEPARTMENT_MAX_MEMBERSHIPS} departments`);
        }
        if (finalIds.length > 0) {
          const found = await tx
            .select({ id: departments.id })
            .from(departments)
            .where(and(eq(departments.companyId, companyId), inArray(departments.id, finalIds)));
          if (found.length !== finalIds.length) {
            throw badRequest("Choose departments from this company");
          }
        }
        await tx.delete(agentDepartments).where(and(
          eq(agentDepartments.companyId, companyId),
          eq(agentDepartments.agentId, agentId),
        ));
        if (finalIds.length > 0) {
          await tx.insert(agentDepartments).values(finalIds.map((departmentId) => ({
            companyId,
            agentId,
            departmentId,
          })));
        }
        return { finalIds, createdIds };
      });
      const listed = await listDepartments(db, companyId);
      const createdIdSet = new Set(createdIds);
      return {
        memberships: listed.filter((row) => finalIds.includes(row.id) && row.agentIds.includes(agentId)),
        created: listed.filter((row) => createdIdSet.has(row.id)),
      };
    },
  };
}
