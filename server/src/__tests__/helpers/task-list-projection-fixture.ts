import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { agents, chatConversations, chatEndpoints, companies, issues, toolApplications, toolConnections, type Db } from "@paperclipai/db";
import type { issueService } from "../../services/issues.js";

export type ProjectionQuery = { sql: string; params: unknown[] };
export type ListFactory = typeof issueService;
export type ListFilters = Parameters<ReturnType<ListFactory>["list"]>[1];

export async function captureTaskListQuery(db: Db, factory: ListFactory, companyId: string, filters?: ListFilters) {
  let captured: ProjectionQuery | undefined;
  const stop = new Error("Task list query captured");
  const wrap = (target: object): typeof db => new Proxy(target, { get(target, key) {
    if (key === "with") return (...ctes: unknown[]) => wrap(Reflect.apply(Reflect.get(target, key), target, ctes));
    if (key !== "select" && key !== "selectDistinctOn") return Reflect.get(target, key);
    return (...fields: unknown[]) => {
      const builder = Reflect.apply(Reflect.get(target, key), target, fields);
      const from = builder.from.bind(builder);
      builder.from = (...tables: unknown[]) => {
        const query = from(...tables);
        query.execute = async () => { captured = query.toSQL(); throw stop; };
        return query;
      };
      return builder;
    };
  } }) as typeof db;
  const captureDb = wrap(db);
  try { await factory(captureDb).list(companyId, filters); }
  catch (error) { if (error !== stop) throw error; }
  if (!captured) throw new Error("Real list caller did not generate a projection query");
  return captured;
}

