import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/**
 * One definition of "this run event is evidence the agent did something".
 *
 * Three call sites read the same question and they must not answer it differently: the liveness
 * evidence count in `heartbeat.ts`, the same count in `activity.ts`, and the live runtime-progress
 * projection in `heartbeat.ts`. Each one previously carried its own inline exclusion list, which is
 * how `sandbox.network.*` became action evidence: the events were added on a channel whose
 * consumers were never enumerated, so they inherited the meaning of every event already on it.
 *
 * Two kinds of event are excluded, for different reasons.
 *
 * - **Host bookkeeping** (`lifecycle`, `adapter.invoke`, `error`). Written by the runner about the
 *   run, not by the agent about the work.
 * - **Host-authored audit records** (`sandbox.network.*`). These describe what the confined process
 *   *attempted*, and the host writes one whether the attempt succeeded or was denied. Counting them
 *   as action evidence has two consequences, and the second is the reason this is a prefix rule
 *   rather than three more literals: `proxy.started`/`proxy.stopped` bracket every proxy-enabled
 *   run, so evidence exists before the agent executes an instruction; and a decision event is
 *   reachable by the sandboxed process at will, so an agent that did nothing could manufacture
 *   "concrete action evidence" with one denied socket write. A supervision signal an attacker can
 *   raise is not a supervision signal.
 *
 * A new `sandbox.network.*` event kind is excluded by construction, not by remembering to edit a
 * list — which is the failure this module exists to prevent.
 */
export const NON_AGENT_ACTIVITY_RUN_EVENT_TYPES = [
  "lifecycle",
  "adapter.invoke",
  "error",
] as const;

/** Namespaces of host-authored records *about* a run. Matched as prefixes, see the module comment. */
export const NON_AGENT_ACTIVITY_RUN_EVENT_TYPE_PREFIXES = [
  "sandbox.network.",
] as const;

/**
 * True when this event type counts as the agent having acted.
 *
 * Case-folded. The runtime-progress projection always compared lowercase while the two SQL filters
 * compared verbatim, so the same event type could be excluded on one path and counted on another.
 * Folding is the safe direction for an exclusion list: it can only exclude more spellings of a
 * bookkeeping event, never admit one.
 */
export function isAgentActivityRunEventType(
  eventType: string | null | undefined,
): boolean {
  const normalized = (eventType ?? "").trim().toLowerCase();
  if (normalized.length === 0) return false;
  if (
    (NON_AGENT_ACTIVITY_RUN_EVENT_TYPES as readonly string[]).includes(
      normalized,
    )
  ) {
    return false;
  }
  return !NON_AGENT_ACTIVITY_RUN_EVENT_TYPE_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix),
  );
}

/**
 * The same predicate as SQL, generated from the same two constants so the database answer and the
 * in-process answer cannot drift. Intended for `count(*) filter (where …)` over run events.
 */
export function agentActivityRunEventCondition(eventType: SQLWrapper): SQL {
  const normalized = sql`lower(${eventType})`;
  const clauses: SQL[] = [
    sql`${normalized} not in (${sql.join(
      NON_AGENT_ACTIVITY_RUN_EVENT_TYPES.map((type) => sql`${type}`),
      sql`, `,
    )})`,
    ...NON_AGENT_ACTIVITY_RUN_EVENT_TYPE_PREFIXES.map(
      (prefix) => sql`${normalized} not like ${`${prefix}%`}`,
    ),
  ];
  return sql`(${sql.join(clauses, sql` and `)})`;
}
