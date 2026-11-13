import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations, createDb, heartbeatRuns, agentWakeupRequests, toolInvocations, toolActionRequests, toolActionDeliveries } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../__tests__/helpers/external-test-database.js";
import { captureLineageReads, chatReplyLineageFixture, cleanupChatReplyLineageFixture, expectedLineageContext, type LineageQuery } from "../__tests__/helpers/chat-reply-lineage.js";
import { resolveChatOriginPublicationBindings } from "./issues.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_TEST_DATABASE_URL");
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("chat reply lineage context projection", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  const companyIds: string[] = [];
  async function fixture(bytes?: number) { const f = await chatReplyLineageFixture(db, bytes); companyIds.push(f.companyId); return f; }
  beforeAll(async () => {
    if (externalUrl) await applyPendingMigrations(externalUrl);
    else temporary = await startEmbeddedPostgresTestDatabase("chat-lineage-projection-");
    db = createDb(externalUrl ?? temporary!.connectionString);
  }, 90_000);
  afterAll(async () => {
    try {
      if (db) for (const companyId of companyIds) await cleanupChatReplyLineageFixture(db, companyId);
    } finally {
      try { await db?.$client.end({ timeout: 0 }); }
      finally { await temporary?.cleanup(); }
    }
  });

  it("projects the complete routing context before a wide body crosses PostgreSQL", async () => {
    const f = await fixture(), reads: LineageQuery[] = [];
    expect(await resolveChatOriginPublicationBindings(captureLineageReads(db, reads), f.companyId, f.issueId, f.root.id)).toEqual(f.expected);
    expect(reads).toHaveLength(1);
    const rows = await db.$client.unsafe(reads[0].sql, reads[0].params as never[]).raw();
    expect(rows.reduce((total, row) => total + row.reduce((n: number, value: Buffer | null) => n + (value?.length ?? 0), 0), 0)).toBeLessThan(1024);
    expect(reads[0].rows).toEqual([{ agentId: f.agentId, responsibleUserId: null, contextSnapshot: expectedLineageContext(f.context) }]);
  });

  it.each([null, false, true, 0, 12, "", "malformed", [], ["source", { source: "chat:slack" }], {},
    { issueId: null, taskId: false, source: 3, interactionId: null, wakeCommentIds: { id: "not-array" } },
  ])("preserves malformed JSON and key absence for %j", async snapshot => {
    const f = await fixture(1), run = await f.insertRun(snapshot), reads: LineageQuery[] = [];
    expect(await resolveChatOriginPublicationBindings(captureLineageReads(db, reads), f.companyId, f.issueId, run.id)).toEqual([]);
    expect(reads[0].rows[0].contextSnapshot).toEqual(expectedLineageContext(snapshot));
  });

  it("keeps all nine keys and their JSON values, including explicit nulls and arrays", async () => {
    const f = await fixture(1);
    const snapshot = { issueId: null, taskId: f.issueId, wakeCommentIds: [f.comment.id, 1, null, f.comment.id], wakeCommentId: f.comment.id, commentId: f.comment.id,
      source: "chat:slack", sourceRunId: { invalid: true }, interactionId: null, endpointId: f.endpoint.id, omitted: "wide unrelated value" };
    const run = await f.insertRun(snapshot), reads: LineageQuery[] = [];
    expect(await resolveChatOriginPublicationBindings(captureLineageReads(db, reads), f.companyId, f.issueId, run.id)).toEqual(f.expected);
    expect(reads[0].rows[0].contextSnapshot).toEqual(expectedLineageContext(snapshot));
    expect(Object.hasOwn(reads[0].rows[0].contextSnapshot as object, "interactionId")).toBe(true);
    expect(Object.hasOwn(reads[0].rows[0].contextSnapshot as object, "omitted")).toBe(false);
  });

  it("preserves explicit JSON null as well as SQL null", async () => {
    const f = await fixture(1), run = await f.insertRun(null), reads: LineageQuery[] = [];
    await db.$client.unsafe("update heartbeat_runs set context_snapshot = 'null'::jsonb where id = $1::uuid", [run.id]);
    expect(await resolveChatOriginPublicationBindings(captureLineageReads(db, reads), f.companyId, f.issueId, run.id)).toEqual([]);
    expect(reads[0].rows[0].contextSnapshot).toBeNull();
  });

  it.each([
    { name: "missing", snapshot: {}, wake: {}, allowed: true },
    { name: "explicit null", snapshot: { interactionId: null }, wake: { interactionId: null }, allowed: true },
    { name: "missing versus null", snapshot: { interactionId: null }, wake: {}, allowed: false },
    { name: "equal strings", snapshot: { interactionId: "synthetic-interaction" }, wake: { interactionId: "synthetic-interaction" }, allowed: true },
    { name: "number versus text", snapshot: { interactionId: 12 }, wake: { interactionId: "12" }, allowed: false },
    { name: "separate objects", snapshot: { interactionId: { id: "same" } }, wake: { interactionId: { id: "same" } }, allowed: false },
  ])("retains strict tool-action interaction semantics for $name and requires the durable receipt", async ({ snapshot, wake, allowed }) => {
    const f = await fixture(1), continued = await f.continueFrom(f.root.id);
    const [invocation] = await db.insert(toolInvocations).values({ companyId: f.companyId, issueId: f.issueId, agentId: f.agentId, runId: f.root.id, toolName: "synthetic-operation" }).returning();
    const [request] = await db.insert(toolActionRequests).values({ companyId: f.companyId, issueId: f.issueId, invocationId: invocation.id,
      interactionId: continued.interaction.id, requestedByAgentId: f.agentId, status: "executed", canonicalArgumentsHash: "synthetic", canonicalArgumentsSummary: { summary: "Synthetic operation" } }).returning();
    await db.insert(toolActionDeliveries).values({ companyId: f.companyId, issueId: f.issueId, actionRequestId: request.id, interactionId: continued.interaction.id });
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, source: "tool_action_review", sourceRunId: f.root.id, ...snapshot } }).where(eq(heartbeatRuns.id, continued.run.id));
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation", reason: "issue_commented", status: "claimed", runId: continued.run.id,
      idempotencyKey: `tool-action-response:${request.id}`, payload: { sourceRunId: f.root.id, toolActionRequestIds: [request.id], ...wake } });
    expect(await resolveChatOriginPublicationBindings(db, f.companyId, f.issueId, continued.run.id)).toEqual(allowed ? f.expected : []);
    await db.delete(toolActionDeliveries).where(eq(toolActionDeliveries.actionRequestId, request.id));
    expect(await resolveChatOriginPublicationBindings(db, f.companyId, f.issueId, continued.run.id)).toEqual([]);
  });

  it("retains valid lineage beyond sixteen hops and rejects a durable cycle", async () => {
    const f = await fixture(1);
    let previous = f.root.id;
    for (let index = 0; index < 24; index++) previous = (await f.continueFrom(previous)).run.id;
    expect(await resolveChatOriginPublicationBindings(db, f.companyId, f.issueId, previous)).toEqual(f.expected);
    const cycle = await f.continueFrom(previous);
    await db.update(heartbeatRuns).set({ contextSnapshot: { source: "issue.interaction.accept", issueId: f.issueId, interactionId: cycle.interaction.id, sourceRunId: previous } }).where(eq(heartbeatRuns.id, f.root.id));
    await db.update(agentWakeupRequests).set({ runId: f.root.id }).where(eq(agentWakeupRequests.id, cycle.wake.id));
    const reads: LineageQuery[] = [];
    expect(await resolveChatOriginPublicationBindings(captureLineageReads(db, reads), f.companyId, f.issueId, previous)).toEqual([]);
    expect(reads).toHaveLength(25);
  });

  it("rejects mismatched company, task, agent, and endpoint bindings", async () => {
    const f = await fixture(1), other = await fixture(1);
    expect(await resolveChatOriginPublicationBindings(db, other.companyId, f.issueId, f.root.id)).toEqual([]);
    for (const change of [{ issueId: other.issueId }, { endpointId: other.endpoint.id }, { source: false }, { wakeCommentIds: [randomUUID()], wakeCommentId: 12 }]) {
      const run = await f.insertRun({ ...f.context, ...change });
      expect(await resolveChatOriginPublicationBindings(db, f.companyId, f.issueId, run.id)).toEqual([]);
    }
    const continued = await f.continueFrom(f.root.id);
    await db.update(heartbeatRuns).set({ agentId: other.agentId }).where(eq(heartbeatRuns.id, continued.run.id));
    expect(await resolveChatOriginPublicationBindings(db, f.companyId, f.issueId, continued.run.id)).toEqual([]);
  });
});
