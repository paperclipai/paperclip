import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, agentWakeupRequests, assets, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issueAttachments,
  issueComments, issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { undeliveredLegacyUserCommentIds } from "../explicit-native-continuation.js";
import { deliveredQueuedCommentIds } from "../queued-comment-delivery.js";
import {
  claimFirstTurnQueuedInput, firstTurnClaimedCommentIds, firstTurnTakesAllQueuedComments, runAcceptsFirstTurnQueuedInput,
} from "./first-turn-queued-input.js";

const support = await getEmbeddedPostgresTestSupport();
const USER = "first-turn-user";

describe.skipIf(!support.supported)("first-turn queued input", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-first-turn-queued-input-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed() {
    const [company] = await db.insert(companies).values({ name: "First turn", issuePrefix: `F${randomUUID().slice(0, 4)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Codie", adapterType: "paperclip_runner" }).returning();
    const issueId = randomUUID();
    const runId = await startRun(company!.id, agent!.id, issueId);
    await db.insert(issues).values({ id: issueId, companyId: company!.id, title: "Fix the reports", status: "in_progress",
      assigneeAgentId: agent!.id, executionRunId: runId });
    return { companyId: company!.id, agentId: agent!.id, issueId, runId };
  }

  async function startRun(companyId: string, agentId: string, issueId: string) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", runtimeMode: "native",
      runtimeModeResolvedAt: new Date(), nativeIssueId: issueId, responsibleUserId: USER, startedAt: new Date(),
      contextSnapshot: { issueId } }).returning();
    return run!.id;
  }

  /** A user's comment saved behind the active run, in the shape the previous release writes. */
  async function queueMessage(f: Awaited<ReturnType<typeof seed>>, body: string) {
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: USER, body }).returning();
    const [existing] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.status, "deferred_issue_execution"))
      .then(rows => rows.filter(row => row.companyId === f.companyId));
    const ids = [...((existing?.payload?._paperclipWakeContext as { wakeCommentIds?: string[] } | undefined)?.wakeCommentIds ?? []), comment!.id];
    const payload = { issueId: f.issueId, commentId: comment!.id, _paperclipWakeContext: { issueId: f.issueId, taskId: f.issueId,
      wakeReason: "issue_commented", source: "issue.comment", wakeCommentId: comment!.id, wakeCommentIds: ids } };
    if (existing) await db.update(agentWakeupRequests).set({ payload }).where(eq(agentWakeupRequests.id, existing.id));
    else await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
      triggerDetail: "system", reason: "issue_execution_deferred", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: USER, payload });
    return comment!.id;
  }

  const binding = (f: { companyId: string; issueId: string; agentId: string }, runId: string) =>
    ({ companyId: f.companyId, issueId: f.issueId, agentId: f.agentId, runId });
  const accept = (f: { companyId: string; agentId: string }, runId: string) => appendHeartbeatRunEvent(db, {
    companyId: f.companyId, runId, agentId: f.agentId, eventType: "turn.accepted", stream: "system", level: "info", message: "turn accepted" });
  const readRun = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;

  it("gives a message that arrived during preparation to the first turn, without a stop", async () => {
    const f = await seed();
    const message = await queueMessage(f, "oh i mean each of the ones that appeared within the last 24 hours");
    expect(await runAcceptsFirstTurnQueuedInput(db, await readRun(f.runId))).toBe(true);
    const startedAt = performance.now();
    const firstTurn = await claimFirstTurnQueuedInput(db, binding(f, f.runId));
    const sealMs = performance.now() - startedAt;
    console.info(`first-turn queued input seal took ${sealMs.toFixed(1)}ms before turn.start`);
    expect(firstTurn).toContain("oh i mean each of the ones that appeared within the last 24 hours");
    expect(firstTurn).toContain(`comment ${message}`);
    const run = await readRun(f.runId);
    expect(run.status).toBe("running");
    expect([...firstTurnClaimedCommentIds(run)]).toEqual([message]);
    // Sealed: a later message waits for the turn boundary and Interrupt applies.
    expect(await runAcceptsFirstTurnQueuedInput(db, run)).toBe(false);
    const later = await queueMessage(f, "one more thing");
    expect(await claimFirstTurnQueuedInput(db, binding(f, f.runId))).not.toContain("one more thing");
    expect(firstTurnClaimedCommentIds(await readRun(f.runId)).has(later)).toBe(false);
    expect(sealMs).toBeLessThan(1_000);
  });

  it("delivers two messages from preparation in their queued order", async () => {
    const f = await seed();
    await queueMessage(f, "FIRST follow-up");
    await queueMessage(f, "SECOND follow-up");
    const firstTurn = await claimFirstTurnQueuedInput(db, binding(f, f.runId));
    expect(firstTurn).toMatch(/Message 1 of 2[^\n]*\nFIRST follow-up[\s\S]*Message 2 of 2[^\n]*\nSECOND follow-up/);
  });

  it("keeps the message queued when the run fails before turn.start, then delivers it exactly once", async () => {
    const f = await seed();
    const message = await queueMessage(f, "please include the staging run");
    expect(await claimFirstTurnQueuedInput(db, binding(f, f.runId))).toContain("please include the staging run");
    // A restart before the provider accepted the turn repeats the same input.
    expect(await claimFirstTurnQueuedInput(db, binding(f, f.runId))).toContain("please include the staging run");
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    // Not consumed: release promotion and Send both still deliver it.
    const ids = { companyId: f.companyId, issueId: f.issueId, agentId: f.agentId, commentIds: [message] };
    expect([...await deliveredQueuedCommentIds(db, ids)]).toEqual([]);
    expect(await undeliveredLegacyUserCommentIds(db, f.companyId, f.issueId, f.agentId, [message])).toEqual([message]);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(wake!.status).toBe("deferred_issue_execution");

    // The next run takes it into its own first turn; the provider accepts.
    const nextRunId = await startRun(f.companyId, f.agentId, f.issueId);
    await db.update(issues).set({ executionRunId: nextRunId }).where(eq(issues.id, f.issueId));
    expect(await claimFirstTurnQueuedInput(db, binding(f, nextRunId))).toContain("please include the staging run");
    await accept(f, nextRunId);
    expect([...await deliveredQueuedCommentIds(db, ids)]).toEqual([message]);
    expect(await undeliveredLegacyUserCommentIds(db, f.companyId, f.issueId, f.agentId, [message])).toEqual([]);

    // Exactly once: a later run, and a retry that copied the context, take nothing.
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, nextRunId));
    const thirdRunId = await startRun(f.companyId, f.agentId, f.issueId);
    await db.update(heartbeatRuns).set({ contextSnapshot: (await readRun(nextRunId)).contextSnapshot })
      .where(eq(heartbeatRuns.id, thirdRunId));
    await db.update(issues).set({ executionRunId: thirdRunId }).where(eq(issues.id, f.issueId));
    expect(await claimFirstTurnQueuedInput(db, binding(f, thirdRunId))).toBeNull();
  });

  it("counts a message as delivered once the provider accepted the turn, even if the run later fails", async () => {
    const f = await seed();
    const message = await queueMessage(f, "ship it");
    await claimFirstTurnQueuedInput(db, binding(f, f.runId));
    await accept(f, f.runId);
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    expect([...await deliveredQueuedCommentIds(db, { companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
      commentIds: [message] })]).toEqual([message]);
  });

  it("treats a run saved by the previous release as started once its provider accepted a turn", async () => {
    const f = await seed();
    await queueMessage(f, "mid-turn message");
    await accept(f, f.runId);
    expect(await runAcceptsFirstTurnQueuedInput(db, await readRun(f.runId))).toBe(false);
  });

  it("leaves another user's message and a run without a responsible user to their own delivery", async () => {
    const f = await seed();
    await queueMessage(f, "mine");
    await db.update(agentWakeupRequests).set({ requestedByActorId: "someone-else" }).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(await claimFirstTurnQueuedInput(db, binding(f, f.runId))).toBeNull();
  });
  it("seals on a one-connection pool without waiting for a second connection", async () => {
    const f = await seed();
    await queueMessage(f, "secret-free follow-up");
    const single = createDb(database.connectionString, { maxConnections: 1 });
    try {
      const sealed = await Promise.race([
        claimFirstTurnQueuedInput(single, binding(f, f.runId)),
        new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 5_000)),
      ]);
      expect(sealed).toContain("secret-free follow-up");
    } finally {
      await single.$client.end({ timeout: 1 });
    }
  });

  it("leaves a message with files on its own delivery path so the files reach the agent", async () => {
    const f = await seed();
    await queueMessage(f, "text only");
    const withFile = await queueMessage(f, "see the attached screenshot");
    const [asset] = await db.insert(assets).values({ companyId: f.companyId, provider: "local_disk",
      objectKey: `${f.companyId}/screenshot`, originalFilename: "screenshot.png", contentType: "image/png",
      byteSize: 1, sha256: "0".repeat(64) }).returning();
    await db.insert(issueAttachments).values({ companyId: f.companyId, issueId: f.issueId, assetId: asset!.id,
      issueCommentId: withFile });
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    const queuedIds = (wake!.payload?._paperclipWakeContext as { wakeCommentIds: string[] }).wakeCommentIds;
    // Interrupt keeps its meaning for this queue: the first turn cannot take all of it.
    expect(await firstTurnTakesAllQueuedComments(db, { companyId: f.companyId, issueId: f.issueId, responsibleUserId: USER,
      commentIds: queuedIds })).toBe(false);
    const firstTurn = await claimFirstTurnQueuedInput(db, binding(f, f.runId));
    expect(firstTurn).toContain("text only");
    expect(firstTurn).not.toContain("see the attached screenshot");
    const run = await readRun(f.runId);
    expect(firstTurnClaimedCommentIds(run).has(withFile)).toBe(false);
    await accept(f, f.runId);
    // Still owed after the turn: release promotion delivers it with its file.
    expect([...await deliveredQueuedCommentIds(db, { companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
      commentIds: [withFile] })]).toEqual([]);
  });
});
