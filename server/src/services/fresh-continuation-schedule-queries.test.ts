import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { EXECUTION_RECONCILIATION_CAUSES } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { BACKLOG_CONTINUATION_MAX_AGE_MS, freshContinuationCheckDue, heldExecutionWhere, heldExecutionsAwaitingFreshContinuation,
  nextFreshContinuationCheckAt, recentInterruptionSourceSql } from "./fresh-continuation-fallback.js";
import { continuationCauseIsSystemOwnedSql, continuesAutomaticallySql, recoveryRunSql } from "./continuation-cause.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

// The predicates as they were before they became index lookups (2026-11-14):
// `id::text = text` on the run key and cast issue columns, one OR scan per
// newer-run probe. Kept verbatim as the oracle the rewrite must match.
const previousCancelledAtDispatch = (alias: "newer" | "held") => sql.raw(`coalesce(${alias}.status = 'cancelled' and ${alias}.started_at is null
  and ${alias}.error_code = 'execution_reconciliation_required', false)`);
const previousRunOfTask = (alias: "newer" | "held", issueId: SQL) => sql`(${sql.raw(alias)}.native_issue_id::text = ${issueId}::text
  or ${sql.raw(alias)}.issue_id::text = ${issueId}::text or ${sql.raw(alias)}.context_snapshot->>'issueId' = ${issueId}::text)`;

function previousRecentInterruptionSourceSql(now: Date) {
  const input = { companyId: sql`${issueRecoveryActions.companyId}`, issueId: sql`${issueRecoveryActions.sourceIssueId}`,
    sourceRunId: sql`coalesce(${issueRecoveryActions.evidence}->>'runId', ${issueRecoveryActions.evidence}->>'sourceRunId')` };
  const since = sql`${new Date(now.getTime() - BACKLOG_CONTINUATION_MAX_AGE_MS).toISOString()}::timestamptz`;
  const source = (condition: SQL) => sql`exists (select 1 from ${heartbeatRuns} source where source.company_id = ${input.companyId}
    and source.id::text = ${input.sourceRunId}::text and ${condition})`;
  const refusedLater = sql`held.company_id = source.company_id and held.id <> source.id and ${previousRunOfTask("held", input.issueId)}
    and (held.created_at, held.id) > (source.created_at, source.id) and ${previousCancelledAtDispatch("held")}`;
  const personAsked = source(sql`(exists (select 1 from ${agentWakeupRequests} retry where retry.company_id = source.company_id
      and retry.status = 'deferred_issue_execution' and retry.reason = 'task_retry' and retry.requested_by_actor_type = 'user'
      and retry.run_id is null and retry.payload->>'issueId' = ${input.issueId}::text and retry.requested_at > source.finished_at)
    or exists (select 1 from ${heartbeatRuns} held where ${refusedLater}
      and held.context_snapshot->>'wakeReason' = 'task_retry' and held.finished_at > ${since}))`);
  const systemRetriedSource = sql`(${continuationCauseIsSystemOwnedSql("source")}
    and coalesce(source.context_snapshot->>'wakeReason', '') <> 'task_retry' and not coalesce(source.context_snapshot ? 'explicitUserContinuation', false)
    and exists (select 1 from ${heartbeatRuns} held where ${refusedLater} and ${recoveryRunSql("held")}))`;
  const recent = source(sql`(${continuesAutomaticallySql("source")} or ${systemRetriedSource})
    and greatest(source.finished_at, (select max(held.finished_at) from ${heartbeatRuns} held where ${refusedLater})) > ${since}`);
  return sql`(${recent} or ${personAsked})`;
}

