import { randomBytes, randomUUID } from "node:crypto";
import { getTableName } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, heartbeatRuns, issueComments, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { getExecutionBlocker } from "../../services/execution-blocker.js";

export type BlockerFactory = typeof getExecutionBlocker;
export type CapturedCommentQuery = { sql: string; params: unknown[] };
export const fixtureTime = new Date("2026-10-01T12:00:00.000Z");

export async function seedQueuedCommentConsumption(db: Db, options: { comments?: number; history?: number; payloadBytes?: number; consumed?: boolean; matched?: number; unrelatedHistory?: number } = {}) {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), otherIssueId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Synthetic queued comments", issuePrefix: `Q${companyId.replaceAll("-", "").slice(0, 10).toUpperCase()}` });
  await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", adapterType: "codex_local" });
  await db.insert(issues).values([{ id: issueId, companyId, title: "Held task", status: "blocked", assigneeAgentId: agentId },
    { id: otherIssueId, companyId, title: "Unrelated task" }]);
  const commentIds = Array.from({ length: options.comments ?? 8 }, () => randomUUID());
  if (commentIds.length) await db.insert(issueComments).values(commentIds.map(id => ({ id, companyId, issueId, authorType: "user" as const, authorUserId: "fixture-user", body: "Queued input", createdAt: fixtureTime, updatedAt: fixtureTime })));
  const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "issue_comment", status: "deferred_issue_execution",
    payload: { issueId, _paperclipWakeContext: { wakeCommentIds: commentIds } } }).returning();
  const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog", status: "active",
    ownerType: "board", cause: "legacy_execution_requires_reconciliation", fingerprint: randomUUID(), evidence: {}, nextAction: "Inspect saved work.", createdAt: fixtureTime, updatedAt: fixtureTime }).returning();
  const payload = randomBytes(Math.ceil((options.payloadBytes ?? 0) * 3 / 4)).toString("base64");
  if (options.matched) await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded", startedAt: fixtureTime,
    contextSnapshot: { issueId, wakeCommentIds: commentIds.slice(0, options.matched), prompt: payload } });
  if (options.history) await db.$client.unsafe(`insert into heartbeat_runs (company_id, agent_id, status, started_at, context_snapshot, created_at)
    select $1::uuid, $2::uuid, 'succeeded', $3::timestamptz,
      jsonb_build_object('issueId', $4::text, 'wakeCommentId', case when $7::boolean then $8::text else gen_random_uuid()::text end,
        'wakeCommentIds', jsonb_build_array(gen_random_uuid()::text), 'prompt', $5::text), $3::timestamptz + n * interval '1 second'
    from generate_series(1, $6::int) n`, [companyId, agentId, fixtureTime.toISOString(), issueId, payload, options.history, options.consumed ?? false, commentIds[0] ?? randomUUID()]);
  const unrelatedPayload = randomBytes(20 * 1024).toString("base64");
  if (options.unrelatedHistory) await db.$client.unsafe(`insert into heartbeat_runs (company_id, agent_id, status, started_at, context_snapshot, created_at)
    select $1::uuid, $2::uuid, 'succeeded', $3::timestamptz, jsonb_build_object('issueId', $4::text, 'prompt', $5::text),
      $3::timestamptz + n * interval '1 second' from generate_series(1, $6::int) n`,
    [companyId, agentId, fixtureTime.toISOString(), otherIssueId, unrelatedPayload, options.unrelatedHistory]);
  await db.$client.unsafe("ANALYZE heartbeat_runs");
  await db.$client.unsafe("ANALYZE issue_comments");
  async function run(contextSnapshot: unknown, overrides: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded", startedAt: fixtureTime,
      contextSnapshot: contextSnapshot as Record<string, unknown>, ...overrides }).returning({ id: heartbeatRuns.id });
    return row!;
  }
  return { companyId, agentId, issueId, otherIssueId, commentIds, wake: wake!, action: action!, run };
}

export async function captureQueuedCommentQuery(db: Db, fixture: Awaited<ReturnType<typeof seedQueuedCommentConsumption>>, factory: BlockerFactory = getExecutionBlocker) {
  let query: CapturedCommentQuery | undefined;
  const observed = new Proxy(db, { get(target, key) {
    if (key !== "select") return Reflect.get(target, key);
    return (...fields: Parameters<Db["select"]>) => {
      const builder = target.select(...fields), from = builder.from.bind(builder);
      builder.from = ((table: Parameters<typeof from>[0]) => {
        const selection = from(table), execute = selection.execute.bind(selection);
        selection.execute = async () => {
          const candidate = selection.toSQL();
          if (getTableName(table as typeof issueComments) === "issue_comments" && candidate.sql.includes("consumed")) query = candidate;
          return execute();
        };
        return selection;
      }) as typeof builder.from;
      return builder;
    };
  }});
  const result = await factory(observed, fixture.companyId, fixture.issueId);
  if (fixture.commentIds.length && !query) throw new Error("The real execution blocker did not reach its saved-comment query");
  return { query, result };
}

export function planNodes(plan: Record<string, unknown>): Record<string, unknown>[] {
  return [plan, ...((plan.Plans ?? []) as Record<string, unknown>[]).flatMap(planNodes)];
}
