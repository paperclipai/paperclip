import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

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

/**
 * Built on call, not at module scope.
 *
 * `authorization.ts` imports this module, and it is imported in turn by suites
 * that partially mock `@paperclipai/db`. Reading `heartbeatRuns.*` while the
 * module initializes makes the import itself fail against any such mock that
 * does not happen to re-export this table — a load-time landmine for callers
 * that never touch run authority. Dereferencing inside the query keeps the
 * dependency where it is actually used.
 */
function agentRunColumns() {
  return {
    id: heartbeatRuns.id,
    companyId: heartbeatRuns.companyId,
    agentId: heartbeatRuns.agentId,
    status: heartbeatRuns.status,
    responsibleUserId: heartbeatRuns.responsibleUserId,
    contextSnapshot: heartbeatRuns.contextSnapshot,
  };
}

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
    .select(agentRunColumns())
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
    .select(agentRunColumns())
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

/**
 * The run `errorCode` that marks a heartbeat whose durable write was refused.
 *
 * Denying the write is only half the contract. FAI-9903 is the other half: an
 * agent whose every comment and status PATCH was rejected still finished as a
 * `succeeded` heartbeat, because finalization reads the adapter's exit code and
 * an adapter that never noticed the 403s exits 0. A run that was refused its
 * writes did not do its job, and recording that on the run is what lets
 * finalization say so instead of reporting a success nobody can act on.
 */
export const DURABLE_WRITE_DENIED_ERROR_CODE = "durable_write_denied";

/**
 * Records a refused durable write against the caller's own live run.
 *
 * Deliberately narrow. The run id arrives in a caller-controlled header, so
 * marking whatever run it names would hand any agent-key holder a way to fail
 * *another* agent's run by quoting its id — trading a write-authorization hole
 * for a denial-of-service one. The predicate therefore only matches a run that
 * is live and already belongs to this actor's agent and company, which is
 * exactly the case where the header names the caller's real run and the denial
 * is a fact about that run's own execution.
 *
 * A denial the request cannot attribute to a live run of the caller's — an
 * unknown id, a forged one, a spent one, another agent's — marks nothing. That
 * is not a gap: those requests carry no live run to hold accountable, and they
 * are already audited at the denial site.
 *
 * `errorCode` is only claimed when it is still empty so an earlier, more
 * specific denial (a responsible-user refusal, say) keeps the field it wrote.
 * Both outcomes finalize the same way, so first writer wins is enough.
 */
export async function recordDurableWriteDenialOnActiveRun(
  db: Db,
  input: { runId: string | null | undefined; agentId: string | null | undefined; companyId: string },
): Promise<boolean> {
  const lookupId = agentRunLookupId(input.runId);
  if (!lookupId || !input.agentId) return false;
  try {
    const updated = await db
      .update(heartbeatRuns)
      .set({ errorCode: DURABLE_WRITE_DENIED_ERROR_CODE, updatedAt: new Date() })
      .where(and(
        eq(heartbeatRuns.id, lookupId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        inArray(heartbeatRuns.status, [...AGENT_WRITE_HEARTBEAT_RUN_STATUSES]),
        isNull(heartbeatRuns.errorCode),
      ))
      .returning({ id: heartbeatRuns.id })
      .then((rows) => rows.length > 0);
    if (updated) {
      logger.info(
        { runId: lookupId, agentId: input.agentId, companyId: input.companyId },
        "recorded durable-write denial on active heartbeat run",
      );
    }
    return updated;
  } catch (err) {
    // Best effort on purpose: this marker exists to make a denial louder, so
    // failing to write it must not convert an audited 403 into a 500.
    logger.warn(
      { err, runId: lookupId, agentId: input.agentId, companyId: input.companyId },
      "failed to record durable-write denial on active heartbeat run",
    );
    return false;
  }
}
