import { and, eq, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import { parkScheduledRetryInTx } from "./scheduled-retry-park.js";
import {
  ENVIRONMENT_PROVIDER_WAIT,
  ENVIRONMENT_PROVIDER_WAIT_KEY,
  ENVIRONMENT_PROVIDER_WAIT_RETRY_REASON,
  readEnvironmentProviderWait,
} from "../../../services/environment-provider-wait.js";

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;

const waitEnvironmentSql = sql<string>`${heartbeatRuns.contextSnapshot} -> ${ENVIRONMENT_PROVIDER_WAIT_KEY} ->> 'environmentId'`;
const waitingSinceSql = sql<string>`${heartbeatRuns.contextSnapshot} -> ${ENVIRONMENT_PROVIDER_WAIT_KEY} ->> 'waitingSince'`;

export async function parkEnvironmentProviderWaitInTx(tx: Db, run: HeartbeatRun, now: Date): Promise<boolean> {
  if (run.status !== "scheduled_retry" || run.scheduledRetryReason !== ENVIRONMENT_PROVIDER_WAIT_RETRY_REASON) return false;
  const wait = readEnvironmentProviderWait(run.contextSnapshot);
  if (!wait) return false;
  if (Date.parse(wait.waitingSince) + ENVIRONMENT_PROVIDER_WAIT.ceilingMs <= now.getTime()) return false;
  const [recovered] = await tx.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId),
    eq(environmentLeases.environmentId, wait.environmentId),
    sql`${environmentLeases.acquiredAt} >= ${run.createdAt.toISOString()}::timestamptz`,
    sql`${environmentLeases.status} <> 'pending_cleanup'`,
    sql`${environmentLeases.failureReason} is null`,
  )).limit(1);
  if (recovered) return false;
  const [earlier] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, run.companyId),
    sql`${heartbeatRuns.id} <> ${run.id}`,
    eq(heartbeatRuns.scheduledRetryReason, ENVIRONMENT_PROVIDER_WAIT_RETRY_REASON),
    sql`${heartbeatRuns.status} in ('scheduled_retry', 'queued', 'running')`,
    sql`${waitEnvironmentSql} = ${wait.environmentId}`,
    sql`((${waitingSinceSql})::timestamptz, ${heartbeatRuns.id}::text) < (${wait.waitingSince}::timestamptz, ${run.id}::text)`,
    sql`(${heartbeatRuns.status} = 'scheduled_retry'
      or (${heartbeatRuns.status} = 'queued' and ${heartbeatRuns.updatedAt} > ${new Date(now.getTime() - ENVIRONMENT_PROVIDER_WAIT.probeStartGraceMs).toISOString()}::timestamptz)
      or (${heartbeatRuns.status} = 'running' and ${heartbeatRuns.startedAt} > ${new Date(now.getTime() - ENVIRONMENT_PROVIDER_WAIT.probeRunningBoundMs).toISOString()}::timestamptz
        and not exists (select 1 from ${environmentLeases} l
          where l.company_id = ${heartbeatRuns.companyId} and l.heartbeat_run_id = ${heartbeatRuns.id})))`,
  )).limit(1);
  if (!earlier) return false;
  const recheckAt = new Date(now.getTime() + ENVIRONMENT_PROVIDER_WAIT.parkedRecheckMs);
  return parkScheduledRetryInTx(tx, run, now, recheckAt);
}
