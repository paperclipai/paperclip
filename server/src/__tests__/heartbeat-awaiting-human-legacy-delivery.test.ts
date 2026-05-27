import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, companies, createDb, goals, issueThreadInteractions, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockExpireWaitingBridges = vi.hoisted(() => vi.fn(async () => undefined));
const mockRetryFailedBridgeOpenings = vi.hoisted(() => vi.fn(async () => ({
  checked: 0,
  reopened: 0,
  failed: 0,
  skipped: 0,
  issueIds: [],
  interactionIds: [],
})));
const mockReconcileDeliveredInteractions = vi.hoisted(() => vi.fn(async (input: Array<{ issueId: string; interactionId: string }>) => ({
  checked: input.length,
  approved: input.length,
  failed: 0,
  skipped: 0,
  noSignal: 0,
  approvedIssueIds: input.map((candidate) => candidate.issueId),
  approvedInteractionIds: input.map((candidate) => candidate.interactionId),
})));
const mockReconcilePendingConfirmations = vi.hoisted(() => vi.fn(async () => ({
  checked: 0,
  approved: 0,
  failed: 0,
  skipped: 0,
  noApproval: 0,
  issueIds: [],
  interactionIds: [],
})));
const mockHasAnyAwaitingHumanBridgeAdapter = vi.hoisted(() => vi.fn(() => true));
const mockResolveAwaitingHumanBridgeAdapter = vi.hoisted(() => vi.fn(() => ({
  send: vi.fn(),
  poll: vi.fn(),
  close: vi.fn(),
})));

vi.mock("../services/awaiting-human-bridge.js", () => ({
  awaitingHumanBridgeService: vi.fn(() => ({
    expireWaitingBridges: mockExpireWaitingBridges,
    retryFailedBridgeOpenings: mockRetryFailedBridgeOpenings,
    reconcileDeliveredInteractions: mockReconcileDeliveredInteractions,
    reconcilePendingConfirmations: mockReconcilePendingConfirmations,
  })),
}));
vi.mock("../services/awaiting-human-bridge-registry.js", () => ({
  hasAnyAwaitingHumanBridgeAdapter: mockHasAnyAwaitingHumanBridgeAdapter,
  hasAwaitingHumanBridgeAdapter: vi.fn(() => true),
  registerAwaitingHumanBridgeAdapter: vi.fn(),
  resolveAwaitingHumanBridgeAdapter: mockResolveAwaitingHumanBridgeAdapter,
}));

import { heartbeatService } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat legacy awaiting_human delivery reconciliation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-legacy-delivery-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(companies);
    mockExpireWaitingBridges.mockClear();
    mockRetryFailedBridgeOpenings.mockClear();
    mockReconcileDeliveredInteractions.mockClear();
    mockReconcilePendingConfirmations.mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("forwards legacy delivered handoffs into the bridge reconciler", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const interactionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Legacy bridge goal",
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Awaiting legacy approval",
      status: "awaiting_human",
      priority: "medium",
      assigneeUserId: "local-board",
    });
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee_on_accept",
      payload: {
        version: 1,
        prompt: "Approve this plan?",
      },
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "awaiting_human_handoff",
      action: "issue.awaiting_human.entered",
      entityType: "issue",
      entityId: issueId,
      details: {
        interactionId,
        notificationDelivery: {
          status: "sent",
          channel: "clickup-chat",
          externalId: "message-legacy",
        },
      },
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileAwaitingHumanApprovals();

    expect(mockExpireWaitingBridges).toHaveBeenCalledTimes(1);
    expect(mockRetryFailedBridgeOpenings).toHaveBeenCalledTimes(1);
    expect(mockReconcileDeliveredInteractions).toHaveBeenCalledTimes(1);
    expect(mockReconcileDeliveredInteractions).toHaveBeenCalledWith([
      expect.objectContaining({
        companyId,
        issueId,
        interactionId,
        handoffDetails: expect.objectContaining({
          notificationDelivery: expect.objectContaining({
            status: "sent",
            channel: "clickup-chat",
            externalId: "message-legacy",
          }),
        }),
      }),
    ]);
    expect(mockReconcilePendingConfirmations).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({
      checked: 1,
      approved: 1,
      failed: 0,
      skipped: 0,
      noApproval: 0,
    }));
  });

  it("treats legacy enqueued ClickUp deliveries as reconciliable delivered handoffs", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const interactionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Legacy bridge goal",
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Awaiting legacy approval",
      status: "awaiting_human",
      priority: "medium",
      assigneeUserId: "local-board",
    });
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee_on_accept",
      payload: {
        version: 1,
        prompt: "Approve this plan?",
      },
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "awaiting_human_handoff",
      action: "issue.awaiting_human.entered",
      entityType: "issue",
      entityId: issueId,
      details: {
        interactionId,
        notificationDelivery: {
          status: "enqueued",
          channel: "clickup-chat",
          externalId: "message-legacy",
        },
      },
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileAwaitingHumanApprovals();

    expect(mockRetryFailedBridgeOpenings).toHaveBeenCalledTimes(1);
    expect(mockReconcileDeliveredInteractions).toHaveBeenCalledTimes(1);
    expect(mockReconcileDeliveredInteractions).toHaveBeenCalledWith([
      expect.objectContaining({
        companyId,
        issueId,
        interactionId,
        handoffDetails: expect.objectContaining({
          notificationDelivery: expect.objectContaining({
            status: "enqueued",
            channel: "clickup-chat",
            externalId: "message-legacy",
          }),
        }),
      }),
    ]);
    expect(result).toEqual(expect.objectContaining({
      checked: 1,
      approved: 1,
      failed: 0,
      skipped: 0,
      noApproval: 0,
    }));
  });

  it("skips legacy handoffs for resolved interactions even when the issue remains awaiting_human", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const resolvedInteractionId = randomUUID();
    const pendingInteractionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Legacy bridge goal",
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Awaiting legacy approval",
      status: "awaiting_human",
      priority: "medium",
      assigneeUserId: "local-board",
    });
    await db.insert(issueThreadInteractions).values([
      {
        id: resolvedInteractionId,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "approved",
        continuationPolicy: "wake_assignee_on_accept",
        payload: {
          version: 1,
          prompt: "Approve the first plan?",
        },
      },
      {
        id: pendingInteractionId,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee_on_accept",
        payload: {
          version: 1,
          prompt: "Approve the second plan?",
        },
      },
    ]);
    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "system",
        actorId: "awaiting_human_handoff",
        action: "issue.awaiting_human.entered",
        entityType: "issue",
        entityId: issueId,
        details: {
          interactionId: resolvedInteractionId,
          notificationDelivery: {
            status: "sent",
            channel: "clickup-chat",
            externalId: "message-resolved",
          },
        },
      },
      {
        companyId,
        actorType: "system",
        actorId: "awaiting_human_handoff",
        action: "issue.awaiting_human.entered",
        entityType: "issue",
        entityId: issueId,
        details: {
          interactionId: pendingInteractionId,
          notificationDelivery: {
            status: "sent",
            channel: "clickup-chat",
            externalId: "message-pending",
          },
        },
      },
    ]);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileAwaitingHumanApprovals();

    expect(mockReconcileDeliveredInteractions).toHaveBeenCalledTimes(1);
    expect(mockReconcileDeliveredInteractions).toHaveBeenCalledWith([
      expect.objectContaining({
        companyId,
        issueId,
        interactionId: pendingInteractionId,
      }),
    ]);
    expect(result).toEqual(expect.objectContaining({
      checked: 1,
      approved: 1,
      failed: 0,
      skipped: 0,
      noApproval: 0,
    }));
  });
});
