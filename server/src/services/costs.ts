import { and, desc, eq, gte, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, companies, costEvents, heartbeatRuns, issues, projects } from "@paperclipai/db";
import type { CostByRoutine } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { budgetService, type BudgetServiceHooks } from "./budgets.js";
import { visibleIssueCondition } from "./issue-visibility.js";

export interface CostDateRange {
  from?: Date;
  to?: Date;
}

const METERED_BILLING_TYPE = "metered_api";
const SUBSCRIPTION_BILLING_TYPES = ["subscription_included", "subscription_overage"] as const;

/**
 * Failure codes that mean the run never got a prompt to the model.
 *
 * A run with one of these codes wrote no cost event, but it also consumed
 * nothing: the session died before `session/new` completed, the adapter was
 * never invoked, or the issue changed hands first. Counting them as missing
 * consumption overstates the gap by an order of magnitude.
 *
 * Measured against the live company database (2026-08-19, 1.696 runs): 267 runs
 * carried no `usage_json`. 237 of them matched these codes and showed no model
 * output — their logs are adapter error text (~2 KB), never a transcript. The
 * remaining 30 (`process_lost`, unpriced `adapter_failed`) had real transcripts
 * up to 188 KB and are the genuine accounting gap.
 *
 * The split keys off `error_code`, never off `status`, because a successful run
 * is not a guarantee of accounting. Re-measured 2026-09-08 (2.378 runs): 8 of
 * 1.478 `succeeded` runs carry no `usage_json`, so an earlier "success always
 * accounts" reading of this rule was wrong. Those 8 share one shape — the whole
 * finalization write is missing (`result_json` is null on exactly the same 8
 * rows), because usage and result are persisted by a single guarded write that
 * is skipped when the run already left `running`. They carry no
 * `NO_MODEL_WORK_ERROR_CODES` code, so they land in `lost` and stay visible
 * instead of being silently excused as never having run.
 *
 * Membership test: a code belongs here only when the path that writes it runs
 * *before* the adapter is dispatched. That is what makes "consumed nothing" a
 * property of the code rather than a guess. `cancelled` failed that test and
 * was removed on 2026-09-08: `cancelActiveForAgentInternal` writes it while
 * terminating an already-running child process, so the run can be mid-turn.
 * The live data agrees — of 28 such runs, 15 recorded `process_started_at`, 26
 * emitted output (median `last_output_seq` 120, max 645, against a max of 4 for
 * the pre-dispatch `acpx_session_*` codes whose logs are adapter error text),
 * and one `cancelled` run does carry `usage_json` with 4.57M tokens, proving
 * the state is reachable after the model has been billed. Excusing them cost
 * 26 runs of real consumption from `lostRunCount`; keeping them costs 2 runs
 * that emitted nothing, which overstates a declared gap instead of hiding one.
 */
const NO_MODEL_WORK_ERROR_CODES = [
  "acpx_session_config_failed",
  "acpx_session_init_failed",
  "configuration_incomplete",
  "issue_terminal_status",
  "issue_reassigned",
  "issue_assignee_changed",
  "issue_continuation_waiting_on_review",
  "lock_released_on_reassignment",
  "issue_dependencies_blocked",
  "setup_failed",
] as const;

function sumAsNumber(column: typeof costEvents.costCents | typeof costEvents.inputTokens | typeof costEvents.cachedInputTokens | typeof costEvents.outputTokens) {
  return sql<number>`coalesce(sum(${column}), 0)::double precision`;
}

/**
 * Real dollar cost of subscription usage.
 *
 * `cost_events.cost_cents` is deliberately 0 for `subscription_included`
 * (see normalizeBilledCostCents in heartbeat.ts) because the plan already paid
 * for those tokens. That is correct for budget math and useless for capacity
 * math: it is why the cost panel read $0 right up to the day the account was
 * locked out. The dollar figure the provider actually attributes to the run
 * only ever lands in `heartbeat_runs.usage_json`, so we read it back from
 * there. Joining on `heartbeat_run_id` keeps this at one row per run — the
 * same grain as the cost event — so it cannot double-count.
 *
 * `costUsd` is absent on some runs (not every adapter reports it), so this is
 * a floor. Callers that need to say how much is missing use `unpricedRunCount`.
 */
