import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueTreeHoldMembers,
  issueTreeHolds,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueTreeControlService } from "../services/issue-tree-control.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue tree control service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueTreeControlService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-tree-control-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueTreeHoldMembers);
    await db.delete(issueTreeHolds);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("previews a subtree without changing issue statuses", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const rootIssueId = randomUUID();
    const runningChildId = randomUUID();
    const doneChildId = randomUUID();
    const cancelledChildId = randomUUID();

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "OtherCo",
        issuePrefix: `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: { issueId: runningChildId },
    });

    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        title: "Root",
        status: "todo",
        priority: "medium",
        createdAt: new Date("2026-04-21T10:00:00.000Z"),
      },
      {
        id: runningChildId,
        companyId,
        parentId: rootIssueId,
        title: "Running child",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        executionRunId: runId,
        createdAt: new Date("2026-04-21T10:01:00.000Z"),
      },
      {
        id: doneChildId,
        companyId,
        parentId: rootIssueId,
        title: "Done child",
        status: "done",
        priority: "medium",
        createdAt: new Date("2026-04-21T10:02:00.000Z"),
      },
      {
        id: cancelledChildId,
        companyId,
        parentId: rootIssueId,
        title: "Cancelled child",
        status: "cancelled",
        priority: "medium",
        createdAt: new Date("2026-04-21T10:03:00.000Z"),
      },
    ]);

    const svc = issueTreeControlService(db);
    const preview = await svc.preview(companyId, rootIssueId, { mode: "pause" });

    expect(preview.issues.map((issue) => [issue.id, issue.depth, issue.skipped, issue.skipReason])).toEqual([
      [rootIssueId, 0, false, null],
      [runningChildId, 1, false, null],
      [doneChildId, 1, true, "terminal_status"],
      [cancelledChildId, 1, true, "terminal_status"],
    ]);
    expect(preview.totals).toMatchObject({
      totalIssues: 4,
      affectedIssues: 2,
      skippedIssues: 2,
      activeRuns: 1,
      queuedRuns: 0,
      affectedAgents: 1,
    });
    expect(preview.countsByStatus).toMatchObject({ todo: 1, in_progress: 1, done: 1, cancelled: 1 });
    expect(preview.activeRuns).toEqual([
      expect.objectContaining({ id: runId, issueId: runningChildId, agentId, status: "running" }),
    ]);
    expect(preview.warnings.map((warning) => warning.code)).toContain("running_runs_present");

    const [runningChildAfterPreview] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, runningChildId));
    expect(runningChildAfterPreview.status).toBe("in_progress");

    await expect(svc.preview(otherCompanyId, rootIssueId, { mode: "pause" })).rejects.toMatchObject({
      status: 404,
    });
  });

  it("creates and releases normalized hold snapshots", async () => {
    const companyId = randomUUID();
    const rootIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: rootIssueId,
      companyId,
      title: "Root",
      status: "todo",
      priority: "medium",
    });

    const svc = issueTreeControlService(db);
    const created = await svc.createHold(companyId, rootIssueId, {
      mode: "pause",
      reason: "operator requested pause",
      actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
    });

    expect(created.hold.status).toBe("active");
    expect(created.hold.members).toHaveLength(1);
    expect(created.hold.members?.[0]).toMatchObject({
      issueId: rootIssueId,
      issueStatus: "todo",
      skipped: false,
    });

    const released = await svc.releaseHold(companyId, rootIssueId, created.hold.id, {
      reason: "operator resumed",
      actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
    });

    expect(released.status).toBe("released");
    expect(released.releaseReason).toBe("operator resumed");
    expect(released.members).toHaveLength(1);
  });

  it("cancels non-terminal issue statuses and restores from the cancel snapshot", async () => {
    const companyId = randomUUID();
    const rootIssueId = randomUUID();
    const runningChildId = randomUUID();
    const todoChildId = randomUUID();
    const doneChildId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        title: "Root",
        status: "done",
        priority: "medium",
        createdAt: new Date("2026-04-21T10:00:00.000Z"),
      },
      {
        id: runningChildId,
        companyId,
        parentId: rootIssueId,
        title: "Running child",
        status: "in_progress",
        priority: "medium",
        createdAt: new Date("2026-04-21T10:01:00.000Z"),
      },
      {
        id: todoChildId,
        companyId,
        parentId: rootIssueId,
        title: "Todo child",
        status: "todo",
        priority: "medium",
        createdAt: new Date("2026-04-21T10:02:00.000Z"),
      },
      {
        id: doneChildId,
        companyId,
        parentId: rootIssueId,
        title: "Done child",
        status: "done",
        priority: "medium",
        createdAt: new Date("2026-04-21T10:03:00.000Z"),
      },
    ]);

    const svc = issueTreeControlService(db);
    const cancel = await svc.createHold(companyId, rootIssueId, {
      mode: "cancel",
      reason: "bad plan",
      actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
    });
    expect(cancel.preview.issues.map((issue) => [issue.id, issue.skipped, issue.skipReason])).toEqual([
      [rootIssueId, true, "terminal_status"],
      [runningChildId, false, null],
      [todoChildId, false, null],
      [doneChildId, true, "terminal_status"],
    ]);

    const cancelled = await svc.cancelIssueStatusesForHold(companyId, rootIssueId, cancel.hold.id);
    expect(cancelled.updatedIssueIds.sort()).toEqual([runningChildId, todoChildId].sort());

    const afterCancel = await db
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(inArray(issues.id, [runningChildId, todoChildId, doneChildId]));
    expect(Object.fromEntries(afterCancel.map((issue) => [issue.id, issue.status]))).toMatchObject({
      [runningChildId]: "cancelled",
      [todoChildId]: "cancelled",
      [doneChildId]: "done",
    });

    await db
      .update(issues)
      .set({ status: "blocked", cancelledAt: null, updatedAt: new Date() })
      .where(eq(issues.id, todoChildId));

    const restorePreview = await svc.preview(companyId, rootIssueId, { mode: "restore" });
    expect(restorePreview.issues.map((issue) => [issue.id, issue.skipped, issue.skipReason])).toEqual([
      [rootIssueId, true, "not_cancelled"],
      [runningChildId, false, null],
      [todoChildId, true, "changed_after_cancel"],
      [doneChildId, true, "not_cancelled"],
    ]);
    expect(restorePreview.warnings.map((warning) => warning.code)).toContain("restore_conflicts_present");

    const restore = await svc.createHold(companyId, rootIssueId, {
      mode: "restore",
      reason: "resume useful work",
      actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
    });
    const restored = await svc.restoreIssueStatusesForHold(companyId, rootIssueId, restore.hold.id, {
      reason: "resume useful work",
      actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
    });
    expect(restored.updatedIssueIds).toEqual([runningChildId]);

    const afterRestore = await db
      .select({ id: issues.id, status: issues.status, checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(inArray(issues.id, [runningChildId, todoChildId, doneChildId]));
    expect(Object.fromEntries(afterRestore.map((issue) => [issue.id, issue.status]))).toMatchObject({
      [runningChildId]: "todo",
      [todoChildId]: "blocked",
      [doneChildId]: "done",
    });

    const holds = await db
      .select({ id: issueTreeHolds.id, mode: issueTreeHolds.mode, status: issueTreeHolds.status })
      .from(issueTreeHolds)
      .where(inArray(issueTreeHolds.id, [cancel.hold.id, restore.hold.id]));
    expect(Object.fromEntries(holds.map((hold) => [hold.mode, hold.status]))).toMatchObject({
      cancel: "released",
      restore: "released",
    });
  });

  it("blocks normal checkout but allows comment interaction checkout under a pause hold", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();
    const rootRunId = randomUUID();
    const childRunId = randomUUID();
    const forgedRunId = randomUUID();
    const rootWakeupRequestId = randomUUID();
    const childWakeupRequestId = randomUUID();
    const forgedWakeupRequestId = randomUUID();
    const rootCommentId = randomUUID();
    const childCommentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SecurityEngineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        title: "Paused root",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: childIssueId,
        companyId,
        parentId: rootIssueId,
        title: "Paused child",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(issueComments).values([
      {
        id: rootCommentId,
        companyId,
        issueId: rootIssueId,
        authorUserId: "board-user",
        body: "Please answer this root issue question.",
      },
      {
        id: childCommentId,
        companyId,
        issueId: childIssueId,
        authorUserId: "board-user",
        body: "Please answer this child issue question.",
      },
    ]);
    await db.insert(agentWakeupRequests).values([
      {
        id: rootWakeupRequestId,
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId: rootIssueId, commentId: rootCommentId },
        status: "queued",
        requestedByActorType: "user",
        requestedByActorId: "board-user",
        runId: rootRunId,
      },
      {
        id: forgedWakeupRequestId,
        companyId,
        agentId,
        source: "on_demand",
        triggerDetail: "manual",
        reason: "issue_commented",
        payload: { issueId: childIssueId, commentId: childCommentId },
        status: "queued",
        requestedByActorType: "agent",
        requestedByActorId: agentId,
        runId: forgedRunId,
      },
      {
        id: childWakeupRequestId,
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId: childIssueId, commentId: childCommentId },
        status: "queued",
        requestedByActorType: "user",
        requestedByActorId: "board-user",
        runId: childRunId,
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: rootRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: rootWakeupRequestId,
        contextSnapshot: {
          issueId: rootIssueId,
          wakeReason: "issue_commented",
          commentId: rootCommentId,
          wakeCommentId: rootCommentId,
          source: "issue.comment",
        },
      },
      {
        id: forgedRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "queued",
        wakeupRequestId: forgedWakeupRequestId,
        contextSnapshot: {
          issueId: childIssueId,
          wakeReason: "issue_commented",
          commentId: childCommentId,
          wakeCommentId: childCommentId,
        },
      },
      {
        id: childRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: childWakeupRequestId,
        contextSnapshot: {
          issueId: childIssueId,
          wakeReason: "issue_commented",
          commentId: childCommentId,
          wakeCommentId: childCommentId,
          source: "issue.comment",
        },
      },
    ]);

    const treeSvc = issueTreeControlService(db);
    await treeSvc.createHold(companyId, rootIssueId, {
      mode: "pause",
      reason: "operator requested pause",
      actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
    });

    const issueSvc = issueService(db);
    await expect(issueSvc.checkout(childIssueId, agentId, ["todo"], randomUUID())).rejects.toMatchObject({
      status: 409,
      details: expect.objectContaining({
        rootIssueId,
        mode: "pause",
      }),
    });
    await expect(issueSvc.checkout(childIssueId, agentId, ["todo"], forgedRunId)).rejects.toMatchObject({
      status: 409,
      details: expect.objectContaining({
        rootIssueId,
        mode: "pause",
      }),
    });

    const checkedOutChild = await issueSvc.checkout(childIssueId, agentId, ["todo"], childRunId);
    expect(checkedOutChild.status).toBe("in_progress");
    expect(checkedOutChild.checkoutRunId).toBe(childRunId);

    const checkedOutRoot = await issueSvc.checkout(rootIssueId, agentId, ["todo"], rootRunId);
    expect(checkedOutRoot.status).toBe("in_progress");
    expect(checkedOutRoot.checkoutRunId).toBe(rootRunId);

    await db.update(issues).set({
      status: "todo",
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      updatedAt: new Date(),
    }).where(eq(issues.id, rootIssueId));
    await db.update(issueTreeHolds).set({
      status: "released",
      releasedAt: new Date(),
      releasedByActorType: "user",
      releasedByUserId: "board-user",
      releaseReason: "switch to full pause",
      updatedAt: new Date(),
    }).where(eq(issueTreeHolds.rootIssueId, rootIssueId));
    await treeSvc.createHold(companyId, rootIssueId, {
      mode: "pause",
      reason: "full pause",
      releasePolicy: { strategy: "manual", note: "full_pause" },
      actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
    });

    const checkedOutLegacyFullPauseRoot = await issueSvc.checkout(rootIssueId, agentId, ["todo"], rootRunId);
    expect(checkedOutLegacyFullPauseRoot.status).toBe("in_progress");
    expect(checkedOutLegacyFullPauseRoot.checkoutRunId).toBe(rootRunId);
  });
});
