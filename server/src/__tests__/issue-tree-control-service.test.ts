import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
import { acquireIssueDeliveryLock } from "../services/delivery.js";

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

  it("reads legacy automatic-release rows as truthful manual holds", async () => {
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
      title: "Legacy hold root",
      status: "todo",
      priority: "medium",
    });
    const [legacy] = await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId,
      mode: "pause",
      status: "active",
      releasePolicy: { strategy: "after_active_runs_finish", note: "legacy" },
      createdByActorType: "system",
    }).returning();

    const svc = issueTreeControlService(db);
    await expect(svc.getHold(companyId, legacy.id)).resolves.toMatchObject({
      releasePolicy: { strategy: "manual", note: "legacy" },
    });
    await expect(svc.getActivePauseHoldGate(companyId, rootIssueId)).resolves.toMatchObject({
      releasePolicy: { strategy: "manual", note: "legacy" },
    });
  });

  it("does not activate a pause hold until an in-flight delivery mutation releases its issue lock", async () => {
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
      title: "Serialized root",
      status: "in_progress",
      priority: "medium",
    });

    let releaseMutation!: () => void;
    let mutationLocked!: () => void;
    const release = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const locked = new Promise<void>((resolve) => { mutationLocked = resolve; });
    const mutation = db.transaction(async (rawTx) => {
      await acquireIssueDeliveryLock(rawTx as unknown as typeof db, companyId, rootIssueId);
      mutationLocked();
      await release;
    });
    await locked;

    let holdSettled = false;
    const hold = issueTreeControlService(db).createHold(companyId, rootIssueId, {
      mode: "pause",
      reason: "serialize with delivery",
      actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
    }).then((result) => {
      holdSettled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(holdSettled).toBe(false);

    releaseMutation();
    await mutation;
    await expect(hold).resolves.toMatchObject({
      hold: { status: "active", rootIssueId },
    });
  });

  it("rejects a locked tree when its boundary differs from the authorized preview", async () => {
    const companyId = randomUUID();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values([
      { id: rootIssueId, companyId, title: "Root", status: "todo", priority: "medium" },
      { id: childIssueId, companyId, parentId: rootIssueId, title: "Late child", status: "todo", priority: "medium" },
    ]);

    await expect(issueTreeControlService(db).createHold(companyId, rootIssueId, {
      mode: "cancel",
      expectedIssueIds: [rootIssueId],
      actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
    })).rejects.toMatchObject({
      status: 409,
      details: expect.objectContaining({ code: "issue_tree_boundary_conflict" }),
    });
    await expect(db.select().from(issueTreeHolds)).resolves.toHaveLength(0);
    await expect(db.select({ status: issues.status }).from(issues).where(eq(issues.id, childIssueId)))
      .resolves.toEqual([{ status: "todo" }]);
  });

  it("reauthorizes only after the subtree boundary is locked", async () => {
    const companyId = randomUUID();
    const rootIssueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Tree authorization lock company",
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
    const authorization = vi.fn().mockRejectedValue(new Error("access revoked"));

    await expect(issueTreeControlService(db).createHold(companyId, rootIssueId, {
      mode: "pause",
      actor: { actorType: "user", actorId: "user-1", userId: "user-1" },
      expectedIssueIds: [rootIssueId],
      authorizeLockedBoundary: authorization,
    })).rejects.toThrow("access revoked");

    expect(authorization).toHaveBeenCalledTimes(1);
    expect(await db.select().from(issueTreeHolds)).toHaveLength(0);
  });

  it("commits cancel hold and statuses atomically and rejects a stale queued mutation", async () => {
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
      title: "Atomic cancel root",
      status: "todo",
      priority: "medium",
    });

    let releaseDelivery!: () => void;
    let deliveryLocked!: () => void;
    const release = new Promise<void>((resolve) => { releaseDelivery = resolve; });
    const locked = new Promise<void>((resolve) => { deliveryLocked = resolve; });
    const deliveryMutation = db.transaction(async (rawTx) => {
      await acquireIssueDeliveryLock(rawTx as unknown as typeof db, companyId, rootIssueId);
      deliveryLocked();
      await release;
    });
    await locked;

    const treeSvc = issueTreeControlService(db);
    const cancel = treeSvc.createHold(companyId, rootIssueId, {
      mode: "cancel",
      actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The transaction is blocked after taking the issue row lock. Other
    // sessions still see the complete old state, never an active hold paired
    // with an uncancelled issue.
    await expect(db.select({ status: issues.status }).from(issues).where(eq(issues.id, rootIssueId)))
      .resolves.toEqual([{ status: "todo" }]);
    await expect(db.select().from(issueTreeHolds)).resolves.toHaveLength(0);

    let staleUpdateSettled = false;
    const staleUpdate = issueService(db).update(rootIssueId, { title: "stale title" })
      .then((value) => {
        staleUpdateSettled = true;
        return value;
      }, (error) => {
        staleUpdateSettled = true;
        throw error;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(staleUpdateSettled).toBe(false);

    releaseDelivery();
    await deliveryMutation;
    const cancelled = await cancel;
    expect(cancelled.statusUpdate?.updatedIssueIds).toEqual([rootIssueId]);
    await expect(staleUpdate).rejects.toMatchObject({
      status: 409,
      details: expect.objectContaining({ code: "issue_tree_cancelled", rootIssueId }),
    });
    await expect(db.select({ status: issues.status, title: issues.title }).from(issues).where(eq(issues.id, rootIssueId)))
      .resolves.toEqual([{ status: "cancelled", title: "Atomic cancel root" }]);
    await expect(treeSvc.getActiveCancelHoldGate(companyId, rootIssueId)).resolves.toMatchObject({
      holdId: cancelled.hold.id,
      rootIssueId,
      mode: "cancel",
    });
    await expect(treeSvc.releaseHold(companyId, rootIssueId, cancelled.hold.id, {
      reason: "generic release must not bypass restore",
      actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
    })).rejects.toMatchObject({
      status: 409,
      details: expect.objectContaining({ code: "issue_tree_restore_required" }),
    });
    await expect(issueService(db).createChild(rootIssueId, {
      title: "forbidden child",
      priority: "medium",
    })).rejects.toMatchObject({
      status: 409,
      details: expect.objectContaining({ code: "issue_tree_cancelled" }),
    });
  });

  it("allows only one concurrent release to win", async () => {
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
      title: "Release once",
      status: "todo",
      priority: "medium",
    });
    const svc = issueTreeControlService(db);
    const created = await svc.createHold(companyId, rootIssueId, {
      mode: "pause",
      actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
    });
    const releases = await Promise.allSettled([
      svc.releaseHold(companyId, rootIssueId, created.hold.id, {
        reason: "first",
        actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
      }),
      svc.releaseHold(companyId, rootIssueId, created.hold.id, {
        reason: "second",
        actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
      }),
    ]);
    expect(releases.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(releases.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = releases.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { status: 409 } });
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

    const cancelled = cancel.statusUpdate!;
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
    const restored = restore.statusUpdate!;
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

  it("rejects nested cancel holds in both directions before either can create conflicting restore authority", async () => {
    const companyId = randomUUID();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Cancel overlap company",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values([
      { id: rootIssueId, companyId, title: "Root", status: "todo", priority: "medium" },
      {
        id: childIssueId,
        companyId,
        parentId: rootIssueId,
        title: "Child",
        status: "todo",
        priority: "medium",
      },
    ]);

    const svc = issueTreeControlService(db);
    const actor = { actorType: "user" as const, actorId: "board-user", userId: "board-user" };

    const ancestorCancel = await svc.createHold(companyId, rootIssueId, { mode: "cancel", actor });
    await expect(svc.createHold(companyId, childIssueId, { mode: "cancel", actor })).rejects.toMatchObject({
      status: 409,
      details: expect.objectContaining({
        code: "issue_tree_cancel_hold_overlap",
        activeHoldId: ancestorCancel.hold.id,
        activeRootIssueId: rootIssueId,
        requestedRootIssueId: childIssueId,
        operation: "cancel",
      }),
    });
    await svc.createHold(companyId, rootIssueId, { mode: "restore", actor });
    await expect(db.select({ status: issues.status }).from(issues).where(eq(issues.id, childIssueId)))
      .resolves.toEqual([{ status: "todo" }]);

    const childCancel = await svc.createHold(companyId, childIssueId, { mode: "cancel", actor });
    await expect(svc.createHold(companyId, rootIssueId, { mode: "cancel", actor })).rejects.toMatchObject({
      status: 409,
      details: expect.objectContaining({
        code: "issue_tree_cancel_hold_overlap",
        activeHoldId: childCancel.hold.id,
        activeRootIssueId: childIssueId,
        requestedRootIssueId: rootIssueId,
        operation: "cancel",
      }),
    });
    await svc.createHold(companyId, childIssueId, { mode: "restore", actor });
    await expect(db.select({ status: issues.status }).from(issues).where(eq(issues.id, childIssueId)))
      .resolves.toEqual([{ status: "todo" }]);
  });

  it("fails restore securely when a historical overlapping cancel hold still covers the tree", async () => {
    const companyId = randomUUID();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Legacy cancel overlap company",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values([
      { id: rootIssueId, companyId, title: "Root", status: "todo", priority: "medium" },
      {
        id: childIssueId,
        companyId,
        parentId: rootIssueId,
        title: "Child",
        status: "todo",
        priority: "medium",
      },
    ]);

    const svc = issueTreeControlService(db);
    const actor = { actorType: "user" as const, actorId: "board-user", userId: "board-user" };
    const ancestorCancel = await svc.createHold(companyId, rootIssueId, { mode: "cancel", actor });
    const [legacyNestedHold] = await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId: childIssueId,
      mode: "cancel",
      status: "active",
      reason: "legacy nested cancel",
      releasePolicy: { strategy: "manual" },
      createdByActorType: "system",
    }).returning();

    await expect(svc.createHold(companyId, rootIssueId, { mode: "restore", actor })).rejects.toMatchObject({
      status: 409,
      details: expect.objectContaining({
        code: "issue_tree_cancel_hold_overlap",
        activeHoldId: legacyNestedHold.id,
        activeRootIssueId: childIssueId,
        operation: "restore",
      }),
    });
    await expect(db.select({ status: issues.status }).from(issues).where(eq(issues.id, childIssueId)))
      .resolves.toEqual([{ status: "cancelled" }]);
    await expect(db.select({ id: issueTreeHolds.id, status: issueTreeHolds.status })
      .from(issueTreeHolds)
      .where(inArray(issueTreeHolds.id, [ancestorCancel.hold.id, legacyNestedHold.id])))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: ancestorCancel.hold.id, status: "active" }),
        expect.objectContaining({ id: legacyNestedHold.id, status: "active" }),
      ]));
  });

  it("walks pause-hold ancestry beyond 15 levels for checkout and interaction waives", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePath = Array.from({ length: 17 }, () => randomUUID());
    const rootIssueId = issuePath[0];
    const deepDescendantIssueId = issuePath.at(-1)!;
    const rootRunId = randomUUID();
    const deepDescendantRunId = randomUUID();
    const forgedRunId = randomUUID();
    const rootWakeupRequestId = randomUUID();
    const deepDescendantWakeupRequestId = randomUUID();
    const forgedWakeupRequestId = randomUUID();
    const rootCommentId = randomUUID();
    const deepDescendantCommentId = randomUUID();

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
    await db.insert(issues).values(
      issuePath.map((issueId, index) => ({
        id: issueId,
        companyId,
        parentId: index > 0 ? issuePath[index - 1] : null,
        title: `Issue ${index}`,
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      })),
    );
    await db.insert(issueComments).values([
      {
        id: rootCommentId,
        companyId,
        issueId: rootIssueId,
        authorUserId: "board-user",
        body: "Please answer this root issue question.",
      },
      {
        id: deepDescendantCommentId,
        companyId,
        issueId: deepDescendantIssueId,
        authorUserId: "board-user",
        body: "Please answer this deep descendant issue question.",
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
        payload: { issueId: deepDescendantIssueId, commentId: deepDescendantCommentId },
        status: "queued",
        requestedByActorType: "agent",
        requestedByActorId: agentId,
        runId: forgedRunId,
      },
      {
        id: deepDescendantWakeupRequestId,
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId: deepDescendantIssueId, commentId: deepDescendantCommentId },
        status: "queued",
        requestedByActorType: "user",
        requestedByActorId: "board-user",
        runId: deepDescendantRunId,
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
          issueId: deepDescendantIssueId,
          wakeReason: "issue_commented",
          commentId: deepDescendantCommentId,
          wakeCommentId: deepDescendantCommentId,
        },
      },
      {
        id: deepDescendantRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: deepDescendantWakeupRequestId,
        contextSnapshot: {
          issueId: deepDescendantIssueId,
          wakeReason: "issue_commented",
          commentId: deepDescendantCommentId,
          wakeCommentId: deepDescendantCommentId,
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
    const deepDescendantGate = await treeSvc.getActivePauseHoldGate(companyId, deepDescendantIssueId);
    expect(deepDescendantGate).toMatchObject({
      holdId: expect.any(String),
      rootIssueId,
      issueId: deepDescendantIssueId,
      isRoot: false,
      mode: "pause",
    });

    const issueSvc = issueService(db);
    await expect(
      issueSvc.checkout(deepDescendantIssueId, agentId, ["todo"], randomUUID()),
    ).rejects.toMatchObject({
      status: 409,
      details: expect.objectContaining({
        rootIssueId,
        mode: "pause",
      }),
    });
    await expect(
      issueSvc.checkout(deepDescendantIssueId, agentId, ["todo"], forgedRunId),
    ).rejects.toMatchObject({
      status: 409,
      details: expect.objectContaining({
        rootIssueId,
        mode: "pause",
      }),
    });

    const checkedOutChild = await issueSvc.checkout(deepDescendantIssueId, agentId, ["todo"], deepDescendantRunId);
    expect(checkedOutChild.status).toBe("in_progress");
    expect(checkedOutChild.checkoutRunId).toBe(deepDescendantRunId);

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

  it("resumes subtree pauses by releasing matching pause holds", async () => {
    const companyId = randomUUID();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();
    const nonSubtreeIssueId = randomUUID();

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
        status: "todo",
        priority: "medium",
      },
      {
        id: childIssueId,
        companyId,
        parentId: rootIssueId,
        title: "Child",
        status: "todo",
        priority: "medium",
      },
      {
        id: nonSubtreeIssueId,
        companyId,
        title: "Unrelated",
        status: "todo",
        priority: "medium",
      },
    ]);

    const treeSvc = issueTreeControlService(db);
    const subtreePause = await treeSvc.createHold(companyId, childIssueId, {
      mode: "pause",
      reason: "pause child only",
      actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
    });
    const nonSubtreePause = await treeSvc.createHold(companyId, nonSubtreeIssueId, {
      mode: "pause",
      reason: "pause unrelated issue",
      actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
    });

    const resumed = await treeSvc.createHold(companyId, rootIssueId, {
      mode: "resume",
      reason: "resume subtree",
      actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
    });

    expect(resumed.hold.mode).toBe("resume");
    expect(resumed.hold.status).toBe("released");
    expect(resumed.resumedPauseHoldIds).toEqual([subtreePause.hold.id]);

    const rows = await db
      .select({ id: issueTreeHolds.id, status: issueTreeHolds.status, releaseMetadata: issueTreeHolds.releaseMetadata })
      .from(issueTreeHolds)
      .where(eq(issueTreeHolds.companyId, companyId));
    const byId = new Map(rows.map((row) => [row.id, row] as const));
    expect(byId.get(subtreePause.hold.id)?.status).toBe("released");
    expect(byId.get(nonSubtreePause.hold.id)?.status).toBe("active");
    expect(byId.get(resumed.hold.id)?.status).toBe("released");

    const releaseMetadata = byId.get(subtreePause.hold.id)?.releaseMetadata as
      | Record<string, unknown>
      | null;
    expect(releaseMetadata).toMatchObject({
      resumedByResumeHoldId: resumed.hold.id,
      resumeHoldMode: "tree_resume",
      resumedPauseHoldId: subtreePause.hold.id,
    });
    expect((byId.get(resumed.hold.id)?.releaseMetadata as Record<string, unknown> | null)).toMatchObject({
      resumedPauseHoldIds: [subtreePause.hold.id],
      resumeMode: "subtree",
    });
  });
});
