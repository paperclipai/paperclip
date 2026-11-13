import { heartbeatRuns, type Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";

type Database = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type Scope = { companyId: string; agentId: string; failedRunId: string };

const contextKeys = [
  "source", "issueId", "interactionId", "taskKey", "wakeCommentIds",
  "wakeCommentId", "chatFailedRunRetry", "retryOfRunId",
] as const;

const committedContext = sql<Record<string, unknown> | null>`
  case when ${heartbeatRuns.contextSnapshot} is null then null else (
    select coalesce(jsonb_object_agg(field.key, field.value), '{}'::jsonb)
    from jsonb_each(case when jsonb_typeof(${heartbeatRuns.contextSnapshot}) = 'object'
      then ${heartbeatRuns.contextSnapshot} else '{}'::jsonb end) as field(key, value)
    where field.key in (${sql.join(contextKeys.map(key => sql`${key}`), sql`, `)})
  ) end
`;

export async function readChatAuthorizationRun(db: Database, scope: Scope, committed: boolean) {
  const where = and(
    eq(heartbeatRuns.id, scope.failedRunId),
    eq(heartbeatRuns.companyId, scope.companyId),
    eq(heartbeatRuns.agentId, scope.agentId),
  );
  if (!committed) {
    const [run] = await db.select().from(heartbeatRuns).where(where).for("share", { noWait: true });
    return { kind: "retry" as const, run };
  }
  const [run] = await db.select({
    id: heartbeatRuns.id,
    companyId: heartbeatRuns.companyId,
    agentId: heartbeatRuns.agentId,
    wakeupRequestId: heartbeatRuns.wakeupRequestId,
    status: heartbeatRuns.status,
    finishedAt: heartbeatRuns.finishedAt,
    runtimeMode: heartbeatRuns.runtimeMode,
    errorCode: heartbeatRuns.errorCode,
    nativeIssueId: heartbeatRuns.nativeIssueId,
    completionContractId: heartbeatRuns.completionContractId,
    retryOfRunId: heartbeatRuns.retryOfRunId,
    contextSnapshot: committedContext,
  }).from(heartbeatRuns).where(where).for("share", { noWait: true });
  return { kind: "committed" as const, run };
}
