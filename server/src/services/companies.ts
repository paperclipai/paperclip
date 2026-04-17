import { randomBytes } from "node:crypto";
import { and, count, eq, gte, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companies,
  companyLogos,
  companySecrets,
  companySecretVersions,
  companySubscriptions,
  subscriptionPlans,
  assets,
  agents,
  agentApiKeys,
  agentConfigRevisions,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  issues,
  issueApprovals,
  issueAttachments,
  issueComments,
  issueDocuments,
  issueLabels,
  issueReadStates,
  issueWorkProducts,
  projects,
  projectGoals,
  projectWorkspaces,
  executionWorkspaces,
  workspaceOperations,
  workspaceRuntimeServices,
  goals,
  heartbeatRuns,
  heartbeatRunEvents,
  costEvents,
  financeEvents,
  approvalComments,
  approvals,
  activityLog,
  budgetPolicies,
  budgetIncidents,
  documents,
  documentRevisions,
  joinRequests,
  invites,
  principalPermissionGrants,
  companyMemberships,
  companySkills,
} from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";

export function companyService(db: Db) {
  const ISSUE_PREFIX_FALLBACK = "CMP";

  const companySelection = {
    id: companies.id,
    name: companies.name,
    description: companies.description,
    status: companies.status,
    issuePrefix: companies.issuePrefix,
    issueCounter: companies.issueCounter,
    budgetMonthlyCents: companies.budgetMonthlyCents,
    spentMonthlyCents: companies.spentMonthlyCents,
    requireBoardApprovalForNewAgents: companies.requireBoardApprovalForNewAgents,
    inferenceMode: companies.inferenceMode,
    feedbackDataSharingEnabled: companies.feedbackDataSharingEnabled,
    feedbackDataSharingConsentAt: companies.feedbackDataSharingConsentAt,
    feedbackDataSharingConsentByUserId: companies.feedbackDataSharingConsentByUserId,
    feedbackDataSharingTermsVersion: companies.feedbackDataSharingTermsVersion,
    brandColor: companies.brandColor,
    logoAssetId: companyLogos.assetId,
    createdAt: companies.createdAt,
    updatedAt: companies.updatedAt,
  };

  function enrichCompany<T extends { logoAssetId: string | null }>(company: T) {
    return {
      ...company,
      logoUrl: company.logoAssetId ? `/api/assets/${company.logoAssetId}/content` : null,
    };
  }

  function currentUtcMonthWindow(now = new Date()) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    return {
      start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
      end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
    };
  }

  async function getMonthlySpendByCompanyIds(
    companyIds: string[],
    database: Pick<Db, "select"> = db,
  ) {
    if (companyIds.length === 0) return new Map<string, number>();
    const { start, end } = currentUtcMonthWindow();
    const rows = await database
        .select({
          companyId: costEvents.companyId,
          spentMonthlyCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
        })
      .from(costEvents)
      .where(
        and(
          inArray(costEvents.companyId, companyIds),
          gte(costEvents.occurredAt, start),
          lt(costEvents.occurredAt, end),
        ),
      )
      .groupBy(costEvents.companyId);
    return new Map(rows.map((row) => [row.companyId, Number(row.spentMonthlyCents ?? 0)]));
  }

  async function hydrateCompanySpend<T extends { id: string; spentMonthlyCents: number }>(
    rows: T[],
    database: Pick<Db, "select"> = db,
  ) {
    const spendByCompanyId = await getMonthlySpendByCompanyIds(rows.map((row) => row.id), database);
    return rows.map((row) => ({
      ...row,
      spentMonthlyCents: spendByCompanyId.get(row.id) ?? 0,
    }));
  }

  function getCompanyQuery(database: Pick<Db, "select">) {
    return database
      .select(companySelection)
      .from(companies)
      .leftJoin(companyLogos, eq(companyLogos.companyId, companies.id));
  }

  function deriveIssuePrefixBase(name: string) {
    const normalized = name.toUpperCase().replace(/[^A-Z]/g, "");
    return normalized.slice(0, 3) || ISSUE_PREFIX_FALLBACK;
  }

  function randomSuffix(length: number) {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/1/O/0 to avoid ambiguity
    let result = "";
    for (let i = 0; i < length; i++) {
      result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
  }

  function suffixForAttempt(attempt: number) {
    if (attempt <= 1) return "";
    return randomSuffix(attempt <= 3 ? 3 : 5);
  }

  function isIssuePrefixConflict(error: unknown) {
    const constraint = typeof error === "object" && error !== null && "constraint" in error
      ? (error as { constraint?: string }).constraint
      : typeof error === "object" && error !== null && "constraint_name" in error
        ? (error as { constraint_name?: string }).constraint_name
        : undefined;
    return typeof error === "object"
      && error !== null
      && "code" in error
      && (error as { code?: string }).code === "23505"
      && constraint === "companies_issue_prefix_idx";
  }

  async function createCompanyWithUniquePrefix(data: typeof companies.$inferInsert) {
    const base = deriveIssuePrefixBase(data.name);
    const jwtSigningKey = randomBytes(32).toString("hex");
    let suffix = 1;
    while (suffix < 10000) {
      const candidate = `${base}${suffixForAttempt(suffix)}`;
      try {
        const rows = await db
          .insert(companies)
          .values({ ...data, issuePrefix: candidate, jwtSigningKey })
          .returning();
        return rows[0];
      } catch (error) {
        if (!isIssuePrefixConflict(error)) throw error;
      }
      suffix += 1;
    }
    throw new Error("Unable to allocate unique issue prefix");
  }

  return {
    list: async () => {
      const rows = await getCompanyQuery(db).where(ne(companies.status, "archived"));
      const hydrated = await hydrateCompanySpend(rows);
      return hydrated.map((row) => enrichCompany(row));
    },

    listArchived: async () => {
      const rows = await getCompanyQuery(db).where(eq(companies.status, "archived"));
      const hydrated = await hydrateCompanySpend(rows);
      return hydrated.map((row) => enrichCompany(row));
    },

    getById: async (id: string) => {
      const row = await getCompanyQuery(db)
        .where(eq(companies.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const [hydrated] = await hydrateCompanySpend([row], db);
      return enrichCompany(hydrated);
    },

    create: async (data: typeof companies.$inferInsert) => {
      const created = await createCompanyWithUniquePrefix(data);

      // Provision subscription: pro (trial) or self-hosted (free)
      const isCloud = !!process.env.STRIPE_SECRET_KEY?.trim();
      const planId = isCloud ? "pro" : "free";

      // Only provision if the plan exists in the database
      const plan = await db
        .select({ id: subscriptionPlans.id })
        .from(subscriptionPlans)
        .where(eq(subscriptionPlans.id, planId))
        .then((rows) => rows[0] ?? null);

      if (plan) {
        const now = new Date();
        const trialEndsAt = isCloud
          ? new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)
          : null;

        await db.insert(companySubscriptions).values({
          companyId: created.id,
          planId,
          status: isCloud ? "trialing" : "free",
          trialEndsAt,
          currentPeriodStart: now,
          currentPeriodEnd: trialEndsAt,
        });
      }

      const row = await getCompanyQuery(db)
        .where(eq(companies.id, created.id))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Company not found after creation");
      const [hydrated] = await hydrateCompanySpend([row], db);
      return enrichCompany(hydrated);
    },

    update: (
      id: string,
      data: Partial<typeof companies.$inferInsert> & { logoAssetId?: string | null },
    ) =>
      db.transaction(async (tx) => {
        const existing = await getCompanyQuery(tx)
          .where(eq(companies.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        const { logoAssetId, ...companyPatch } = data;

        if (logoAssetId !== undefined && logoAssetId !== null) {
          const nextLogoAsset = await tx
            .select({ id: assets.id, companyId: assets.companyId })
            .from(assets)
            .where(eq(assets.id, logoAssetId))
            .then((rows) => rows[0] ?? null);
          if (!nextLogoAsset) throw notFound("Logo asset not found");
          if (nextLogoAsset.companyId !== existing.id) {
            throw unprocessable("Logo asset must belong to the same company");
          }
        }

        const updated = await tx
          .update(companies)
          .set({ ...companyPatch, updatedAt: new Date() })
          .where(eq(companies.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) return null;

        if (logoAssetId === null) {
          await tx.delete(companyLogos).where(eq(companyLogos.companyId, id));
        } else if (logoAssetId !== undefined) {
          await tx
            .insert(companyLogos)
            .values({
              companyId: id,
              assetId: logoAssetId,
            })
            .onConflictDoUpdate({
              target: companyLogos.companyId,
              set: {
                assetId: logoAssetId,
                updatedAt: new Date(),
              },
            });
        }

        if (logoAssetId !== undefined && existing.logoAssetId && existing.logoAssetId !== logoAssetId) {
          await tx.delete(assets).where(eq(assets.id, existing.logoAssetId));
        }

        const [hydrated] = await hydrateCompanySpend([{
          ...updated,
          logoAssetId: logoAssetId === undefined ? existing.logoAssetId : logoAssetId,
        }], tx);

        return enrichCompany(hydrated);
      }),

    archive: (id: string) =>
      db.transaction(async (tx) => {
        const now = new Date();
        const updated = await tx
          .update(companies)
          .set({ status: "archived", updatedAt: now })
          .where(eq(companies.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) return null;

        // Cancel all queued and running heartbeat runs for this company
        await tx
          .update(heartbeatRuns)
          .set({ status: "cancelled", updatedAt: now })
          .where(
            and(
              eq(heartbeatRuns.companyId, id),
              inArray(heartbeatRuns.status, ["queued", "running"]),
            ),
          );

        // Detach wakeup requests from heartbeat runs before deleting them
        await tx
          .update(heartbeatRuns)
          .set({ wakeupRequestId: null })
          .where(
            and(
              eq(heartbeatRuns.companyId, id),
              isNotNull(heartbeatRuns.wakeupRequestId),
            ),
          );

        // Delete all pending agent wakeup requests for this company
        await tx.delete(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, id));

        const row = await getCompanyQuery(tx)
          .where(eq(companies.id, id))
          .then((rows) => rows[0] ?? null);
        if (!row) return null;
        const [hydrated] = await hydrateCompanySpend([row], tx);
        return enrichCompany(hydrated);
      }),

    remove: (id: string) =>
      db.transaction(async (tx) => {
        // Delete from child tables in dependency order (deepest dependencies first)
        // Workspace & runtime
        await tx.delete(workspaceOperations).where(eq(workspaceOperations.companyId, id));
        await tx.delete(workspaceRuntimeServices).where(eq(workspaceRuntimeServices.companyId, id));
        // Heartbeat
        await tx.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, id));
        await tx.delete(agentTaskSessions).where(eq(agentTaskSessions.companyId, id));
        await tx.delete(activityLog).where(eq(activityLog.companyId, id));
        await tx.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, id));
        await tx.delete(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, id));
        await tx.delete(agentApiKeys).where(eq(agentApiKeys.companyId, id));
        await tx.delete(agentConfigRevisions).where(eq(agentConfigRevisions.companyId, id));
        await tx.delete(agentRuntimeState).where(eq(agentRuntimeState.companyId, id));
        // Issue children (before issues)
        await tx.delete(issueWorkProducts).where(eq(issueWorkProducts.companyId, id));
        await tx.delete(issueApprovals).where(eq(issueApprovals.companyId, id));
        await tx.delete(issueAttachments).where(eq(issueAttachments.companyId, id));
        await tx.delete(issueComments).where(eq(issueComments.companyId, id));
        await tx.delete(issueReadStates).where(eq(issueReadStates.companyId, id));
        await tx.delete(documentRevisions).where(eq(documentRevisions.companyId, id));
        await tx.delete(issueDocuments).where(eq(issueDocuments.companyId, id));
        await tx.delete(documents).where(eq(documents.companyId, id));
        // Cost & finance
        await tx.delete(costEvents).where(eq(costEvents.companyId, id));
        await tx.delete(financeEvents).where(eq(financeEvents.companyId, id));
        // Budget
        await tx.delete(budgetIncidents).where(eq(budgetIncidents.companyId, id));
        await tx.delete(budgetPolicies).where(eq(budgetPolicies.companyId, id));
        // Approvals
        await tx.delete(approvalComments).where(eq(approvalComments.companyId, id));
        await tx.delete(approvals).where(eq(approvals.companyId, id));
        // Secrets (versions cascade-delete via FK on secretId)
        await tx.delete(companySecrets).where(eq(companySecrets.companyId, id));
        // Access
        await tx.delete(joinRequests).where(eq(joinRequests.companyId, id));
        await tx.delete(invites).where(eq(invites.companyId, id));
        await tx.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, id));
        await tx.delete(companyMemberships).where(eq(companyMemberships.companyId, id));
        // Execution workspaces (before issues/projects)
        await tx.delete(executionWorkspaces).where(eq(executionWorkspaces.companyId, id));
        // companySkills must be deleted before issues (FK constraint added upstream)
        await tx.delete(companySkills).where(eq(companySkills.companyId, id));
        // Issues (after all issue children)
        await tx.delete(issues).where(eq(issues.companyId, id));
        // Project children (before projects)
        await tx.delete(projectWorkspaces).where(eq(projectWorkspaces.companyId, id));
        await tx.delete(projectGoals).where(eq(projectGoals.companyId, id));
        // Subscriptions
        await tx.delete(companySubscriptions).where(eq(companySubscriptions.companyId, id));
        // Top-level entities
        await tx.delete(companyLogos).where(eq(companyLogos.companyId, id));
        await tx.delete(assets).where(eq(assets.companyId, id));
        await tx.delete(goals).where(eq(goals.companyId, id));
        await tx.delete(projects).where(eq(projects.companyId, id));
        await tx.delete(agents).where(eq(agents.companyId, id));
        await tx.delete(activityLog).where(eq(activityLog.companyId, id));
        // Finally the company itself
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
