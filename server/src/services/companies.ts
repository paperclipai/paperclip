import { and, count, eq, gte, inArray, isNull, lt, notInArray, sql } from "drizzle-orm";
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
  issueReadStates,
  approvalComments,
  approvals,
  activityLog,
  companySecrets,
  joinRequests,
  invites,
  principalPermissionGrants,
  companyMemberships,
  companySkills,
  documents,
  routineRuns,
  routineTriggers,
  routineRevisions,
  routines,
} from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { environmentService } from "./environments.js";
import { heartbeatService } from "./heartbeat.js";
import { logActivity } from "./activity-log.js";
import { builtInAgentService } from "./built-in-agents.js";

export interface CompanyActivityActor {
  actorType: "user" | "agent" | "system" | "plugin";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
}

const SYSTEM_COMPANY_ACTOR: CompanyActivityActor = {
  actorType: "system",
  actorId: "system",
  agentId: null,
  runId: null,
};

export type RestrictiveForeignKeyEdge = {
  childSchema: string;
  childTable: string;
  parentSchema: string;
  parentTable: string;
  constraintName: string;
  deleteAction: "a" | "r";
};

const SAFE_SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export function buildCompanyScopedDeleteOrder(
  tableNames: string[],
  restrictiveEdges: RestrictiveForeignKeyEdge[],
) {
  const scopedTables = new Set(tableNames);
  if (scopedTables.size === 0) {
    throw new Error("Company deletion refused: no public company-scoped tables were discovered");
  }

  for (const tableName of scopedTables) {
    if (!SAFE_SQL_IDENTIFIER.test(tableName)) {
      throw new Error(`Company deletion refused: unsafe table identifier ${JSON.stringify(tableName)}`);
    }
  }

  const outgoing = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const tableName of scopedTables) {
    outgoing.set(tableName, new Set());
    indegree.set(tableName, 0);
  }

  for (const edge of restrictiveEdges) {
    if (edge.parentSchema !== "public" || !scopedTables.has(edge.parentTable)) continue;
    if (edge.childSchema !== "public" || !scopedTables.has(edge.childTable)) {
      throw new Error(
        `Company deletion refused: restrictive external FK ${edge.constraintName} ` +
        `(${edge.childSchema}.${edge.childTable} -> ${edge.parentSchema}.${edge.parentTable})`,
      );
    }
    if (edge.childTable === edge.parentTable) continue;
    const parents = outgoing.get(edge.childTable)!;
    if (parents.has(edge.parentTable)) continue;
    parents.add(edge.parentTable);
    indegree.set(edge.parentTable, indegree.get(edge.parentTable)! + 1);
  }

  const ready = [...scopedTables].filter((tableName) => indegree.get(tableName) === 0).sort();
  const ordered: string[] = [];
  while (ready.length > 0) {
    const tableName = ready.shift()!;
    ordered.push(tableName);
    for (const parentTable of [...outgoing.get(tableName)!].sort()) {
      const nextIndegree = indegree.get(parentTable)! - 1;
      indegree.set(parentTable, nextIndegree);
      if (nextIndegree === 0) {
        ready.push(parentTable);
        ready.sort();
      }
    }
  }

  if (ordered.length !== scopedTables.size) {
    const blocked = [...scopedTables].filter((tableName) => !ordered.includes(tableName)).sort();
    throw new Error(`Company deletion refused: restrictive FK cycle among ${blocked.join(", ")}`);
  }
  return ordered;
}

