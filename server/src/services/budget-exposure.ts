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
async function readObservedSpends(db: Db, policies: SpendPolicy[], now: Date): Promise<ObservedSpend[]> {
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
    const run = and(eq(heartbeatRuns.companyId, policy.companyId), eq(heartbeatRuns.costAccountingPending, true),
      policy.scopeType === "agent" ? eq(heartbeatRuns.agentId, policy.scopeId) : undefined,
      policy.scopeType === "project" ? sql`${usage}->'ledgerScope'->>'projectId' = ${policy.scopeId}` : undefined)!;
    const terminal = and(run, inArray(heartbeatRuns.status, ["succeeded", "failed", "timed_out", "cancelled", "interrupted"]), inWindow)!;
    // Keep correlated subqueries in nested SQL chunks. Drizzle strips column
    // qualifiers from a single-table selection's direct column chunks.
    const hasReservation = sql`exists (select 1 from ${budgetReservations}
      where ${budgetReservations.companyId} = ${heartbeatRuns.companyId}
        and ${budgetReservations.runId} = ${heartbeatRuns.id} and ${budgetReservations.state} = 'held')`;
    const recovering = sql`exists (select 1 from ${nativeRunFinalizations}
      where ${nativeRunFinalizations.runId} = ${heartbeatRuns.id}
        and ${nativeRunFinalizations.companyId} = ${heartbeatRuns.companyId}
        and ${nativeRunFinalizations.resultId} is null and ${nativeRunFinalizations.phase} <> 'terminal_failure')`;
    ledgerPredicates.push(ledger); heldPredicates.push(held); runPredicates.push(run);
    ledgerColumns[`total${index}`] = sql`coalesce(sum(${costEvents.costCents}) filter (where ${ledger}), 0)::text`;
    ledgerColumns[`unpriced${index}`] = sql`count(*) filter (where ${ledger} and ${costEvents.costStatus} = 'unpriced' and ${costEvents.billingType} <> 'subscription_included')::int`;
    runColumns[`live${index}`] = sql`coalesce(sum(${liveCost}) filter (where ${run} and ${inWindow}), 0)::text`;
    runColumns[`unreserved${index}`] = sql`coalesce(sum(${liveCost}) filter (where ${run} and not ${hasReservation}), 0)::text`;
    // Reservations carry over UTC windows. A reservation and its running
    // observation describe one operation, so count their maximum, not both.
    heldColumns[`held${index}`] = sql`coalesce(sum(greatest(${budgetReservations.amountCents}, ${liveCost})) filter (where ${held}), 0)::text`;
    runColumns[`pending${index}`] = sql`count(*) filter (where ${terminal})::int`;
    runColumns[`recovering${index}`] = sql`count(*) filter (where ${terminal} and ${heartbeatRuns.runtimeMode} = 'native' and ${recovering})::int`;
  }
  const [ledger = {}] = billable.length ? await db.select(ledgerColumns).from(costEvents).where(or(...ledgerPredicates)) : [];
  const [held = {}] = billable.length ? await db.select(heldColumns).from(budgetReservations)
    .leftJoin(heartbeatRuns, and(eq(heartbeatRuns.id, budgetReservations.runId), eq(heartbeatRuns.companyId, budgetReservations.companyId)))
    .where(or(...heldPredicates)) : [];
  const [runs = {}] = billable.length ? await db.select(runColumns).from(heartbeatRuns).where(or(...runPredicates)) : [];
  const [browser = {}] = billable.length ? await db.select(browserColumns).from(browserUseRuns)
    .innerJoin(browserUseSessions, and(eq(browserUseSessions.id, browserUseRuns.sessionId), eq(browserUseSessions.companyId, browserUseRuns.companyId)))
    .leftJoin(issues, and(eq(issues.id, browserUseSessions.issueId), eq(issues.companyId, browserUseSessions.companyId)))
    .where(or(...browserPredicates)) : [];
  return policies.map((_, index) => {
    const ledgerCents = normalizeCents(String(ledger[`total${index}`] ?? 0));
    const liveObservedCents = normalizeCents(String(runs[`live${index}`] ?? 0));
    const totalExact = addCents(ledgerCents, liveObservedCents);
    const pendingRunCount = Number(runs[`pending${index}`] ?? 0);
    return { windowStart: windows[index].start, windowEnd: windows[index].end,
      ledgerCents, liveObservedCents, effectiveHeldCents: addCents(String(held[`held${index}`] ?? 0), String(runs[`unreserved${index}`] ?? 0), String(browser[`held${index}`] ?? 0)),
      total: Number(totalExact), totalExact, pendingRunCount, pendingTerminalRunCount: pendingRunCount,
      unpricedEventCount: Number(ledger[`unpriced${index}`] ?? 0), unknownBrowserRunCount: Number(browser[`unknown${index}`] ?? 0), recoveringRunCount: Number(runs[`recovering${index}`] ?? 0) };
  });
}

export async function computeObservedSpend(db: Db, policy: SpendPolicy) {
  return (await computeObservedSpends(db, [policy]))[0];
}

export function computeObservedSpends(db: Db, policies: SpendPolicy[], now = new Date()): Promise<ObservedSpend[]> {
  return withBudgetSpan("budget.exposure.evaluate", () => readObservedSpends(db, policies, now), { "budget.policy_count": policies.length });
}
