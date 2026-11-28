import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { agents, createDb, issueRelations, issues } from "@paperclipai/db";
import { attentionService } from "../services/attention.js";
import { ROUTABLE_BLOCKED_ROLLOUT_AT } from "../services/routable-blocked.js";
import {
  createAttentionServiceHarness,
  describeAttentionEmbeddedPostgres,
} from "./helpers/attention-service-harness.js";

describeAttentionEmbeddedPostgres("attention service: terminal blocker cards", () => {
  const h = createAttentionServiceHarness();
  let db!: ReturnType<typeof createDb>;
  beforeAll(() => { db = h.db; });
  const { seedCompany, insertIssue, pendingAgentExecutionState } = h;

  async function insertPausedAgent(companyId: string) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: "Paused Owner",
      role: "engineer",
      status: "paused",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  it("does not raise a board card for work routed to an invokable agent unblock owner", async () => {
    const { companyId, workerId } = await seedCompany("ATG");
    const waitingId = await insertIssue({
      companyId,
      identifier: "ATG-1",
      title: "Waiting on an outside reply",
      status: "blocked",
      assigneeAgentId: workerId,
      unblockDescriptor: { owner: { agentId: workerId }, action: "Resume when the outside reply arrives." },
      blockedTransitionAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1),
      blockedOwnerNotifiedAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 2),
    });
    const dependantId = await insertIssue({ companyId, identifier: "ATG-2", title: "Dependant", status: "blocked" });
    await db.insert(issueRelations).values({ companyId, issueId: waitingId, relatedIssueId: dependantId, type: "blocks" });

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });

    expect(feed.items.filter((item) => item.sourceKind === "blocker_attention")).toEqual([]);
  });

  it("explains a dead unblock path with its cause, owner and unblock step", async () => {
    const { companyId } = await seedCompany("ATK");
    const pausedId = await insertPausedAgent(companyId);
    const waitingId = await insertIssue({
      companyId,
      identifier: "ATK-1",
      title: "Owner went away",
      status: "blocked",
      assigneeAgentId: pausedId,
      unblockDescriptor: { owner: { agentId: pausedId }, action: "Resume when the outside reply arrives" },
      blockedTransitionAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1),
      blockedOwnerNotifiedAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 2),
    });
    const dependantId = await insertIssue({ companyId, identifier: "ATK-2", title: "Dependant", status: "blocked" });
    await db.insert(issueRelations).values({ companyId, issueId: waitingId, relatedIssueId: dependantId, type: "blocks" });

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    const rows = feed.items.filter((item) => item.sourceKind === "blocker_attention");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subject: { id: waitingId },
      whyNow: "Blocked with no open blocker, pending request, or invokable unblock owner. "
        + "Unblock step (Paused Owner (paused)): Resume when the outside reply arrives. Blocks 1 task.",
    });
    expect(rows[0]?.decisionVerbs.find((verb) => verb.id === "unblock")?.description)
      .toBe("Resume when the outside reply arrives");
  });

  it("names an invokable unblock owner that was never sent the request", async () => {
    const { companyId, workerId } = await seedCompany("ATU");
    const waitingId = await insertIssue({
      companyId,
      identifier: "ATU-1",
      title: "Owner not yet told",
      status: "blocked",
      assigneeAgentId: workerId,
      unblockDescriptor: { owner: { agentId: workerId }, action: "Resume when the outside reply arrives" },
    });
    const dependantId = await insertIssue({ companyId, identifier: "ATU-2", title: "Dependant", status: "blocked" });
    await db.insert(issueRelations).values({ companyId, issueId: waitingId, relatedIssueId: dependantId, type: "blocks" });

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    const row = feed.items.find((item) => item.dedupKey === `blocker:${waitingId}`);

    expect(row?.whyNow).toBe(
      "Blocked; its unblock owner Worker has not been sent the request. "
        + "Unblock step (Worker): Resume when the outside reply arrives. Blocks 1 task.",
    );
  });

  it("counts the union of blocked parents and explicitly blocked work", async () => {
    const { companyId, workerId } = await seedCompany("ATM");
    const parentId = await insertIssue({ companyId, identifier: "ATM-1", title: "Blocked parent", status: "blocked" });
    const leafId = await insertIssue({
      companyId,
      identifier: "ATM-2",
      title: "Stalled review leaf",
      status: "in_review",
      parentId,
      assigneeAgentId: workerId,
    });
    const todoId = await insertIssue({ companyId, identifier: "ATM-3", title: "Explicitly blocked follow-up", status: "todo" });
    await db.insert(issueRelations).values({ companyId, issueId: leafId, relatedIssueId: todoId, type: "blocks" });

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    const row = feed.items.find((item) => item.dedupKey === `blocker:${leafId}`);

    expect(row?.detail).toMatchObject({ kind: "blocker", blockedTaskCount: 2 });
    expect(row?.whyNow).toContain("Blocks 2 tasks.");
  });

  it("names a saved future monitor instead of denying it", async () => {
    const { companyId, workerId } = await seedCompany("ATO");
    const parentId = await insertIssue({ companyId, identifier: "ATO-1", title: "Blocked parent", status: "blocked" });
    const leafId = await insertIssue({
      companyId,
      identifier: "ATO-2",
      title: "Monitored review leaf",
      status: "in_review",
      parentId,
      assigneeAgentId: workerId,
    });
    const dueAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db.update(issues).set({ monitorNextCheckAt: dueAt }).where(eq(issues.id, leafId));

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    const row = feed.items.find((item) => item.dedupKey === `blocker:${leafId}`);

    // Blocker attention still surfaces this leaf here (monitor liveness is
    // upstream #10398). The card must not claim the monitor is absent.
    expect(row?.whyNow).not.toContain("scheduled monitor");
    expect(row?.whyNow).toContain(`its monitor is next due ${dueAt.toISOString()}`);
  });

  it("does not deny a saved agent review participant on a stalled review", async () => {
    const { companyId, workerId, reviewerId } = await seedCompany("ATP");
    const parentId = await insertIssue({ companyId, identifier: "ATP-1", title: "Blocked parent", status: "blocked" });
    const leafId = await insertIssue({
      companyId,
      identifier: "ATP-2",
      title: "Review with a saved agent participant",
      status: "in_review",
      parentId,
      assigneeAgentId: workerId,
      executionState: pendingAgentExecutionState(reviewerId),
    });

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    const row = feed.items.find((item) => item.dedupKey === `blocker:${leafId}`);

    expect(row?.whyNow).toContain("In review with no active run or scheduled monitor.");
    expect(row?.whyNow).not.toContain("no reviewer");
  });

  it("shows no card, title or unblock step to a viewer who cannot read the terminal blocker", async () => {
    const { companyId } = await seedCompany("ATH");
    const pausedId = await insertPausedAgent(companyId);
    const privateId = randomUUID();
    await insertIssue({
      id: privateId,
      companyId,
      identifier: "ATH-1",
      title: "Confidential blocker",
      status: "blocked",
      assigneeAgentId: pausedId,
      unblockDescriptor: { owner: { agentId: pausedId }, action: "Confidential unblock step" },
      blockedTransitionAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1),
      blockedOwnerNotifiedAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 2),
      visibility: "private",
      privacyRootIssueId: privateId,
      responsibleUserId: "private-owner",
    });
    const visibleId = await insertIssue({ companyId, identifier: "ATH-2", title: "Visible dependant", status: "blocked" });
    await db.insert(issueRelations).values({ companyId, issueId: privateId, relatedIssueId: visibleId, type: "blocks" });

    const boardFeed = await attentionService(db).list(companyId, { userId: "board-user" });
    expect(boardFeed.items.find((item) => item.dedupKey === `blocker:${privateId}`)?.whyNow)
      .toContain("Confidential unblock step");

    const actor = {
      type: "board" as const,
      source: "session" as const,
      userId: "non-member",
      companyIds: [companyId],
      isInstanceAdmin: false,
    };
    const feed = await attentionService(db).list(companyId, { userId: actor.userId, actor });
    const serialized = JSON.stringify(feed);
    expect(feed.items.some((item) => item.dedupKey === `blocker:${privateId}`)).toBe(false);
    expect(serialized).not.toContain("Confidential blocker");
    expect(serialized).not.toContain("Confidential unblock step");
    expect(serialized).not.toContain(privateId);
  });

  it("counts the blocked parents of a stalled review child and names its owner", async () => {
    const { companyId, workerId } = await seedCompany("ATS");
    const rootId = await insertIssue({ companyId, identifier: "ATS-1", title: "Root", status: "blocked" });
    const middleId = await insertIssue({
      companyId,
      identifier: "ATS-2",
      title: "Middle",
      status: "blocked",
      parentId: rootId,
    });
    const leafId = await insertIssue({
      companyId,
      identifier: "ATS-3",
      title: "Stalled review leaf",
      status: "in_review",
      parentId: middleId,
      assigneeAgentId: workerId,
    });

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    const rows = feed.items.filter((item) => item.sourceKind === "blocker_attention");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subject: { id: leafId },
      whyNow: "In review with no active run or scheduled monitor. Owner: Worker. Blocks 2 tasks.",
      detail: { kind: "blocker", blockedTaskCount: 2 },
    });
  });
});