export function companyService(db: Db) {
  const ISSUE_PREFIX_FALLBACK = "CMP";
  const environmentsSvc = environmentService(db);
  const heartbeat = heartbeatService(db);
  const builtInAgents = builtInAgentService(db);

  type CompanyTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

  async function applyArchiveCascadeInTx(tx: CompanyTx, id: string) {
    const pausedAgentRows = await tx
      .update(agents)
      .set({
        status: "paused",
        pauseReason: "company_archived",
        pausedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(agents.companyId, id),
        notInArray(agents.status, ["paused", "terminated", "pending_approval"]),
      ))
      .returning({ id: agents.id });

    const activeRunIds = await tx
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, id),
        inArray(heartbeatRuns.status, ["queued", "running"]),
      ))
      .then((rows) => rows.map((row) => row.id));

    await tx
      .update(agentWakeupRequests)
      .set({
        status: "cancelled",
        error: "Cancelled because the company was archived",
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(agentWakeupRequests.companyId, id),
        inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution", "claimed"]),
        isNull(agentWakeupRequests.runId),
      ));

    return { agentsPaused: pausedAgentRows.length, activeRunIds };
  }

  async function finalizeArchive(
    id: string,
    actor: CompanyActivityActor,
    cascade: { agentsPaused: number; activeRunIds: string[] },
  ) {
    for (const runId of cascade.activeRunIds) {
      await heartbeat.cancelRun(runId, "Cancelled because the company was archived");
    }

    await logActivity(db, {
      companyId: id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      action: "company.archived",
      entityType: "company",
      entityId: id,
      details: {
        agentsPaused: cascade.agentsPaused,
        runsCancelled: cascade.activeRunIds.length,
      },
    });
  }

  const companySelection = {
    id: companies.id,
    name: companies.name,
    description: companies.description,
    status: companies.status,
    issuePrefix: companies.issuePrefix,
    issueCounter: companies.issueCounter,
    budgetMonthlyCents: companies.budgetMonthlyCents,
    spentMonthlyCents: companies.spentMonthlyCents,
    attachmentMaxBytes: companies.attachmentMaxBytes,
    defaultResponsibleUserId: companies.defaultResponsibleUserId,
    requireBoardApprovalForNewAgents: companies.requireBoardApprovalForNewAgents,
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

  function suffixForAttempt(attempt: number) {
    if (attempt <= 1) return "";
    return "A".repeat(attempt - 1);
  }

  function isIssuePrefixConflict(error: unknown) {
    const seen = new Set<unknown>();
    let current = error;
    while (typeof current === "object" && current !== null && !seen.has(current)) {
      seen.add(current);
      const maybe = current as { code?: string; constraint?: string; constraint_name?: string; cause?: unknown };
      const constraint = maybe.constraint ?? maybe.constraint_name;
      if (maybe.code === "23505" && constraint === "companies_issue_prefix_idx") {
        return true;
      }
      current = maybe.cause;
    }
    return false;
  }

  async function createCompanyWithUniquePrefix(data: typeof companies.$inferInsert) {
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

  return {
    list: async () => {
      const rows = await getCompanyQuery(db);
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
      await environmentsSvc.ensureLocalEnvironment(created.id);
      await builtInAgents.autoProvisionBundledAgents(created.id);
      const row = await getCompanyQuery(db)
        .where(eq(companies.id, created.id))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Company not found after creation");
      const [hydrated] = await hydrateCompanySpend([row], db);
      return enrichCompany(hydrated);
    },

    update: async (
      id: string,
      data: Partial<typeof companies.$inferInsert> & { logoAssetId?: string | null },
      actor: CompanyActivityActor = SYSTEM_COMPANY_ACTOR,
    ) => {
      const result = await db.transaction(async (tx) => {
        const existing = await getCompanyQuery(tx)
          .where(eq(companies.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        const { logoAssetId, ...companyPatch } = data;
        const willReactivate = existing.status !== "active" && companyPatch.status === "active";
        const willArchive = existing.status !== "archived" && companyPatch.status === "archived";

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

        let agentsRestored = 0;
        if (willReactivate) {
          const restoredRows = await tx
            .update(agents)
            .set({
              status: "idle",
              pauseReason: null,
              pausedAt: null,
              updatedAt: new Date(),
            })
            .where(and(
              eq(agents.companyId, id),
              eq(agents.status, "paused"),
              eq(agents.pauseReason, "company_archived"),
            ))
            .returning({ id: agents.id });
          agentsRestored = restoredRows.length;
        }

        const archiveCascade = willArchive ? await applyArchiveCascadeInTx(tx, id) : null;

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

        const shouldLogReactivation = willReactivate &&
          (existing.status === "archived" || agentsRestored > 0);

        return {
          company: enrichCompany(hydrated),
          reactivated: shouldLogReactivation ? { agentsRestored } : null,
          archiveCascade,
        };
      });
      if (!result) return null;
      if (result.reactivated) {
        await logActivity(db, {
          companyId: id,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId ?? null,
          runId: actor.runId ?? null,
          action: "company.reactivated",
          entityType: "company",
          entityId: id,
          details: { agentsRestored: result.reactivated.agentsRestored },
        });
      }
      if (result.archiveCascade) {
        await finalizeArchive(id, actor, result.archiveCascade);
      }
      return result.company;
    },

    archive: async (id: string, actor: CompanyActivityActor = SYSTEM_COMPANY_ACTOR) => {
      const result = await db.transaction(async (tx) => {
        const existing = await tx
          .select({ status: companies.status })
          .from(companies)
          .where(eq(companies.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        const wasAlreadyArchived = existing.status === "archived";

        if (!wasAlreadyArchived) {
          await tx
            .update(companies)
            .set({ status: "archived", updatedAt: new Date() })
            .where(eq(companies.id, id));
        }

        const cascade = wasAlreadyArchived ? null : await applyArchiveCascadeInTx(tx, id);

        const row = await getCompanyQuery(tx)
          .where(eq(companies.id, id))
          .then((rows) => rows[0] ?? null);
        if (!row) return null;
        const [hydrated] = await hydrateCompanySpend([row], tx);
        return {
          company: enrichCompany(hydrated),
          cascade,
        };
      });
      if (!result) return null;

      if (result.cascade) {
        await finalizeArchive(id, actor, result.cascade);
      }

      return result.company;
    },

    remove: (id: string) =>
      db.transaction(async (tx) => {
        // Lock the parent first so concurrent workers cannot add new rows after
        // their company-scoped table has already been cleared.
        await tx.execute(sql`SELECT id FROM ${companies} WHERE ${companies.id} = ${id} FOR UPDATE`);

        // Preserve the historical cross-scope safeguard: old/corrupt event rows
        // may point at a company run while carrying a different company_id.
        const companyRunIds = await tx
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.companyId, id));
        if (companyRunIds.length > 0) {
          await tx
            .delete(heartbeatRunEvents)
            .where(inArray(heartbeatRunEvents.runId, companyRunIds.map((run) => run.id)));
        }

        const companyScopedRows = Array.from(await tx.execute(sql<{ tableName: string }>`
          SELECT table_name AS "tableName"
          FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'company_id'
          ORDER BY table_name
        `)) as unknown as Array<{ tableName: string }>;
        const restrictiveEdges = Array.from(await tx.execute(sql<RestrictiveForeignKeyEdge>`
          SELECT
            child_ns.nspname AS "childSchema",
            child.relname AS "childTable",
            parent_ns.nspname AS "parentSchema",
            parent.relname AS "parentTable",
            constraint_row.conname AS "constraintName",
            constraint_row.confdeltype AS "deleteAction"
          FROM pg_constraint constraint_row
          JOIN pg_class child ON child.oid = constraint_row.conrelid
          JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
          JOIN pg_class parent ON parent.oid = constraint_row.confrelid
          JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
          WHERE constraint_row.contype = 'f'
            AND constraint_row.confdeltype IN ('a', 'r')
            AND parent_ns.nspname = 'public'
          ORDER BY child_ns.nspname, child.relname, parent.relname, constraint_row.conname
        `)) as unknown as RestrictiveForeignKeyEdge[];

        const deleteOrder = buildCompanyScopedDeleteOrder(
          companyScopedRows.map((row) => row.tableName),
          restrictiveEdges,
        );
        for (const tableName of deleteOrder) {
          await tx.execute(
            sql`DELETE FROM ${sql.identifier(tableName)} WHERE ${sql.identifier("company_id")} = ${id}`,
          );
        }

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
