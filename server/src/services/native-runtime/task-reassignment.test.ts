import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import { activityLog, agents, companies, createDb, heartbeatRuns, issues, issueComments } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { issueService } from "../issues.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";

describe("runner task reassignment", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("runner-reassign-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture(status = "todo") {
    const companyId = randomUUID(), agentId = randomUUID(), nextId = randomUUID(), issueId = randomUUID(), targetId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Reassignment", issuePrefix: `R${companyId.slice(0, 6)}` });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Manager", role: "ceo", status: "active", adapterType: "paperclip_runner" },
      { id: nextId, companyId, name: "Engineer", role: "engineer", status: "active", adapterType: "paperclip_runner" },
    ]);
    await db.insert(issues).values([
      { id: issueId, companyId, title: "Coordinate", status: "in_progress", assigneeAgentId: agentId },
      { id: targetId, companyId, title: "Existing work", status, assigneeAgentId: agentId, description: "Keep the existing plan and context" },
    ]);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId, invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const enqueueWakeup = vi.fn().mockResolvedValue({ id: randomUUID() });
    const stopTaskForReassignment = vi.fn().mockResolvedValue(undefined);
    const binding = { companyId, agentId, issueId, runId, enqueueWakeup, stopTaskForReassignment };
    const authority = new PaperclipRunnerToolAuthority(db, binding);
    const call = { tool: "reassign_task", callId: "handoff", arguments: { taskId: targetId, assigneeActorId: nextId, expectedAssigneeActorId: agentId, expectedStatusVersion: 0, reason: "Engineer owns implementation; retain the existing plan.", idempotencyKey: "handoff" } };
    const target = async () => (await db.select().from(issues).where(eq(issues.id, targetId)))[0]!;
    return { companyId, agentId, nextId, issueId, targetId, runId, authority, binding, call, target, enqueueWakeup, stopTaskForReassignment };
  }

  it("moves existing work once, persists context and audit, and dispatches a guarded wake", async () => {
    const f = await fixture();
    const receipt = await f.authority.execute(f.call);
    expect(await f.target()).toMatchObject({ assigneeAgentId: f.nextId, status: "todo", statusVersion: 1, description: "Keep the existing plan and context" });
    await expect(f.authority.execute({ ...f.call, callId: "retry" })).resolves.toEqual(receipt);
    expect(f.stopTaskForReassignment).toHaveBeenCalledTimes(1);
    expect(f.enqueueWakeup).toHaveBeenCalledWith(f.nextId, expect.objectContaining({ issueStateGuard: { statuses: ["todo"], assigneeAgentId: f.nextId, statusVersion: 1 } }));
    expect(f.enqueueWakeup.mock.calls[0]![1].idempotencyKey).toEqual(f.enqueueWakeup.mock.calls[1]![1].idempotencyKey);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "issue.reassigned")))).toHaveLength(1);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.targetId))).toHaveLength(1);
  });

  it.each(["blocked", "backlog"])("preserves %s and does not wake work prematurely", async status => {
    const f = await fixture(status);
    await f.authority.execute(f.call);
    expect(await f.target()).toMatchObject({ assigneeAgentId: f.nextId, status });
    expect(f.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("replays across a replacement caller run without a second mutation", async () => {
    const f = await fixture();
    const receipt = await f.authority.execute(f.call);
    const replacement = randomUUID();
    await db.insert(heartbeatRuns).values({ id: replacement, companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId, runtimeMode: "native", status: "running", invocationSource: "assignment", triggerDetail: "system" });
    await db.update(issues).set({ executionRunId: replacement }).where(eq(issues.id, f.issueId));
    await expect(new PaperclipRunnerToolAuthority(db, { ...f.binding, runId: replacement }).execute(f.call)).resolves.toEqual(receipt);
    expect((await f.target()).statusVersion).toBe(1);
  });

  it("repairs a dispatch failure by replaying the committed receipt", async () => {
    const f = await fixture();
    f.enqueueWakeup.mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(f.authority.execute(f.call)).rejects.toThrow("queue unavailable");
    expect((await f.target()).assigneeAgentId).toBe(f.nextId);
    await f.authority.execute(f.call);
    expect(f.stopTaskForReassignment).toHaveBeenCalledTimes(1);
    expect(f.enqueueWakeup).toHaveBeenCalledTimes(2);
  });

  it("rejects key reuse with different input and stale ownership/version", async () => {
    const f = await fixture();
    await f.authority.execute(f.call);
    await expect(f.authority.execute({ ...f.call, arguments: { ...f.call.arguments, reason: "Changed intent" } })).rejects.toThrow("idempotency_conflict");
    await expect(f.authority.execute({ ...f.call, arguments: { ...f.call.arguments, idempotencyKey: "stale" } })).rejects.toThrow("reassignment_conflict");
  });

  it("stops active execution before transferring ownership", async () => {
    const f = await fixture("in_progress");
    const oldRun = randomUUID();
    await db.insert(heartbeatRuns).values({ id: oldRun, companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.targetId, runtimeMode: "native", status: "running", invocationSource: "assignment", triggerDetail: "system" });
    await db.update(issues).set({ executionRunId: oldRun, checkoutRunId: oldRun }).where(eq(issues.id, f.targetId));
    f.stopTaskForReassignment.mockImplementationOnce(async () => {
      expect((await f.target()).assigneeAgentId).toBe(f.agentId);
      await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, oldRun));
    });
    await f.authority.execute(f.call);
    expect(await f.target()).toMatchObject({ assigneeAgentId: f.nextId, status: "todo", executionRunId: null, checkoutRunId: null });
  });

  it("does not transfer ownership if stop fails or a new run races the stop", async () => {
    const f = await fixture();
    f.stopTaskForReassignment.mockRejectedValueOnce(new Error("stop failed"));
    await expect(f.authority.execute(f.call)).rejects.toThrow("stop failed");
    expect((await f.target()).assigneeAgentId).toBe(f.agentId);
    f.stopTaskForReassignment.mockImplementationOnce(async () => {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, status: "running", invocationSource: "assignment", triggerDetail: "system" });
      await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, f.targetId));
    });
    await expect(f.authority.execute(f.call)).rejects.toThrow("reassignment_conflict");
    expect(f.enqueueWakeup).not.toHaveBeenCalled();
  });

  it.each(["done", "cancelled", "in_review"])("rejects %s before interrupting work", async status => {
    const f = await fixture(status);
    await expect(f.authority.execute(f.call)).rejects.toThrow("state_denied");
    expect(f.stopTaskForReassignment).not.toHaveBeenCalled();
  });

  it("rejects conversations and the caller’s own task", async () => {
    const f = await fixture();
    await db.update(issues).set({ conversationAgentId: f.agentId, conversationUserId: "test-user", conversationState: "active", status: "in_progress" }).where(eq(issues.id, f.targetId));
    await expect(f.authority.execute(f.call)).rejects.toThrow("conversation_locked");
    await expect(f.authority.execute({ ...f.call, arguments: { ...f.call.arguments, taskId: f.issueId } })).rejects.toThrow("current_task");
    expect(f.stopTaskForReassignment).not.toHaveBeenCalled();
  });

  it.each(["planning", "ask"])("denies reassignment from %s mode", async workMode => {
    const f = await fixture();
    await db.update(issues).set({ workMode }).where(eq(issues.id, f.issueId));
    await expect(f.authority.execute(f.call)).rejects.toThrow("mode_denied");
  });

  it("denies foreign targets and unavailable assignees", async () => {
    const f = await fixture(), foreign = await fixture();
    await expect(f.authority.execute({ ...f.call, arguments: { ...f.call.arguments, taskId: foreign.targetId } })).rejects.toThrow("task_not_found");
    await expect(f.authority.execute({ ...f.call, arguments: { ...f.call.arguments, assigneeActorId: foreign.agentId } })).rejects.toThrow();
    await db.update(agents).set({ status: "pending_approval" }).where(eq(agents.id, f.nextId));
    await expect(f.authority.execute(f.call)).rejects.toThrow();
    expect(f.stopTaskForReassignment).not.toHaveBeenCalled();
  });
  it("rejects an ownership ABA race through the existing issue service", async () => {
    const f = await fixture();
    await issueService(db).update(f.targetId, { assigneeAgentId: f.nextId });
    await issueService(db).update(f.targetId, { assigneeAgentId: f.agentId });
    expect((await f.target()).statusVersion).toBe(2);
    await expect(f.authority.execute(f.call)).rejects.toThrow("reassignment_conflict");
    expect(f.stopTaskForReassignment).not.toHaveBeenCalled();
  });

  it("respects protected assignment policies instead of inheriting board authority", async () => {
    const f = await fixture();
    await db.update(agents).set({ permissions: { authorizationPolicy: { protectedAgent: { blockAssignment: true } } } }).where(eq(agents.id, f.nextId));
    await expect(f.authority.execute(f.call)).rejects.toThrow();
    expect((await f.target()).assigneeAgentId).toBe(f.agentId);
    expect(f.stopTaskForReassignment).not.toHaveBeenCalled();
  });

  it("rejects writes after the caller loses its run binding", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.runId));
    await expect(f.authority.execute(f.call)).rejects.toThrow("binding_not_authorized");
    expect((await f.target()).assigneeAgentId).toBe(f.agentId);
  });

});
