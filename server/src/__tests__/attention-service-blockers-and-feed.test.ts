import { createAgentLifecycle } from "../services/agent-lifecycle.js";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { createFullDatabaseResponseCapture, installDatabaseResponseCapture } from "./helpers/full-database-response-capture.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  approvals,
  assets,
  budgetIncidents,
  budgetPolicies,
  companies,
  createDb,
  decisionQueueItems,
  decisionQueues,
  decisions,
  decisionTriage,
  documents,
  heartbeatRunEvents,
  heartbeatRuns,
  inboxDismissals,
  invites,
  issueApprovals,
  issueAttachments,
  issueDocuments,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
  joinRequests,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { attentionRoutes } from "../routes/attention.js";
import { attentionService } from "../services/attention.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { decisionHistoryService } from "../services/decision-history.js";
import { listAttentionExhaustedRuns } from "../services/attention-exhausted-runs.js";
import { agentService } from "../services/agents.js";
import { ROUTABLE_BLOCKED_ROLLOUT_AT } from "../services/routable-blocked.js";

import {
  createAttentionServiceHarness,
  describeAttentionEmbeddedPostgres,
} from "./helpers/attention-service-harness.js";

describeAttentionEmbeddedPostgres("attention service: blockers and feed", () => {
  const h = createAttentionServiceHarness();
  let db!: ReturnType<typeof createDb>;
  beforeAll(() => { db = h.db; });
  const { seedCompany, insertIssue, pendingUserExecutionState, pendingAgentExecutionState } = h;

  it("delivers a structured human unblock descriptor once per blocked transition", async () => {
    const { companyId } = await seedCompany("ATU");
    const transitionAt = new Date("2026-07-23T18:30:00.000Z");
    const issueId = await insertIssue({
      companyId,
      identifier: "ATU-1",
      title: "Needs board action",
      status: "blocked",
      unblockDescriptor: { owner: "board", action: "Approve the exception" },
      blockedTransitionAt: transitionAt,
    });

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    const items = feed.items.filter((item) => item.dedupKey === `blocked-owner:${issueId}:${transitionAt.toISOString()}`);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sourceKind: "blocker_attention", whyNow: "Approve the exception" });
  });

  it("keeps legacy blocker attention visible for pre-rollout blocked issues", async () => {
    const { companyId } = await seedCompany("ATP");
    const issueId = await insertIssue({
      companyId,
      identifier: "ATP-1",
      title: "Blocked before rollout",
      status: "blocked",
      blockedTransitionAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() - 1),
    });

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });

    expect(feed.items.some((item) => item.dedupKey === `blocker:${issueId}`)).toBe(true);
  });

  // Regression: both blocker_attention call sites fell back to the blocked
  // task's own identity when no `blocks` relation was loaded, so every such row
  // claimed the task was blocked by itself ("PAP-23 — Blocked by PAP-23").
  it("reports no blocking task rather than a self-reference when the blocker is unknown", async () => {
    const { companyId } = await seedCompany("ATV");
    const issueId = await insertIssue({
      companyId,
      identifier: "ATV-1",
      title: "Blocked with no relation",
      status: "blocked",
      blockedTransitionAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() - 1),
    });

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    const row = feed.items.find((item) => item.dedupKey === `blocker:${issueId}`);

    expect(row).toBeTruthy();
    expect(row?.detail).toMatchObject({ kind: "blocker", blockingIssue: null });
    expect(row?.dismissalKey).toBe(`attention:blocker:${issueId}`);
  });

  it("suppresses a blocked dependency row while its blocker is actively progressing", async () => {
    const { companyId } = await seedCompany("ATW");
    const blockedId = await insertIssue({
      companyId,
      identifier: "ATW-1",
      title: "Blocked parent",
      status: "blocked",
      blockedTransitionAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() - 1),
    });
    const blockerId = await insertIssue({
      companyId,
      identifier: "ATW-2",
      title: "The actual blocker",
      status: "in_progress",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedId,
      type: "blocks",
    });

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    expect(feed.items.some((item) => item.sourceKind === "blocker_attention")).toBe(false);
  });

  it("suppresses a mixed blocker tree when any blocker is live", async () => {
    const { companyId } = await seedCompany("ATL");
    const blockedId = await insertIssue({
      companyId,
      identifier: "ATL-1",
      title: "Blocked rollout",
      status: "blocked",
    });
    const blockerIds = await Promise.all([
      insertIssue({ companyId, identifier: "ATL-2", title: "Live phase one", status: "in_progress" }),
      insertIssue({ companyId, identifier: "ATL-3", title: "Live phase two", status: "in_progress" }),
      insertIssue({ companyId, identifier: "ATL-4", title: "Live phase three", status: "in_progress" }),
      insertIssue({ companyId, identifier: "ATL-5", title: "Stopped phase", status: "todo" }),
    ]);
    await db.insert(issueRelations).values(blockerIds.map((issueId) => ({
      companyId,
      issueId,
      relatedIssueId: blockedId,
      type: "blocks" as const,
    })));

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });

    expect(feed.items.filter((item) => item.sourceKind === "blocker_attention")).toEqual([]);
  });

  it("emits one terminal-blocker row with a cycle-safe transitive blocked-work count", async () => {
    const { companyId } = await seedCompany("ATC");
    const terminalId = await insertIssue({
      companyId,
      identifier: "ATC-1",
      title: "Choose migration owner",
      status: "todo",
    });
    const blockedId = await insertIssue({
      companyId,
      identifier: "ATC-2",
      title: "Blocked migration",
      status: "blocked",
    });
    await insertIssue({
      companyId,
      identifier: "ATC-3",
      title: "Open migration child",
      status: "todo",
      parentId: blockedId,
    });
    const transitiveId = await insertIssue({
      companyId,
      identifier: "ATC-4",
      title: "Transitively blocked follow-up",
      status: "todo",
    });
    await insertIssue({
      companyId,
      identifier: "ATC-5",
      title: "Closed child",
      status: "done",
      parentId: blockedId,
    });
    await db.insert(issueRelations).values([
      { companyId, issueId: terminalId, relatedIssueId: blockedId, type: "blocks" },
      { companyId, issueId: blockedId, relatedIssueId: transitiveId, type: "blocks" },
      // Corrupt legacy cycles must not inflate or hang the count.
      { companyId, issueId: transitiveId, relatedIssueId: blockedId, type: "blocks" },
    ]);

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    const rows = feed.items.filter((item) => item.sourceKind === "blocker_attention");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subject: { id: terminalId, identifier: "ATC-1", title: "Choose migration owner" },
      relatedIssue: { id: blockedId },
      whyNow: "Blocks 3 tasks and needs human attention.",
      detail: { kind: "blocker", blockingIssue: null, blockedTaskCount: 3 },
    });
    expect(rows[0]?.subject.id).not.toBe(blockedId);
  });

  it("orders terminal blockers by blocked-work weight descending", async () => {
    const { companyId } = await seedCompany("ATR");
    const heavyTerminalId = await insertIssue({
      companyId,
      identifier: "ATR-1",
      title: "Heavy blocker",
      status: "todo",
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    const lightTerminalId = await insertIssue({
      companyId,
      identifier: "ATR-2",
      title: "Light blocker",
      status: "todo",
      updatedAt: new Date("2026-07-03T00:00:00.000Z"),
    });
    const heavyBlockedId = await insertIssue({
      companyId,
      identifier: "ATR-3",
      title: "Heavy blocked root",
      status: "blocked",
    });
    const lightBlockedId = await insertIssue({
      companyId,
      identifier: "ATR-4",
      title: "Light blocked root",
      status: "blocked",
    });
    await insertIssue({ companyId, identifier: "ATR-5", title: "Heavy child one", status: "todo", parentId: heavyBlockedId });
    await insertIssue({ companyId, identifier: "ATR-6", title: "Heavy child two", status: "todo", parentId: heavyBlockedId });
    await db.insert(issueRelations).values([
      { companyId, issueId: heavyTerminalId, relatedIssueId: heavyBlockedId, type: "blocks" },
      { companyId, issueId: lightTerminalId, relatedIssueId: lightBlockedId, type: "blocks" },
    ]);

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    const rows = feed.items.filter((item) => item.sourceKind === "blocker_attention");

    expect(rows.map((item) => item.subject.id)).toEqual([heavyTerminalId, lightTerminalId]);
    expect(rows.map((item) => item.detail?.kind === "blocker" ? item.detail.blockedTaskCount : null)).toEqual([3, 1]);
  });

  it("does not name the blocked task as its own blocker on a human-owned unblock row", async () => {
    const { companyId } = await seedCompany("ATX");
    const transitionAt = new Date("2026-07-23T18:30:00.000Z");
    const issueId = await insertIssue({
      companyId,
      identifier: "ATX-1",
      title: "Needs board action",
      status: "blocked",
      unblockDescriptor: { owner: "board", action: "Approve the exception" },
      blockedTransitionAt: transitionAt,
    });

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    const row = feed.items.find(
      (item) => item.dedupKey === `blocked-owner:${issueId}:${transitionAt.toISOString()}`,
    );

    expect(row?.detail).toMatchObject({ kind: "blocker", blockingIssue: null });
  });

  it("does not route pre-rollout human unblock descriptors", async () => {
    const { companyId } = await seedCompany("ATQ");
    const transitionAt = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() - 1);
    const issueId = await insertIssue({
      companyId,
      identifier: "ATQ-1",
      title: "Human-owned before rollout",
      status: "blocked",
      unblockDescriptor: { owner: "board", action: "Review the issue" },
      blockedTransitionAt: transitionAt,
    });

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });

    expect(feed.items.some((item) => item.dedupKey === `blocked-owner:${issueId}:${transitionAt.toISOString()}`)).toBe(false);
  });

  it("returns one pending approval row when the approval is linked to multiple tasks", async () => {
    const { companyId } = await seedCompany("ATM");
    const approvalId = randomUUID();
    const firstIssueId = "00000000-0000-4000-8000-000000000001";
    const secondIssueId = "00000000-0000-4000-8000-000000000002";
    await insertIssue({ companyId, id: firstIssueId, identifier: "ATM-1", title: "First task", status: "in_progress" });
    await insertIssue({ companyId, id: secondIssueId, identifier: "ATM-2", title: "Second task", status: "in_progress" });
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      status: "pending",
      payload: { title: "Approve rollout" },
      requestedByUserId: "dotta-user",
    });
    await db.insert(issueApprovals).values([
      { companyId, issueId: secondIssueId, approvalId },
      { companyId, issueId: firstIssueId, approvalId },
    ]);

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    const approvalItems = feed.items.filter((item) => item.dedupKey === `approval:${approvalId}`);

    expect(approvalItems).toHaveLength(1);
    expect(approvalItems[0]?.subject.metadata?.issueId).toBe(firstIssueId);
    // A person who asked is the requester; their name comes from the directory (PAP-775, UI2).
    expect(approvalItems[0]?.requester).toEqual({ kind: "user", id: "dotta-user", name: null });
    // A board approval is approved on the card like any other approval (PAP-775).
    expect(approvalItems[0]?.inlineResolvable).toBe(true);
  });

  it("hides snoozed attention rows until snoozedUntil passes, then returns them unconditionally", async () => {
    const { companyId } = await seedCompany("ATS");
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "hire_agent",
      status: "pending",
      payload: { title: "Hire Researcher" },
      createdAt: new Date("2026-07-09T12:00:00.000Z"),
      updatedAt: new Date("2026-07-09T12:00:00.000Z"),
    });
    await db.insert(inboxDismissals).values({
      companyId,
      userId: "board-user",
      itemKey: `attention:approval:${approvalId}`,
      kind: "snooze",
      dismissedAt: new Date("2099-01-01T00:00:00.000Z"),
      snoozedUntil: new Date("2099-01-02T00:00:00.000Z"),
    });

    await expect(attentionService(db).list(companyId, { userId: "board-user" }))
      .resolves.toMatchObject({ totalCount: 1 }); // agent_error_alert from seed
    await expect(attentionService(db).summary(companyId, { userId: "board-user" })).resolves.toMatchObject({ totalCount: 1 });
    const hiddenFeed = await attentionService(db).list(companyId, { userId: "board-user", includeDismissed: true });
    expect(hiddenFeed.items.find((item) => item.dedupKey === `approval:${approvalId}`)?.dismissal)
      .toMatchObject({ kind: "snooze", isActive: true, snoozedUntil: "2099-01-02T00:00:00.000Z" });

    await db
      .update(inboxDismissals)
      .set({ snoozedUntil: new Date("2020-01-01T00:00:00.000Z") })
      .where(eq(inboxDismissals.itemKey, `attention:approval:${approvalId}`));

    const visibleFeed = await attentionService(db).list(companyId, { userId: "board-user" });
    const visibleApproval = visibleFeed.items.find((item) => item.dedupKey === `approval:${approvalId}`);
    expect(visibleApproval?.dismissal).toMatchObject({ kind: "snooze", isActive: false });
    expect(visibleApproval).toBeTruthy();
    const summary = await attentionService(db).summary(companyId, { userId: "board-user" });
    expect(summary.totalCount).toBe(visibleFeed.totalCount);

  });

  it("enriches, filters, paginates, snoozes, and ranks the decide-now feed", async () => {
    const { companyId, workerId, errorAgentId } = await seedCompany("ATP");
    const now = Date.now();
    const originIssueId = await insertIssue({
      companyId,
      identifier: "ATP-1",
      title: "Decision origin",
      status: "in_progress",
      assigneeAgentId: workerId,
      updatedAt: new Date(now - 10 * 60_000),
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: workerId,
      status: "succeeded",
      contextSnapshot: { issueId: originIssueId },
    });

    const expiringSoonId = randomUUID();
    const expiringLaterId = randomUUID();
    const wheneverId = randomUUID();
    const snoozedId = randomUUID();
    const decisionValues = [
      { id: expiringSoonId, ruleKey: "release.soon", title: "Expires sooner", updatedAt: new Date(now - 60_000), expiresAt: new Date(now + 60 * 60_000) },
      { id: expiringLaterId, ruleKey: "release.later", title: "Expires later", updatedAt: new Date(now - 2 * 60_000), expiresAt: new Date(now + 2 * 60 * 60_000) },
      { id: wheneverId, ruleKey: "release.whenever", title: "Can wait", updatedAt: new Date(now), expiresAt: new Date(now + 30 * 60_000) },
      { id: snoozedId, ruleKey: "release.snoozed", title: "Snoozed", updatedAt: new Date(now - 3 * 60_000), expiresAt: new Date(now + 15 * 60_000) },
    ];
    await db.insert(decisions).values(decisionValues.map((value) => ({
      ...value,
      companyId,
      originAgentId: workerId,
      originIssueId,
      originRunId: runId,
      body: value.title,
      options: [],
      status: "open",
      signedSpec: "test",
      targetSnapshots: {},
      createdAt: value.updatedAt,
    })));

    const queueId = randomUUID();
    await db.insert(decisionQueues).values({
      id: queueId,
      companyId,
      key: "urgent-releases",
      title: "Urgent releases",
      createdByType: "user",
      createdByUserId: "board-user",
    });
    await db.insert(decisionQueueItems).values([expiringSoonId, expiringLaterId].map((sourceId) => ({
      companyId,
      queueId,
      sourceKind: "decision",
      sourceId,
      addedByType: "user",
      addedByUserId: "board-user",
    })));
    await db.insert(decisionTriage).values([
      expiringSoonId,
      expiringLaterId,
      snoozedId,
    ].map((sourceId) => ({
      companyId,
      sourceKind: "decision",
      sourceId,
      decideBy: "today",
      setByType: "agent",
      setByAgentId: workerId,
      snoozedUntil: sourceId === snoozedId ? new Date(now + 60 * 60_000) : null,
    })));
    await db.insert(decisionTriage).values({
      companyId,
      sourceKind: "decision",
      sourceId: wheneverId,
      decideBy: "whenever",
      setByType: "agent",
      setByAgentId: workerId,
    });

    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "hire_agent",
      status: "pending",
      payload: { title: "Newer medium-severity approval" },
      createdAt: new Date(now + 5 * 60_000),
      updatedAt: new Date(now + 5 * 60_000),
    });
    await db.update(agents).set({ updatedAt: new Date(now - 5 * 60_000) }).where(eq(agents.id, errorAgentId));

    const feed = await attentionService(db).list(companyId, {
      userId: "board-user",
      sort: "decide",
      limit: 20,
    });
    // The badge is this person's "For you" count (PAP-749 Rule 5), with no day
    // boundary; the whole page fits under limit:20 so items == rankedItems.
    const expectedBadge = feed.items.filter(
      (item) => item.audience.kind === "user" && item.audience.userId === "board-user",
    ).length;
    expect(feed.deskBadgeCount).toBe(expectedBadge);
    expect(feed.viewCounts.mine).toBe(expectedBadge);
    expect(feed.items.some((item) => item.subject.id === snoozedId)).toBe(false);
    expect(feed.items.slice(0, 3).map((item) => item.subject.id)).toEqual([
      expiringSoonId,
      expiringLaterId,
      wheneverId,
    ]);
    const erroredAgentIndex = feed.items.findIndex((item) => item.subject.id === errorAgentId);
    const approvalIndex = feed.items.findIndex((item) => item.subject.id === approvalId);
    expect(erroredAgentIndex).toBeGreaterThan(-1);
    expect(erroredAgentIndex).toBeLessThan(approvalIndex);

    const enriched = feed.items.find((item) => item.subject.id === expiringSoonId);
    expect(enriched).toMatchObject({
      expiresAt: decisionValues[0]!.expiresAt.toISOString(),
      ruleKey: "release.soon",
      originAgentName: "Worker",
      // Who is asking (PAP-775, UI2).
      requester: { kind: "agent", id: workerId, name: "Worker" },
      queues: [{ key: "urgent-releases", title: "Urgent releases" }],
      decideBy: "today",
      decideByAttribution: {
        type: "agent",
        agentId: workerId,
        agentName: "Worker",
      },
      snoozedUntil: null,
    });

    const firstPage = await attentionService(db).list(companyId, {
      userId: "board-user",
      queue: "urgent-releases",
      sort: "decide",
      limit: 1,
    });
    // A queue filter narrows the page, never the shared badge.
    expect(firstPage).toMatchObject({ totalCount: 2, deskBadgeCount: feed.deskBadgeCount, viewCounts: feed.viewCounts });
    expect(firstPage.items.map((item) => item.subject.id)).toEqual([expiringSoonId]);
    expect(firstPage.nextCursor).toBeTruthy();
    const secondPage = await attentionService(db).list(companyId, {
      userId: "board-user",
      queue: "urgent-releases",
      sort: "decide",
      limit: 1,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage.items.map((item) => item.subject.id)).toEqual([expiringLaterId]);
    expect(secondPage.nextCursor).toBeNull();

    const completeSnapshot = await attentionService(db).list(companyId, {
      userId: "board-user",
      queue: "urgent-releases",
      sort: "decide",
      all: true,
    });
    expect(completeSnapshot.items.map((item) => item.subject.id)).toEqual([expiringSoonId, expiringLaterId]);
    expect(completeSnapshot.nextCursor).toBeNull();

    const dateFiltered = await attentionService(db).list(companyId, {
      userId: "board-user",
      queue: "urgent-releases",
      activitySince: new Date(now - 90_000).toISOString(),
      activityUntil: new Date(now).toISOString(),
    });
    expect(dateFiltered.items.map((item) => item.subject.id)).toEqual([expiringSoonId]);

    const withSnoozed = await attentionService(db).list(companyId, {
      userId: "board-user",
      includeDismissed: true,
      limit: 20,
    });
    expect(withSnoozed.items.find((item) => item.subject.id === snoozedId)?.snoozedUntil)
      .toBe(new Date(now + 60 * 60_000).toISOString());
  });

  it("returns a complete queue snapshot beyond the normal page limit", async () => {
    const { companyId } = await seedCompany("ATS");
    const queueId = randomUUID();
    await db.insert(decisionQueues).values({
      id: queueId,
      companyId,
      key: "bulk-review",
      title: "Bulk review",
      createdByType: "user",
      createdByUserId: "board-user",
    });

    const approvalRows = Array.from({ length: 101 }, (_, index) => ({
      id: randomUUID(),
      companyId,
      type: "hire_agent",
      status: "pending",
      payload: { title: `Review ${index + 1}` },
      createdAt: new Date(Date.UTC(2026, 7, 2, 12, 0, index)),
      updatedAt: new Date(Date.UTC(2026, 7, 2, 12, 0, index)),
    }));
    await db.insert(approvals).values(approvalRows);
    await db.insert(decisionQueueItems).values(approvalRows.map((approval) => ({
      companyId,
      queueId,
      sourceKind: "approval",
      sourceId: approval.id,
      addedByType: "user",
      addedByUserId: "board-user",
    })));

    const firstPage = await attentionService(db).list(companyId, {
      userId: "board-user",
      queue: "bulk-review",
    });
    expect(firstPage.items).toHaveLength(50);
    expect(firstPage.nextCursor).toBeTruthy();

    const completeSnapshot = await attentionService(db).list(companyId, {
      userId: "board-user",
      queue: "bulk-review",
      all: true,
    });
    expect(completeSnapshot.items).toHaveLength(101);
    expect(new Set(completeSnapshot.items.map((item) => item.id)).size).toBe(101);
    expect(completeSnapshot.nextCursor).toBeNull();

    const internalSnapshot = await attentionService(db).list(companyId, {
      userId: "board-user",
      all: true,
      allowUnscopedAll: true,
    });
    const internalSnapshotIds = new Set(internalSnapshot.items.map((item) => item.subject.id));
    expect(approvalRows.every((approval) => internalSnapshotIds.has(approval.id))).toBe(true);
    expect(internalSnapshot.items.length).toBeGreaterThan(100);
    expect(internalSnapshot.nextCursor).toBeNull();
    const summary = await attentionService(db).summary(companyId, { userId: "board-user" });
    expect(summary).toEqual({
      companyId, generatedAt: expect.any(String), totalCount: internalSnapshot.totalCount,
      deskBadgeCount: internalSnapshot.deskBadgeCount, countsBySourceKind: internalSnapshot.countsBySourceKind,
      viewCounts: internalSnapshot.viewCounts,
    });
    expect(JSON.stringify(summary).length).toBeLessThan(JSON.stringify(internalSnapshot).length / 10);


    await expect(attentionService(db).list(companyId, { userId: "board-user", all: true }))
      .rejects.toThrow("all requires a queue filter");
    await expect(attentionService(db).list(companyId, {
      userId: "board-user",
      queue: "bulk-review",
      all: true,
      limit: 25,
    })).rejects.toThrow("all cannot be combined with cursor or limit");
  });

  it("does not apply the open-decision safety limit to complete snapshots", async () => {
    const { companyId, workerId } = await seedCompany("ATC");
    const originIssueId = await insertIssue({
      companyId,
      identifier: "ATC-1",
      title: "Decision origin",
      status: "in_progress",
      assigneeAgentId: workerId,
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: workerId,
      status: "succeeded",
      contextSnapshot: { issueId: originIssueId },
    });
    await db.insert(decisions).values(["First decision", "Second decision"].map((title) => ({
      id: randomUUID(),
      companyId,
      originAgentId: workerId,
      originIssueId,
      originRunId: runId,
      title,
      body: title,
      options: [],
      status: "open" as const,
      expiresAt: new Date("2026-08-10T00:00:00.000Z"),
      signedSpec: "test",
      targetSnapshots: {},
    })));

    const svc = attentionService(db, { openDecisionLimit: 1 });
    const limited = await svc.list(companyId, { userId: "board-user" });
    expect(limited.items.filter((item) => item.sourceKind === "decision")).toHaveLength(1);

    const complete = await svc.list(companyId, {
      userId: "board-user",
      all: true,
      allowUnscopedAll: true,
    });
    expect(complete.items.filter((item) => item.sourceKind === "decision")).toHaveLength(2);
    const summary = await svc.summary(companyId, { userId: "board-user" });
    expect(summary.totalCount).toBe(complete.totalCount);
    expect(summary.countsBySourceKind).toEqual(complete.countsBySourceKind);

    expect(complete.nextCursor).toBeNull();
  });

  it("keeps this-week deadlines in the current UTC week", async () => {
    const { companyId, workerId } = await seedCompany("ATW");
    const now = Date.parse("2026-08-02T12:00:00.000Z"); // Sunday in an ISO Monday-Sunday week.
    const originIssueId = await insertIssue({
      companyId,
      identifier: "ATW-1",
      title: "Decision origin",
      status: "in_progress",
      assigneeAgentId: workerId,
      updatedAt: new Date(now),
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: workerId,
      status: "succeeded",
      contextSnapshot: { issueId: originIssueId },
    });

    const thisWeekId = randomUUID();
    const nextWeekId = randomUUID();
    await db.insert(decisions).values([
      { id: thisWeekId, title: "This week", expiresAt: new Date("2026-08-09T12:00:00.000Z") },
      { id: nextWeekId, title: "Next week", expiresAt: new Date("2026-08-03T12:00:00.000Z") },
    ].map((value) => ({
      ...value,
      companyId,
      originAgentId: workerId,
      originIssueId,
      originRunId: runId,
      body: value.title,
      options: [],
      status: "open" as const,
      signedSpec: "test",
      targetSnapshots: {},
      createdAt: new Date(now),
      updatedAt: new Date(now),
    })));
    await db.insert(decisionTriage).values([
      {
        companyId,
        sourceKind: "decision",
        sourceId: thisWeekId,
        decideBy: "this_week",
        setByType: "user",
        setByUserId: "board-user",
      },
      {
        companyId,
        sourceKind: "decision",
        sourceId: nextWeekId,
        decideBy: "date",
        decideByDate: "2026-08-03",
        setByType: "user",
        setByUserId: "board-user",
      },
    ]);

    const feed = await attentionService(db, { now: () => now }).list(companyId, {
      userId: "board-user",
      sort: "decide",
      limit: 20,
    });
    const decisionItems = feed.items.filter((item) => item.sourceKind === "decision");

    expect(decisionItems.map((item) => item.subject.id)).toEqual([thisWeekId, nextWeekId]);
    expect(decisionItems[0]).toMatchObject({
      decideBy: "this_week",
      expiresAt: "2026-08-09T12:00:00.000Z",
    });
    expect(decisionItems[1]).toMatchObject({
      decideBy: "2026-08-03",
      expiresAt: "2026-08-03T12:00:00.000Z",
    });
  });

  it("serves the route for board users and rejects agent callers", async () => {
    const { companyId } = await seedCompany("ATR");

    function app(actor: Record<string, unknown>) {
      const testApp = express();
      testApp.use(express.json());
      testApp.use((req, _res, next) => {
        (req as any).actor = actor;
        next();
      });
      testApp.use("/api", attentionRoutes(db));
      testApp.use(errorHandler);
      return testApp;
    }

    const board = {
      type: "board",
      source: "local_implicit",
      userId: "board-user",
      companyIds: [companyId],
      isInstanceAdmin: false,
    };
    const agent = {
      type: "agent",
      source: "agent_key",
      companyId,
      agentId: randomUUID(),
      runId: null,
    };

    await request(app(board)).get(`/api/companies/${companyId}/attention`).expect(200);
    const completeFeed = await request(app(board))
      .get(`/api/companies/${companyId}/attention?includeDismissed=true&all=true`)
      .expect(200);
    expect(completeFeed.body.nextCursor).toBeNull();
    const summary = await request(app(board)).get(`/api/companies/${companyId}/attention/summary`).expect(200);
    expect(summary.body).not.toHaveProperty("items");
    expect(summary.body.totalCount).toBe(completeFeed.body.totalCount);
    const taskIndex = await request(app(board)).get(`/api/companies/${companyId}/attention/tasks`).expect(200);
    expect(taskIndex.body).not.toHaveProperty("items");
    expect(taskIndex.body.taskIds).toEqual([]);
    await request(app(agent)).get(`/api/companies/${companyId}/attention/tasks`).expect(403);
    await request(app({ ...board, source: "session", companyIds: [] })).get(`/api/companies/${companyId}/attention/tasks`).expect(403);

    await request(app(agent)).get(`/api/companies/${companyId}/attention/summary`).expect(403);
    await request(app({ ...board, source: "session", companyIds: [] })).get(`/api/companies/${companyId}/attention/summary`).expect(403);

    await request(app(board))
      .get(`/api/companies/${companyId}/attention?activitySince=yesterday`)
      .expect(400, { error: "activitySince must be an ISO timestamp" });
    await request(app(board))
      .get(`/api/companies/${companyId}/attention?sort=oldest`)
      .expect(400, { error: "sort must be 'activity' or 'decide'" });
    await request(app(agent)).get(`/api/companies/${companyId}/attention`).expect(403);
  });

  it("omits private issue review items for a non-member board user", async () => {
    const { companyId } = await seedCompany("ATP");
    const privateIssueId = randomUUID();
    await insertIssue({
      id: privateIssueId,
      companyId,
      identifier: "ATP-1",
      title: "Confidential review",
      status: "in_review",
      assigneeUserId: "private-owner",
      executionState: pendingUserExecutionState("private-owner"),
      visibility: "private",
      privacyRootIssueId: privateIssueId,
      responsibleUserId: "private-owner",
    });

    const actor = {
      type: "board" as const,
      source: "session" as const,
      userId: "non-member",
      companyIds: [companyId],
      isInstanceAdmin: false,
    };
    const feed = await attentionService(db).list(companyId, { userId: actor.userId, actor });

    expect(feed.items.map((item) => item.subject.title)).not.toContain("Confidential review");
    expect(JSON.stringify(feed)).not.toContain(privateIssueId);
    const summary = await attentionService(db).summary(companyId, { userId: actor.userId, actor });
    expect(summary.totalCount).toBe(feed.totalCount);
    expect(summary.countsBySourceKind).toEqual(feed.countsBySourceKind);

  });

  it("computes the aging shelf uniformly across approval, interaction, and review sources", async () => {
    const { companyId, workerId } = await seedCompany("AGE");
    const now = Date.parse("2026-08-02T12:00:00.000Z");
    const idleAt = new Date("2026-06-30T12:00:00.000Z");
    const interactionIssueId = await insertIssue({
      companyId,
      identifier: "AGE-1",
      title: "Old questions",
      status: "in_progress",
      assigneeAgentId: workerId,
      createdAt: idleAt,
      updatedAt: idleAt,
    });
    const reviewIssueId = await insertIssue({
      companyId,
      identifier: "AGE-2",
      title: "Old review",
      status: "in_review",
      assigneeUserId: "board-user",
      createdAt: idleAt,
      updatedAt: idleAt,
    });
    const approvalId = randomUUID();
    const queueApprovalId = randomUUID();
    const interactionId = randomUUID();
    const queueIdleAt = new Date("2026-07-18T12:00:00.000Z");
    await db.insert(approvals).values([
      {
        id: approvalId,
        companyId,
        type: "request_board_approval",
        requestedByAgentId: workerId,
        status: "pending",
        payload: { title: "Old approval" },
        createdAt: idleAt,
        updatedAt: idleAt,
      },
      {
        id: queueApprovalId,
        companyId,
        type: "request_board_approval",
        requestedByAgentId: workerId,
        status: "pending",
        payload: { title: "Queue-retained approval" },
        createdAt: queueIdleAt,
        updatedAt: queueIdleAt,
      },
    ]);
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId: interactionIssueId,
      kind: "ask_user_questions",
      status: "pending",
      createdByAgentId: workerId,
      payload: { version: 1, questions: [] },
      createdAt: idleAt,
      updatedAt: idleAt,
    });
    const [queue] = await db.insert(decisionQueues).values({
      companyId,
      key: "fast-aging",
      title: "Fast aging",
      retentionDays: 10,
      createdByType: "system",
    }).returning();
    await db.insert(decisionQueueItems).values({
      companyId,
      queueId: queue!.id,
      sourceKind: "approval",
      sourceId: queueApprovalId,
      addedByType: "system",
    });

    const feed = await attentionService(db, { now: () => now }).list(companyId, {
      userId: "board-user",
      limit: 100,
    });
    const byKey = new Map(feed.items.map((item) => [`${item.sourceKind}:${item.subject.id}`, item]));
    for (const key of [
      `approval:${approvalId}`,
      `issue_thread_interaction:${interactionId}`,
      `review:${reviewIssueId}`,
    ]) {
      expect(byKey.get(key)).toMatchObject({ shelf: true, retentionDays: 30, archivedAt: null });
    }
    expect(byKey.get(`approval:${queueApprovalId}`)).toMatchObject({ shelf: true, retentionDays: 10 });
  });
});
