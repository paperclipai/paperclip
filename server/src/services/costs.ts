import { receiptFingerprint } from "./receipt-fingerprint.js";
import { agentAvatarUrl, resolveAgentAppearance, createCostEventSchema, createServiceCostEventSchema, normalizeCents, isUuidLike, type MoneyInput, type CostByUserReport } from "@paperclipai/shared";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, agentRuntimeState, authUsers, companies, companyMemberships, costEvents, heartbeatRuns, issues, projects, goals, aiSubscriptions } from "@paperclipai/db";
import { notFound, unprocessable, conflict } from "../errors.js";
import { budgetService, budgetServiceInTransaction, type BudgetServiceHooks } from "./budgets.js";
import { logActivity, type LogActivityInput, type ActivityPublication } from "./activity-log.js";
import { withAccountingReadSnapshot, withAccountingTransaction } from "./accounting-transaction.js";
import { visibleIssueCondition } from "./issue-visibility.js";

import { resolveCostDateRange, type CostDateRange } from "./cost-date-range.js";
export type { CostDateRange } from "./cost-date-range.js";

const METERED_BILLING_TYPE = "metered_api";
const SUBSCRIPTION_BILLING_TYPES = ["subscription_included", "subscription_overage"] as const;

// Pre-receipt Codex events stored cache reads inside input; Pi/OpenCode used
// provider-qualified model IDs and already excluded cache reads. Normalize each
// historical row before aggregation so mixed old/new groups share the current
// exclusive-input contract. Preserve the original ledger and monetary amounts.
export const ordinaryInputTokens = sql<number>`case
  when ${costEvents.receiptHash} is null and ${costEvents.provider} = 'openai'
    and ${costEvents.model} not like 'openai/_%'
    then greatest(0, ${costEvents.inputTokens} - ${costEvents.cachedInputTokens})
  else ${costEvents.inputTokens} end`;

function sumAsNumber(column: typeof costEvents.costCents | typeof costEvents.inputTokens | typeof costEvents.cachedInputTokens | typeof costEvents.outputTokens | ReturnType<typeof sql>) {
  return sql<number>`coalesce(sum(${column}), 0)::double precision`;
}

function currentUtcMonthWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
  };
}

/** Increment an initialized month under the company lock. On upgrade or UTC
 * rollover, initialize from the ledger in the same transaction exactly once.
 * Reports, budgets and the integrity checker continue reading the ledger. */
export async function updateMonthlySpendProjections(db: Db, companyId: string, agentId: string | null, amountCents: MoneyInput, occurredAt: Date) {
  const { start, end } = currentUtcMonthWindow();
  const month = start.toISOString().slice(0, 10);
  const delta = occurredAt >= start && occurredAt < end ? normalizeCents(amountCents) : "0.0000000";
  for (const table of [companies, agents] as const) {
    const id = table === companies ? companyId : agentId;
    if (!id) continue;
    const companyCondition = table === companies ? eq(companies.id, companyId) : eq(agents.companyId, companyId);
    await db.update(table).set({
      spentMonthlyCents: sql`case when ${table.spendMonthUtc} = ${month} then ${table.spentMonthlyCents} + ${delta}::numeric else (
        select coalesce(sum(${costEvents.costCents}),0) from ${costEvents} where ${costEvents.companyId} = ${companyId}
        and ${costEvents.occurredAt} >= ${start.toISOString()}::timestamptz and ${costEvents.occurredAt} < ${end.toISOString()}::timestamptz
        ${table === agents ? sql`and ${costEvents.agentId} = ${agentId}` : sql``}) end`,
      spendMonthUtc: month, updatedAt: new Date(),
    }).where(and(eq(table.id, id), companyCondition));
  }
}

export async function getMonthlySpendTotal(
  db: Db,
  scope: { companyId: string; agentId?: string | null },
) {
  const { start, end } = currentUtcMonthWindow();
  const conditions = [
    eq(costEvents.companyId, scope.companyId),
    gte(costEvents.occurredAt, start),
    lt(costEvents.occurredAt, end),
  ];
  if (scope.agentId) {
    conditions.push(eq(costEvents.agentId, scope.agentId));
  }
  const [row] = await db
    .select({
      total: sumAsNumber(costEvents.costCents),
    })
    .from(costEvents)
    .where(and(...conditions));
  return Number(row?.total ?? 0);
}

