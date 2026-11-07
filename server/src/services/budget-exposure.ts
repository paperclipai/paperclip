import { addCents, normalizeCents, usdToUnits, unitsToCents } from "@paperclipai/shared";
import { and, eq, gte, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { budgetPolicies, budgetReservations, browserUseRuns, browserUseSessions, costEvents, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { withBudgetSpan } from "./budget-tracing.js";

export interface BudgetExposure {
  ledgerCents: string;
  liveObservedCents: string;
  effectiveHeldCents: string;
  pendingTerminalRunCount: number;
  unpricedEventCount: number;
  /** Unconfirmed POSTs or unfinished uncapped browser work, separate from ledger data quality. */
  unknownBrowserRunCount: number;
}

export type SpendPolicy = Pick<typeof budgetPolicies.$inferSelect, "companyId" | "scopeType" | "scopeId" | "windowKind" | "metric">;
export type ObservedSpend = BudgetExposure & {
  windowStart: Date; windowEnd: Date; total: number; totalExact: string;
  pendingRunCount: number; recoveringRunCount: number;
  /** Pending runs that hold admission: they ended without succeeding, so
   * their provider may not have stopped, and no coordinator is recovering them. */
  waitingRunCount: number;
};

export function budgetWindow(kind: string, now = new Date()) {
  return kind === "lifetime" ? { start: new Date(0), end: new Date(Date.UTC(9999, 0, 1)) }
    : { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) };
}

/** Only normalized per-run prices are exposure. An incomplete receipt can
 * contain a known partial price while still being unpriced for settlement. */
export function knownRunCostCents(usage: Record<string, unknown>): string | null {
  if (usage.billingType === "subscription_included" || usage.billingType === "subscription") return "0";
  if (usage.usageSource === "session_cumulative" || usage.usageBasis === "session_cumulative") return null;
  for (const value of [usage.cacheAdjustedCostUsd, usage.costUsdExact, usage.costUsd]) {
    if ((typeof value !== "number" || !Number.isFinite(value) || value < 0) && typeof value !== "string") continue;
    try {
      const amount = usdToUnits(value);
      if (amount >= 0n) return unitsToCents(amount);
    } catch { /* An older malformed field cannot erase a reliable later field. */ }
  }
  return null;
}

/** SQL compatibility for active runs written before the exposure projection.
 * Numeric text is bounded and checked before casting legacy JSON fields. */
function normalizedNumericCents(value: SQL, usd = false) {
  const scale = usd ? 1_000_000_000 : 10_000_000;
  return sql`case when length(${value}) <= 160 and ${value} ~ '^[+]?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]{1,3})?$'
    then case when abs(coalesce(substring(${value} from '[eE]([+-]?[0-9]+)$'), '0')::int) <= 100
      then case when round((${value})::numeric * ${scale}) <= 999999999999999999999999::numeric
        then round((${value})::numeric * ${scale}) / 10000000::numeric else null end
      else null end else null end`;
}

const usage = heartbeatRuns.usageJson;
const projected = normalizedNumericCents(sql`${usage}->'budgetExposure'->>'costCents'`);
const hasProjection = sql`jsonb_typeof(${usage}->'budgetExposure') = 'object'
  and jsonb_typeof(${usage}->'budgetExposure'->'sourceId') = 'string'
  and jsonb_typeof(${usage}->'budgetExposure'->'sequence') = 'number'`;
const legacy = sql`case when coalesce(${usage}->>'usageSource', 'per_run') <> 'session_cumulative'
  and coalesce(${usage}->>'usageBasis', 'per_run') <> 'session_cumulative' then
  coalesce(${normalizedNumericCents(sql`${usage}->>'cacheAdjustedCostUsd'`, true)},
  ${normalizedNumericCents(sql`${usage}->>'costUsdExact'`, true)}, ${normalizedNumericCents(sql`${usage}->>'costUsd'`, true)}) else null end`;
// The projection already separates attempts and cumulative/session counters.
// Raw compatibility fields are a fallback, never stronger monetary evidence.
// A canonical unknown projection must remain unknown, not inherit an unsafe
// cumulative aggregate retained only for old accounting compatibility.
const liveCost = sql`case when ${heartbeatRuns.costAccountedAt} is null and ${heartbeatRuns.id} is not null
  and coalesce(${usage}->>'billingType', '') not in ('subscription_included', 'subscription')
  then case when ${hasProjection} then coalesce(${projected}, 0)
    else coalesce(${projected}, ${legacy}, 0) end else 0 end`;

/** Batched ledger, held-operation and unfinished-run aggregates. Never scans
 * agents or receipt history; each policy retains its own scope and window. */
async function readObservedSpends(db: Db, policies: SpendPolicy[], now: Date, excludeRunId?: string | null): Promise<ObservedSpend[]> {
  const windows = policies.map(policy => budgetWindow(policy.windowKind, now));
  const billable = policies.map((policy, index) => ({ policy, index })).filter(({ policy }) => policy.metric === "billed_cents");
  const ledgerColumns: Record<string, SQL> = {}, heldColumns: Record<string, SQL> = {}, runColumns: Record<string, SQL> = {}, browserColumns: Record<string, SQL> = {};
  const ledgerPredicates: SQL[] = [], heldPredicates: SQL[] = [], runPredicates: SQL[] = [], browserPredicates: SQL[] = [];
  for (const { policy, index } of billable) {
    const { start, end } = windows[index];
    const ledger = and(eq(costEvents.companyId, policy.companyId),
      policy.scopeType === "agent" ? eq(costEvents.agentId, policy.scopeId) : undefined,
      policy.scopeType === "project" ? eq(costEvents.projectId, policy.scopeId) : undefined,
      policy.windowKind === "calendar_month_utc" ? and(gte(costEvents.occurredAt, start), lt(costEvents.occurredAt, end)) : undefined)!;
    const held = and(eq(budgetReservations.companyId, policy.companyId), eq(budgetReservations.state, "held"),
      policy.scopeType === "agent" ? eq(budgetReservations.agentId, policy.scopeId) : undefined,
      policy.scopeType === "project" ? eq(budgetReservations.projectId, policy.scopeId) : undefined)!;
    // Hosted browser work is a separate paid operation from its parent run.
    // Its durable hold survives unknown POST outcomes and monthly rollover.
    const browserHold = sql`${browserUseRuns.result}->'paperclipBudgetHold'`;
    const hasBrowserHold = sql`coalesce(jsonb_typeof(${browserHold}) = 'object'
      and ${browserHold}->>'invocationId' = ${browserUseRuns.invocationId}::text, false)`;
    // Earlier browser rows did not persist a cap/dispatch projection. Their
    // unfinished work remains unknown until a terminal receipt is accounted.
    const legacyBrowserPending = sql`not ${hasBrowserHold} and ${browserUseRuns.eventsDrained} = 0
      and (${browserUseRuns.providerRunId} is not null or ${browserUseRuns.status} in ('creating', 'unknown', 'queued', 'dispatching', 'running'))`;
    const browser = and(eq(browserUseRuns.companyId, policy.companyId), eq(browserUseSessions.companyId, policy.companyId),
      sql`((${hasBrowserHold} and ${browserHold}->>'state' = 'held') or (${legacyBrowserPending}))`,
      policy.scopeType === "agent" ? eq(browserUseSessions.agentId, policy.scopeId) : undefined,
      policy.scopeType === "project" ? sql`case when ${hasBrowserHold} then ${browserHold}->>'projectId'
        else ${issues.projectId}::text end = ${policy.scopeId}` : undefined)!;
    browserPredicates.push(browser);
    browserColumns[`held${index}`] = sql`coalesce(sum(${normalizedNumericCents(sql`${browserHold}->>'amountCents'`)}) filter (where ${browser}), 0)::text`;
    // A successful uncapped POST still has no bounded monetary exposure until
    // terminal accounting. Introducing a budget cannot treat that work as free.
    // Older holds had no explicit flag: zero meant an uncapped dispatch. New
    // capped zero holds are distinct, and unstarted reservations are not spend.
    const uncapped = sql`case when ${browserHold}->>'uncapped' = 'false' then false
      when ${browserHold}->>'uncapped' = 'true' then true
      else coalesce(${normalizedNumericCents(sql`${browserHold}->>'amountCents'`)}, 0) = 0 end`;
    const dispatched = sql`(${browserUseRuns.providerRunId} is not null or ${browserHold}->>'dispatchCommittedAt' is not null)`;
    browserColumns[`unknown${index}`] = sql`count(*) filter (where ${browser} and
      ((${legacyBrowserPending}) or ${browserHold}->>'billingUnknown' = 'true' or (${uncapped} and ${dispatched})))::int`;
    const inWindow = policy.windowKind === "calendar_month_utc"
      ? sql`coalesce(${heartbeatRuns.finishedAt}, ${now.toISOString()}::timestamptz) >= ${start.toISOString()}::timestamptz
        and coalesce(${heartbeatRuns.finishedAt}, ${now.toISOString()}::timestamptz) < ${end.toISOString()}::timestamptz` : sql`true`;
    const lateReceiptDebt = sql`coalesce(${usage}->>'accountingLateReceiptPending', 'false') = 'true'`;
    const run = and(eq(heartbeatRuns.companyId, policy.companyId), or(eq(heartbeatRuns.costAccountingPending, true), lateReceiptDebt),
      policy.scopeType === "agent" ? eq(heartbeatRuns.agentId, policy.scopeId) : undefined,
      policy.scopeType === "project" ? sql`${usage}->'ledgerScope'->>'projectId' = ${policy.scopeId}` : undefined)!;
    // A task never waits on its own unfinished accounting: the run being
    // admitted and earlier runs of the same task (its recovery generation) are
    // what its continuation and finalization settle. They still count as spend.
    // coalesce keeps this a definite boolean when the admitted run has no task.
    const ownTask = excludeRunId ? sql`coalesce(${heartbeatRuns.id} = ${excludeRunId}::uuid or (${heartbeatRuns.nativeIssueId} is not null
      and ${heartbeatRuns.nativeIssueId} = (select admitted_run.native_issue_id from ${heartbeatRuns} admitted_run
        where admitted_run.id = ${excludeRunId}::uuid and admitted_run.company_id = ${heartbeatRuns.companyId})), false)` : sql`false`;
    const terminal = and(run, inArray(heartbeatRuns.status, ["succeeded", "failed", "timed_out", "cancelled", "interrupted"]), or(inWindow, lateReceiptDebt),
      sql`not ${ownTask}`)!;
    // Keep correlated subqueries in nested SQL chunks. Drizzle strips column
    // qualifiers from a single-table selection's direct column chunks.
    const hasReservation = sql`exists (select 1 from ${budgetReservations}
      where ${budgetReservations.companyId} = ${heartbeatRuns.companyId}
        and ${budgetReservations.runId} = ${heartbeatRuns.id} and ${budgetReservations.state} = 'held')`;
    // A terminal failure whose final receipt never closed is still recovering
    // accounting: once its provider stop is verified, accounting settles the
    // known part as unpriced. That window holds new work; it is not a hard stop.
    const closingReceipt = sql`${usage}->>'accountingReceiptReady' = 'false'
      and ${usage}->>'accountingCaptureFailed' is distinct from 'true'`;
    const recovering = sql`not (${lateReceiptDebt}) and exists (select 1 from ${nativeRunFinalizations}
      where ${nativeRunFinalizations.runId} = ${heartbeatRuns.id}
        and ${nativeRunFinalizations.companyId} = ${heartbeatRuns.companyId}
        and ${nativeRunFinalizations.resultId} is null
        and (${nativeRunFinalizations.phase} <> 'terminal_failure' or (${closingReceipt})))`;
    ledgerPredicates.push(ledger); heldPredicates.push(held); runPredicates.push(run);
    ledgerColumns[`total${index}`] = sql`coalesce(sum(${costEvents.costCents}) filter (where ${ledger}), 0)::text`;
    // "Usage with no reliable price" means observed usage that could not be
    // priced. These unpriced charges are not that, so they never trip the
    // blocking policy (they stay visible in Costs):
    // - a receipt lost with its stopped provider (restart-derived, any usage);
    // - a charge that carries a known partial cost;
    // - metered API or subscription billing with no observed tokens.
    // Unknown billing with no tokens (for example Cursor Cloud) still counts.
    // The lost-receipt exemption covers only that run's settled final charge;
    // later growth from a complete receipt is ordinary usage.
    // A final charge settled only because closure evidence never arrived is
    // genuinely unknown spend (its provider may still have run), so none of
    // these exemptions apply to it, unless a control-plane restart caused it.
    // A restart-derived receipt never trips the blocking policy, whatever its
    // token count: the run replaced its receipt source, recovered from the
    // restart, or lost a provider turn on restore. Its activity entry and
    // provenance remain the board's notice.
    const finalCharge = sql`${costEvents.idempotencyKey} = 'heartbeat:' || ${costEvents.heartbeatRunId}::text || ':final'`;
    // Every usage recorder binds an empty fence map; only a replaced receipt
    // source (a non-empty map) is restart evidence.
    const restartDerived = (alias: string) => sql.raw(`(coalesce(${alias}.usage_json->'accountingReceiptSourceFences', '{}'::jsonb) <> '{}'::jsonb
        or coalesce(${alias}.usage_json->'pricingProvenance'->>'evidence', '') like '%lost on restore%'
        or exists (select 1 from heartbeat_run_events restart_event where restart_event.run_id = ${alias}.id
          and restart_event.company_id = ${alias}.company_id and restart_event.event_type = 'native.recovery.transition'
          and restart_event.payload->>'trigger' is distinct from 'same_run_retry'))`);
    const closureTimedOutCharge = sql`(${finalCharge}
      and exists (select 1 from ${heartbeatRuns} timed_out_run where timed_out_run.id = ${costEvents.heartbeatRunId}
        and timed_out_run.company_id = ${costEvents.companyId}
        and timed_out_run.usage_json->>'accountingClosureTimedOut' = 'true'
        -- A failed capture is unknown spend whatever its source history.
        and (timed_out_run.usage_json->>'accountingCaptureFailed' = 'true' or not ${restartDerived("timed_out_run")})))`;
    const exemptFromUnpricedBlock = sql`(not ${closureTimedOutCharge} and ((${finalCharge}
        and exists (select 1 from ${heartbeatRuns} lost_receipt_run where lost_receipt_run.id = ${costEvents.heartbeatRunId}
          and lost_receipt_run.company_id = ${costEvents.companyId}
          and (lost_receipt_run.usage_json->>'accountingReceiptUnavailable' = 'true'
            or coalesce(lost_receipt_run.usage_json->'pricingProvenance'->>'evidence', '') like '%lost on restore%')))
      or ${costEvents.costCents} > 0
      or (${costEvents.billingType} in ('metered_api', 'api', 'subscription') and ${costEvents.inputTokens} = 0 and ${costEvents.cachedInputTokens} = 0
        and ${costEvents.outputTokens} = 0)))`;
    ledgerColumns[`unpriced${index}`] = sql`count(*) filter (where ${ledger} and ${costEvents.costStatus} = 'unpriced' and ${costEvents.billingType} <> 'subscription_included'
      and not ${exemptFromUnpricedBlock})::int`;
    runColumns[`live${index}`] = sql`coalesce(sum(${liveCost}) filter (where ${run} and ${inWindow}), 0)::text`;
    runColumns[`unreserved${index}`] = sql`coalesce(sum(${liveCost}) filter (where ${run} and not ${hasReservation}), 0)::text`;
    // Reservations carry over UTC windows. A reservation and its running
    // observation describe one operation, so count their maximum, not both.
    heldColumns[`held${index}`] = sql`coalesce(sum(greatest(${budgetReservations.amountCents}, ${liveCost})) filter (where ${held}), 0)::text`;
    runColumns[`pending${index}`] = sql`count(*) filter (where ${terminal})::int`;
    runColumns[`recovering${index}`] = sql`count(*) filter (where ${terminal} and ${heartbeatRuns.runtimeMode} = 'native' and ${recovering})::int`;
    // A succeeded run whose provider reported observed usage has only its
    // final usage report outstanding. Like a running run, that observed cost
    // counts toward spend and reservation capacity, and its settled charge can
    // still reach the hard stop, but it does not hold the whole scope's new
    // work. A succeeded run with no observed cost (for example an unproven
    // Cursor Cloud terminal) still holds new work.
    const boundedSucceeded = sql`${heartbeatRuns.status} = 'succeeded' and ${usage}->'budgetExposure'->>'costCents' is not null`;
    runColumns[`waiting${index}`] = sql`count(*) filter (where ${terminal} and not (${boundedSucceeded})
      and not (${heartbeatRuns.runtimeMode} = 'native' and ${recovering}))::int`;
  }
  // A single statement preserves hold-to-ledger atomicity even when a caller
  // owns an otherwise READ COMMITTED transaction. Alias dynamic columns before
  // JSON projection so the driver does not collapse repeated aggregate names.
  const columns = (values: Record<string, SQL>) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.as(key)]));
  let ledger: Record<string, string> = {}, held: Record<string, string> = {}, runs: Record<string, string> = {}, browser: Record<string, string> = {};
  if (billable.length) {
    const ledgerQuery = db.select(columns(ledgerColumns)).from(costEvents).where(or(...ledgerPredicates));
    const heldQuery = db.select(columns(heldColumns)).from(budgetReservations)
      .leftJoin(heartbeatRuns, and(eq(heartbeatRuns.id, budgetReservations.runId), eq(heartbeatRuns.companyId, budgetReservations.companyId)))
      .where(or(...heldPredicates));
    const runsQuery = db.select(columns(runColumns)).from(heartbeatRuns).where(or(...runPredicates));
    const browserQuery = db.select(columns(browserColumns)).from(browserUseRuns)
      .innerJoin(browserUseSessions, and(eq(browserUseSessions.id, browserUseRuns.sessionId), eq(browserUseSessions.companyId, browserUseSessions.companyId)))
      .leftJoin(issues, and(eq(issues.id, browserUseSessions.issueId), eq(issues.companyId, browserUseSessions.companyId)))
      .where(or(...browserPredicates));
    const [row] = await db.execute<{ ledger: Record<string, string>; held: Record<string, string>; runs: Record<string, string>; browser: Record<string, string> }>(sql`
      select row_to_json(ledger) as ledger, row_to_json(held) as held,
        row_to_json(runs) as runs, row_to_json(browser) as browser
      from (${ledgerQuery}) ledger cross join (${heldQuery}) held
        cross join (${runsQuery}) runs cross join (${browserQuery}) browser`);
    ({ ledger, held, runs, browser } = row);
  }
  return policies.map((_, index) => {
    const ledgerCents = normalizeCents(String(ledger[`total${index}`] ?? 0));
    const liveObservedCents = normalizeCents(String(runs[`live${index}`] ?? 0));
    const totalExact = addCents(ledgerCents, liveObservedCents);
    const pendingRunCount = Number(runs[`pending${index}`] ?? 0);
    return { windowStart: windows[index].start, windowEnd: windows[index].end,
      ledgerCents, liveObservedCents, effectiveHeldCents: addCents(String(held[`held${index}`] ?? 0), String(runs[`unreserved${index}`] ?? 0), String(browser[`held${index}`] ?? 0)),
      total: Number(totalExact), totalExact, pendingRunCount, pendingTerminalRunCount: pendingRunCount,
      unpricedEventCount: Number(ledger[`unpriced${index}`] ?? 0), unknownBrowserRunCount: Number(browser[`unknown${index}`] ?? 0), recoveringRunCount: Number(runs[`recovering${index}`] ?? 0),
      waitingRunCount: Number(runs[`waiting${index}`] ?? 0) };
  });
}

export async function computeObservedSpend(db: Db, policy: SpendPolicy, now = new Date()) {
  return (await computeObservedSpends(db, [policy], now))[0];
}

export function computeObservedSpends(db: Db, policies: SpendPolicy[], now = new Date(), excludeRunId?: string | null): Promise<ObservedSpend[]> {
  return withBudgetSpan("budget.exposure.evaluate", async () => {
    // Each policy contributes several aggregate columns. Bound statement width
    // below PostgreSQL's target-list limit. Multi-scope evaluators/reports own
    // a repeatable-read transaction; individual admission batches fit one SQL.
    const result: ObservedSpend[] = [];
    for (let offset = 0; offset < policies.length; offset += 128)
      result.push(...await readObservedSpends(db, policies.slice(offset, offset + 128), now, excludeRunId));
    return result;
  }, { "budget.policy_count": policies.length });
}
