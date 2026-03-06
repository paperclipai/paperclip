import { eq, count } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companies,
  issuePrefixes,
  agents,
  agentApiKeys,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  issues,
  issueComments,
  projects,
  goals,
  heartbeatRuns,
  heartbeatRunEvents,
  costEvents,
  approvalComments,
  approvals,
  activityLog,
  companySecrets,
  joinRequests,
  invites,
  principalPermissionGrants,
  companyMemberships,
} from "@paperclipai/db";
import { buildIssuePrefixCandidate, deriveIssuePrefixBase } from "@paperclipai/shared";
import { isUniqueViolation } from "../errors.js";

const COMPANY_PREFIX_CONSTRAINTS = ["companies_issue_prefix_idx", "issue_prefixes_pkey"];

export function companyService(db: Db) {

  async function createCompanyWithUniquePrefix(data: typeof companies.$inferInsert) {
    const base = deriveIssuePrefixBase(data.name);
    let attempt = 1;
    while (attempt < 10000) {
      const candidate = buildIssuePrefixCandidate(base, attempt);
      try {
        const company = await db.transaction(async (tx) => {
          const rows = await tx
            .insert(companies)
            .values({ ...data, issuePrefix: candidate })
            .returning();
          const created = rows[0]!;
          await tx.insert(issuePrefixes).values({
            prefix: candidate,
            ownerType: "company",
            ownerId: created.id,
            counter: 0,
          });
          return created;
        });
        return company;
      } catch (error) {
        if (!isUniqueViolation(error, COMPANY_PREFIX_CONSTRAINTS)) throw error;
      }
      attempt += 1;
    }
    throw new Error("Unable to allocate unique issue prefix");
  }

  return {
    list: () => db.select().from(companies),

    getById: (id: string) =>
      db
        .select()
        .from(companies)
        .where(eq(companies.id, id))
        .then((rows) => rows[0] ?? null),

    create: async (data: typeof companies.$inferInsert) => createCompanyWithUniquePrefix(data),

    update: (id: string, data: Partial<typeof companies.$inferInsert>) =>
      db
        .update(companies)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(companies.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    archive: (id: string) =>
      db
        .update(companies)
        .set({ status: "archived", updatedAt: new Date() })
        .where(eq(companies.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    remove: (id: string) =>
      db.transaction(async (tx) => {
        // Delete from child tables in dependency order
        await tx.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, id));
        await tx.delete(agentTaskSessions).where(eq(agentTaskSessions.companyId, id));
        await tx.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, id));
        await tx.delete(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, id));
        await tx.delete(agentApiKeys).where(eq(agentApiKeys.companyId, id));
        await tx.delete(agentRuntimeState).where(eq(agentRuntimeState.companyId, id));
        await tx.delete(issueComments).where(eq(issueComments.companyId, id));
        await tx.delete(costEvents).where(eq(costEvents.companyId, id));
        await tx.delete(approvalComments).where(eq(approvalComments.companyId, id));
        await tx.delete(approvals).where(eq(approvals.companyId, id));
        await tx.delete(companySecrets).where(eq(companySecrets.companyId, id));
        await tx.delete(joinRequests).where(eq(joinRequests.companyId, id));
        await tx.delete(invites).where(eq(invites.companyId, id));
        await tx.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, id));
        await tx.delete(companyMemberships).where(eq(companyMemberships.companyId, id));
        await tx.delete(issues).where(eq(issues.companyId, id));
        await tx.delete(goals).where(eq(goals.companyId, id));
        await tx.delete(projects).where(eq(projects.companyId, id));
        await tx.delete(agents).where(eq(agents.companyId, id));
        await tx.delete(activityLog).where(eq(activityLog.companyId, id));
        const rows = await tx
          .delete(companies)
          .where(eq(companies.id, id))
          .returning();
        return rows[0] ?? null;
      }),

    stats: () =>
      Promise.all([
        db
          .select({ companyId: agents.companyId, count: count() })
          .from(agents)
          .groupBy(agents.companyId),
        db
          .select({ companyId: issues.companyId, count: count() })
          .from(issues)
          .groupBy(issues.companyId),
      ]).then(([agentRows, issueRows]) => {
        const result: Record<string, { agentCount: number; issueCount: number }> = {};
        for (const row of agentRows) {
          result[row.companyId] = { agentCount: row.count, issueCount: 0 };
        }
        for (const row of issueRows) {
          if (result[row.companyId]) {
            result[row.companyId].issueCount = row.count;
          } else {
            result[row.companyId] = { agentCount: 0, issueCount: row.count };
          }
        }
        return result;
      }),
  };
}