export async function createCostEventInTransaction(db: Db, companyId: string, data: Omit<typeof costEvents.$inferInsert, "companyId" | "receiptHash" | "costCents"> & { costCents: MoneyInput }, publications: ActivityPublication[] = [], actor?: Pick<LogActivityInput, "actorType" | "actorId" | "agentId">) {
  const parsed = ((data.usageKind === "decision" || data.usageKind === "fast_response") ? createServiceCostEventSchema : createCostEventSchema).safeParse({ ...data, occurredAt: data.occurredAt.toISOString() });
  if (!parsed.success) throw unprocessable("Invalid cost receipt", parsed.error.flatten());
  const values = {
    ...parsed.data,
    issueId: parsed.data.issueId ?? null,
    projectId: parsed.data.projectId ?? null,
    goalId: parsed.data.goalId ?? null,
    heartbeatRunId: parsed.data.heartbeatRunId ?? null,
    billingCode: parsed.data.billingCode ?? null,
    idempotencyKey: parsed.data.idempotencyKey ?? null,
    costCents: normalizeCents(parsed.data.costCents),
    occurredAt: new Date(parsed.data.occurredAt),
  };
  const receiptHash = receiptFingerprint(values);
  // Older receipts hashed the numeric API value. Retain replay compatibility
  // only when the decimal value survives that representation exactly.
  let legacyHash: string | null = null;
  try {
    if (normalizeCents(Number(values.costCents)) === values.costCents) legacyHash = receiptFingerprint({ ...values, costCents: Number(values.costCents) });
  } catch { /* The legacy number may round beyond the decimal storage limit. */ }
  if (values.idempotencyKey) {
    const [existing] = await db.select().from(costEvents).where(and(
      eq(costEvents.companyId, companyId), eq(costEvents.idempotencyKey, values.idempotencyKey),
    ));
    if (existing) {
      if (existing.receiptHash !== receiptHash && existing.receiptHash !== legacyHash) throw conflict("Idempotency key already used for a different cost receipt");
      const [exact] = await db.select({ costCents: sql<string>`${costEvents.costCents}::text` }).from(costEvents).where(eq(costEvents.id, existing.id));
      return { ...existing, costCentsExact: normalizeCents(exact.costCents) };
    }
  }
  const links = [
    [agents, values.agentId, "Agent"], [issues, values.issueId, "Issue"],
    [projects, values.projectId, "Project"], [goals, values.goalId, "Goal"],
    [heartbeatRuns, values.heartbeatRunId, "Heartbeat run"],
  ] as const;
  for (const [table, id, label] of links) {
    if (!id) continue;
    const [row] = await db.select({ companyId: table.companyId }).from(table).where(eq(table.id, id));
    if (!row) throw notFound(`${label} not found`);
    if (row.companyId !== companyId) throw unprocessable(`${label} does not belong to company`);
  }
  let subscriptionId: string | null = null;
  if (values.heartbeatRunId) {
    const [run] = await db.select({ agentId: heartbeatRuns.agentId, context: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(eq(heartbeatRuns.id, values.heartbeatRunId));
    if (run.agentId !== values.agentId) throw unprocessable("Heartbeat run does not belong to agent");
    const attribution = run.context?.aiConnection as { subscriptionId?: unknown; provider?: unknown } | undefined;
    if (SUBSCRIPTION_BILLING_TYPES.includes(values.billingType as typeof SUBSCRIPTION_BILLING_TYPES[number]) && attribution?.provider === values.provider && typeof attribution.subscriptionId === "string" && isUuidLike(attribution.subscriptionId)) {
      const [account] = await db.select({ id: aiSubscriptions.id }).from(aiSubscriptions).where(and(eq(aiSubscriptions.id, attribution.subscriptionId), eq(aiSubscriptions.companyId, companyId), eq(aiSubscriptions.provider, values.provider)));
      subscriptionId = account?.id ?? null;
    }
  }
  // Server-derived attribution stays outside the immutable receipt fingerprint;
  // replaying a receipt must not depend on later account metadata changes.
  const [event] = await db.insert(costEvents).values({ ...values, subscriptionId, costCents: sql`${values.costCents}::numeric`, reportedCostCents: values.costCents, id: data.id, companyId, receiptHash }).returning();
  await updateMonthlySpendProjections(db, companyId, event.agentId, values.costCents, event.occurredAt);
  // Separately reported charges linked to an already-accounted run contribute
  // to lifetime totals too. Before acknowledgement, accountRunCost includes
  // all of the run's events atomically when it initializes the projection.
  if (event.heartbeatRunId && event.agentId) {
    const [run] = await db.select({ acknowledged: heartbeatRuns.costAccountedAt, version: heartbeatRuns.accountingProjectionVersion })
      .from(heartbeatRuns).where(and(eq(heartbeatRuns.id, event.heartbeatRunId), eq(heartbeatRuns.companyId, companyId)));
    if (run.acknowledged && run.version === "v2") await db.update(agentRuntimeState).set({
      totalCostCents: sql`${agentRuntimeState.totalCostCents} + ${values.costCents}::numeric`,
      totalInputTokens: sql`${agentRuntimeState.totalInputTokens} + ${event.inputTokens}`,
      totalCachedInputTokens: sql`${agentRuntimeState.totalCachedInputTokens} + ${event.cachedInputTokens}`,
      totalOutputTokens: sql`${agentRuntimeState.totalOutputTokens} + ${event.outputTokens}`,
      updatedAt: new Date(),
    }).where(and(eq(agentRuntimeState.agentId, event.agentId), eq(agentRuntimeState.companyId, companyId)));
  }
  await budgetServiceInTransaction(db, publications).evaluateCostEvent(event);
  await logActivity(db, {
    companyId, actorType: actor?.actorType ?? "system", actorId: actor?.actorId ?? "cost_accounting", agentId: actor?.agentId ?? event.agentId,
    ...((event.usageKind === "decision" || event.usageKind === "fast_response") ? { responsibleUserIdOverride: event.responsibleUserId } : {}),
    runId: event.heartbeatRunId, action: "cost.reported", entityType: "cost_event", entityId: event.id,
    details: { costCents: event.costCents, costCentsExact: values.costCents, model: event.model, costStatus: event.costStatus },
  }, publications);
  return { ...event, costCentsExact: values.costCents };
}

export function costService(db: Db, budgetHooks: BudgetServiceHooks = {}) {
  const budgets = budgetService(db, budgetHooks);
  return {
    createEvent: async (companyId: string, data: Omit<typeof costEvents.$inferInsert, "companyId" | "receiptHash" | "costCents"> & { costCents: MoneyInput }, actor?: Pick<LogActivityInput, "actorType" | "actorId" | "agentId">) => {
      if (data.idempotencyKey?.startsWith("heartbeat:")) throw unprocessable("The heartbeat idempotency namespace is reserved for run receipts");
      const event = await withAccountingTransaction(db, companyId, (tx, publications) => createCostEventInTransaction(tx, companyId, data, publications, actor));
      await budgets.deliverPendingEnforcement(companyId);
      return event;
    },

    summary: async (companyId: string, range?: CostDateRange) => withAccountingReadSnapshot(db, companyId, async (db) => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      range = resolveCostDateRange(range);
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      const [{ total, totalExact, eventCount, unpricedEventCount, estimatedEventCount }] = await db
        .select({
          eventCount: sql<number>`count(*)::int`,
          estimatedEventCount: sql<number>`count(*) filter (where ${costEvents.costStatus} = 'estimated')::int`,
          unpricedEventCount: sql<number>`count(*) filter (where ${costEvents.costStatus} = 'unpriced' and ${costEvents.billingType} <> 'subscription_included')::int`,
          total: sumAsNumber(costEvents.costCents),
          totalExact: sql<string>`coalesce(sum(${costEvents.costCents}), 0)::text`,
        })
        .from(costEvents)
        .where(and(...conditions));

      const pendingConditions = [eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.costAccountingPending, true),
        inArray(heartbeatRuns.status, ["succeeded", "failed", "timed_out", "cancelled", "interrupted"])];
      if (range?.from) pendingConditions.push(sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.createdAt}) >= ${range.from.toISOString()}::timestamptz`);
      if (range?.to) pendingConditions.push(sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.createdAt}) <= ${range.to.toISOString()}::timestamptz`);
      const [pending] = await db.select({ count: sql<number>`count(*)::int` }).from(heartbeatRuns).where(and(...pendingConditions));
      const pendingRunCount = pending?.count ?? 0;
      const spendCents = Number(total);
      const utilization =
        company.budgetMonthlyCents > 0
          ? (spendCents / company.budgetMonthlyCents) * 100
          : 0;

      return {
        companyId,
        eventCount,
        unpricedEventCount,
        estimatedEventCount,
        pendingRunCount,
        pricingComplete: unpricedEventCount === 0 && pendingRunCount === 0,
        spendCents,
        spendCentsExact: normalizeCents(totalExact),
        budgetCents: company.budgetMonthlyCents,
        utilizationPercent: Number(utilization.toFixed(2)),
      };
    }),

    issueTreeSummary: async (
      companyId: string,
      issueId: string,
      options: { excludeRoot?: boolean } = {},
    ) => {
      // Callers must resolve and authorize a visible root issue before invoking this.
      // The route does that so zero counts are not mistaken for a missing root.
      const childIssues = alias(issues, "child");

      // The seed of the recursive CTE: when excludeRoot is true, start from
      // the direct children so the root issue itself is not counted.
      const cteSeed = options.excludeRoot
        ? sql`
            SELECT ${issues.id}
            FROM ${issues}
            WHERE ${issues.companyId} = ${companyId}
              AND ${issues.parentId} = ${issueId}
              AND ${issues.hiddenAt} IS NULL
              AND ${issues.harnessKind} IS NULL
          `
        : sql`
            SELECT ${issues.id}
            FROM ${issues}
            WHERE ${issues.companyId} = ${companyId}
              AND ${issues.id} = ${issueId}
              AND ${issues.hiddenAt} IS NULL
              AND ${issues.harnessKind} IS NULL
          `;

      const cteSeedText = options.excludeRoot
        ? sql`
            SELECT (${issues.id})::text AS id
            FROM ${issues}
            WHERE ${issues.companyId} = ${companyId}
              AND ${issues.parentId} = ${issueId}
              AND ${issues.hiddenAt} IS NULL
              AND ${issues.harnessKind} IS NULL
          `
        : sql`
            SELECT (${issues.id})::text AS id
            FROM ${issues}
            WHERE ${issues.companyId} = ${companyId}
              AND ${issues.id} = ${issueId}
              AND ${issues.hiddenAt} IS NULL
              AND ${issues.harnessKind} IS NULL
          `;

      const issueTreeCondition = sql<boolean>`
        ${issues.id} IN (
          WITH RECURSIVE issue_tree(id) AS (
            ${cteSeed}
            UNION ALL
            SELECT ${childIssues.id}
            FROM ${issues} ${childIssues}
            JOIN issue_tree ON ${childIssues.parentId} = issue_tree.id
            WHERE ${childIssues.companyId} = ${companyId}
              AND ${childIssues.hiddenAt} IS NULL
              AND ${childIssues.harnessKind} IS NULL
          )
          SELECT id FROM issue_tree
        )
      `;

      // Runs in the issue subtree, gathered as a UNION of two branches instead of one
      // `issue link OR EXISTS (...)` filter, which no index can serve. The first branch
      // reads the heartbeat_runs.issue_id column, the same link runsForIssue uses, so it
      // never detoasts context_snapshot. The second branch reaches runs through
      // activity_log and the primary key. UNION (not UNION ALL) keeps a run that matches
      // both branches counted once.
      const runSummarySql = sql`
        WITH RECURSIVE issue_tree(id) AS (
          ${cteSeedText}
          UNION ALL
          SELECT (${childIssues.id})::text
          FROM ${issues} ${childIssues}
          JOIN issue_tree ON (${childIssues.parentId})::text = issue_tree.id
          WHERE ${childIssues.companyId} = ${companyId}
            AND ${childIssues.hiddenAt} IS NULL
            AND ${childIssues.harnessKind} IS NULL
        ),
        matching_runs AS (
          SELECT ${heartbeatRuns.id} AS id, ${heartbeatRuns.startedAt} AS started_at, ${heartbeatRuns.finishedAt} AS finished_at
          FROM ${heartbeatRuns}
          WHERE ${heartbeatRuns.companyId} = ${companyId}
            AND ${heartbeatRuns.startedAt} IS NOT NULL
            AND ${heartbeatRuns.issueId} IN (SELECT id::uuid FROM issue_tree)
          UNION
          SELECT ${heartbeatRuns.id} AS id, ${heartbeatRuns.startedAt} AS started_at, ${heartbeatRuns.finishedAt} AS finished_at
          FROM ${heartbeatRuns}
          WHERE ${heartbeatRuns.companyId} = ${companyId}
            AND ${heartbeatRuns.startedAt} IS NOT NULL
            AND ${heartbeatRuns.id} IN (
              SELECT ${activityLog.runId}
              FROM ${activityLog}
              WHERE ${activityLog.companyId} = ${companyId}
                AND ${activityLog.entityType} = 'issue'
                AND ${activityLog.entityId} IN (SELECT id FROM issue_tree)
                AND ${activityLog.runId} IS NOT NULL
            )
        )
        SELECT
          count(*)::int AS "runCount",
          coalesce(sum(extract(epoch from (coalesce(finished_at, now()) - started_at)) * 1000), 0)::double precision AS "runtimeMs"
        FROM matching_runs
      `;

      // Run cost-event aggregation and run-duration aggregation in parallel.
      // They're separate queries because cost_events fan out per-event and
      // joining heartbeat_runs through them would double-count run durations.
      const [costRowResult, runRowResult] = await Promise.all([
        db
          .select({
            issueCount: sql<number>`count(distinct ${issues.id})::int`,
            costCents: sumAsNumber(costEvents.costCents),
          costCentsExact: sql<string>`coalesce(sum(${costEvents.costCents}), 0)::text`,
            inputTokens: sumAsNumber(ordinaryInputTokens),
            cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
            outputTokens: sumAsNumber(costEvents.outputTokens),
          })
          .from(issues)
          .leftJoin(
            costEvents,
            and(
              eq(costEvents.companyId, companyId),
              eq(costEvents.issueId, issues.id),
            ),
          )
          .where(
            and(
              eq(issues.companyId, companyId),
              visibleIssueCondition(),
              issueTreeCondition,
            ),
          ),
        db.execute(runSummarySql),
      ]);

      const costRow = costRowResult[0];
      const runRow = Array.isArray(runRowResult)
        ? (runRowResult[0] as { runCount?: number | string | null; runtimeMs?: number | string | null } | undefined)
        : undefined;

      return {
        issueId,
        issueCount: Number(costRow?.issueCount ?? 0),
        includeDescendants: true,
        costCents: Number(costRow?.costCents ?? 0),
        costCentsExact: normalizeCents(costRow?.costCentsExact ?? 0),
        inputTokens: Number(costRow?.inputTokens ?? 0),
        cachedInputTokens: Number(costRow?.cachedInputTokens ?? 0),
        outputTokens: Number(costRow?.outputTokens ?? 0),
        runCount: Number(runRow?.runCount ?? 0),
        runtimeMs: Number(runRow?.runtimeMs ?? 0),
      };
    },

    byUser: (companyId: string, range?: CostDateRange): Promise<CostByUserReport> => withAccountingReadSnapshot(db, companyId, async tx => {
      // Keep membership, identity and spend in one non-blocking read snapshot.
      const members = await tx.select({
        userId: companyMemberships.principalId,
        status: companyMemberships.status,
        userName: authUsers.name,
        userImage: authUsers.image,
      }).from(companyMemberships)
        .leftJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
        .where(and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          ne(companyMemberships.principalId, "local-board"),
        ));
      const activeMembers = members.filter(member => member.status === "active");
      const activeUserCount = activeMembers.length;

      const bounds = resolveCostDateRange(range);
      const conditions = [eq(costEvents.companyId, companyId)];
      if (bounds.from) conditions.push(gte(costEvents.occurredAt, bounds.from));
      if (bounds.to) conditions.push(lte(costEvents.occurredAt, bounds.to));
      const totals = await tx.select({
        userId: companyMemberships.principalId,
        eventCount: sql<number>`count(*)::int`,
        estimatedEventCount: sql<number>`count(*) filter (where ${costEvents.costStatus} = 'estimated')::int`,
        unpricedEventCount: sql<number>`count(*) filter (where ${costEvents.costStatus} = 'unpriced' and ${costEvents.billingType} <> 'subscription_included')::int`,
        costCents: sumAsNumber(costEvents.costCents),
        costCentsExact: sql<string>`coalesce(sum(${costEvents.costCents}), 0)::text`,
        inputTokens: sumAsNumber(ordinaryInputTokens),
        cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
        outputTokens: sumAsNumber(costEvents.outputTokens),
        runCount: sql<number>`count(distinct ${heartbeatRuns.id})::int`,
      }).from(costEvents)
        .leftJoin(heartbeatRuns, and(
          eq(heartbeatRuns.id, costEvents.heartbeatRunId),
          eq(heartbeatRuns.companyId, costEvents.companyId),
          eq(heartbeatRuns.agentId, costEvents.agentId),
        ))
        // Never resolve names through a foreign-company run or membership. Retain
        // former members' historical spend; missing attribution remains in the total.
        // The synthetic Board principal is not a person. Any historical charges
        // attached to it remain in Unattributed so the report still reconciles.
        .leftJoin(companyMemberships, and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          ne(companyMemberships.principalId, "local-board"),
          eq(companyMemberships.principalId, sql`case when ${costEvents.usageKind} in ('decision', 'fast_response') then ${costEvents.responsibleUserId} else ${heartbeatRuns.responsibleUserId} end`),
        ))
        .where(and(...conditions))
        .groupBy(companyMemberships.principalId)
        .orderBy(desc(sql`sum(${costEvents.costCents})`), companyMemberships.principalId);
      const directory = new Map(members.map(member => [member.userId, member]));
      const rows: CostByUserReport["rows"] = totals.map(row => ({
        ...row,
        userName: row.userId ? directory.get(row.userId)?.userName ?? "Former user" : null,
        userImage: row.userId ? directory.get(row.userId)?.userImage ?? null : null,
        costCentsExact: normalizeCents(row.costCentsExact),
      }));
      const represented = new Set(rows.map(row => row.userId));
      for (const member of activeMembers.sort((a, b) => (a.userName ?? a.userId).localeCompare(b.userName ?? b.userId))) {
        if (represented.has(member.userId)) continue;
        rows.push({
          userId: member.userId, userName: member.userName ?? "Unknown user", userImage: member.userImage,
          eventCount: 0, estimatedEventCount: 0, unpricedEventCount: 0,
          costCents: 0, costCentsExact: "0.0000000",
          inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, runCount: 0,
        });
      }
      return { activeUserCount, rows };
    }),

    byAgent: async (companyId: string, range?: CostDateRange) => {
      range = resolveCostDateRange(range);
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      const rows = await db
        .select({
          agentId: costEvents.agentId,
          agentName: agents.name,
          agentAppearance: agents.appearance,
          agentStatus: agents.status,
          eventCount: sql<number>`count(*)::int`,
          estimatedEventCount: sql<number>`count(*) filter (where ${costEvents.costStatus} = 'estimated')::int`,
          costCents: sumAsNumber(costEvents.costCents),
          costCentsExact: sql<string>`coalesce(sum(${costEvents.costCents}), 0)::text`,
          inputTokens: sumAsNumber(ordinaryInputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
          apiRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} = ${METERED_BILLING_TYPE} then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionCachedInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.cachedInputTokens} else 0 end), 0)::double precision`,
          subscriptionInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${ordinaryInputTokens} else 0 end), 0)::double precision`,
          subscriptionOutputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.outputTokens} else 0 end), 0)::double precision`,
        })
        .from(costEvents)
        .leftJoin(agents, eq(costEvents.agentId, agents.id))
        .where(and(...conditions))
        .groupBy(costEvents.agentId, agents.name, agents.appearance, agents.status)
        .orderBy(desc(sumAsNumber(costEvents.costCents)));
      return rows.map(row => {
        const appearance = row.agentId ? resolveAgentAppearance(row.agentAppearance, row.agentId) : null;
        return { ...row, agentAppearance: appearance, avatarUrl: appearance ? agentAvatarUrl(appearance, 512) : undefined };
      });
    },

    byProvider: async (companyId: string, range?: CostDateRange) => {
      range = resolveCostDateRange(range);
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      return db
        .select({
          provider: costEvents.provider,
          biller: costEvents.biller,
          billingType: costEvents.billingType,
          model: costEvents.model,
          costCents: sumAsNumber(costEvents.costCents),
          costCentsExact: sql<string>`coalesce(sum(${costEvents.costCents}), 0)::text`,
          inputTokens: sumAsNumber(ordinaryInputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
          apiRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} = ${METERED_BILLING_TYPE} then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionCachedInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.cachedInputTokens} else 0 end), 0)::double precision`,
          subscriptionInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${ordinaryInputTokens} else 0 end), 0)::double precision`,
          subscriptionOutputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.outputTokens} else 0 end), 0)::double precision`,
        })
        .from(costEvents)
        .where(and(...conditions))
        .groupBy(costEvents.provider, costEvents.biller, costEvents.billingType, costEvents.model)
        .orderBy(desc(sumAsNumber(costEvents.costCents)));
    },

    byBiller: async (companyId: string, range?: CostDateRange) => {
      range = resolveCostDateRange(range);
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      return db
        .select({
          biller: costEvents.biller,
          costCents: sumAsNumber(costEvents.costCents),
          costCentsExact: sql<string>`coalesce(sum(${costEvents.costCents}), 0)::text`,
          inputTokens: sumAsNumber(ordinaryInputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
          apiRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} = ${METERED_BILLING_TYPE} then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionCachedInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.cachedInputTokens} else 0 end), 0)::double precision`,
          subscriptionInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${ordinaryInputTokens} else 0 end), 0)::double precision`,
          subscriptionOutputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.outputTokens} else 0 end), 0)::double precision`,
          providerCount: sql<number>`count(distinct ${costEvents.provider})::int`,
          modelCount: sql<number>`count(distinct ${costEvents.model})::int`,
        })
        .from(costEvents)
        .where(and(...conditions))
        .groupBy(costEvents.biller)
        .orderBy(desc(sumAsNumber(costEvents.costCents)));
    },

    /**
     * aggregates cost_events by provider for each of three rolling windows:
     * last 5 hours, last 24 hours, last 7 days.
     * purely internal consumption data, no external rate-limit sources.
     */
    windowSpend: async (companyId: string) => {
      const windows = [
        { label: "5h", hours: 5 },
        { label: "24h", hours: 24 },
        { label: "7d", hours: 168 },
      ] as const;

      const now = new Date();
      const results = await Promise.all(
        windows.map(async ({ label, hours }) => {
          const since = new Date(now.getTime() - hours * 60 * 60 * 1000);
          const rows = await db
            .select({
              provider: costEvents.provider,
              biller: sql<string>`case when count(distinct ${costEvents.biller}) = 1 then min(${costEvents.biller}) else 'mixed' end`,
              costCents: sumAsNumber(costEvents.costCents),
          costCentsExact: sql<string>`coalesce(sum(${costEvents.costCents}), 0)::text`,
              inputTokens: sumAsNumber(ordinaryInputTokens),
              cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
              outputTokens: sumAsNumber(costEvents.outputTokens),
            })
            .from(costEvents)
            .where(
              and(
                eq(costEvents.companyId, companyId),
                gte(costEvents.occurredAt, since),
                lte(costEvents.occurredAt, now),
              ),
            )
            .groupBy(costEvents.provider)
            .orderBy(desc(sumAsNumber(costEvents.costCents)));

          return rows.map((row) => ({
            provider: row.provider,
            biller: row.biller,
            window: label as string,
            windowHours: hours,
            costCents: row.costCents,
            costCentsExact: normalizeCents(row.costCentsExact),
            inputTokens: row.inputTokens,
            cachedInputTokens: row.cachedInputTokens,
            outputTokens: row.outputTokens,
          }));
        }),
      );

      return results.flat();
    },

    byAgentModel: async (companyId: string, range?: CostDateRange) => {
      range = resolveCostDateRange(range);
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      // single query: group by agent + provider + model.
      // the (companyId, agentId, occurredAt) composite index covers this well.
      // order by provider + model for stable db-level ordering; cost-desc sort
      // within each agent's sub-rows is done client-side in the ui memo.
      const rows = await db
        .select({
          agentId: costEvents.agentId,
          agentName: agents.name,
          agentAppearance: agents.appearance,
          provider: costEvents.provider,
          biller: costEvents.biller,
          billingType: costEvents.billingType,
          model: costEvents.model,
          eventCount: sql<number>`count(*)::int`,
          estimatedEventCount: sql<number>`count(*) filter (where ${costEvents.costStatus} = 'estimated')::int`,
          costCents: sumAsNumber(costEvents.costCents),
          costCentsExact: sql<string>`coalesce(sum(${costEvents.costCents}), 0)::text`,
          inputTokens: sumAsNumber(ordinaryInputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
        })
        .from(costEvents)
        .leftJoin(agents, eq(costEvents.agentId, agents.id))
        .where(and(...conditions))
        .groupBy(
          costEvents.agentId,
          agents.name,
          agents.appearance,
          costEvents.provider,
          costEvents.biller,
          costEvents.billingType,
          costEvents.model,
        )
        .orderBy(costEvents.provider, costEvents.biller, costEvents.billingType, costEvents.model);
      return rows.map(row => {
        const appearance = row.agentId ? resolveAgentAppearance(row.agentAppearance, row.agentId) : null;
        return { ...row, agentAppearance: appearance, avatarUrl: appearance ? agentAvatarUrl(appearance, 512) : undefined };
      });
    },

    byProject: async (companyId: string, range?: CostDateRange) => {
      const issueIdAsText = sql<string>`${issues.id}::text`;
      const runProjectLinks = db
        .select({
          runId: activityLog.runId,
          projectId: sql<string>`min(${issues.projectId}::text)::uuid`.as("linked_project_id"),
        })
        .from(activityLog)
        .innerJoin(
          issues,
          and(
            eq(activityLog.entityType, "issue"),
            eq(activityLog.entityId, issueIdAsText),
          ),
        )
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(issues.companyId, companyId),
            isNotNull(activityLog.runId),
            isNotNull(issues.projectId),
          ),
        )
        .groupBy(activityLog.runId)
        .having(sql`count(distinct ${issues.projectId}) = 1`)
        .as("run_project_links");

      const effectiveProjectId = sql<string | null>`coalesce(${costEvents.projectId}, case when ${costEvents.receiptHash} is null then ${runProjectLinks.projectId} end)`;
      range = resolveCostDateRange(range);
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      const costCentsExpr = sumAsNumber(costEvents.costCents);

      return db
        .select({
          projectId: projects.id,
          projectName: projects.name,
          eventCount: sql<number>`count(*)::int`,
          estimatedEventCount: sql<number>`count(*) filter (where ${costEvents.costStatus} = 'estimated')::int`,
          costCents: costCentsExpr,
          costCentsExact: sql<string>`coalesce(sum(${costEvents.costCents}), 0)::text`,
          inputTokens: sumAsNumber(ordinaryInputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
        })
        .from(costEvents)
        .leftJoin(runProjectLinks, eq(costEvents.heartbeatRunId, runProjectLinks.runId))
        .leftJoin(projects, and(eq(projects.companyId, companyId), sql`${projects.id} = ${effectiveProjectId}`))
        .where(and(...conditions))
        .groupBy(projects.id, projects.name)
        .orderBy(desc(costCentsExpr));
    },
  };
}
