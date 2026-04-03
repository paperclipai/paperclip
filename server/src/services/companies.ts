import { and, count, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companies,
  companyLogos,
  assets,
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
  financeEvents,
  approvalComments,
  approvals,
  activityLog,
  companySecrets,
  joinRequests,
  invites,
  principalPermissionGrants,
  companyMemberships,
  routines,
  routineTriggers,
  routineRuns,
  labels,
  companySkills,
  budgetPolicies,
  budgetIncidents,
  documents,
  documentRevisions,
  feedbackVotes,
  feedbackExports,
} from "@paperclipai/db";
import type { CompanyResetDeletedCounts } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";

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
    requireBoardApprovalForNewAgents:
      companies.requireBoardApprovalForNewAgents,
    feedbackDataSharingEnabled: companies.feedbackDataSharingEnabled,
    feedbackDataSharingConsentAt: companies.feedbackDataSharingConsentAt,
    feedbackDataSharingConsentByUserId:
      companies.feedbackDataSharingConsentByUserId,
    feedbackDataSharingTermsVersion: companies.feedbackDataSharingTermsVersion,
    brandColor: companies.brandColor,
    logoAssetId: companyLogos.assetId,
    createdAt: companies.createdAt,
    updatedAt: companies.updatedAt,
  };

  function enrichCompany<T extends { logoAssetId: string | null }>(company: T) {
    return {
      ...company,
      logoUrl: company.logoAssetId
        ? `/api/assets/${company.logoAssetId}/content`
        : null,
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
        spentMonthlyCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
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
    return new Map(
      rows.map((row) => [row.companyId, Number(row.spentMonthlyCents ?? 0)]),
    );
  }

  async function hydrateCompanySpend<
    T extends { id: string; spentMonthlyCents: number },
  >(rows: T[], database: Pick<Db, "select"> = db) {
    const spendByCompanyId = await getMonthlySpendByCompanyIds(
      rows.map((row) => row.id),
      database,
    );
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

  function suffixForAttempt(attempt: number) {
    if (attempt <= 1) return "";
    return "A".repeat(attempt - 1);
  }

  function isIssuePrefixConflict(error: unknown) {
    const constraint =
      typeof error === "object" && error !== null && "constraint" in error
        ? (error as { constraint?: string }).constraint
        : typeof error === "object" &&
            error !== null &&
            "constraint_name" in error
          ? (error as { constraint_name?: string }).constraint_name
          : undefined;
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "23505" &&
      constraint === "companies_issue_prefix_idx"
    );
  }

  async function createCompanyWithUniquePrefix(
    data: typeof companies.$inferInsert,
  ) {
    const base = deriveIssuePrefixBase(data.name);
    let suffix = 1;
    while (suffix < 10000) {
      const candidate = `${base}${suffixForAttempt(suffix)}`;
      try {
        const rows = await db
          .insert(companies)
          .values({ ...data, issuePrefix: candidate })
          .returning();
        return rows[0];
      } catch (error) {
        if (!isIssuePrefixConflict(error)) throw error;
      }
      suffix += 1;
    }
    throw new Error("Unable to allocate unique issue prefix");
  }

  async function getCompanyById(id: string) {
    const row = await getCompanyQuery(db)
      .where(eq(companies.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const [hydrated] = await hydrateCompanySpend([row], db);
    return enrichCompany(hydrated);
  }

  return {
    list: async () => {
      const rows = await getCompanyQuery(db);
      const hydrated = await hydrateCompanySpend(rows);
      return hydrated.map((row) => enrichCompany(row));
    },

    getById: (id: string) => getCompanyById(id),

    create: async (data: typeof companies.$inferInsert) => {
      const created = await createCompanyWithUniquePrefix(data);
      const row = await getCompanyQuery(db)
        .where(eq(companies.id, created.id))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Company not found after creation");
      const [hydrated] = await hydrateCompanySpend([row], db);
      return enrichCompany(hydrated);
    },

    update: (
      id: string,
      data: Partial<typeof companies.$inferInsert> & {
        logoAssetId?: string | null;
      },
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

        if (
          logoAssetId !== undefined &&
          existing.logoAssetId &&
          existing.logoAssetId !== logoAssetId
        ) {
          await tx.delete(assets).where(eq(assets.id, existing.logoAssetId));
        }

        const [hydrated] = await hydrateCompanySpend(
          [
            {
              ...updated,
              logoAssetId:
                logoAssetId === undefined ? existing.logoAssetId : logoAssetId,
            },
          ],
          tx,
        );

        return enrichCompany(hydrated);
      }),

    archive: (id: string) =>
      db.transaction(async (tx) => {
        const updated = await tx
          .update(companies)
          .set({ status: "archived", updatedAt: new Date() })
          .where(eq(companies.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) return null;
        const row = await getCompanyQuery(tx)
          .where(eq(companies.id, id))
          .then((rows) => rows[0] ?? null);
        if (!row) return null;
        const [hydrated] = await hydrateCompanySpend([row], tx);
        return enrichCompany(hydrated);
      }),

    remove: (id: string) =>
      db.transaction(async (tx) => {
        // Delete from child tables in dependency order
        await tx
          .delete(heartbeatRunEvents)
          .where(eq(heartbeatRunEvents.companyId, id));
        await tx
          .delete(agentTaskSessions)
          .where(eq(agentTaskSessions.companyId, id));
        await tx.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, id));
        await tx
          .delete(agentWakeupRequests)
          .where(eq(agentWakeupRequests.companyId, id));
        await tx.delete(agentApiKeys).where(eq(agentApiKeys.companyId, id));
        await tx
          .delete(agentRuntimeState)
          .where(eq(agentRuntimeState.companyId, id));
        await tx.delete(issueComments).where(eq(issueComments.companyId, id));
        await tx.delete(costEvents).where(eq(costEvents.companyId, id));
        await tx.delete(financeEvents).where(eq(financeEvents.companyId, id));
        await tx
          .delete(approvalComments)
          .where(eq(approvalComments.companyId, id));
        await tx.delete(approvals).where(eq(approvals.companyId, id));
        await tx.delete(companySecrets).where(eq(companySecrets.companyId, id));
        await tx.delete(joinRequests).where(eq(joinRequests.companyId, id));
        await tx.delete(invites).where(eq(invites.companyId, id));
        await tx
          .delete(principalPermissionGrants)
          .where(eq(principalPermissionGrants.companyId, id));
        await tx
          .delete(companyMemberships)
          .where(eq(companyMemberships.companyId, id));
        await tx.delete(issues).where(eq(issues.companyId, id));
        await tx.delete(companySkills).where(eq(companySkills.companyId, id));
        await tx.delete(companyLogos).where(eq(companyLogos.companyId, id));
        await tx.delete(assets).where(eq(assets.companyId, id));
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

    reset: async (id: string, confirmName: string) => {
      // Step 1: Verify company exists
      const company = await getCompanyById(id);
      if (!company) {
        throw notFound("Company not found");
      }

      // Step 2: Verify name matches
      if (confirmName !== company.name) {
        throw unprocessable("Company name does not match");
      }

      // Step 3: Count records before deletion
      const [
        agentsCount,
        projectsCount,
        goalsCount,
        issuesCount,
        routinesCount,
        skillsCount,
        labelsCount,
        budgetsCount,
        secretsCount,
      ] = await Promise.all([
        db
          .select({ count: count() })
          .from(agents)
          .where(eq(agents.companyId, id))
          .then((r) => r[0]?.count ?? 0),
        db
          .select({ count: count() })
          .from(projects)
          .where(eq(projects.companyId, id))
          .then((r) => r[0]?.count ?? 0),
        db
          .select({ count: count() })
          .from(goals)
          .where(eq(goals.companyId, id))
          .then((r) => r[0]?.count ?? 0),
        db
          .select({ count: count() })
          .from(issues)
          .where(eq(issues.companyId, id))
          .then((r) => r[0]?.count ?? 0),
        db
          .select({ count: count() })
          .from(routines)
          .where(eq(routines.companyId, id))
          .then((r) => r[0]?.count ?? 0),
        db
          .select({ count: count() })
          .from(companySkills)
          .where(eq(companySkills.companyId, id))
          .then((r) => r[0]?.count ?? 0),
        db
          .select({ count: count() })
          .from(labels)
          .where(eq(labels.companyId, id))
          .then((r) => r[0]?.count ?? 0),
        db
          .select({ count: count() })
          .from(budgetPolicies)
          .where(eq(budgetPolicies.companyId, id))
          .then((r) => r[0]?.count ?? 0),
        db
          .select({ count: count() })
          .from(companySecrets)
          .where(eq(companySecrets.companyId, id))
          .then((r) => r[0]?.count ?? 0),
      ]);

      const deletedCounts: CompanyResetDeletedCounts = {
        agents: Number(agentsCount),
        projects: Number(projectsCount),
        goals: Number(goalsCount),
        issues: Number(issuesCount),
        routines: Number(routinesCount),
        skills: Number(skillsCount),
        labels: Number(labelsCount),
        budgets: Number(budgetsCount),
        secrets: Number(secretsCount),
      };

      // Step 4: Delete all org-scoped data in a single transaction
      // PRESERVE: company, company_logos, board memberships (role = 'board')
      await db.transaction(async (tx) => {
        // Delete heartbeat_run_events
        await tx
          .delete(heartbeatRunEvents)
          .where(eq(heartbeatRunEvents.companyId, id));
        // Delete agent_task_sessions
        await tx
          .delete(agentTaskSessions)
          .where(eq(agentTaskSessions.companyId, id));
        // Delete heartbeat_runs
        await tx.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, id));
        // Delete agent_wakeup_requests
        await tx
          .delete(agentWakeupRequests)
          .where(eq(agentWakeupRequests.companyId, id));
        // Delete agent_api_keys
        await tx.delete(agentApiKeys).where(eq(agentApiKeys.companyId, id));
        // Delete agent_runtime_state
        await tx
          .delete(agentRuntimeState)
          .where(eq(agentRuntimeState.companyId, id));
        // Delete issue_comments
        await tx.delete(issueComments).where(eq(issueComments.companyId, id));
        // Delete cost_events
        await tx.delete(costEvents).where(eq(costEvents.companyId, id));
        // Delete finance_events
        await tx.delete(financeEvents).where(eq(financeEvents.companyId, id));
        // Delete approval_comments
        await tx
          .delete(approvalComments)
          .where(eq(approvalComments.companyId, id));
        // Delete approvals
        await tx.delete(approvals).where(eq(approvals.companyId, id));
        // Delete company_secrets (cascade to company_secret_versions)
        await tx.delete(companySecrets).where(eq(companySecrets.companyId, id));
        // Delete join_requests
        await tx.delete(joinRequests).where(eq(joinRequests.companyId, id));
        // Delete invites
        await tx.delete(invites).where(eq(invites.companyId, id));
        // Delete principal_permission_grants
        await tx
          .delete(principalPermissionGrants)
          .where(eq(principalPermissionGrants.companyId, id));
        // Delete issues (cascade to issue_labels, issue_comments, issue_attachments, issue_documents, issue_work_products, issue_approvals)
        await tx.delete(issues).where(eq(issues.companyId, id));
        // Delete company_skills
        await tx.delete(companySkills).where(eq(companySkills.companyId, id));
        // Delete labels (cascade to issue_labels)
        await tx.delete(labels).where(eq(labels.companyId, id));
        // Delete projects (cascade to project_goals, routine_runs, execution_workspaces)
        await tx.delete(projects).where(eq(projects.companyId, id));
        // Delete goals (cascade to routines)
        await tx.delete(goals).where(eq(goals.companyId, id));
        // Delete routine_triggers (cascade to routine_runs via FK, routines via FK)
        await tx
          .delete(routineTriggers)
          .where(eq(routineTriggers.companyId, id));
        // Delete routines (cascade to routine_runs, routine_triggers)
        await tx.delete(routines).where(eq(routines.companyId, id));
        // Delete routine_runs (standalone since routines already deleted via cascade, but explicit for clarity)
        await tx.delete(routineRuns).where(eq(routineRuns.companyId, id));
        // Delete budget_policies (cascade to budget_incidents)
        await tx.delete(budgetPolicies).where(eq(budgetPolicies.companyId, id));
        // Delete budget_incidents
        await tx
          .delete(budgetIncidents)
          .where(eq(budgetIncidents.companyId, id));
        // Delete documents (cascade to document_revisions, issue_documents)
        await tx.delete(documents).where(eq(documents.companyId, id));
        // Delete document_revisions
        await tx
          .delete(documentRevisions)
          .where(eq(documentRevisions.companyId, id));
        // Delete feedback_votes (cascade to feedback_exports)
        await tx.delete(feedbackVotes).where(eq(feedbackVotes.companyId, id));
        // Delete feedback_exports
        await tx
          .delete(feedbackExports)
          .where(eq(feedbackExports.companyId, id));
        // Delete assets
        await tx.delete(assets).where(eq(assets.companyId, id));
        // Delete non-board company_memberships only
        await tx
          .delete(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, id),
              eq(companyMemberships.membershipRole, "board"),
            ),
          );
        // Delete agents
        await tx.delete(agents).where(eq(agents.companyId, id));
        // Delete activity_log
        await tx.delete(activityLog).where(eq(activityLog.companyId, id));
      });

      // Step 5: Log activity
      await logActivity(db, {
        companyId: id,
        actorType: "system",
        actorId: "system",
        action: "company.reset",
        entityType: "company",
        entityId: id,
        details: { deletedCounts },
      });

      // Step 6: Return company (still exists) and deleted counts
      const updatedCompany = await getCompanyById(id);
      return {
        company: updatedCompany!,
        deletedCounts,
      };
    },

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
        const result: Record<
          string,
          { agentCount: number; issueCount: number }
        > = {};
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
