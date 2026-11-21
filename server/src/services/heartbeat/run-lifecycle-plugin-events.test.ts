import type { Db, heartbeatRuns } from "@paperclipai/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUserRedactionOptions } from "../../log-redaction.js";
import { publishPluginDomainEvent } from "../activity-log.js";
import { createHeartbeatRunState } from "./run-state.js";
import { createHeartbeatRunPreparation } from "./run-preparation.js";
import { createHeartbeatLifecycle, type HeartbeatLifecycleDependencies } from "./run-lifecycle.js";

vi.mock("../activity-log.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../activity-log.js")>(),
  publishPluginDomainEvent: vi.fn(),
}));

type Run = typeof heartbeatRuns.$inferSelect;

function dependencies(db: Db) {
  const state = createHeartbeatRunState(db);
  return {
    ...state,
    ...createHeartbeatRunPreparation(db),
    issuesSvc: {
      addComment: vi.fn<HeartbeatLifecycleDependencies["issuesSvc"]["addComment"]>(),
      listReviewAttention: vi.fn<HeartbeatLifecycleDependencies["issuesSvc"]["listReviewAttention"]>(),
    },
    recovery: { escalateStrandedAssignedIssue: vi.fn<HeartbeatLifecycleDependencies["recovery"]["escalateStrandedAssignedIssue"]>() },
    companySkills: { completeTestRunForIssue: vi.fn<HeartbeatLifecycleDependencies["companySkills"]["completeTestRunForIssue"]>() },
    budgets: { getInvocationBlock: vi.fn(async () => null) },
    treeControlSvc: { getActivePauseHoldGate: vi.fn(async () => null) },
    enqueueWakeup: vi.fn<HeartbeatLifecycleDependencies["enqueueWakeup"]>(),
    getCurrentUserRedactionOptions: vi.fn(async (): Promise<CurrentUserRedactionOptions> => ({})),
    getAgentInvokability: vi.fn<HeartbeatLifecycleDependencies["getAgentInvokability"]>(async () => ({ invokable: true })),
    emitTerminalAgentTaskRun: vi.fn<HeartbeatLifecycleDependencies["emitTerminalAgentTaskRun"]>(),
    budgetHooks: {},
  } satisfies HeartbeatLifecycleDependencies;
}

function commentDb(rows: unknown[] | Error) {
  const limit = rows instanceof Error ? vi.fn().mockRejectedValue(rows) : vi.fn().mockResolvedValue(rows);
  const query = { from: () => query, where: () => query, limit };
  const select = vi.fn(() => query);
  return { db: { select } as unknown as Db, select };
}

function heldCommentDb() {
  let release!: (rows: unknown[]) => void;
  const limit = vi.fn(() => new Promise<unknown[]>((resolve) => { release = resolve; }));
  const query = { from: () => query, where: () => query, limit };
  const db = { select: vi.fn(() => query) } as unknown as Db;
  return { db, limit, release: (rows: unknown[]) => release(rows) };
}

function flushAsyncWork() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function publishedEventTypes() {
  return vi.mocked(publishPluginDomainEvent).mock.calls.map(([event]) => event.eventType);
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1", companyId: "company-1", agentId: "agent-1", status: "running",
    invocationSource: "automation", triggerDetail: "system", error: null, errorCode: null,
    nativeIssueId: null, startedAt: new Date(0), finishedAt: null,
    contextSnapshot: { issueId: "issue-1", source: "issue.comment", wakeReason: "issue_commented", wakeCommentIds: ["comment-1"] },
    ...overrides,
  } as Run;
}

function publishedPayload(call = 0) {
  return vi.mocked(publishPluginDomainEvent).mock.calls[call]![0].payload as Record<string, unknown>;
}