function subscriptionCostUsdExpr() {
  return sql<number>`coalesce(sum(
    case
      when ${costEvents.billingType} in (${sql.join(
        SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`),
        sql`, `,
      )})
      then coalesce(
        (${heartbeatRuns.usageJson} ->> 'cacheAdjustedCostUsd')::double precision,
        (${heartbeatRuns.usageJson} ->> 'costUsd')::double precision,
        0
      )
      else 0
    end
  ), 0)::double precision`;
}

/** Cents actually billed through a metered API — the only spend that hits a card. */
function meteredCostCentsExpr() {
  return sql<number>`coalesce(sum(
    case when ${costEvents.billingType} = ${METERED_BILLING_TYPE} then ${costEvents.costCents} else 0 end
  ), 0)::double precision`;
}

/** Subscription runs whose usage_json carried no dollar figure at all. */
function unpricedRunCountExpr() {
  return sql<number>`count(distinct case
    when ${costEvents.billingType} in (${sql.join(
      SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`),
      sql`, `,
    )})
      and coalesce(
        ${heartbeatRuns.usageJson} ->> 'cacheAdjustedCostUsd',
        ${heartbeatRuns.usageJson} ->> 'costUsd'
      ) is null
    then ${costEvents.heartbeatRunId}
  end)::int`;
}

/**
 * Runs that finished inside the window but produced no cost_event at all.
 *
 * A run only writes a cost event when it reports token usage or a billed cost
 * (heartbeat.ts `updateRuntimeState`), so a run that dies before the adapter
 * returns usage consumed real tokens and recorded none. Surfacing the count is
 * the honest alternative to silently reporting a total that is short by an
 * unknown amount.
 *
 * The bare count conflates three different situations, so it is split. Measured
 * against the live company database on 2026-08-19 (1.656 started runs):
 *
 *   609 runs have no cost_event, of which
 *     383 DO carry usage_json  -> measured, just never aggregated (`strandedRuns`)
 *     197 died before the model -> genuinely consumed nothing (`neverRanRuns`)
 *      29 ran and lost usage    -> the true blind spot (`lostRuns`)
 *
 * Only `lostRuns` makes the totals a floor. `strandedRuns` is recoverable — the
 * numbers are already in `usage_json` (764.094 tokens, US$ 48,96) and are simply
 * missing from every endpoint that reads `cost_events`. Reporting all 609 as one
 * figure implies a 37% blind spot where the real one is 1,8%.
 */
async function countRunsWithoutCostEvents(db: Db, companyId: string, range?: CostDateRange) {
  const conditions = [
    eq(heartbeatRuns.companyId, companyId),
    // Only finalized runs can be missing a cost event. A run gets `startedAt`
    // when it is claimed but writes its cost event at finalization, so counting
    // by start time reports every run currently in flight as lost consumption.
    //
    // Written as raw SQL rather than `isNotNull` on purpose: the in-flight PR
    // that fixes `by-project` double counting drops the last other use of that
    // helper and removes it from the shared `drizzle-orm` import. Git merges the
    // two changes without a conflict because neither edits the other's lines, so
    // depending on the binding here would break the build only after both land.
    sql`${heartbeatRuns.finishedAt} is not null`,
    sql`not exists (
      select 1 from ${costEvents}
      where ${costEvents.heartbeatRunId} = ${heartbeatRuns.id}
    )`,
  ];
  // Windowed on finalization, matching `cost_events.occurred_at`: filtering on
  // start time would put a run that crosses midnight in a different window here
  // than in the ledger, so the gap count would not line up with the totals it
  // qualifies.
  if (range?.from) conditions.push(gte(heartbeatRuns.finishedAt, range.from));
  if (range?.to) conditions.push(lte(heartbeatRuns.finishedAt, range.to));

  const noModelWork = sql`coalesce(${heartbeatRuns.errorCode}, '') in (${sql.join(
    NO_MODEL_WORK_ERROR_CODES.map((value) => sql`${value}`),
    sql`, `,
  )})`;
  const hasUsage = sql`${heartbeatRuns.usageJson} is not null`;

  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      // Usage was captured on the run but never became a cost event. Recoverable.
      stranded: sql<number>`count(*) filter (where ${hasUsage})::int`,
      // Died before the model ran: no prompt was sent, so nothing was consumed.
      neverRan: sql<number>`count(*) filter (where not ${hasUsage} and ${noModelWork})::int`,
      // Ran, produced output, and the usage was never persisted. The real gap.
      lost: sql<number>`count(*) filter (where not ${hasUsage} and not (${noModelWork}))::int`,
      // Tokens sitting in usage_json that no cost endpoint currently reports.
      strandedTokens: sql<number>`coalesce(sum(
        case when ${hasUsage} then
          coalesce((${heartbeatRuns.usageJson} ->> 'inputTokens')::bigint, 0)
          + coalesce((${heartbeatRuns.usageJson} ->> 'cachedInputTokens')::bigint, 0)
          + coalesce((${heartbeatRuns.usageJson} ->> 'outputTokens')::bigint, 0)
        else 0 end
      ), 0)::double precision`,
    })
    .from(heartbeatRuns)
    .where(and(...conditions));

  return {
    total: Number(row?.total ?? 0),
    stranded: Number(row?.stranded ?? 0),
    neverRan: Number(row?.neverRan ?? 0),
    lost: Number(row?.lost ?? 0),
    strandedTokens: Number(row?.strandedTokens ?? 0),
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

async function getMonthlySpendTotal(
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

export function costService(db: Db, budgetHooks: BudgetServiceHooks = {}) {
  const budgets = budgetService(db, budgetHooks);
  return {
    createEvent: async (companyId: string, data: Omit<typeof costEvents.$inferInsert, "companyId">) => {
      const agent = await db
        .select()
        .from(agents)
        .where(eq(agents.id, data.agentId))
        .then((rows) => rows[0] ?? null);

      if (!agent) throw notFound("Agent not found");
      if (agent.companyId !== companyId) {
        throw unprocessable("Agent does not belong to company");
      }

      const event = await db
        .insert(costEvents)
        .values({
          ...data,
          companyId,
          biller: data.biller ?? data.provider,
          billingType: data.billingType ?? "unknown",
          cachedInputTokens: data.cachedInputTokens ?? 0,
        })
        .returning()
        .then((rows) => rows[0]);

      const [agentMonthSpend, companyMonthSpend] = await Promise.all([
        getMonthlySpendTotal(db, { companyId, agentId: event.agentId }),
        getMonthlySpendTotal(db, { companyId }),
      ]);

      await db
        .update(agents)
        .set({
          spentMonthlyCents: agentMonthSpend,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, event.agentId));

      await db
        .update(companies)
        .set({
          spentMonthlyCents: companyMonthSpend,
          updatedAt: new Date(),
        })
        .where(eq(companies.id, companyId));

      await budgets.evaluateCostEvent(event);

      return event;
    },

    summary: async (companyId: string, range?: CostDateRange) => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      const [row] = await db
        .select({
          total: sumAsNumber(costEvents.costCents),
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
          // Subscription usage is billed at 0 cents by design (the plan already
          // paid for it), so `spendCents` alone reads as "nothing is happening"
          // even while the account burns through its quota. These two fields are
          // what make subscription consumption visible before a lockout.
          subscriptionCostUsd: subscriptionCostUsdExpr(),
          meteredCostCents: meteredCostCentsExpr(),
          eventCount: sql<number>`count(*)::int`,
          runCount: sql<number>`count(distinct ${costEvents.heartbeatRunId})::int`,
          unpricedRunCount: unpricedRunCountExpr(),
        })
        .from(costEvents)
        // `heartbeat_runs.id` is the primary key and `cost_events.heartbeat_run_id`
        // points at one row, so this join is 1:0..1 and cannot fan the sums out.
        // It exists only to reach `usage_json`, where the subscription dollar
        // figure lives.
        .leftJoin(heartbeatRuns, eq(costEvents.heartbeatRunId, heartbeatRuns.id))
        .where(and(...conditions));

      const spendCents = Number(row?.total ?? 0);
      const utilization =
        company.budgetMonthlyCents > 0
          ? (spendCents / company.budgetMonthlyCents) * 100
          : 0;

      const inputTokens = Number(row?.inputTokens ?? 0);
      const cachedInputTokens = Number(row?.cachedInputTokens ?? 0);
      const outputTokens = Number(row?.outputTokens ?? 0);
      const unmeteredRuns = await countRunsWithoutCostEvents(db, companyId, range);

      return {
        companyId,
        spendCents,
        budgetCents: company.budgetMonthlyCents,
        utilizationPercent: Number(utilization.toFixed(2)),
        inputTokens,
        cachedInputTokens,
        outputTokens,
        totalTokens: inputTokens + cachedInputTokens + outputTokens,
        meteredCostCents: Number(row?.meteredCostCents ?? 0),
        subscriptionCostUsd: Number(row?.subscriptionCostUsd ?? 0),
        eventCount: Number(row?.eventCount ?? 0),
        runCount: Number(row?.runCount ?? 0),
        // Runs that did write a cost event but whose provider never reported a
        // dollar figure. Their tokens are counted; their cost is not.
        unpricedRunCount: Number(row?.unpricedRunCount ?? 0),
        // Runs that produced no cost_event at all, split by what actually
        // happened. Only `lostRunCount` makes the totals a floor:
        //  - strandedRunCount: measured on the run, missing from the aggregates
        //  - neverRanRunCount: died before the model; consumed nothing
        //  - lostRunCount: ran and the usage was never persisted
        unmeteredRunCount: unmeteredRuns.total,
        strandedRunCount: unmeteredRuns.stranded,
        strandedTokens: unmeteredRuns.strandedTokens,
        neverRanRunCount: unmeteredRuns.neverRan,
        lostRunCount: unmeteredRuns.lost,
      };
    },

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
        )
        SELECT
          count(distinct ${heartbeatRuns.id})::int AS "runCount",
          coalesce(sum(extract(epoch from (coalesce(${heartbeatRuns.finishedAt}, now()) - ${heartbeatRuns.startedAt})) * 1000), 0)::double precision AS "runtimeMs"
        FROM ${heartbeatRuns}
        WHERE ${heartbeatRuns.companyId} = ${companyId}
          AND ${heartbeatRuns.startedAt} IS NOT NULL
          AND (
            ${heartbeatRuns.contextSnapshot} ->> 'issueId' IN (SELECT id FROM issue_tree)
            OR EXISTS (
              SELECT 1
              FROM ${activityLog}
              JOIN issue_tree ON ${activityLog.entityId} = issue_tree.id
              WHERE ${activityLog.companyId} = ${companyId}
                AND ${activityLog.entityType} = 'issue'
                AND ${activityLog.runId} = ${heartbeatRuns.id}
            )
          )
      `;

      // Run cost-event aggregation and run-duration aggregation in parallel.
      // They're separate queries because cost_events fan out per-event and
      // joining heartbeat_runs through them would double-count run durations.
      const [costRowResult, runRowResult] = await Promise.all([
        db
          .select({
            issueCount: sql<number>`count(distinct ${issues.id})::int`,
            costCents: sumAsNumber(costEvents.costCents),
            inputTokens: sumAsNumber(costEvents.inputTokens),
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
        inputTokens: Number(costRow?.inputTokens ?? 0),
        cachedInputTokens: Number(costRow?.cachedInputTokens ?? 0),
        outputTokens: Number(costRow?.outputTokens ?? 0),
        runCount: Number(runRow?.runCount ?? 0),
        runtimeMs: Number(runRow?.runtimeMs ?? 0),
      };
    },

    byAgent: async (companyId: string, range?: CostDateRange) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      return db
        .select({
          agentId: costEvents.agentId,
          agentName: agents.name,
          agentStatus: agents.status,
          costCents: sumAsNumber(costEvents.costCents),
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
          apiRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} = ${METERED_BILLING_TYPE} then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionCachedInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.cachedInputTokens} else 0 end), 0)::double precision`,
          subscriptionInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.inputTokens} else 0 end), 0)::double precision`,
          subscriptionOutputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.outputTokens} else 0 end), 0)::double precision`,
        })
        .from(costEvents)
        .leftJoin(agents, eq(costEvents.agentId, agents.id))
        .where(and(...conditions))
        .groupBy(costEvents.agentId, agents.name, agents.status)
        .orderBy(desc(sumAsNumber(costEvents.costCents)));
    },

    byProvider: async (companyId: string, range?: CostDateRange) => {
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
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
          apiRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} = ${METERED_BILLING_TYPE} then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionCachedInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.cachedInputTokens} else 0 end), 0)::double precision`,
          subscriptionInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.inputTokens} else 0 end), 0)::double precision`,
          subscriptionOutputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.outputTokens} else 0 end), 0)::double precision`,
        })
        .from(costEvents)
        .where(and(...conditions))
        .groupBy(costEvents.provider, costEvents.biller, costEvents.billingType, costEvents.model)
        .orderBy(desc(sumAsNumber(costEvents.costCents)));
    },

    byBiller: async (companyId: string, range?: CostDateRange) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      return db
        .select({
          biller: costEvents.biller,
          costCents: sumAsNumber(costEvents.costCents),
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
          apiRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} = ${METERED_BILLING_TYPE} then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionCachedInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.cachedInputTokens} else 0 end), 0)::double precision`,
          subscriptionInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.inputTokens} else 0 end), 0)::double precision`,
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

      const results = await Promise.all(
        windows.map(async ({ label, hours }) => {
          const since = new Date(Date.now() - hours * 60 * 60 * 1000);
          const rows = await db
            .select({
              provider: costEvents.provider,
              biller: sql<string>`case when count(distinct ${costEvents.biller}) = 1 then min(${costEvents.biller}) else 'mixed' end`,
              costCents: sumAsNumber(costEvents.costCents),
              inputTokens: sumAsNumber(costEvents.inputTokens),
              cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
              outputTokens: sumAsNumber(costEvents.outputTokens),
            })
            .from(costEvents)
            .where(
              and(
                eq(costEvents.companyId, companyId),
                gte(costEvents.occurredAt, since),
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
            inputTokens: row.inputTokens,
            cachedInputTokens: row.cachedInputTokens,
            outputTokens: row.outputTokens,
          }));
        }),
      );

      return results.flat();
    },

    byAgentModel: async (companyId: string, range?: CostDateRange) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      // single query: group by agent + provider + model.
      // the (companyId, agentId, occurredAt) composite index covers this well.
      // order by provider + model for stable db-level ordering; cost-desc sort
      // within each agent's sub-rows is done client-side in the ui memo.
      return db
        .select({
          agentId: costEvents.agentId,
          agentName: agents.name,
          provider: costEvents.provider,
          biller: costEvents.biller,
          billingType: costEvents.billingType,
          model: costEvents.model,
          costCents: sumAsNumber(costEvents.costCents),
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
        })
        .from(costEvents)
        .leftJoin(agents, eq(costEvents.agentId, agents.id))
        .where(and(...conditions))
        .groupBy(
          costEvents.agentId,
          agents.name,
          costEvents.provider,
          costEvents.biller,
          costEvents.billingType,
          costEvents.model,
        )
        .orderBy(costEvents.provider, costEvents.biller, costEvents.billingType, costEvents.model);
    },

    /**
     * Tokens and cost per issue, ranked.
     *
     * Attribution note (this is the whole point of the endpoint): a run is
     * attributed to exactly one issue — the one in its `contextSnapshot.issueId`,
     * resolved once at run finalization into `cost_events.issue_id`. Summing
     * `GET /issues/{id}/runs` instead inflates the company total by ~87%,
     * because that route returns the full run — usage included — to every
     * issue the run happened to touch, and one run touched 61 of them.
     * Grouping on the cost event keeps one row per run, so these rows sum to
     * the company total rather than to a multiple of it.
     *
     * Cost events with a null `issue_id` (work done outside any issue) are
     * excluded here and reported by `summary` instead, so the difference
     * between this list and the company total stays visible.
     *
     * `offset` makes that conservation property actually checkable. The rows are
     * ranked and capped, so on a company with more than `limit` cost-bearing
     * issues a single response is a top-N, not the aggregate; without a way to
     * page past the cap, summing the endpoint could never reproduce the company
     * total the way the acceptance criterion requires. The order is total tokens
     * descending, tie-broken on `issue_id` so paging is stable across calls.
     */
    byIssue: async (
      companyId: string,
      range?: CostDateRange,
      limit = 20,
      offset = 0,
    ) => {
      // Raw SQL instead of `isNotNull` for the same reason as in
      // `countRunsWithoutCostEvents`: the concurrent `by-project` fix removes
      // that helper from this file's import list, and the two changes merge
      // without a textual conflict.
      const conditions: ReturnType<typeof eq>[] = [
        eq(costEvents.companyId, companyId),
        sql`${costEvents.issueId} is not null` as ReturnType<typeof eq>,
      ];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      const totalTokensExpr = sql<number>`coalesce(sum(
        ${costEvents.inputTokens} + ${costEvents.cachedInputTokens} + ${costEvents.outputTokens}
      ), 0)::double precision`;

      return db
        .select({
          issueId: costEvents.issueId,
          issueIdentifier: issues.identifier,
          issueTitle: issues.title,
          issueStatus: issues.status,
          projectId: issues.projectId,
          projectName: projects.name,
          costCents: sumAsNumber(costEvents.costCents),
          meteredCostCents: meteredCostCentsExpr(),
          subscriptionCostUsd: subscriptionCostUsdExpr(),
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
          totalTokens: totalTokensExpr,
          runCount: sql<number>`count(distinct ${costEvents.heartbeatRunId})::int`,
          unpricedRunCount: unpricedRunCountExpr(),
        })
        .from(costEvents)
        .innerJoin(issues, eq(costEvents.issueId, issues.id))
        .leftJoin(projects, eq(issues.projectId, projects.id))
        .leftJoin(heartbeatRuns, eq(costEvents.heartbeatRunId, heartbeatRuns.id))
        .where(and(...conditions, visibleIssueCondition()))
        .groupBy(
          costEvents.issueId,
          issues.identifier,
          issues.title,
          issues.status,
          issues.projectId,
          projects.name,
        )
        .orderBy(desc(totalTokensExpr), costEvents.issueId)
        .limit(limit)
        .offset(offset);
    },

    /**
     * Tokens and cost per routine, aggregated across every firing.
     *
     * Each firing opens its own issue (`routine_runs.linked_issue_id`), so a
     * daily routine's cost is otherwise spread across dozens of unrelated-looking
     * issues — Slack triage alone opened ~20. Rolling the linked issues back up
     * to the routine is the only way to see what a recurring job actually costs.
     *
     * Costs are counted through the linked issue's whole subtree, because a
     * routine firing routinely spawns child issues and the work delegated to a
     * child is still that routine's cost.
     *
     * The subtrees are kept disjoint on purpose, so the rows can be summed. Two
     * rules do that:
     *
     *  - the walk stops at any issue that is itself some routine's firing root.
     *    Nothing forbids a routine firing from being parented to another
     *    routine's firing (parent validation only checks company ownership), and
     *    without the cut the nested firing and its whole subtree would land in
     *    both routine trees and its cost would be summed into both rows, so the
     *    routine totals could exceed the company total. The cost stays with the
     *    routine that opened the issue, which is the one that caused the spend.
     *  - the firing root passes the same visibility test as the recursive step.
     *    A root that was later hidden, or that is harness work, is excluded from
     *    `byIssue` and from issue-tree accounting, so counting it here would
     *    make the two views disagree.
     *
     * Paged like `byIssue`, and for the same reason.
     */
    byRoutine: async (
      companyId: string,
      range?: CostDateRange,
      limit = 20,
      offset = 0,
    ) => {
      // Bound as ISO text with an explicit cast: this statement goes through
      // `db.execute`, which hands parameters straight to the driver without the
      // column-type mapping a Drizzle column reference would carry, and the
      // driver rejects a raw Date.
      const rangeFilter =
        range?.from || range?.to
          ? sql`
              AND (${range?.from ? sql`ce.occurred_at >= ${range.from.toISOString()}::timestamptz` : sql`true`})
              AND (${range?.to ? sql`ce.occurred_at <= ${range.to.toISOString()}::timestamptz` : sql`true`})
            `
          : sql``;

      const rows = await db.execute(sql`
        WITH RECURSIVE firing_root AS (
          SELECT DISTINCT rr.routine_id, rr.linked_issue_id AS issue_id
          FROM routine_runs rr
          WHERE rr.company_id = ${companyId}
            AND rr.linked_issue_id IS NOT NULL
        ),
        routine_issue_tree(routine_id, issue_id) AS (
          SELECT fr.routine_id, fr.issue_id
          FROM firing_root fr
          JOIN issues i ON i.id = fr.issue_id
          WHERE i.company_id = ${companyId}
            AND i.hidden_at IS NULL
            AND i.harness_kind IS NULL
          UNION
          SELECT t.routine_id, i.id
          FROM issues i
          JOIN routine_issue_tree t ON i.parent_id = t.issue_id
          WHERE i.company_id = ${companyId}
            AND i.hidden_at IS NULL
            AND i.harness_kind IS NULL
            -- Stop at another routine's firing root: that subtree is its own
            -- routine's cost, and claiming it here would double-count it.
            AND NOT EXISTS (
              SELECT 1 FROM firing_root fr WHERE fr.issue_id = i.id
            )
        )
        SELECT
          r.id AS "routineId",
          r.title AS "routineTitle",
          r.status AS "routineStatus",
          r.assignee_agent_id AS "assigneeAgentId",
          a.name AS "assigneeAgentName",
          count(DISTINCT t.issue_id)::int AS "issueCount",
          count(DISTINCT ce.heartbeat_run_id)::int AS "runCount",
          coalesce(sum(ce.cost_cents), 0)::double precision AS "costCents",
          coalesce(sum(ce.input_tokens), 0)::double precision AS "inputTokens",
          coalesce(sum(ce.cached_input_tokens), 0)::double precision AS "cachedInputTokens",
          coalesce(sum(ce.output_tokens), 0)::double precision AS "outputTokens",
          coalesce(sum(
            ce.input_tokens + ce.cached_input_tokens + ce.output_tokens
          ), 0)::double precision AS "totalTokens",
          coalesce(sum(
            CASE WHEN ce.billing_type IN ('subscription_included', 'subscription_overage')
              THEN coalesce(
                (hr.usage_json ->> 'cacheAdjustedCostUsd')::double precision,
                (hr.usage_json ->> 'costUsd')::double precision,
                0)
              ELSE 0 END
          ), 0)::double precision AS "subscriptionCostUsd"
        FROM routines r
        LEFT JOIN routine_issue_tree t ON t.routine_id = r.id
        LEFT JOIN cost_events ce
          ON ce.issue_id = t.issue_id
          AND ce.company_id = ${companyId}
          ${rangeFilter}
        LEFT JOIN heartbeat_runs hr ON hr.id = ce.heartbeat_run_id
        LEFT JOIN agents a ON a.id = r.assignee_agent_id
        WHERE r.company_id = ${companyId}
        GROUP BY r.id, r.title, r.status, r.assignee_agent_id, a.name
        ORDER BY "totalTokens" DESC, r.id
        LIMIT ${limit}
        OFFSET ${offset}
      `);

      const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
      return list as CostByRoutine[];
    },

    byProject: async (companyId: string, range?: CostDateRange) => {
      const issueIdAsText = sql<string>`${issues.id}::text`;
      const runProjectLinks = db
        .selectDistinctOn([activityLog.runId, issues.projectId], {
          runId: activityLog.runId,
          projectId: issues.projectId,
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
        .orderBy(activityLog.runId, issues.projectId, desc(activityLog.createdAt))
        .as("run_project_links");

      const effectiveProjectId = sql<string | null>`coalesce(${costEvents.projectId}, ${runProjectLinks.projectId})`;
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      const costCentsExpr = sumAsNumber(costEvents.costCents);

      return db
        .select({
          projectId: effectiveProjectId,
          projectName: projects.name,
          costCents: costCentsExpr,
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
        })
        .from(costEvents)
        .leftJoin(runProjectLinks, eq(costEvents.heartbeatRunId, runProjectLinks.runId))
        .innerJoin(projects, sql`${projects.id} = ${effectiveProjectId}`)
        .where(and(...conditions, sql`${effectiveProjectId} is not null`))
        .groupBy(effectiveProjectId, projects.name)
        .orderBy(desc(costCentsExpr));
    },
  };
}
