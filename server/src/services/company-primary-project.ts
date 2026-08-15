import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, projects } from "@paperclipai/db";

/**
 * Resolves the project to use for a parentless system-created record. Keeping
 * this in one place makes all creator paths apply the same workspace binding.
 */
export async function resolveCompanyPrimaryProjectId(companyId: string, reader: Db) {
  const primary = await reader
    .select({ projectId: projects.id, issueCount: sql<number>`count(${issues.id})` })
    .from(projects)
    .leftJoin(issues, eq(issues.projectId, projects.id))
    .where(and(eq(projects.companyId, companyId), isNull(projects.archivedAt)))
    .groupBy(projects.id)
    .orderBy(desc(sql`count(${issues.id})`), projects.createdAt, projects.id)
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return primary?.projectId ?? null;
}
