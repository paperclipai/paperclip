import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, chatActions, companies, createDb, heartbeatRuns, issues, runIdentityContexts, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { createDeliveryWorkCoordinator } from "../../delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../../delivery-work-notifications.js";
import { idleWorkSnapshot } from "../../task-admission.js";
import { registerGitHubAcknowledgementWork } from "./acknowledgement-work.js";
import { GITHUB_TERMINAL_RESPONSE_DECISION_VERSION, registerGitHubTerminalResponseWork } from "./terminal-response-work.js";
import { readGitHubResponseRuns } from "./response-run-state.js";

const support = await getEmbeddedPostgresTestSupport();

// Staging (2026-11-15) held 1,557 processed, non-final response comments whose
// result codes were null (89%), acknowledgement_unconfirmed (10%) and
// acknowledgement_superseded (1%). Each task's latest run had ended and had
// been started by a later GitHub request, so it did not own these requests.
const ISSUES = 30;
const STALE_PER_ISSUE = 4;
const STALE = ISSUES * STALE_PER_ISSUE;
const code = (index: number) => index % 50 === 1 ? "acknowledgement_superseded"
  : index % 10 === 0 ? "acknowledgement_unconfirmed" : null;

describe.skipIf(!support.supported)("GitHub terminal response sweep backlog", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  const errors: unknown[] = [];
  const acknowledged: string[] = [];

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("github-terminal-response-work-");
    db = createDb(temporary.connectionString);
  }, 60_000);
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined; acknowledged.length = 0;
    vi.useRealTimers();
    expect(errors.splice(0)).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  type Request = { issueId: string; deliveryId: string; actionId: string; commentId: string };
  /** `waiting`: processed, non-final responses as on staging. `received`: every
   * request still owes its first acknowledgement. */
  async function seed(shape: "waiting" | "received" = "waiting") {
    const client = db.$client;
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "GitHub backlog", issuePrefix: `G${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Reviewer" });
    const [{ application }] = await client.unsafe(`insert into tool_applications (company_id, application_key, name, type)
      values ($1, 'github', 'GitHub', 'chat') returning id as application`, [companyId]);
    const [{ connection }] = await client.unsafe(`insert into tool_connections (company_id, application_id, name, uid, transport, connection_purpose)
      values ($1, $2, 'GitHub', $3, 'chat_sdk', 'channel') returning id as connection`, [companyId, application, `github-${companyId}`]);
    const [{ endpoint }] = await client.unsafe(`insert into chat_endpoints (company_id, connection_id, provider, public_id, assigned_agent_id, status)
      values ($1, $2, 'github', $3, $4, 'active') returning id as endpoint`, [companyId, connection, `backlog-${companyId}`, agentId]);
    const stale: Request[] = [];
    const runs: Array<{ issueId: string; runId: string }> = [];
    const base = Date.UTC(2026, 9, 28);
    for (let issueNumber = 1; issueNumber <= ISSUES; issueNumber++) {
      const [{ issue }] = await client.unsafe(`insert into issues (company_id, title, status, assignee_agent_id)
        values ($1, $2, 'in_progress', $3) returning id as issue`, [companyId, `Pull ${issueNumber}`, agentId]);
      const [{ conversation }] = await client.unsafe(`insert into chat_conversations (company_id, endpoint_id, issue_id,
          external_conversation_id, external_label, external_thread_id)
        values ($1, $2, $3, $4, $4, $4) returning id as conversation`, [companyId, endpoint, issue, `github:paperclipai/paperclip:${issueNumber}`]);
      const requests: Request[] = [];
      for (let request = 0; request <= STALE_PER_ISSUE; request++) {
        const [{ delivery }] = await client.unsafe(`insert into chat_deliveries (company_id, endpoint_id, provider_event_id,
            deduplication_key, event_kind, normalized_event, conversation_id, state)
          values ($1, $2, $3, $3, 'message', '{}', $4, 'processed') returning id as delivery`,
        [companyId, endpoint, `event-${companyId}-${issueNumber}-${request}`, conversation]);
        const [{ comment }] = await client.unsafe(`insert into issue_comments (company_id, issue_id, body)
          values ($1, $2, 'Please review') returning id as comment`, [companyId, issue]);
        await client.unsafe(`insert into chat_message_links (company_id, endpoint_id, conversation_id, delivery_id, comment_id,
            provider_message_id, direction) values ($1, $2, $3, $4, $5, $6, 'inbound')`,
        [companyId, endpoint, conversation, delivery, comment, `in-${companyId}-${issueNumber}-${request}`]);
        const index = stale.length;
        const latest = request === STALE_PER_ISSUE;
        const [action] = await db.insert(chatActions).values({ companyId, endpointId: endpoint, conversationId: conversation,
          deliveryId: delivery, kind: "github_response_comment", providerActionId: `github_response:${delivery}`,
          payload: { agentId }, status: shape === "received" ? "received" : "processed",
          result: shape === "received" ? null : { id: String(1_000 + index),
            url: `https://github.com/paperclipai/paperclip/pull/${issueNumber}#c${index}`,
            final: latest, versionAt: new Date(base).toISOString(), ...(latest ? {} : { code: code(index) }) },
          updatedAt: new Date(base + index * 60_000) }).returning();
        requests.push({ issueId: issue, deliveryId: delivery, actionId: action!.id, commentId: comment });
      }
      stale.push(...(shape === "received" ? requests : requests.slice(0, STALE_PER_ISSUE)));
      // The latest run answered the newest request, through its identity context.
      const runId = randomUUID(), contextId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issue, issueId: issue,
        scopeKind: "issue", status: "succeeded", responsibleUserId: "requester", activeIdentityContextId: contextId,
        contextSnapshot: { issueId: issue }, createdAt: new Date(base + issueNumber * 3_600_000) });
      await db.insert(runIdentityContexts).values({ id: contextId, companyId, runId, revision: 1, responsibleUserId: "requester",
        messageId: requests[STALE_PER_ISSUE]!.commentId, cause: "chat_request", correlationId: runId, status: "accepted" });
      runs.push({ issueId: issue, runId });
    }
    await db.execute(sql`analyze`);
    return { companyId, agentId, endpointId: endpoint as string, stale, runs };
  }

  async function start(register: typeof registerGitHubTerminalResponseWork = registerGitHubTerminalResponseWork) {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true,
      onError: error => errors.push(error) });
    const worker = register(db, coordinator, async deliveryId => {
      acknowledged.push(deliveryId);
      // Stand in for the real acknowledgement, which records a final response.
      await db.update(chatActions).set({ status: "processed", updatedAt: new Date(),
        result: sql`coalesce(${chatActions.result}, '{}'::jsonb) || '{"final": true}'::jsonb` })
        .where(and(eq(chatActions.deliveryId, deliveryId), eq(chatActions.kind, "github_response_comment")));
    }, () => true);
    await worker.ready;
  }
  async function advance(ms: number) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await vi.advanceTimersByTimeAsync(Math.min(1_000, until - Date.now())); await delay(1);
      while (idleWorkSnapshot().active > 0) await delay(5);
    }
  }
  /** Company-wide hints, as run lifecycle changes elsewhere in the company send them. */
  async function companyHint(companyId: string) {
    await db.transaction(async tx => {
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.chatGitHubTerminalResponses, JSON.stringify({ companyId }));
    });
  }
  async function observe(work: () => Promise<unknown>) {
    const statements: string[] = [], prior = db.$client.options.debug;
    db.$client.options.debug = (_connection, query) => { statements.push(query); };
    try { await work(); } finally { db.$client.options.debug = prior; }
    const sweep = statements.filter(query => /"chat_actions"|heartbeat_runs|run_identity_contexts|chat_message_links/.test(query));
    return {
      statements: sweep.length,
      // Requester provenance reads, not the page read that names identity contexts in a subquery.
      provenance: sweep.filter(query => /from "run_identity_contexts"/.test(query) && !/github_response_request/.test(query)).length,
    };
  }
  const finals = async (actionIds: string[]) => (await db.select({ result: chatActions.result }).from(chatActions)
    .where(inArray(chatActions.id, actionIds))).filter(row => row.result?.final === true).length;

  it("stops re-reading processed, non-final responses that cannot progress on every company rebuild", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const f = await seed();
    const first = await observe(async () => { await start(); await advance(5_000); });
    expect(acknowledged).toEqual([]);
    const rebuilds = await observe(async () => {
      for (let pass = 0; pass < 4; pass++) { await companyHint(f.companyId); await advance(31_000); }
    });
    console.info(`terminal response sweep: first pass ${first.statements} statements (${first.provenance} run identity reads); `
      + `4 company rebuilds ${rebuilds.statements} statements (${rebuilds.provenance} run identity reads) for ${STALE} rows`);
    // Nothing these rows wait for changed, so a rebuild reads none of them.
    expect(rebuilds.provenance).toBe(0);
    expect(rebuilds.statements).toBeLessThanOrEqual(4 * 2);
    expect(acknowledged).toEqual([]);
    // No GitHub comment changed and no row was finalized.
    expect(await finals(f.stale.map(request => request.actionId))).toBe(0);
  }, 300_000);

  it("reads a page of waiting responses in a constant number of statements", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    await seed();
    const first = await observe(async () => { await start(); await advance(5_000); });
    console.info(`terminal response sweep, first pass: ${first.statements} statements `
      + `(${first.provenance} run identity reads) for ${STALE} rows in 2 pages`);
    expect(acknowledged).toEqual([]);
    // Per page: the page, its latest runs, the batched context and link reads, and the wait keys.
    expect(first.provenance).toBeLessThanOrEqual(2);
    expect(first.statements).toBeLessThanOrEqual(2 * 5);
  }, 300_000);

  it("settles requests whose own run finished before another request's run, with a batched page read", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const f = await seed();
    const base = Date.UTC(2026, 9, 28);
    // Each waiting request's own run finished just before the newest request's
    // run started. Half are linked by a wake comment, half only by an accepted
    // identity context for the request's comment.
    for (const [index, request] of f.stale.entries()) {
      const issueNumber = f.runs.findIndex(run => run.issueId === request.issueId) + 1;
      const runId = randomUUID(), contextId = randomUUID(), byIdentity = index % 2 === 1;
      await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId,
        nativeIssueId: request.issueId, issueId: request.issueId, scopeKind: "issue", status: "succeeded",
        responsibleUserId: "requester", activeIdentityContextId: byIdentity ? contextId : null,
        contextSnapshot: byIdentity ? { issueId: request.issueId } : { issueId: request.issueId, wakeCommentId: request.commentId },
        createdAt: new Date(base + issueNumber * 3_600_000 - (index + 1) * 1_000) });
      if (byIdentity) await db.insert(runIdentityContexts).values({ id: contextId, companyId: f.companyId, runId, revision: 1,
        responsibleUserId: "requester", messageId: request.commentId, cause: "chat_request", correlationId: runId, status: "accepted" });
    }
    const inputs = f.stale.map(request => ({ companyId: f.companyId, endpointId: f.endpointId, agentId: f.agentId,
      issueId: request.issueId, deliveryId: request.deliveryId, sourceMessageId: request.commentId }));
    let reads: Awaited<ReturnType<typeof readGitHubResponseRuns>> = [];
    const read = await observe(async () => { reads = await readGitHubResponseRuns(db, inputs); });
    // The latest runs, their requester provenance, and the earlier runs: each one statement for the page.
    expect(read.statements).toBeLessThanOrEqual(4);
    expect(reads.every(state => !("forbidden" in state) && !state.ownsLatestRequest && state.finishedRequestRun)).toBe(true);
    // One earlier run is still publishing its reply: that request waits.
    const publishing = f.stale[0]!;
    const [publishingRun] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, f.companyId), sql`${heartbeatRuns.contextSnapshot}->>'wakeCommentId' = ${publishing.commentId}`));
    const [conversation] = await db.select({ conversationId: chatActions.conversationId }).from(chatActions)
      .where(eq(chatActions.id, publishing.actionId));
    await db.insert(chatActions).values({ companyId: f.companyId, endpointId: f.endpointId,
      conversationId: conversation!.conversationId, kind: "github_review_publication",
      providerActionId: `github_publication:${randomUUID()}`, status: "processing",
      payload: { operation: "comment", session: { companyId: f.companyId, issueId: publishing.issueId,
        runId: publishingRun!.id, agentId: f.agentId } } });
    await start(); await advance(31_000);
    const settled = f.stale.filter(request => request !== publishing);
    expect(new Set(acknowledged)).toEqual(new Set(settled.map(request => request.deliveryId)));
    expect(await finals(settled.map(request => request.actionId))).toBe(settled.length);
    const [waiting] = await db.select().from(chatActions).where(eq(chatActions.id, publishing.actionId));
    expect(waiting).toMatchObject({ status: "processed" });
    expect(waiting!.result?.final).not.toBe(true);
  }, 300_000);

  it("reads requests parked by an older decision once after a deploy", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const f = await seed();
    const base = Date.UTC(2026, 9, 28);
    for (const [index, request] of f.stale.entries()) {
      const issueNumber = f.runs.findIndex(run => run.issueId === request.issueId) + 1;
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
        nativeIssueId: request.issueId, issueId: request.issueId, scopeKind: "issue", status: "succeeded",
        contextSnapshot: { issueId: request.issueId, wakeCommentId: request.commentId },
        createdAt: new Date(base + issueNumber * 3_600_000 - (index + 1) * 1_000) });
    }
    const previous = `v${Number(GITHUB_TERMINAL_RESPONSE_DECISION_VERSION.slice(1)) - 1}|`;
    const versioned = new Set(f.stale.filter((_, index) => index % 2 === 0).map(request => request.actionId));
    await db.execute(sql`update ${chatActions} a set result = coalesce(a.result, '{}'::jsonb) || jsonb_build_object('terminalWaitKey',
      (case when a.id in (${sql.join([...versioned].map(id => sql`${id}::uuid`), sql`, `)}) then ${previous} else '' end) || (select r.id::text || ':' || r.status || ':' || extract(epoch from r.updated_at)::text from ${heartbeatRuns} r
        where r.company_id = a.company_id and r.native_issue_id = c.issue_id order by r.created_at desc, r.id desc limit 1)
      || '|' || i.status || '|' || extract(epoch from a.updated_at)::text)
      from chat_conversations c, issues i
      where c.id = a.conversation_id and i.id = c.issue_id and a.id in (${sql.join(f.stale.map(request => sql`${request.actionId}::uuid`), sql`, `)})`);
    await start(); await advance(31_000);
    expect(new Set(acknowledged)).toEqual(new Set(f.stale.map(request => request.deliveryId)));
  }, 300_000);

  it("acknowledges every owed request of a page when one run's requester provenance changed", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const f = await seed("received");
    // One task's latest run lost its accepted identity context, so reading its
    // requester provenance is forbidden. Only that task's requests are affected.
    await db.update(runIdentityContexts).set({ status: "revoked" }).where(eq(runIdentityContexts.runId, f.runs[3]!.runId));
    const first = await observe(async () => { await start(registerGitHubAcknowledgementWork); await advance(30_000); });
    console.info(`acknowledgement sweep: ${first.statements} statements (${first.provenance} run identity reads) `
      + `for ${f.stale.length} owed requests`);
    expect(new Set(acknowledged)).toEqual(new Set(f.stale.map(request => request.deliveryId)));
    expect(acknowledged).toHaveLength(f.stale.length);
  }, 300_000);

  it("still settles a waiting response once a run that owns it ends", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const f = await seed();
    await start(); await advance(5_000);
    const target = f.stale[5]!;
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, nativeIssueId: target.issueId,
      issueId: target.issueId, scopeKind: "issue", status: "failed",
      contextSnapshot: { issueId: target.issueId, wakeCommentId: target.commentId }, createdAt: new Date() });
    await companyHint(f.companyId);
    await advance(31_000);
    expect(acknowledged).toEqual([target.deliveryId]);
    const rebuilds = await observe(async () => { await companyHint(f.companyId); await advance(31_000); });
    expect(rebuilds.provenance).toBe(0);
    expect(acknowledged).toEqual([target.deliveryId]);
  }, 300_000);

  it("still settles a response after a restart lost the hint of the reply publication it waited for", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const f = await seed();
    const target = f.stale[9]!;
    const [response] = await db.select().from(chatActions).where(eq(chatActions.id, target.actionId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, nativeIssueId: target.issueId,
      issueId: target.issueId, scopeKind: "issue", status: "failed",
      contextSnapshot: { issueId: target.issueId, wakeCommentId: target.commentId }, createdAt: new Date() });
    // The owning run's formal review is still being published.
    const [publication] = await db.insert(chatActions).values({ companyId: f.companyId, endpointId: f.endpointId,
      conversationId: response!.conversationId, deliveryId: target.deliveryId, kind: "github_review_publication",
      providerActionId: `github_review:${runId}`, status: "processing",
      payload: { operation: "formal_review", session: { companyId: f.companyId, issueId: target.issueId, runId, agentId: f.agentId } } })
      .returning();
    await start(); await advance(5_000);
    expect(acknowledged).toEqual([]);
    // The publication commits, and the server stops before its lease release
    // sends the targeted hint. The next start runs only a broad load.
    await db.update(chatActions).set({ status: "processed", updatedAt: new Date(),
      result: { id: "77", url: "https://github.com/paperclipai/paperclip/pull/1#pullrequestreview-77" } })
      .where(eq(chatActions.id, publication!.id));
    await coordinator!.stop(); coordinator = undefined;
    await start(); await advance(5_000);
    expect(acknowledged).toEqual([target.deliveryId]);
  }, 300_000);

  it("still pauses waiting responses once their task is blocked", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const f = await seed();
    await start(); await advance(5_000);
    const blocked = f.runs[2]!.issueId;
    await db.update(issues).set({ status: "blocked", updatedAt: new Date() }).where(eq(issues.id, blocked));
    await companyHint(f.companyId);
    await advance(31_000);
    expect(new Set(acknowledged)).toEqual(new Set(f.stale.filter(request => request.issueId === blocked).map(request => request.deliveryId)));
  }, 300_000);
});
