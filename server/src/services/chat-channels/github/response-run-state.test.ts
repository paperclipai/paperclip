import { randomUUID } from "node:crypto";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatMessageLinks, createDb, heartbeatRuns, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { chatRunSourceMessageId } from "../run-origin.js";
import { readGitHubResponseRun, responseRunColumns } from "./response-run-state.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

type Input = Parameters<typeof readGitHubResponseRun>[1];

async function previousReadGitHubResponseRun(db: Db, input: Input) {
  const [requestRun] = await db.select({ runId: heartbeatRuns.id }).from(heartbeatRuns).innerJoin(chatMessageLinks, and(
    eq(chatMessageLinks.companyId, input.companyId), eq(chatMessageLinks.endpointId, input.endpointId),
    eq(chatMessageLinks.deliveryId, input.deliveryId), eq(chatMessageLinks.direction, "inbound"),
    or(sql`${chatMessageLinks.commentId}::text = ${heartbeatRuns.contextSnapshot}->>'wakeCommentId'`,
      sql`coalesce(${heartbeatRuns.contextSnapshot}->'wakeCommentIds', '[]'::jsonb) ? ${chatMessageLinks.commentId}::text`),
  )).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId),
    sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${input.issueId}`))
    .orderBy(desc(heartbeatRuns.createdAt)).limit(1);
  const [latestRun] = await db.select(responseRunColumns).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId),
    sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${input.issueId}`,
  )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
  const originMessageId = latestRun?.activeIdentityContextId ? await chatRunSourceMessageId(db, latestRun,
    { allowLegacyWakeComment: true, provider: "github" }) : null;
  const ownsLatestRequest = !!latestRun && (requestRun?.runId === latestRun.id ||
    (!!input.sourceMessageId && originMessageId === input.sourceMessageId));
  return { latestRun, ownsLatestRequest };
}

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

type PlanNode = { "Relation Name"?: string; "Actual Loops"?: number; "Actual Rows"?: number;
  "Rows Removed by Filter"?: number; "Rows Removed by Index Recheck"?: number; Plans?: PlanNode[] };

function heartbeatRunRowsRead(node: PlanNode): number {
  const own = node["Relation Name"] === "heartbeat_runs" ? (node["Actual Loops"] ?? 0)
    * ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0) + (node["Rows Removed by Index Recheck"] ?? 0)) : 0;
  return own + (node.Plans ?? []).reduce((total, child) => total + heartbeatRunRowsRead(child), 0);
}

type Tenant = { companyId: string; endpointId: string; agentIds: [string, string];
  requests: Array<{ issueId: string; deliveryId: string; inboundCommentId: string | null; outboundCommentId: string }> };