export async function seedTaskListProjectionFixture(db: Db, options: { count: number; chatCount: number; history: number; payloadBytes: number; liveCount?: number; activityPerIssue?: number; commentsPerIssue?: number; activityDecoys?: number; descriptionBytes?: number; hostedShape?: boolean }) {
  if (options.hostedShape) assert.ok(options.count >= options.chatCount + 695, "Hosted shape needs chatCount + 695 tasks for all GitHub and removed-conversation controls");
  const companyId = randomUUID(), otherCompanyId = randomUUID(), agentId = randomUUID();
  await db.insert(companies).values([companyId, otherCompanyId].map(id => ({ id, name: "Projection fixture", issuePrefix: `P${id.slice(0, 7)}` })));
  await db.insert(agents).values({ id: agentId, companyId, name: "Projection agent", adapterType: "process" });
  const noise = randomBytes(options.payloadBytes).toString("base64");
  const records = await db.insert(issues).values(Array.from({ length: options.count }, (_, n) => ({
    companyId, title: `Projection task ${n}`, description: !options.descriptionBytes || n%3 === 0 ? null : n%3 === 1 ? "Projection résumé 世界" : `Projection résumé 世界 ${noise.slice(0, options.descriptionBytes)}`, status: n < options.chatCount ? "in_review" : "todo", assigneeAgentId: agentId,
    createdByUserId: "projection-human", priority: n % 3 === 0 ? "high" : "medium",
    originKind: n < options.chatCount ? "chat_channel" : "human",
    createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date(Date.parse("2026-01-01T00:00:00Z") + n * 1000),
  }))).returning();
  const [application] = await db.insert(toolApplications).values({ companyId, name: "Projection chat", type: "native" }).returning();
  const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: application!.id, name: "Projection chat", uid: randomUUID(), transport: "chat_sdk", connectionPurpose: "channel" }).returning();
  const [endpoint] = await db.insert(chatEndpoints).values({ companyId, connectionId: connection!.id, provider: "slack", publicId: randomUUID(), assignedAgentId: agentId, status: "active" }).returning();
  if (options.chatCount) await db.insert(chatConversations).values(records.slice(0, options.chatCount).map((issue, n) => ({ companyId, endpointId: endpoint!.id, issueId: issue.id,
    externalConversationId: `channel-${n}`, externalThreadId: "thread", externalLabel: "#synthetic", state: options.hostedShape ? n === 0 ? "waiting" : "active" : n % 3 === 0 ? "active" : "waiting", createdAt: new Date("2026-01-01T00:00:00Z") })));
  if (options.hostedShape) {
    const [githubConnection] = await db.insert(toolConnections).values({ companyId, applicationId: application!.id, name: "Projection reviews", uid: randomUUID(), transport: "chat_sdk", connectionPurpose: "channel" }).returning();
    const [github] = await db.insert(chatEndpoints).values({ companyId, connectionId: githubConnection!.id, provider: "github", publicId: randomUUID(), assignedAgentId: agentId, status: "active" }).returning();
    await db.insert(chatConversations).values(records.slice(options.chatCount, options.chatCount + 642).map((issue, n) => ({ companyId, endpointId: github!.id, issueId: issue.id,
      externalConversationId: `github-${n}`, externalThreadId: "thread", externalLabel: "Synthetic review", state: "active", createdAt: new Date("2026-01-01") })));
    await db.insert(chatConversations).values(records.slice(options.chatCount + 642, options.chatCount + 642 + 53).map((issue, n) => ({ companyId, endpointId: endpoint!.id, issueId: issue.id,
      externalConversationId: `removed-${n}`, externalThreadId: "thread", externalLabel: "#removed", state: "endpoint_removed", createdAt: new Date("2026-01-01") })));
  }
  const wakeNoise = options.hostedShape ? randomBytes(1024).toString("base64") : noise;
  await db.$client.unsafe(`insert into heartbeat_runs(company_id,agent_id,status,context_snapshot,native_issue_id,created_at,finished_at)
    select $1::uuid,$2::uuid,'succeeded',case when n%3=0 then jsonb_build_object('issueId',id::text,'noise',$4::text)
      when n%3=1 then jsonb_build_object('taskId',id::text,'noise',$4::text) else jsonb_build_object('noise',$4::text) end,
      case when n%3=2 then id end,'2026-01-02'::timestamptz+n*interval '1 second','2026-01-03'::timestamptz
    from unnest($3::uuid[]) task(id) cross join generate_series(1,$5::integer)n`, [companyId, agentId, records.map(row => row.id), noise, options.history]);
  await db.$client.unsafe(`insert into agent_wakeup_requests(company_id,agent_id,source,status,payload,created_at)
    select $1::uuid,$2::uuid,'synthetic','consumed',case when n%3=0 then jsonb_build_object('issueId',id::text,'noise',$4::text)
      when n%3=1 then jsonb_build_object('taskId',id::text,'noise',$4::text)
      else jsonb_build_object('_paperclipWakeContext',jsonb_build_object('issueId',id::text),'noise',$4::text) end,'2026-01-02'::timestamptz+n*interval '1 second'
    from unnest($3::uuid[]) task(id) cross join generate_series(1,$5::integer)n`, [companyId, agentId, records.map(row => row.id), wakeNoise, options.hostedShape ? 28 : options.history]);
  const liveCount = options.hostedShape ? 210 : options.liveCount ?? 0;
  const liveIds = records.slice(options.hostedShape ? options.chatCount : 0).map(row => row.id);
  if (liveCount) {
    await db.$client.unsafe(`insert into heartbeat_runs(company_id,agent_id,status,context_snapshot,native_issue_id,created_at)
      select $1::uuid,$2::uuid,case when $7::boolean then 'running' else case n%3 when 0 then 'queued' when 1 then 'running' else 'scheduled_retry' end end,
        case n%3 when 0 then jsonb_build_object('issueId',id::text,'noise',$4::text)
          when 1 then jsonb_build_object('taskId',id::text,'noise',$4::text) else jsonb_build_object('noise',$4::text) end,
        case when n%3=2 then id end,'2026-01-04'::timestamptz
      from generate_series(1,$5::integer)n join unnest($3::uuid[]) with ordinality task(id,ordinal)
        on ordinal=1+(n%least($6::integer,12))`, [companyId, agentId, liveIds, noise, options.hostedShape ? 2 : liveCount, liveIds.length, options.hostedShape ?? false]);
    await db.$client.unsafe(`insert into agent_wakeup_requests(company_id,agent_id,source,status,payload,created_at)
      select $1::uuid,$2::uuid,'synthetic',case when $7::boolean then case when n<=139 then 'claimed' else 'deferred_issue_execution' end else case n%3 when 0 then 'queued' when 1 then 'claimed' else 'deferred_issue_execution' end end,
        case n%3 when 0 then jsonb_build_object('issueId',id::text,'noise',$4::text)
          when 1 then jsonb_build_object('taskId',id::text,'noise',$4::text)
          else jsonb_build_object('_paperclipWakeContext',jsonb_build_object('issueId',id::text),'noise',$4::text) end,
        '2026-01-04'::timestamptz
      from generate_series(1,$5::integer)n join unnest($3::uuid[]) with ordinality task(id,ordinal)
        on ordinal=1+(n%least($6::integer,12))`, [companyId, agentId, liveIds, wakeNoise, liveCount, liveIds.length, options.hostedShape ?? false]);
  }
  if (options.activityPerIssue) await db.$client.unsafe(`insert into activity_log(company_id,entity_type,entity_id,actor_type,actor_id,action,details,created_at)
    select $1::uuid,'issue',id::text,'agent','synthetic-worker','issue.updated',jsonb_build_object('noise',left($3,4096)),
      '2026-01-03'::timestamptz+n*interval '1 second'
    from unnest($2::uuid[]) task(id) cross join generate_series(1,$4::integer)n order by n,id`,
    [companyId, records.map(row => row.id), noise, options.activityPerIssue]);
  if (options.commentsPerIssue) await db.$client.unsafe(`insert into issue_comments(company_id,issue_id,author_type,author_user_id,body,created_at)
    select $1::uuid,id,'user','synthetic-reader',left($3,4096),'2026-01-05'::timestamptz+n*interval '1 second'
    from unnest($2::uuid[]) task(id) cross join generate_series(1,$4::integer)n order by n,id`,
    [companyId, records.map(row => row.id), noise, options.commentsPerIssue]);
  if (options.activityDecoys) await db.$client.unsafe(`insert into activity_log(company_id,entity_type,entity_id,actor_type,actor_id,action,details,created_at)
    select $1::uuid,'heartbeat_run',gen_random_uuid()::text,'agent','synthetic-worker','heartbeat.run.created',
      jsonb_build_object('noise',left($2,256)),'2026-01-03'::timestamptz+n*interval '1 second'
    from generate_series(1,$3::integer)n`, [companyId, noise, options.activityDecoys]);
  await db.$client.unsafe("ANALYZE");
  return { companyId, otherCompanyId, agentId, endpointId: endpoint!.id, records, options, payloadBytes: Buffer.byteLength(noise) };
}