function previousHeldExecutionWhere(options: { includeActive?: boolean } = {}) {
  return and(
    inArray(issueRecoveryActions.cause, [...EXECUTION_RECONCILIATION_CAUSES]),
    sql`${issueRecoveryActions.evidence}->'executionReconciliation' is null`,
    sql`${issueRecoveryActions.evidence}->'freshContinuation' is null`,
    sql`coalesce(${issueRecoveryActions.evidence}->>'runId', ${issueRecoveryActions.evidence}->>'sourceRunId') is not null`,
    or(
      sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
      and(inArray(issueRecoveryActions.status, ["active", "escalated"]),
        sql`${issueRecoveryActions.evidence}#>>'{systemRecovery,state}' in ('complete', 'exhausted')`),
      options.includeActive ? and(inArray(issueRecoveryActions.status, ["active", "escalated"]),
        eq(issueRecoveryActions.kind, "active_run_watchdog")) : undefined,
      sql`${issueRecoveryActions.evidence}#>>'{systemRecovery,state}' in ('scheduled', 'running', 'awaiting_evidence')`,
    ),
    isNull(issueRecoveryActions.ownerUserId),
    sql`${issues.status} not in ('done', 'cancelled')`,
    sql`${issues.assigneeAgentId} is not null`,
    sql`exists (select 1 from ${heartbeatRuns} source where source.company_id = ${issueRecoveryActions.companyId}
      and source.id::text = coalesce(${issueRecoveryActions.evidence}->>'runId', ${issueRecoveryActions.evidence}->>'sourceRunId')
      and source.status in ('failed', 'timed_out', 'interrupted', 'cancelled') and source.finished_at is not null
      and source.agent_id = ${issues.assigneeAgentId}
      and not exists (select 1 from ${heartbeatRuns} newer where newer.company_id = source.company_id and newer.id <> source.id
        and (newer.native_issue_id = ${issues.id} or newer.issue_id = ${issues.id} or newer.context_snapshot->>'issueId' = ${issues.id}::text)
        and not ${previousCancelledAtDispatch("newer")}
        and (newer.status in ('queued', 'running', 'scheduled_retry') or (newer.created_at, newer.id) > (source.created_at, source.id))))`,
  )!;
}

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

type PlanNode = { "Relation Name"?: string; "Actual Loops"?: number; "Actual Rows"?: number;
  "Rows Removed by Filter"?: number; "Rows Removed by Index Recheck"?: number; Plans?: PlanNode[] };

function heartbeatRunRowsRead(node: PlanNode): number {
  const own = node["Relation Name"] === "heartbeat_runs" ? (node["Actual Loops"] ?? 0)
    * ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0) + (node["Rows Removed by Index Recheck"] ?? 0)) : 0;
  return own + (node.Plans ?? []).reduce((total, child) => total + heartbeatRunRowsRead(child), 0);
}