suite("GitHub response run state", () => {
  let db!: Db;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tenants: Tenant[] = [];
  const history = 1_500;

  async function seedTenant(index: number): Promise<Tenant> {
    const client = db.$client;
    const [{ company }] = await client.unsafe(`insert into companies (name, issue_prefix) values ($1, $2) returning id as company`,
      [`Response ${index}`, `RS${index}`]);
    const agentRows = await client.unsafe(`insert into agents (company_id, name) values ($1, 'GitHub agent'), ($1, 'Other agent')
      returning id`, [company]);
    const agentIds = agentRows.map(row => row.id as string) as [string, string];
    const [{ application }] = await client.unsafe(`insert into tool_applications (company_id, application_key, name, type)
      values ($1, 'github', 'GitHub', 'chat') returning id as application`, [company]);
    const [{ connection }] = await client.unsafe(`insert into tool_connections (company_id, application_id, name, uid, transport, connection_purpose)
      values ($1, $2, 'GitHub', $3, 'chat_sdk', 'channel') returning id as connection`, [company, application, `github-${index}`]);
    const [{ endpoint }] = await client.unsafe(`insert into chat_endpoints (company_id, connection_id, provider, public_id, assigned_agent_id, status)
      values ($1, $2, 'github', $3, $4, 'active') returning id as endpoint`, [company, connection, `response-${index}`, agentIds[0]]);
    const requests: Tenant["requests"] = [];
    for (let issueNumber = 1; issueNumber <= 60; issueNumber++) {
      const [{ issue }] = await client.unsafe(`insert into issues (company_id, title, status) values ($1, $2, 'in_progress') returning id as issue`,
        [company, `Issue ${issueNumber}`]);
      const [{ conversation }] = await client.unsafe(`insert into chat_conversations (company_id, endpoint_id, issue_id,
          external_conversation_id, external_label, external_thread_id)
        values ($1, $2, $3, $4, $4, $4) returning id as conversation`, [company, endpoint, issue, `github:paperclipai/paperclip:${issueNumber}`]);
      for (let request = 0; request < 1 + (issueNumber % 2); request++) {
        const [{ delivery }] = await client.unsafe(`insert into chat_deliveries (company_id, endpoint_id, provider_event_id,
            deduplication_key, event_kind, normalized_event, conversation_id, state)
          values ($1, $2, $3, $3, 'message', '{}', $4, 'processed') returning id as delivery`,
        [company, endpoint, `event-${issueNumber}-${request}`, conversation]);
        const commentRows = await client.unsafe(`insert into issue_comments (company_id, issue_id, body)
          values ($1, $2, 'Inbound'), ($1, $2, 'Outbound') returning id`, [company, issue]);
        const inboundCommentId = issueNumber % 13 === 0 ? null : commentRows[0]!.id as string;
        const outboundCommentId = commentRows[1]!.id as string;
        await client.unsafe(`insert into chat_message_links (company_id, endpoint_id, conversation_id, delivery_id, comment_id,
            provider_message_id, direction)
          values ($1, $2, $3, $4, $5, $6, 'inbound'), ($1, $2, $3, $4, $7, $8, 'outbound')`,
        [company, endpoint, conversation, delivery, inboundCommentId, `in-${issueNumber}-${request}`,
          outboundCommentId, `out-${issueNumber}-${request}`]);
        requests.push({ issueId: issue, deliveryId: delivery, inboundCommentId, outboundCommentId });
      }
    }
    return { companyId: company, endpointId: endpoint, agentIds, requests };
  }

  async function seedRuns(seed: number) {
    const next = random(seed);
    const pick = <T,>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
    const base = Date.UTC(2026, 10, 1);
    const rows: Array<typeof heartbeatRuns.$inferInsert> = [];
    let timeline = 0;
    for (const tenant of tenants) {
      const other = tenants.find(candidate => candidate !== tenant)!;
      const issueIds = [...new Set(tenant.requests.map(request => request.issueId))];
      for (const issueId of issueIds) {
        timeline += 1;
        const requests = tenant.requests.filter(request => request.issueId === issueId);
        const slots = Array.from({ length: 1 + Math.floor(next() * 6) }, (_, slot) => slot);
        let linkedAt = new Set<number>();
        for (const slot of slots) {
          const tie = slot > 0 && next() < 0.3;
          const minute = tie ? slot - 1 : slot;
          const request = pick(requests);
          let wake = pick(["none", "comment", "comments", "scalar", "sibling", "outbound", "foreign"] as const);
          const links = wake === "comment" || wake === "comments" || wake === "scalar" || wake === "sibling";
          if (links && linkedAt.has(minute)) wake = "none";
          else if (links) linkedAt = new Set([...linkedAt, minute]);
          const sibling = requests.find(candidate => candidate !== request) ?? request;
          const foreignComment = pick(other.requests).inboundCommentId;
          const wakeContext = wake === "comment" ? { wakeCommentId: request.inboundCommentId }
            : wake === "comments" ? { wakeCommentIds: [randomUUID(), request.inboundCommentId] }
            : wake === "scalar" ? { wakeCommentIds: request.inboundCommentId }
            : wake === "outbound" ? { wakeCommentId: request.outboundCommentId }
            : wake === "foreign" ? { wakeCommentId: foreignComment }
            : wake === "sibling" ? { wakeCommentIds: [sibling.inboundCommentId] } : {};
          const binding = pick(["native", "native", "legacy", "legacy", "nativeElsewhere", "otherCompany", "otherAgent"] as const);
          const nativeIssueId = binding === "native" ? issueId : binding === "nativeElsewhere" ? pick(issueIds) : null;
          rows.push({
            id: randomUUID(),
            companyId: binding === "otherCompany" ? other.companyId : tenant.companyId,
            agentId: binding === "otherCompany" ? other.agentIds[0] : binding === "otherAgent" ? tenant.agentIds[1] : pick([tenant.agentIds[0], tenant.agentIds[0], tenant.agentIds[1]]),
            scopeKind: nativeIssueId ? "issue" : "company",
            issueId: nativeIssueId,
            nativeIssueId,
            status: pick(["queued", "running", "succeeded", "failed", "cancelled", "timed_out"]),
            createdAt: new Date(base + timeline * 3_600_000 + minute * 60_000),
            contextSnapshot: { issueId, ...wakeContext },
          });
        }
      }
    }
    await db.insert(heartbeatRuns).values(rows);
  }

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-github-response-run-state-");
    db = createDb(temporary.connectionString);
    tenants.push(await seedTenant(0), await seedTenant(1));
    await seedRuns(20261114);
    await db.$client.unsafe(`insert into heartbeat_runs (company_id, agent_id, status, context_snapshot, created_at)
      select $1::uuid, $2::uuid, 'succeeded', jsonb_build_object('issueId', gen_random_uuid()::text,
        'prompt', (select string_agg(md5(random()::text || g::text || n::text), '') from generate_series(1, 64) g)),
        timestamptz '2026-10-01' + (n || ' minutes')::interval from generate_series(1, ${history}) n`,
    [tenants[0]!.companyId, tenants[0]!.agentIds[0]]);
    await db.execute(sql`analyze`);
  }, 120_000);

  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  function inputs(): Input[] {
    const all: Input[] = [];
    for (const tenant of tenants) {
      const other = tenants.find(candidate => candidate !== tenant)!;
      for (const request of tenant.requests) {
        for (const agentId of [...tenant.agentIds, other.agentIds[0]]) {
          all.push({ companyId: tenant.companyId, endpointId: tenant.endpointId, agentId, issueId: request.issueId,
            deliveryId: request.deliveryId, sourceMessageId: request.inboundCommentId });
        }
        all.push({ companyId: tenant.companyId, endpointId: other.endpointId, agentId: tenant.agentIds[0], issueId: request.issueId,
          deliveryId: request.deliveryId, sourceMessageId: null });
        all.push({ companyId: tenant.companyId, endpointId: tenant.endpointId, agentId: tenant.agentIds[0], issueId: null,
          deliveryId: request.deliveryId, sourceMessageId: null });
      }
    }
    return all;
  }

  it("returns the latest run and request ownership the previous queries returned, for every run binding and wake link", async () => {
    const before = [], after = [];
    for (const input of inputs()) {
      before.push(await previousReadGitHubResponseRun(db, input));
      after.push(await readGitHubResponseRun(db, input));
    }
    expect(after).toEqual(before);
    expect(before.filter(result => result.ownsLatestRequest).length).toBeGreaterThan(20);
    expect(before.filter(result => result.latestRun && !result.ownsLatestRequest).length).toBeGreaterThan(20);
    expect(before.filter(result => !result.latestRun).length).toBeGreaterThan(20);
    expect(new Set(before.flatMap(result => result.latestRun ? [result.latestRun.nativeIssueId ? "native" : "legacy"] : [])))
      .toEqual(new Set(["native", "legacy"]));
  }, 120_000);

  it("reads a few runs of the issue, not the agent's whole run history", async () => {
    const tenant = tenants[0]!;
    const request = tenant.requests[0]!;
    const captured: Array<{ sql: string; params: unknown[] }> = [];
    const capture = new Proxy(db, { get(target, key) {
      if (key !== "select") return Reflect.get(target, key);
      return (...fields: Parameters<typeof db.select>) => {
        const builder = target.select(...fields), from = builder.from.bind(builder);
        builder.from = ((...args: Parameters<typeof from>) => {
          const selection = from(...args), execute = selection.execute.bind(selection);
          selection.execute = (async () => { captured.push(selection.toSQL()); return execute(); }) as typeof selection.execute;
          return selection;
        }) as typeof builder.from;
        return builder;
      };
    } });
    await readGitHubResponseRun(capture as Db, { companyId: tenant.companyId, endpointId: tenant.endpointId,
      agentId: tenant.agentIds[0], issueId: request.issueId, deliveryId: request.deliveryId, sourceMessageId: null });
    expect(captured.length).toBeGreaterThan(0);
    let rowsRead = 0;
    for (const query of captured) {
      const [row] = await db.$client.unsafe(`explain (analyze, format json) ${query.sql}`, query.params as never[]);
      rowsRead += heartbeatRunRowsRead((row!["QUERY PLAN"] as Array<{ Plan: PlanNode }>)[0]!.Plan);
    }
    expect(rowsRead).toBeLessThan(history / 10);
  }, 60_000);
});