describe("run lifecycle plugin events", () => {
  beforeEach(() => {
    vi.mocked(publishPluginDomainEvent).mockClear();
  });

  it("adds the verified source comment to agent.run.started", async () => {
    const { db } = commentDb([{ id: "comment-1", authorUserId: "user-1", authorAgentId: null }]);
    const lifecycle = createHeartbeatLifecycle(db, dependencies(db));
    await lifecycle.publishRunLifecyclePluginEvent(run());
    expect(publishPluginDomainEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "agent.run.started", entityId: "run-1", companyId: "company-1",
    }));
    expect(publishedPayload()).toMatchObject({ runId: "run-1", issueId: "issue-1", sourceCommentId: "comment-1" });
  });

  it("publishes null when the comment is not found", async () => {
    const { db } = commentDb([]);
    const lifecycle = createHeartbeatLifecycle(db, dependencies(db));
    await lifecycle.publishRunLifecyclePluginEvent(run());
    expect(publishedPayload()).toMatchObject({ sourceCommentId: null });
  });

  it("publishes null when the comment read fails", async () => {
    const { db } = commentDb(new Error("database unavailable"));
    const lifecycle = createHeartbeatLifecycle(db, dependencies(db));
    await lifecycle.publishRunLifecyclePluginEvent(run());
    expect(publishPluginDomainEvent).toHaveBeenCalledOnce();
    expect(publishedPayload()).toMatchObject({ sourceCommentId: null });
  });

  it.each(["succeeded", "failed", "timed_out", "cancelled"])("publishes %s without a database read", async (status) => {
    const { db, select } = commentDb([{ id: "comment-1", authorUserId: "user-1", authorAgentId: null }]);
    const lifecycle = createHeartbeatLifecycle(db, dependencies(db));
    await lifecycle.publishRunLifecyclePluginEvent(run({ status, finishedAt: new Date(1) }));
    expect(select).not.toHaveBeenCalled();
    expect(publishedPayload()).toMatchObject({ status, sourceCommentId: null });
  });

  describe("ordering per run", () => {
    const comment = [{ id: "comment-1", authorUserId: "user-1", authorAgentId: null }];
    const cancelled = { status: "cancelled", finishedAt: new Date(1) } satisfies Partial<Run>;

    it("does not let a cancel from another service instance overtake a pending started event", async () => {
      const held = heldCommentDb();
      const claimLifecycle = createHeartbeatLifecycle(held.db, dependencies(held.db));
      const { db: otherDb } = commentDb(comment);
      const cancelLifecycle = createHeartbeatLifecycle(otherDb, dependencies(otherDb));

      const started = claimLifecycle.publishRunLifecyclePluginEvent(run());
      await flushAsyncWork();
      expect(held.limit).toHaveBeenCalledOnce();
      const cancel = cancelLifecycle.publishRunLifecyclePluginEvent(run(cancelled));
      await flushAsyncWork();
      expect(publishPluginDomainEvent).not.toHaveBeenCalled();

      held.release(comment);
      await Promise.all([started, cancel]);
      expect(publishedEventTypes()).toEqual(["agent.run.started", "agent.run.cancelled"]);
      expect(publishedPayload(0)).toMatchObject({ status: "running", sourceCommentId: "comment-1" });
    });

    it("queues run-dispatch effect events behind a pending started event", async () => {
      const held = heldCommentDb();
      const lifecycle = createHeartbeatLifecycle(held.db, dependencies(held.db));

      const started = lifecycle.publishRunLifecyclePluginEvent(run());
      await flushAsyncWork();
      lifecycle.publishRunLifecyclePluginEventData({
        companyId: "company-1", runId: "run-1", agentId: "agent-1", status: "cancelled",
        invocationSource: "automation", triggerDetail: "system", error: null, errorCode: null,
        issueId: "issue-1", startedAt: new Date(0), finishedAt: new Date(1),
      });
      await flushAsyncWork();
      expect(publishPluginDomainEvent).not.toHaveBeenCalled();

      held.release(comment);
      await started;
      await flushAsyncWork();
      expect(publishedEventTypes()).toEqual(["agent.run.started", "agent.run.cancelled"]);
    });

    it("does not hold events for other runs", async () => {
      const held = heldCommentDb();
      const lifecycle = createHeartbeatLifecycle(held.db, dependencies(held.db));

      const started = lifecycle.publishRunLifecyclePluginEvent(run());
      await flushAsyncWork();
      void lifecycle.publishRunLifecyclePluginEvent(run({ id: "run-2", ...cancelled }));
      expect(publishedEventTypes()).toEqual(["agent.run.cancelled"]);

      held.release(comment);
      await started;
    });

    it("publishes synchronously again once the pending event settles", async () => {
      const held = heldCommentDb();
      const lifecycle = createHeartbeatLifecycle(held.db, dependencies(held.db));

      const started = lifecycle.publishRunLifecyclePluginEvent(run());
      await flushAsyncWork();
      held.release(comment);
      await started;
      await flushAsyncWork();
      vi.mocked(publishPluginDomainEvent).mockClear();

      void lifecycle.publishRunLifecyclePluginEvent(run(cancelled));
      expect(publishedEventTypes()).toEqual(["agent.run.cancelled"]);
    });
  });
});
