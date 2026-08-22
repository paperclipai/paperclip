import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";

/**
 * The heartbeat-run statuses that carry agent write authority (FAI-9983).
 *
 * This is an allowlist on purpose. Deriving authority as "not terminal" handed
 * the same authority to `scheduled_retry` — a state recovery parks a run in
 * precisely because no process is executing it — so a caller could name one of
 * its own parked runs and take the canonical issue lock before any heartbeat
 * existed. `queued` stays in because it is the run the agent is about to
 * execute; every other status has to be added here deliberately.
 */
export const AGENT_WRITE_HEARTBEAT_RUN_STATUSES = ["queued", "running"] as const;

const AGENT_WRITE_STATUSES: ReadonlySet<string> = new Set(AGENT_WRITE_HEARTBEAT_RUN_STATUSES);

export function hasAgentWriteRunAuthority(status: string | null | undefined) {
  return typeof status === "string" && AGENT_WRITE_STATUSES.has(status);
}

export type AgentRunRow = {
  id: string;
  companyId: string;
  agentId: string | null;
  status: string;
  responsibleUserId: string | null;
  contextSnapshot: unknown;
};

const AGENT_RUN_COLUMNS = {
  id: heartbeatRuns.id,
  companyId: heartbeatRuns.companyId,
  agentId: heartbeatRuns.agentId,
  status: heartbeatRuns.status,
  responsibleUserId: heartbeatRuns.responsibleUserId,
  contextSnapshot: heartbeatRuns.contextSnapshot,
};

/**
 * Normalizes a caller-supplied run id into something safe to hand a query.
 *
 * `X-Paperclip-Run-Id` is an arbitrary string an API-key caller controls, and
 * `heartbeat_runs.id` is a uuid column: passing the raw value through raises a
 * Postgres cast error, which surfaces as a 500 and skips the audited denial
 * contract entirely. Anything that is not uuid-shaped is "no run" here.
 */
export function agentRunLookupId(runId: string | null | undefined): string | null {
  const normalized = runId?.trim();
  return normalized && isUuidLike(normalized) ? normalized : null;
}

/**
 * The one run-row read for caller-supplied run ids. Every database consumer of
 * `X-Paperclip-Run-Id` goes through here so the malformed-id contract cannot be
 * re-lost the next time a route needs the run row (FAI-9983).
 */
export async function loadAgentRunRow(
  dbOrTx: Db,
  runId: string | null | undefined,
): Promise<AgentRunRow | null> {
  const lookupId = agentRunLookupId(runId);
  if (!lookupId) return null;
  return await dbOrTx
    .select(AGENT_RUN_COLUMNS)
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, lookupId))
    .then((rows) => (rows[0] ?? null) as AgentRunRow | null);
}

/**
 * Re-reads and row-locks the run inside the caller's mutation transaction.
 *
 * Authorizing from a run row read in an earlier statement leaves a window: a
 * concurrent terminalization can land after the check and before the durable
 * write, so a spent credential completes a mutation. Holding `FOR UPDATE` on
 * the run row until the business write commits closes it — a terminalizing
 * writer either wins outright (and this returns null) or blocks behind us.
 */
export async function lockLiveAgentRun(
  tx: Db,
  input: { runId: string | null | undefined; companyId: string; agentId: string | null | undefined },
): Promise<AgentRunRow | null> {
  const lookupId = agentRunLookupId(input.runId);
  if (!lookupId || !input.agentId) return null;
  const run = await tx
    .select(AGENT_RUN_COLUMNS)
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.id, lookupId),
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId),
    ))
    .for("update")
    .then((rows) => (rows[0] ?? null) as AgentRunRow | null);
  return run && hasAgentWriteRunAuthority(run.status) ? run : null;
}
