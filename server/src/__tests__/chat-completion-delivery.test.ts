import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, authUsers, chatCompletionDeliveries as deliveries,
  companies, companyMemberships, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { acknowledgeReusedChatCompletionReply, chatCompletionDeliveryService, prepareChatCompletionTurn } from "../services/chat-completion-delivery.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { recoveryPostgresSupport as support, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

(support.supported ? describe : describe.skip)("chat completion delivery", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;

  beforeAll(async () => {
    temporary = await startRecoveryPostgres("chat-completion-");
    db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, 60_000);
  afterAll(async () => { await temporary?.cleanup(); });
  beforeEach(async () => { await db.update(deliveries).set({ status: "exhausted" }); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), sourceId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Completion", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Lead", status: "idle", adapterType: "process" });
    await db.insert(issues).values({ id: sourceId, companyId, title: "Chat", status: "in_progress", conversationAgentId: agentId,
      conversationUserId: "operator", conversationState: "waiting", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", contextSnapshot: { issueId: sourceId, conversationSessionGeneration: 0 } });
    const create = () => issueService(db).create(companyId, { title: `Write note ${randomUUID()}`, status: "todo", createdByAgentId: agentId, actorRunId: runId });
    const task = await create();
    const finish = (taskId = task.id) => issueService(db).update(taskId, { status: "done" });
    const rows = () => db.select().from(deliveries).where(eq(deliveries.companyId, companyId)).orderBy(asc(deliveries.createdAt), asc(deliveries.id));
    const due = () => db.update(deliveries).set({ nextAttemptAt: new Date(0) }).where(eq(deliveries.companyId, companyId));
    const wakeup = vi.fn<Parameters<typeof chatCompletionDeliveryService>[1]["wakeup"]>(async (_agentId, options) => {
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "queued", contextSnapshot: options.contextSnapshot }).returning();
      await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", status: "queued", idempotencyKey: options.idempotencyKey, runId: run.id });
      return run;
    });
    const service = chatCompletionDeliveryService(db, { wakeup });
    const run = async () => {
      const [delivery] = await rows();
      await service.deliver(delivery.id);
      const [current] = await rows();
      const [r] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, current.targetRunId!));
      return prepareChatCompletionTurn(db, r);
    };
    return { companyId, agentId, sourceId, runId, task, create, finish, rows, due, wakeup, service, run };
  }

  it("acknowledges a reused provider comment before a restarted delivery sweep", async () => {
    const f = await seed();
    await db.insert(authUsers).values({ id: "operator", name: "Operator", email: "operator@example.test", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: "operator", status: "active", membershipRole: "operator" });
    await db.update(issues).set({ responsibleUserId: "operator" }).where(eq(issues.id, f.sourceId));
    const cwd = await mkdtemp(join(tmpdir(), "completion-presentation-"));
    const listener = createServer(async (req, res) => {
      try {
        const runId = req.url!.slice(1);
        await issueService(db).addComment(f.sourceId, "Both notes are ready.", { agentId: f.agentId, runId });
        res.end("ok");
      } catch (error) {
        res.statusCode = 500;
        res.end(String(error));
      }
    }).listen(0, "127.0.0.1");
    await new Promise<void>(resolve => listener.once("listening", resolve));
    const { port } = listener.address() as { port: number };
    const script = `fetch('http://127.0.0.1:${port}/' + process.env.PAPERCLIP_RUN_ID).then(async r => {if (!r.ok) throw new Error(await r.text())})`;
    await db.update(agents).set({ adapterConfig: { command: process.execPath, args: ["-e", script], cwd },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } }).where(eq(agents.id, f.agentId));
    const heartbeat = heartbeatService(db);
    const delivery = chatCompletionDeliveryService(db, heartbeat);
    try {
      await f.finish();
      await delivery.sweepPending({ companyId: f.companyId, taskId: f.task.id });
      await expect.poll(async () => {
        const source = await issueService(db).getById(f.sourceId);
        const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
        return runs.some(run => run.contextSnapshot?.wakeReason === "chat_task_completed" && run.status === "succeeded") && source?.conversationState === "waiting" && !source.executionRunId;
      }, { timeout: 20_000 }).toBe(true).catch(async error => {
        throw new Error(JSON.stringify({ deliveries: await f.rows(), wakes: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)) }), { cause: error });
      });
      const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.agentId)));
      const reporting = runs.filter(run => run.contextSnapshot?.wakeReason === "chat_task_completed");
      expect(reporting).toHaveLength(1);
      expect(reporting[0]).toMatchObject({ status: "succeeded", resultJson: { presentationDecision: { commentAction: "reuse" } } });
      const replies = await db.select().from(issueComments).where(eq(issueComments.createdByRunId, reporting[0].id));
      expect(replies).toHaveLength(1);
      expect(await f.rows()).toMatchObject([{ status: "delivered", responseCommentId: replies[0].id }]);
      await f.due();
      const restarted = chatCompletionDeliveryService(db, { wakeup: f.wakeup });
      await Promise.all([restarted.sweepPending(), restarted.sweepPending()]);
      expect(f.wakeup).not.toHaveBeenCalled();
    } finally {
      await heartbeat.cancelActiveForAgent(f.agentId);
      await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  it.each(["company", "issue", "run", "comment", "agent", "reset", "reopen", "deleted"])("does not acknowledge a reused reply with %s", async mismatch => {
    const f = await seed(); await f.finish(); const run = await f.run();
    const reply = await issueService(db).addComment(f.sourceId, "Ready", { agentId: f.agentId, runId: run.id });
    const input: Parameters<typeof acknowledgeReusedChatCompletionReply>[1] = {
      companyId: f.companyId, issueId: f.sourceId, runId: run.id, commentId: reply.id,
    };
    if (mismatch === "company") input.companyId = randomUUID();
    if (mismatch === "issue") input.issueId = f.task.id;
    if (mismatch === "run") input.runId = f.runId;
    if (mismatch === "comment") input.commentId = randomUUID();
    if (mismatch === "agent") {
      const other = await seed();
      await db.update(issueComments).set({ authorAgentId: other.agentId }).where(eq(issueComments.id, reply.id));
    }
    if (mismatch === "reset") await db.update(issues).set({ conversationSessionGeneration: 1 }).where(eq(issues.id, f.sourceId));
    if (mismatch === "reopen") await issueService(db).update(f.task.id, { status: "todo" });
    if (mismatch === "deleted") await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, reply.id));
    const acknowledged = acknowledgeReusedChatCompletionReply(db, input);
    if (["reset", "reopen"].includes(mismatch)) await expect(acknowledged).rejects.toThrow("chat_completion_superseded");
    else await acknowledged;
    expect((await f.rows())[0].responseCommentId).toBeNull();
    if (mismatch === "deleted") {
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run.id));
      await f.due(); await f.service.sweepPending();
      expect(f.wakeup).toHaveBeenCalledTimes(2);
      expect(await f.rows()).toMatchObject([{ status: "queued", responseCommentId: null, attempts: 1 }]);
    }
  });

  it("serializes reused reply acknowledgement and leaves later completions pending", async () => {
    const f = await seed(); await f.finish(); const run = await f.run();
    const reply = await issueService(db).addComment(f.sourceId, "First note ready", { agentId: f.agentId, runId: run.id });
    const later = await f.create(); await f.finish(later.id);
    await Promise.all(Array.from({ length: 3 }, () => acknowledgeReusedChatCompletionReply(db, {
      companyId: f.companyId, issueId: f.sourceId, runId: run.id, commentId: reply.id,
    })));
    const rows = await f.rows();
    expect(rows.find(row => row.taskId === f.task.id)).toMatchObject({ status: "delivered", responseCommentId: reply.id });
    expect(rows.find(row => row.taskId === later.id)).toMatchObject({ status: "pending", responseCommentId: null });
  });

  it("revalidates the whole frozen batch even after finding an acknowledged reply", async () => {
    const f = await seed();
    const second = await f.create();
    await f.finish(); await f.finish(second.id);
    const run = await f.run();
    const reply = await issueService(db).addComment(f.sourceId, "Both notes are ready.", { agentId: f.agentId, runId: run.id });
    const frozen = await db.select().from(deliveries).where(eq(deliveries.targetRunId, run.id));
    expect(frozen).toHaveLength(2);
    await db.update(deliveries).set({ status: "delivered", responseCommentId: reply.id }).where(eq(deliveries.id, frozen[0].id));
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, frozen[1].taskId));
    await expect(acknowledgeReusedChatCompletionReply(db, {
      companyId: f.companyId, issueId: f.sourceId, runId: run.id, commentId: reply.id,
    })).rejects.toThrow("chat_completion_superseded");
    expect((await f.rows()).find(row => row.id === frozen[1].id)).toMatchObject({ status: "queued", responseCommentId: null });
  });

  it.each([false, true])("defers a retry while the succeeded run is still finalizing (expired: %s)", async expired => {
    const f = await seed(); await f.finish(); const run = await f.run();
    const reply = await issueService(db).addComment(f.sourceId, "Ready", { agentId: f.agentId, runId: run.id });
    await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, f.sourceId));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: expired ? new Date(0) : new Date() })
      .where(eq(heartbeatRuns.id, run.id));
    await f.due(); await f.service.sweepPending();
    expect(f.wakeup).toHaveBeenCalledTimes(expired ? 2 : 1);
    if (!expired) {
      expect(await f.rows()).toMatchObject([{ status: "queued", attempts: 0, targetRunId: run.id }]);
      await acknowledgeReusedChatCompletionReply(db, {
        companyId: f.companyId, issueId: f.sourceId, runId: run.id, commentId: reply.id,
      });
      expect(await f.rows()).toMatchObject([{ status: "delivered", attempts: 0, responseCommentId: reply.id }]);
    }
  });
});
