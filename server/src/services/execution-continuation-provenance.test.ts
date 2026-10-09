import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueComments, issueThreadInteractions, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { buildExecutionContinuation, currentContinuationOrigins } from "./execution-continuation.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("interaction producer task scope", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-continuation-provenance-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), producerIssueId = randomUUID();
    const producerRunId = randomUUID(), interactionId = randomUUID(), targetCommentId = randomUUID(), producerCommentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Provenance fixture", issuePrefix: `PRV${companyId.slice(0, 8)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Executor", role: "engineer", adapterType: "paperclip_runner" });
    await db.insert(issues).values([
      { id: issueId, companyId, title: "Target task", status: "in_progress", assigneeAgentId: agentId },
      { id: producerIssueId, companyId, title: "Producer task", status: "in_progress", assigneeAgentId: agentId },
    ]);
    await db.insert(issueComments).values([
      { id: targetCommentId, companyId, issueId, authorType: "user", authorUserId: "local-board", body: "Keep the target direction." },
      { id: producerCommentId, companyId, issueId: producerIssueId, authorType: "user", authorUserId: "local-board", body: "Unrelated producer direction." },
    ]);
    const producerContext = { issueId: producerIssueId, commentId: producerCommentId };
    await db.insert(heartbeatRuns).values({ id: producerRunId, companyId, agentId, status: "succeeded",
      contextSnapshot: producerContext,
      resultJson: { summary: "Unrelated producer work.", apiToolReceipts: { saved: { state: "completed", operationId: "producer_operation", result: "Unrelated result." } } },
    });
    await db.insert(issueThreadInteractions).values({ id: interactionId, companyId, issueId,
      kind: "ask_user_questions", status: "answered", sourceRunId: producerRunId,
      originCommentIds: [producerCommentId, targetCommentId],
      resolvedByUserId: "local-board", resolvedAt: new Date(),
      payload: { version: 1, questions: [{ id: "scope", prompt: "Which scope?", selectionMode: "single", options: [{ id: "target", label: "Target" }] }] },
      result: { version: 1, answers: [{ questionId: "scope", optionIds: ["target"] }] },
    });
    const build = (context: Record<string, unknown> = {}) => buildExecutionContinuation({
      db, companyId, issueId, agentId, context: { interactionId, wakeReason: "ask_user_questions.answered", ...context },
      summary: null, exposeLowTrustRaw: false,
    });
    return { companyId, agentId, issueId, producerIssueId, producerRunId, interactionId, targetCommentId, producerCommentId, producerContext, build };
  }

  it("does not copy another task's comments into newly captured interaction origins", async () => {
    const f = await fixture();
    expect(await currentContinuationOrigins(db, f.companyId, f.issueId, f.producerContext)).toEqual([f.targetCommentId]);
    expect(await currentContinuationOrigins(db, f.companyId, f.issueId, { commentId: f.targetCommentId })).toEqual([f.targetCommentId]);
  });

  it("retains unknown and cross-company origins so dispatch can reject them", async () => {
    const f = await fixture(), other = await fixture(), missing = randomUUID();
    const ids = [missing, "not-a-uuid", other.targetCommentId, f.producerCommentId];
    expect(await currentContinuationOrigins(db, f.companyId, f.issueId, { commentIds: ids }))
      .toEqual([missing, "not-a-uuid", other.targetCommentId, f.targetCommentId]);
  });

  it("resumes a human answer with legacy producer origins without importing the producer task", async () => {
    const f = await fixture();
    const envelope = await f.build();
    expect(envelope.trigger.sourceRunId).toBe(f.producerRunId);
    expect(envelope.originCommentIds).toEqual([f.targetCommentId]);
    expect(envelope.messages.map(row => row.id)).toEqual([f.targetCommentId]);
    expect(envelope.objective).toBe("Keep the target direction.");
    expect(envelope.humanResponses).toEqual([expect.objectContaining({ id: f.interactionId,
      result: { answers: [{ questionId: "scope", optionIds: ["target"], otherText: undefined }] } })]);
    expect(envelope.completedWork).toBeNull();
    expect(envelope.completedActions).toEqual([]);
    expect(JSON.stringify(envelope)).not.toContain("Unrelated");
  });

  it("accepts a taskless producer as provenance when the interaction has target-scoped origins", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ contextSnapshot: {} }).where(eq(heartbeatRuns.id, f.producerRunId));
    await db.update(issueThreadInteractions).set({ originCommentIds: [f.targetCommentId] }).where(eq(issueThreadInteractions.id, f.interactionId));
    const envelope = await f.build();
    expect(envelope.trigger.sourceRunId).toBe(f.producerRunId);
    expect(envelope.completedWork).toBeNull();
    expect(envelope.messages).toHaveLength(1);
  });

  it.each(["retryOfRunId", "previousRunId", "interruptedRunId"])("prefers explicit %s history to the producer", async (key) => {
    const f = await fixture(), resumeRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: resumeRunId, companyId: f.companyId, agentId: f.agentId,
      status: "interrupted", contextSnapshot: { issueId: f.issueId, commentId: f.targetCommentId },
      resultJson: { summary: "Target work.", apiToolReceipts: { saved: { state: "completed", operationId: "target_operation", result: "Target result." } } },
    });
    const envelope = await f.build({ [key]: resumeRunId });
    expect(envelope.trigger.sourceRunId).toBe(resumeRunId);
    expect(envelope.completedWork).toBe("Target work.");
    expect(envelope.completedActions).toEqual([expect.objectContaining({ runId: resumeRunId, operationId: "target_operation" })]);
    expect(envelope.originCommentIds).toEqual([f.targetCommentId]);
    expect(JSON.stringify(envelope)).not.toContain("Unrelated");
  });

  it.each(["retryOfRunId", "previousRunId", "interruptedRunId"])("rejects explicit %s history from another task", async (key) => {
    const f = await fixture();
    await expect(f.build({ [key]: f.producerRunId })).rejects.toThrow("continuation_source_context_missing");
  });

  it("retains the explicit user continuation authorization requirement", async () => {
    const f = await fixture();
    await expect(f.build({ explicitUserContinuation: { previousRunId: f.producerRunId } }))
      .rejects.toThrow("continuation_user_authorization_missing");
  });

  it.each(["sourceCommentId", "commentId"])("rejects an explicit foreign %s even when it matches the producer", async (key) => {
    const f = await fixture();
    if (key === "sourceCommentId") await db.update(issueThreadInteractions)
      .set({ sourceCommentId: f.producerCommentId }).where(eq(issueThreadInteractions.id, f.interactionId));
    await expect(f.build(key === "commentId" ? { commentId: f.producerCommentId } : {}))
      .rejects.toThrow("continuation_source_context_missing");
  });

  it.each(["missing", "cross-company", "unrecorded", "other-task"])("rejects %s origins instead of silently discarding them", async (kind) => {
    const f = await fixture();
    let invalidId = randomUUID();
    if (kind === "cross-company") invalidId = (await fixture()).targetCommentId;
    if (kind === "unrecorded") {
      invalidId = f.producerCommentId;
      await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.producerIssueId } }).where(eq(heartbeatRuns.id, f.producerRunId));
    } else {
      if (kind === "other-task") {
        const thirdIssueId = randomUUID();
        await db.insert(issues).values({ id: thirdIssueId, companyId: f.companyId, title: "Unrelated third task" });
        await db.insert(issueComments).values({ id: invalidId, companyId: f.companyId, issueId: thirdIssueId, body: "Third task." });
      }
      await db.update(heartbeatRuns).set({ contextSnapshot: { ...f.producerContext, commentIds: [invalidId] } }).where(eq(heartbeatRuns.id, f.producerRunId));
    }
    await db.update(issueThreadInteractions).set({ originCommentIds: [invalidId] }).where(eq(issueThreadInteractions.id, f.interactionId));
    await expect(f.build()).rejects.toThrow("continuation_source_context_missing");
  });

  it("rejects a producer outside the company", async () => {
    const f = await fixture(), other = await fixture();
    await db.update(issueThreadInteractions).set({ sourceRunId: other.producerRunId }).where(eq(issueThreadInteractions.id, f.interactionId));
    await expect(f.build()).rejects.toThrow("continuation_source_context_missing");
  });

  it("rejects a missing explicit resume instead of falling back to the producer", async () => {
    const f = await fixture();
    await expect(f.build({ retryOfRunId: randomUUID() })).rejects.toThrow("continuation_source_context_missing");
  });

  it("rejects a missing target origin even when legacy producer origins are recoverable", async () => {
    const f = await fixture();
    await db.delete(issueComments).where(eq(issueComments.id, f.targetCommentId));
    await expect(f.build()).rejects.toThrow("continuation_source_context_missing");
  });
});