suite("fresh-continuation schedule queries", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const now = new Date(Date.UTC(2026, 10, 14, 5, 0, 0));
  const tenants: Array<{ companyId: string; agentIds: string[] }> = [];
  let actions = 0;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-fresh-continuation-schedule-");
    db = createDb(temporary.connectionString);
    for (const prefix of ["FCA", "FCB"]) {
      const companyId = randomUUID(), agentIds = [randomUUID(), randomUUID()];
      await db.insert(companies).values({ id: companyId, name: prefix, issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
      await db.insert(agents).values(agentIds.map((id, index) => ({ id, companyId, name: `Coder ${index}`, role: "engineer",
        status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} })));
      tenants.push({ companyId, agentIds });
    }
    actions = await seedVariedFixture(20261114, 900);
    // Run history that is not linked to any held task, so a scan per candidate shows.
    await db.$client.unsafe(`insert into heartbeat_runs (company_id, agent_id, status, context_snapshot, created_at)
      select $1::uuid, $2::uuid, 'succeeded', jsonb_build_object('issueId', gen_random_uuid()::text, 'prompt', repeat('x', 4000)),
        $3::timestamptz - (n || ' minutes')::interval from generate_series(1, 3000) n`,
    [tenants[0]!.companyId, tenants[0]!.agentIds[0]!, now.toISOString()]);
    await db.execute(sql`analyze`);
  }, 120_000);

  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  /** Held tasks in every shape the predicates distinguish: run keys, run links, statuses, ages, retries. */
  async function seedVariedFixture(seed: number, count: number) {
    const next = random(seed);
    const pick = <T,>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
    const chance = (probability: number) => next() < probability;
    const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);
    const issueRows: Array<typeof issues.$inferInsert> = [];
    const runRows: Array<typeof heartbeatRuns.$inferInsert> = [];
    const wakeRows: Array<typeof agentWakeupRequests.$inferInsert> = [];
    const actionRows: Array<typeof issueRecoveryActions.$inferInsert> = [];
    const link = (issueId: string, kind: string) => kind === "native" ? { scopeKind: "issue" as const, issueId, nativeIssueId: issueId }
      : kind === "issue" ? { scopeKind: "issue" as const, issueId } : kind === "context" ? { scopeKind: "company" as const }
      : { scopeKind: "company" as const };
    for (let index = 0; index < count; index += 1) {
      const tenant = chance(0.9) ? tenants[0]! : tenants[1]!;
      const other = tenant === tenants[0] ? tenants[1]! : tenants[0]!;
      const issueId = randomUUID(), runId = randomUUID();
      const assignee = chance(0.9) ? pick(tenant.agentIds) : null;
      issueRows.push({ id: issueId, companyId: tenant.companyId, title: `Held ${index}`, assigneeAgentId: assignee,
        status: pick(["todo", "in_progress", "blocked", "blocked", "in_review", "done", "cancelled"]) });
      const finishedMinutesAgo = pick([30, 120, 600, 1_200, 1_430, 1_450, 2_000, 4_000]);
      const sourceLink = pick(["native", "issue", "context"]);
      const errorCode = pick(["process_lost", "native_session_interrupted", "server_shutdown_interrupted", "controller_lease_lost",
        "adapter_failed", "reusable_sandbox_resume_failed", "budget_exceeded", null]);
      const sourceCreated = chance(0.92);
      if (sourceCreated) {
        const finished = chance(0.92) ? at(finishedMinutesAgo) : null;
        runRows.push({ id: runId, companyId: chance(0.95) ? tenant.companyId : other.companyId,
          agentId: chance(0.85) && assignee ? assignee : pick(tenant.agentIds), ...link(issueId, sourceLink),
          status: pick(["failed", "failed", "timed_out", "interrupted", "cancelled", "succeeded", "running"]),
          errorCode, error: errorCode === "reusable_sandbox_resume_failed" ? pick(["resume failed (cause=transport_timeout)", "resume failed"]) : errorCode,
          startedAt: at(finishedMinutesAgo + 10), finishedAt: finished, createdAt: at(finishedMinutesAgo + 11), updatedAt: at(finishedMinutesAgo),
          retryOfRunId: null, scheduledRetryReason: chance(0.1) ? "process_lost" : null,
          contextSnapshot: { issueId, wakeReason: pick(["issue_assigned", "task_retry", "process_lost_retry"]),
            ...(chance(0.1) ? { explicitUserContinuation: { runId } } : {}), ...(chance(0.1) ? { previousRunId: randomUUID() } : {}) } });
      }
      for (let extra = Math.floor(next() * 3); extra > 0; extra -= 1) {
        const extraLink = pick(["native", "issue", "context", "unrelated"]);
        const cancelledAtDispatch = chance(0.35);
        const createdMinutesAgo = pick([finishedMinutesAgo + 11, finishedMinutesAgo + 30, finishedMinutesAgo - 5, 5]);
        runRows.push({ companyId: chance(0.95) ? tenant.companyId : other.companyId, agentId: pick(tenant.agentIds),
          ...link(issueId, extraLink),
          status: cancelledAtDispatch ? "cancelled" : pick(["queued", "running", "scheduled_retry", "succeeded", "failed", "cancelled"]),
          errorCode: cancelledAtDispatch ? "execution_reconciliation_required" : null,
          startedAt: cancelledAtDispatch && chance(0.8) ? null : at(createdMinutesAgo - 1),
          finishedAt: chance(0.8) ? at(pick([createdMinutesAgo - 2, 60, 2_000])) : null, createdAt: at(createdMinutesAgo),
          retryOfRunId: sourceCreated && chance(0.3) ? runId : null,
          contextSnapshot: extraLink === "unrelated" ? { issueId: randomUUID() }
            : { issueId, wakeReason: pick(["task_retry", "issue_assigned", "process_lost_retry"]) } });
      }
      if (chance(0.25)) {
        wakeRows.push({ companyId: tenant.companyId, agentId: pick(tenant.agentIds), source: "on_demand", reason: pick(["task_retry", "issue_assigned"]),
          status: pick(["deferred_issue_execution", "deferred_issue_execution", "coalesced"]),
          requestedByActorType: pick(["user", "user", "system"]), runId: !sourceCreated || chance(0.8) ? null : runId,
          requestedAt: at(pick([finishedMinutesAgo - 5, finishedMinutesAgo + 5])), payload: { issueId } });
      }
      const recordedRunId = pick(["runId", "runId", "runId", "runId", "runId", "sourceRunId", "sourceRunId", "upper", "invalid", "number", "missing", "unknown",
        "braced", "padded", "both"]);
      const runKey = recordedRunId === "sourceRunId" ? { sourceRunId: runId }
        : recordedRunId === "upper" ? { runId: runId.toUpperCase() } : recordedRunId === "invalid" ? { runId: "not-a-run" }
        : recordedRunId === "number" ? { runId: 42 } : recordedRunId === "missing" ? {}
        : recordedRunId === "unknown" ? { runId: randomUUID() } : recordedRunId === "braced" ? { runId: `{${runId}}` }
        : recordedRunId === "padded" ? { runId: ` ${runId}` } : recordedRunId === "both" ? { runId: "not-a-run", sourceRunId: runId }
        : { runId };
      actionRows.push({ companyId: tenant.companyId, sourceIssueId: issueId, kind: pick(["active_run_watchdog", "missing_disposition"]),
        status: pick(["active", "escalated", "resolved", "resolved"]), ownerType: "board", ownerUserId: chance(0.05) ? "user-1" : null,
        cause: pick(["legacy_execution_requires_reconciliation", "native_continuation_requires_reconciliation", "stranded_assigned_issue"]),
        fingerprint: `held:${index}`, nextAction: "Fixture",
        evidence: { ...runKey,
          ...(chance(0.7) ? { automaticRecovery: { replay: pick(["blocked", "blocked", "blocked", "allowed"]) } } : {}),
          ...(chance(0.2) ? { systemRecovery: { state: pick(["complete", "exhausted", "scheduled", "running", "failed"]) } } : {}),
          ...(chance(0.05) ? { executionReconciliation: { runId } } : {}),
          ...(chance(0.05) ? { freshContinuation: { sourceRunId: runId } } : {}),
          ...(chance(0.7) ? { freshContinuationCheck: { kind: "backoff", nextCheckAt: now.getTime() + Math.round((next() - 0.5) * 7_200_000) } } : {}) } });
    }
    await db.insert(issues).values(issueRows);
    // One statement, so a retry may name a source run listed after it.
    await db.insert(heartbeatRuns).values(runRows);
    if (wakeRows.length) await db.insert(agentWakeupRequests).values(wakeRows);
    for (let start = 0; start < actionRows.length; start += 500)
      await db.insert(issueRecoveryActions).values(actionRows.slice(start, start + 500));
    return actionRows.length;
  }

  const verdicts = (where: { held: SQL; heldWithActive: SQL; eligible: SQL }) => db.select({ id: issueRecoveryActions.id,
    held: sql<boolean>`coalesce(${where.held}, false)`, heldWithActive: sql<boolean>`coalesce(${where.heldWithActive}, false)`,
    eligible: sql<boolean>`coalesce(${where.eligible}, false)` })
    .from(issueRecoveryActions).innerJoin(issues, and(eq(issues.id, issueRecoveryActions.sourceIssueId),
      eq(issues.companyId, issueRecoveryActions.companyId))).orderBy(asc(issueRecoveryActions.id));

  it("selects exactly the records the previous predicates selected, for every run key, link and status", async () => {
    const before = await verdicts({ held: previousHeldExecutionWhere(), heldWithActive: previousHeldExecutionWhere({ includeActive: true }),
      eligible: previousRecentInterruptionSourceSql(now) });
    const after = await verdicts({ held: heldExecutionWhere(), heldWithActive: heldExecutionWhere({ includeActive: true }),
      eligible: recentInterruptionSourceSql(now) });
    expect(after).toEqual(before);
    expect(before).toHaveLength(actions);
    // The fixture reaches both outcomes of each predicate, so equality is meaningful.
    for (const key of ["held", "heldWithActive", "eligible"] as const) {
      expect(before.filter(row => row[key]).length).toBeGreaterThan(5);
      expect(before.filter(row => !row[key]).length).toBeGreaterThan(5);
    }
    expect(before.filter(row => row.heldWithActive && row.eligible).length).toBeGreaterThan(5);
  }, 60_000);

  it("returns the deadline and the backlog listing the previous queries returned", async () => {
    const liveHold = and(inArray(issueRecoveryActions.status, ["active", "escalated"]), eq(issueRecoveryActions.kind, "active_run_watchdog"))!;
    const [previousDeadline] = await db.select({ at: sql<string | null>`min((${issueRecoveryActions.evidence}#>>'{freshContinuationCheck,nextCheckAt}')::bigint)` })
      .from(issueRecoveryActions).innerJoin(issues, and(eq(issues.id, issueRecoveryActions.sourceIssueId),
        eq(issues.companyId, issueRecoveryActions.companyId)))
      .where(and(previousHeldExecutionWhere({ includeActive: true }),
        sql`${issueRecoveryActions.evidence}#>>'{freshContinuationCheck,nextCheckAt}' is not null`,
        or(liveHold, previousRecentInterruptionSourceSql(now))));
    expect(previousDeadline?.at).not.toBeNull();
    expect(await nextFreshContinuationCheckAt(db, now)).toBe(Number(previousDeadline!.at));

    const previousListing = await db.select({ id: issueRecoveryActions.id, companyId: issueRecoveryActions.companyId,
      runId: sql<string>`coalesce(${issueRecoveryActions.evidence}->>'runId', ${issueRecoveryActions.evidence}->>'sourceRunId')` })
      .from(issueRecoveryActions).innerJoin(issues, and(eq(issues.id, issueRecoveryActions.sourceIssueId),
        eq(issues.companyId, issueRecoveryActions.companyId)))
      .where(and(previousHeldExecutionWhere(), freshContinuationCheckDue(now), previousRecentInterruptionSourceSql(now)))
      .orderBy(desc(sql`(select source.finished_at from ${heartbeatRuns} source where source.company_id = ${issueRecoveryActions.companyId}
        and source.id::text = coalesce(${issueRecoveryActions.evidence}->>'runId', ${issueRecoveryActions.evidence}->>'sourceRunId'))`),
        asc(issueRecoveryActions.id)).limit(1_000);
    expect(previousListing.length).toBeGreaterThan(0);
    expect(await heldExecutionsAwaitingFreshContinuation(db, now, 1_000)).toEqual(previousListing);
  }, 60_000);

  it("finds the deadline by run-key and task-link lookups, not a scan of run history per record", async () => {
    let captured: { sql: string; params: unknown[] } | undefined;
    const capture = new Proxy(db, { get(target, key) {
      if (key !== "select") return Reflect.get(target, key);
      return (...fields: Parameters<typeof db.select>) => {
        const builder = target.select(...fields), from = builder.from.bind(builder);
        builder.from = ((...args: Parameters<typeof from>) => {
          const selection = from(...args);
          selection.execute = async () => { captured = selection.toSQL(); return [{ at: null }]; };
          return selection;
        }) as typeof builder.from;
        return builder;
      };
    } });
    await nextFreshContinuationCheckAt(capture as typeof db, now);
    const [row] = await db.$client.unsafe(`explain (analyze, format json) ${captured!.sql}`, captured!.params as never[]);
    const plan = (row!["QUERY PLAN"] as Array<{ Plan: PlanNode }>)[0]!.Plan;
    const [{ runs }] = await db.$client.unsafe(`select count(*)::int as runs from heartbeat_runs`) as unknown as Array<{ runs: number }>;
    // The previous query read the whole run history once per held record
    // (hundreds of times here); the lookups read a few rows per record.
    expect(heartbeatRunRowsRead(plan)).toBeLessThan(2 * runs);
  }, 60_000);
});
