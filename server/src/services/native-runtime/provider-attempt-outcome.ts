import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRunEvents } from "@paperclipai/db";
import { PROCESS_START_REQUESTED } from "../native-local-process-stop.js";

/**
 * Work-based attempt budgets (durable-ownership plan, section F).
 *
 * An attempt spends execution budget only when a recorded outcome proves that
 * the provider accepted a turn, and that attempt then made no progress before
 * it ended. An intent alone is never that proof:
 *
 * - `provider_not_started`: no accepted turn is recorded. This covers a
 *   startup still marked `beforeSpawn`, a runner that spawned but was never
 *   admitted, and a `turn.start` the provider did not accept. Not charged.
 * - `provider_started_without_progress`: the provider accepted a turn
 *   (`turn.accepted`, or the provider's own `turn.started`), and no accepted
 *   turn completed work afterwards. Charged.
 * - `provider_progressed`: an accepted turn completed work: a tool execution or
 *   a completed item other than a usage report (#19720). Not charged.
 *
 * Restore activity is not progress: lineage items carry no turn, and work on a
 * turn accepted before the window (the interrupted turn) does not count unless
 * the attempt adopted that live provider work.
 */
export type ProviderAttemptOutcome =
  | "provider_not_started"
  | "provider_started_without_progress"
  | "provider_progressed";

export const PROVIDER_TURN_ACCEPTED_EVENT_TYPES = ["turn.accepted", "turn.started"] as const;
export const PROVIDER_PROGRESS_EVENT_TYPES = ["tool.execution.completed", "item.completed"] as const;

/**
 * Uncharged restarts are still bounded: from this controller generation on
 * (native runs), or after this many uncharged preparation retries (legacy
 * runs), every restart charges.
 */
export const PROVIDER_ATTEMPT_CREDIT_GENERATION_LIMIT = 12;

/** The one charge rule. Every attempt-budget reader should use it. */
export function providerAttemptChargesBudget(outcome: ProviderAttemptOutcome): boolean {
  return outcome === "provider_started_without_progress";
}

/**
 * The first event-log position of the attempt that runs after `sinceSeq`: the
 * executor records `native.process_start_requested` before any backend may
 * spawn a runner, so a later normal retry starts a new window and earlier
 * work never counts for it.
 */
export async function providerAttemptWindowStart(
  tx: Pick<Db, "select">,
  input: { runId: string; sinceSeq: number },
): Promise<number> {
  const [start] = await tx
    .select({ seq: heartbeatRunEvents.seq })
    .from(heartbeatRunEvents)
    .where(and(
      eq(heartbeatRunEvents.runId, input.runId),
      gt(heartbeatRunEvents.seq, input.sinceSeq),
      eq(heartbeatRunEvents.eventType, PROCESS_START_REQUESTED),
    ))
    .orderBy(desc(heartbeatRunEvents.seq))
    .limit(1);
  return start ? Number(start.seq) : input.sinceSeq;
}

/**
 * Reads the outcome of the attempt recorded after `sinceSeq`.
 * `adoptedProviderWork` is set when the attempt adopted a live runner whose
 * provider had already started (a reattachment): it counts as started, and
 * work on a turn accepted before the window counts as its progress.
 */
export async function readProviderAttemptOutcome(
  tx: Pick<Db, "select">,
  input: { runId: string; sinceSeq: number; adoptedProviderWork?: boolean },
): Promise<ProviderAttemptOutcome> {
  const workTurnId = sql`${heartbeatRunEvents.payload} -> 'prpEvent' ->> 'turnId'`;
  const acceptedFrom = input.adoptedProviderWork ? 0 : input.sinceSeq;
  const [work] = await tx
    .select({ seq: heartbeatRunEvents.seq })
    .from(heartbeatRunEvents)
    .where(and(
      eq(heartbeatRunEvents.runId, input.runId),
      gt(heartbeatRunEvents.seq, input.sinceSeq),
      inArray(heartbeatRunEvents.eventType, [...PROVIDER_PROGRESS_EVENT_TYPES]),
      sql`coalesce(${heartbeatRunEvents.payload} -> 'prpEvent' -> 'payload' ->> 'kind', '') <> 'usage'`,
      // The inner alias hides the table name, so unqualified outer references
      // below resolve to the outer completed-work row.
      sql`exists (select 1 from ${heartbeatRunEvents} as accepted_turn where accepted_turn.run_id = ${input.runId}
        and accepted_turn.seq > ${acceptedFrom} and accepted_turn.seq < ${heartbeatRunEvents.seq}
        and accepted_turn.event_type in (${sql.join(PROVIDER_TURN_ACCEPTED_EVENT_TYPES.map(type => sql`${type}`), sql`, `)})
        and accepted_turn.payload -> 'prpEvent' ->> 'turnId' = ${workTurnId})`,
    ))
    .limit(1);
  if (work) return "provider_progressed";
  if (input.adoptedProviderWork) return "provider_started_without_progress";
  const [accepted] = await tx
    .select({ seq: heartbeatRunEvents.seq })
    .from(heartbeatRunEvents)
    .where(and(
      eq(heartbeatRunEvents.runId, input.runId),
      gt(heartbeatRunEvents.seq, input.sinceSeq),
      inArray(heartbeatRunEvents.eventType, [...PROVIDER_TURN_ACCEPTED_EVENT_TYPES]),
    ))
    .limit(1);
  return accepted ? "provider_started_without_progress" : "provider_not_started";
}
