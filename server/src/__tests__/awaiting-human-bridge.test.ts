import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  awaitingHumanBridgeInboundEvents,
  activityLog,
  companies,
  createDb,
  goals,
  issues,
  issueThreadInteractions,
  awaitingHumanBridges,
  issueComments,
} from "@paperclipai/db";
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  awaitingHumanBridgeService,
  shouldWakeOnReplyIssueStatus,
} from "../services/awaiting-human-bridge.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { logger } from "../middleware/logger.js";
import type { AwaitingHumanBridgePollEvent } from "../services/awaiting-human-bridge-registry.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("awaitingHumanBridgeService", () => {
  let db!: ReturnType<typeof createDb>;
  let interactionsSvc!: ReturnType<typeof issueThreadInteractionService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-awaiting-human-bridge-");
    db = createDb(tempDb.connectionString);
    interactionsSvc = issueThreadInteractionService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(issueComments);
    await db.delete(awaitingHumanBridgeInboundEvents);
    await db.delete(awaitingHumanBridges);
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(companies);
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAwaitingHumanInteraction() {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Bridge goal",
      level: "task",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Awaiting approval",
      status: "awaiting_human",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const interaction = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_confirmation",
      continuationPolicy: "wake_assignee_on_accept",
      payload: {
        version: 1,
        prompt: "Approve this plan?",
      },
    }, {
      agentId,
    });

    return { companyId, issueId, interactionId: interaction.id, agentId, goalId };
  }

  async function seedAskUserQuestionsInteraction() {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Question bridge goal",
      level: "task",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      identifier: "TES-7",
      title: "Roadmap unblock",
      status: "awaiting_human",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const interaction = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "ask_user_questions",
      continuationPolicy: "wake_assignee",
      title: "Board input needed to unblock roadmap",
      payload: {
        version: 1,
        title: "Please provide the required inputs so roadmap drafting can begin.",
        questions: [
          {
            id: "vision",
            prompt: "What is the one-sentence product vision and primary target customer segment?",
            required: true,
            selectionMode: "single",
            options: [
              { id: "comment", label: "I will provide this in a follow-up comment", description: "Use free text in the issue thread." },
            ],
          },
          {
            id: "mvp",
            prompt: "What are the must-have MVP features for launch?",
            required: true,
            selectionMode: "multi",
            options: [
              { id: "comment", label: "I will provide this in a follow-up comment", description: "List the MVP features in a thread comment." },
              { id: "analytics", label: "Basic analytics" },
            ],
          },
        ],
      },
    }, {
      agentId,
    });

    return { companyId, issueId, interactionId: interaction.id, agentId };
  }

  async function seedAskUserQuestionsBinaryInteraction() {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Question bridge binary goal",
      level: "task",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      identifier: "TES-24",
      title: "Bridge round trip",
      status: "awaiting_human",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const interaction = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "ask_user_questions",
      continuationPolicy: "wake_assignee",
      title: "E2E bridge probe: structured questions",
      payload: {
        version: 1,
        questions: [
          {
            id: "surface_check",
            prompt: "Did the full question card render in ClickUp?",
            selectionMode: "single",
            required: true,
            options: [
              { id: "full_render", label: "Yes, full card rendered" },
              { id: "partial_render", label: "Partially rendered" },
            ],
          },
          {
            id: "roundtrip_observation",
            prompt: "Did you observe a mirrored reply/comment in Bizbox?",
            selectionMode: "single",
            required: true,
            options: [
              { id: "mirrored", label: "Yes, mirrored back" },
              { id: "not_mirrored", label: "No mirror yet" },
            ],
          },
        ],
      },
    }, {
      agentId,
    });

    return { companyId, issueId, interactionId: interaction.id, agentId };
  }

  function approvalNotification() {
    return {
      handoffKind: "request_confirmation" as const,
      notification: {
        title: "Awaiting approval needs confirmation",
        summary: "Approve this plan?",
        link: "",
        cta: "Reply in ClickUp to approve or explain the changes needed.",
        labels: ["awaiting_human", "request_confirmation"],
        kind: "request_confirmation",
        body: null,
      },
    };
  }

  it("builds company-prefixed issue links for ClickUp bridge notifications", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    const prevPublicUrl = process.env.BIZBOX_PUBLIC_URL;

    process.env.BIZBOX_PUBLIC_URL = "http://localhost:3200";
    try {
      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: "CIT",
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(goals).values({
        id: goalId,
        companyId,
        title: "Bridge goal",
        level: "task",
        status: "active",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Engineer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        goalId,
        identifier: "CIT-2",
        title: "Awaiting approval",
        status: "awaiting_human",
        priority: "medium",
        assigneeAgentId: agentId,
      });
      const interaction = await interactionsSvc.create({
        id: issueId,
        companyId,
      }, {
        kind: "request_confirmation",
        continuationPolicy: "wake_assignee_on_accept",
        payload: {
          version: 1,
          prompt: "Approve this plan?",
        },
      }, {
        agentId,
      });

      const send = vi.fn(async () => ({
        externalThreadId: "thread-1",
        externalMessageId: "message-1",
        nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
      }));
      const service = awaitingHumanBridgeService(db, {
        resolveProviderForCompany: async () => "clickup",
        hasAdapter: () => true,
        resolveAdapter: () => ({
          send,
          poll: vi.fn(async () => ({ status: "ok" as const, detail: "ok", events: [] as AwaitingHumanBridgePollEvent[] })),
          close: vi.fn(async () => {}),
        }),
      });

      await service.openForPendingInteraction({
        companyId,
        issueId,
        interactionId: interaction.id,
      });

      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
        notification: expect.objectContaining({
          link: "http://localhost:3200/CIT/issues/CIT-2",
        }),
      }));
    } finally {
      if (prevPublicUrl === undefined) {
        delete process.env.BIZBOX_PUBLIC_URL;
      } else {
        process.env.BIZBOX_PUBLIC_URL = prevPublicUrl;
      }
    }
  });

  it("does not wake a plain reply when the issue status is missing", () => {
    expect(shouldWakeOnReplyIssueStatus(undefined)).toBe(false);
    expect(shouldWakeOnReplyIssueStatus("backlog")).toBe(false);
    expect(shouldWakeOnReplyIssueStatus("todo")).toBe(true);
  });

  it("creates one active bridge for an interaction and reuses it while still open", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const send = vi.fn(async () => ({
      externalThreadId: "thread-1",
      externalMessageId: "message-1",
      nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
    }));
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send,
        poll: vi.fn(async () => ({ status: "ok" as const, detail: "ok", events: [] as AwaitingHumanBridgePollEvent[] })),
        close: vi.fn(async () => {}),
      }),
    });

    const first = await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });
    const second = await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });

    expect(first.id).toBe(second.id);
    expect(send).toHaveBeenCalledTimes(1);

    const rows = await db.select().from(awaitingHumanBridges)
      .where(eq(awaitingHumanBridges.interactionId, seeded.interactionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      provider: "clickup",
      status: "waiting_for_human",
      externalThreadId: "thread-1",
      externalMessageId: "message-1",
    }));
  });

  it("does not create duplicate bridges when concurrent openOrReuse calls race", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    let resolveProviderGate!: () => void;
    let resolveProviderCalls = 0;
    const providerGate = new Promise<void>((resolve) => {
      resolveProviderGate = resolve;
    });
    const send = vi.fn(async () => ({
      externalThreadId: "thread-1",
      externalMessageId: "message-1",
      nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
    }));
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => {
        resolveProviderCalls += 1;
        if (resolveProviderCalls === 2) {
          resolveProviderGate();
        }
        await providerGate;
        return "clickup";
      },
      resolveAdapter: () => ({
        send,
        poll: vi.fn(async () => ({ status: "ok" as const, detail: "ok", events: [] as AwaitingHumanBridgePollEvent[] })),
        close: vi.fn(async () => {}),
      }),
    });

    const [first, second] = await Promise.all([
      service.openOrReuseForInteraction({
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        interactionId: seeded.interactionId,
        agentId: seeded.agentId,
        ...approvalNotification(),
      }),
      service.openOrReuseForInteraction({
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        interactionId: seeded.interactionId,
        agentId: seeded.agentId,
        ...approvalNotification(),
      }),
    ]);

    expect(first.id).toBe(second.id);
    expect(send).toHaveBeenCalledTimes(1);

    const rows = await db.select().from(awaitingHumanBridges)
      .where(eq(awaitingHumanBridges.interactionId, seeded.interactionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      status: "waiting_for_human",
      externalMessageId: "message-1",
    }));
  });

  it("retries a failed bridge-open by creating a fresh row", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const send = vi.fn()
      .mockImplementationOnce(async () => {
        throw new Error("clickup send failed");
      })
      .mockImplementationOnce(async () => ({
        externalThreadId: "thread-1",
        externalMessageId: "message-1",
        nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
      }));
    const close = vi.fn(async () => {});
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send,
        poll: vi.fn(async () => ({ status: "ok" as const, detail: "ok", events: [] as AwaitingHumanBridgePollEvent[] })),
        close,
      }),
    });

    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: "system",
      actorId: "issue_thread_interactions",
      action: "issue.awaiting_human.bridge_open_failed",
      entityType: "issue",
      entityId: seeded.issueId,
      details: {
        interactionId: seeded.interactionId,
        interactionKind: "request_confirmation",
        detail: "clickup send failed",
      },
    });

    const first = await service.retryFailedBridgeOpenings();

    expect(first).toEqual({
      checked: 1,
      reopened: 0,
      failed: 1,
      skipped: 0,
      issueIds: [],
      interactionIds: [],
    });
    expect(send).toHaveBeenCalledTimes(1);

    const [failedBridge] = await db.select().from(awaitingHumanBridges).where(eq(awaitingHumanBridges.interactionId, seeded.interactionId));
    expect(failedBridge).toEqual(expect.objectContaining({
      status: "failed",
      lastError: "clickup send failed",
    }));
    expect(failedBridge?.id).toBeDefined();

    const second = await service.retryFailedBridgeOpenings();

    expect(second).toEqual({
      checked: 1,
      reopened: 1,
      failed: 0,
      skipped: 1,
      issueIds: [seeded.issueId],
      interactionIds: [seeded.interactionId],
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledWith(expect.objectContaining({
      bridgeId: failedBridge?.id,
      outcome: "failed",
      reason: "clickup send failed",
    }));

    const rows = await db.select().from(awaitingHumanBridges)
      .where(eq(awaitingHumanBridges.interactionId, seeded.interactionId))
      .orderBy(asc(awaitingHumanBridges.createdAt), asc(awaitingHumanBridges.id));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toBe(failedBridge?.id);
    expect(rows[0]).toEqual(expect.objectContaining({
      status: "closed",
      closeOutcome: "superseded",
      lastError: "clickup send failed",
    }));
    expect(rows[1]).toEqual(expect.objectContaining({
      status: "waiting_for_human",
      externalMessageId: "message-1",
      lastError: null,
    }));
  });

  it("skips a concurrent retry insert instead of throwing a unique constraint error", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const insertRetryBridge = async () => {
      const [created] = await db.insert(awaitingHumanBridges).values({
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        interactionId: seeded.interactionId,
        agentId: seeded.agentId,
        provider: "clickup",
        status: "pending_delivery",
      }).onConflictDoNothing({
        target: awaitingHumanBridges.interactionId,
        where: inArray(awaitingHumanBridges.status, ["pending_delivery", "waiting_for_human"]),
      }).returning();
      return created ?? null;
    };

    const [first, second] = await Promise.all([
      insertRetryBridge(),
      insertRetryBridge(),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);

    const rows = await db.select().from(awaitingHumanBridges)
      .where(eq(awaitingHumanBridges.interactionId, seeded.interactionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      status: "pending_delivery",
      provider: "clickup",
    }));
  });

  it("builds full ask-user-questions outbound content for the bridge", async () => {
    const seeded = await seedAskUserQuestionsInteraction();
    const send = vi.fn(async () => ({
      externalThreadId: "thread-1",
      externalMessageId: "message-1",
      nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
    }));
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send,
        poll: vi.fn(async () => ({ status: "ok" as const, detail: "ok", events: [] as AwaitingHumanBridgePollEvent[] })),
        close: vi.fn(async () => {}),
      }),
    });

    await service.openForPendingInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      handoffKind: "ask_user_questions",
      notification: expect.objectContaining({
        labels: ["awaiting_human", "ask_user_questions"],
        summary: "Board input needed to unblock roadmap",
      }),
    }));
    const sendArg = send.mock.calls[0]?.[0];
    expect(sendArg?.notification.body).toContain("Question 1: What is the one-sentence product vision and primary target customer segment?");
    expect(sendArg?.notification.body).toContain("Question 2: What are the must-have MVP features for launch?");
    expect(sendArg?.notification.body).toContain("Options:");
    expect(sendArg?.notification.body).toContain("I will provide this in a follow-up comment");
    expect(sendArg?.notification.body).toContain("Basic analytics");
  });

  it("rejects a confirmation when the board replies with Reject", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const [issueBefore] = await db.select({ updatedAt: issues.updatedAt }).from(issues).where(eq(issues.id, seeded.issueId));
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "slack",
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({
          status: "ok",
          detail: "ok",
          events: [
            {
              kind: "reply",
              externalEventId: "reply-1",
              externalThreadId: "thread-1",
              externalMessageId: "message-1",
              authorExternalId: "user-1",
              authorDisplayName: "Board",
              body: "Reject",
              receivedAt: new Date("2026-05-22T00:02:00.000Z"),
              metadata: { clickupReplyId: "reply-1" },
            },
          ],
        })),
        close: vi.fn(async () => {}),
      }),
    });

    const bridge = await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });

    await service.pollActiveBridges(new Date("2026-05-22T00:03:00.000Z"));

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe("Slack reply received:\n\nReject");

    const [interaction] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId));
    expect(interaction?.status).toBe("rejected");

    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(updatedIssue?.status).toBe("todo");

    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, seeded.agentId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.payload).toMatchObject({
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      interactionStatus: "rejected",
      mutation: "interaction",
    });

    const events = await db.select().from(awaitingHumanBridgeInboundEvents).where(
      eq(awaitingHumanBridgeInboundEvents.bridgeId, bridge.id),
    );
    expect(events).toHaveLength(1);

    const [updatedBridge] = await db.select().from(awaitingHumanBridges).where(eq(awaitingHumanBridges.id, bridge.id));
    expect(updatedBridge).toEqual(expect.objectContaining({
      status: "closed",
      closeOutcome: "rejected",
    }));

    const [issueAfter] = await db.select({ updatedAt: issues.updatedAt }).from(issues).where(eq(issues.id, seeded.issueId));
    expect(issueAfter && issueBefore && issueAfter.updatedAt.getTime()).toBeGreaterThanOrEqual(issueBefore.updatedAt.getTime());
  });

  it("dedupes an empty reply event without creating a comment", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({
          status: "ok",
          detail: "ok",
          events: [
            {
              kind: "reply",
              externalEventId: "reply-empty-1",
              externalThreadId: "thread-1",
              externalMessageId: "message-1",
              body: "   ",
              metadata: { clickupReplyId: "reply-empty-1" },
            },
          ],
        })),
        close: vi.fn(async () => {}),
      }),
    });

    const bridge = await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });

    const first = await service.pollActiveBridges(new Date("2026-05-22T00:03:00.000Z"));
    expect(first.replies).toBe(0);

    const second = await service.pollActiveBridges(new Date("2026-05-22T00:04:00.000Z"));
    expect(second.replies).toBe(0);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(0);

    const events = await db.select().from(awaitingHumanBridgeInboundEvents).where(
      eq(awaitingHumanBridgeInboundEvents.bridgeId, bridge.id),
    );
    expect(events).toHaveLength(1);
  });

  it("skips a duplicate inbound event when overlapping polls race on the same ClickUp reply", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    let pollCalls = 0;
    let releasePollGate!: () => void;
    const pollGate = new Promise<void>((resolve) => {
      releasePollGate = resolve;
    });
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => {
          pollCalls += 1;
          if (pollCalls === 2) {
            releasePollGate();
          }
          await pollGate;
          return {
            status: "ok" as const,
            detail: "ok",
            events: [
              {
                kind: "reply" as const,
                externalEventId: "reply-1",
                externalThreadId: "thread-1",
                externalMessageId: "message-1",
                body: "Change please revise the summary first.",
                metadata: { clickupReplyId: "reply-1" },
              },
            ],
          };
        }),
        close: vi.fn(async () => {}),
      }),
    });

    const bridge = await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });

    await Promise.all([
      service.pollBridge(bridge.id, new Date("2026-05-22T00:03:00.000Z")),
      service.pollBridge(bridge.id, new Date("2026-05-22T00:03:00.000Z")),
    ]);

    expect(pollCalls).toBe(2);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);

    const events = await db.select().from(awaitingHumanBridgeInboundEvents).where(
      eq(awaitingHumanBridgeInboundEvents.bridgeId, bridge.id),
    );
    expect(events).toHaveLength(1);
  });

  it("dedupes a reply across bridge reopenings for the same interaction", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const poll = vi.fn(async () => ({
      status: "ok" as const,
      detail: "ok",
      events: [
        {
          kind: "reply" as const,
          externalEventId: "reply-1",
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          body: "Change please revise the summary first.",
          metadata: { clickupReplyId: "reply-1" },
        },
      ],
    }));
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll,
        close: vi.fn(async () => {}),
      }),
    });

    const firstBridge = await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });

    const firstResult = await service.pollBridge(firstBridge.id, new Date("2026-05-22T00:03:00.000Z"));
    expect(firstResult.rejected).toBe(1);

    await service.closeBridge({
      bridgeId: firstBridge.id,
      outcome: "superseded",
      reason: "test",
    });

    const secondBridge = await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });
    expect(secondBridge.id).not.toBe(firstBridge.id);

    const secondResult = await service.pollBridge(secondBridge.id, new Date("2026-05-22T00:04:00.000Z"));
    expect(secondResult.replies).toBe(0);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe("Clickup reply received:\n\nChange please revise the summary first.");

    const events = await db.select().from(awaitingHumanBridgeInboundEvents).where(
      eq(awaitingHumanBridgeInboundEvents.interactionId, seeded.interactionId),
    );
    expect(events).toHaveLength(1);

    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, seeded.agentId));
    expect(wakes).toHaveLength(1);

    const [updatedBridge] = await db.select().from(awaitingHumanBridges).where(eq(awaitingHumanBridges.id, secondBridge.id));
    expect(updatedBridge).toEqual(expect.objectContaining({
      status: "waiting_for_human",
      closeOutcome: null,
    }));
  });

  it("delegates plain reply wakes through requestWakeup when provided", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const requestWakeup = vi.fn(async () => {});
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({
          status: "ok",
          detail: "ok",
          events: [
            {
              kind: "reply",
              externalEventId: "reply-1",
              externalThreadId: "thread-1",
              externalMessageId: "message-1",
              body: "Please revise the summary first.",
              metadata: { clickupReplyId: "reply-1" },
            },
          ],
        })),
        close: vi.fn(async () => {}),
      }),
      requestWakeup,
    });

    const bridge = await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });

    await service.pollActiveBridges(new Date("2026-05-22T00:03:00.000Z"));

    expect(requestWakeup).toHaveBeenCalledTimes(1);
    expect(requestWakeup).toHaveBeenCalledWith(expect.objectContaining({
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      reason: "issue_commented",
      requestedByActorType: "system",
      requestedByActorId: "awaiting_human_bridge",
      payload: expect.objectContaining({
        issueId: seeded.issueId,
        interactionId: seeded.interactionId,
        mutation: "comment",
      }),
    }));

    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, seeded.agentId));
    expect(wakes).toHaveLength(0);
  });

  it("answers ask_user_questions from a ClickUp reply, transitions awaiting_human to todo, and stays idempotent on replay", async () => {
    const seeded = await seedAskUserQuestionsBinaryInteraction();
    const close = vi.fn(async () => {});
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({
          status: "ok",
          detail: "ok",
          events: [
            {
              kind: "reply",
              externalEventId: "reply-1",
              externalThreadId: "thread-1",
              externalMessageId: "message-1",
              body: "question 1 is yet it got diaplyed",
              metadata: { clickupReplyId: "reply-1" },
            },
          ],
        })),
        close,
      }),
    });

    const bridge = await service.openForPendingInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
    });

    expect(bridge).not.toBeNull();
    await service.pollBridge(bridge!.id, new Date("2026-05-22T00:03:00.000Z"));
    await service.pollActiveBridges(new Date("2026-05-22T00:04:00.000Z"));

    const [interaction] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId));
    expect(interaction?.status).toBe("answered");
    expect(interaction?.result).toMatchObject({
      version: 1,
      answers: [
        { questionId: "surface_check", optionIds: ["full_render"] },
        { questionId: "roundtrip_observation", optionIds: ["mirrored"] },
      ],
      summaryMarkdown: "question 1 is yet it got diaplyed",
    });

    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(updatedIssue?.status).toBe("todo");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe("Clickup reply received:\n\nquestion 1 is yet it got diaplyed");

    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, seeded.agentId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.payload).toMatchObject({
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      interactionStatus: "answered",
      mutation: "interaction",
    });

    const bridges = await db.select().from(awaitingHumanBridges)
      .where(eq(awaitingHumanBridges.interactionId, seeded.interactionId));
    expect(bridges).toHaveLength(1);
    expect(bridges[0]).toEqual(expect.objectContaining({
      status: "closed",
      closeOutcome: "superseded",
    }));
    expect(close).toHaveBeenCalledWith(expect.objectContaining({
      bridgeId: bridge!.id,
      outcome: "superseded",
      reason: "Interaction answered via Clickup reply.",
    }));
  });

  it("uses the provider label when closing an answered ask-user bridge", async () => {
    const seeded = await seedAskUserQuestionsBinaryInteraction();
    const close = vi.fn(async () => {});
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "slack",
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({
          status: "ok",
          detail: "ok",
          events: [
            {
              kind: "reply",
              externalEventId: "reply-1",
              externalThreadId: "thread-1",
              externalMessageId: "message-1",
              body: "question 1 is yet it got diaplyed",
              metadata: { clickupReplyId: "reply-1" },
            },
          ],
        })),
        close,
      }),
    });

    const bridge = await service.openForPendingInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
    });

    expect(bridge).not.toBeNull();
    await service.pollBridge(bridge!.id, new Date("2026-05-22T00:03:00.000Z"));

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe("Slack reply received:\n\nquestion 1 is yet it got diaplyed");

    const [updatedBridge] = await db.select().from(awaitingHumanBridges)
      .where(eq(awaitingHumanBridges.id, bridge!.id));
    expect(updatedBridge).toEqual(expect.objectContaining({
      status: "closed",
      closeOutcome: "superseded",
      closeReason: "Interaction answered via Slack reply.",
    }));
    expect(close).toHaveBeenCalledWith(expect.objectContaining({
      bridgeId: bridge!.id,
      outcome: "superseded",
      reason: "Interaction answered via Slack reply.",
    }));
  });

  it("keeps an answered ask-user bridge closed even if adapter close fails", async () => {
    const seeded = await seedAskUserQuestionsBinaryInteraction();
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({
          status: "ok",
          detail: "ok",
          events: [
            {
              kind: "reply",
              externalEventId: "reply-1",
              externalThreadId: "thread-1",
              externalMessageId: "message-1",
              body: "question 1 is yet it got diaplyed",
              metadata: { clickupReplyId: "reply-1" },
            },
          ],
        })),
        close: vi.fn(async () => {
          throw new Error("clickup bridge close failed");
        }),
      }),
    });

    const bridge = await service.openForPendingInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
    });

    expect(bridge).not.toBeNull();
    const result = await service.pollBridge(bridge!.id, new Date("2026-05-22T00:03:00.000Z"));

    expect(result.replies).toBe(1);

    const [updatedBridge] = await db.select().from(awaitingHumanBridges)
      .where(eq(awaitingHumanBridges.id, bridge!.id));
    expect(updatedBridge).toEqual(expect.objectContaining({
      status: "closed",
      closeOutcome: "superseded",
    }));
  });

  it("treats unapproved ask-user replies as negative intent", async () => {
    const seeded = await seedAskUserQuestionsBinaryInteraction();
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({
          status: "ok",
          detail: "ok",
          events: [
            {
              kind: "reply",
              externalEventId: "reply-1",
              externalThreadId: "thread-1",
              externalMessageId: "message-1",
              body: "This is unapproved",
              metadata: { clickupReplyId: "reply-1" },
            },
          ],
        })),
        close: vi.fn(async () => {}),
      }),
    });

    await service.openForPendingInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
    });

    await service.pollActiveBridges(new Date("2026-05-22T00:03:00.000Z"));

    const [interaction] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId));
    expect(interaction?.status).toBe("answered");
    expect(interaction?.result).toMatchObject({
      version: 1,
      answers: [
        { questionId: "surface_check", optionIds: ["partial_render"] },
        { questionId: "roundtrip_observation", optionIds: ["not_mirrored"] },
      ],
      summaryMarkdown: "This is unapproved",
    });
  });

  it("treats near-miss yes tokens as affirmative intent", async () => {
    const seeded = await seedAskUserQuestionsBinaryInteraction();
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({
          status: "ok",
          detail: "ok",
          events: [
            {
              kind: "reply",
              externalEventId: "reply-1",
              externalThreadId: "thread-1",
              externalMessageId: "message-1",
              body: "es",
              metadata: { clickupReplyId: "reply-1" },
            },
          ],
        })),
        close: vi.fn(async () => {}),
      }),
    });

    await service.openForPendingInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
    });

    await service.pollActiveBridges(new Date("2026-05-22T00:03:00.000Z"));

    const [interaction] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId));
    expect(interaction?.status).toBe("answered");
    expect(interaction?.result).toMatchObject({
      version: 1,
      answers: [
        { questionId: "surface_check", optionIds: ["full_render"] },
        { questionId: "roundtrip_observation", optionIds: ["mirrored"] },
      ],
      summaryMarkdown: "es",
    });
  });

  it("mirrors ask_user_questions approval signals as comments and wakes the agent to interpret", async () => {
    const seeded = await seedAskUserQuestionsBinaryInteraction();
    const poll = vi.fn(async () => ({
      status: "ok" as const,
      detail: "ok",
      events: [
        {
          kind: "approval_signal" as const,
          externalEventId: "approval-1",
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          body: "yes",
          metadata: { resolutionSource: "clickup_reply" },
        },
      ],
    }));
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll,
        close: vi.fn(async () => {}),
      }),
    });

    const bridge = await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      handoffKind: "ask_user_questions",
      notification: {
        title: "TES-24 needs answers",
        summary: "Need answers to proceed.",
        link: "",
        cta: "Reply with answers to the questions below.",
        labels: ["awaiting_human", "ask_user_questions"],
        kind: "ask_user_questions",
        body: null,
      },
    });

    const firstResult = await service.pollBridge(bridge.id, new Date("2026-05-22T00:03:00.000Z"));
    expect(firstResult).toEqual(expect.objectContaining({
      checked: 1,
      replies: 1,
      approved: 0,
      rejected: 0,
      failed: 0,
    }));

    const [interaction] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId));
    expect(interaction?.status).toBe("pending");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe("Clickup reply received:\n\nyes");

    const events = await db.select().from(awaitingHumanBridgeInboundEvents).where(
      eq(awaitingHumanBridgeInboundEvents.bridgeId, bridge.id),
    );
    expect(events).toHaveLength(1);

    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, seeded.agentId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.payload).toMatchObject({
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      mutation: "comment",
    });

    const [updatedBridge] = await db.select().from(awaitingHumanBridges).where(eq(awaitingHumanBridges.id, bridge.id));
    expect(updatedBridge?.status).toBe("waiting_for_human");

    const secondResult = await service.pollBridge(bridge.id, new Date("2026-05-22T00:04:00.000Z"));
    expect(secondResult.failed).toBe(0);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("wakes the agent on unrecognized approval_signal text for a pending confirmation", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const poll = vi.fn(async () => ({
      status: "ok" as const,
      detail: "ok",
      events: [
        {
          kind: "approval_signal" as const,
          externalEventId: "approval-1",
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          body: "Maybe revise section two first.",
          metadata: { resolutionSource: "clickup_reply" },
        },
      ],
    }));
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll,
        close: vi.fn(async () => {}),
      }),
    });

    const bridge = await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });

    const firstResult = await service.pollBridge(bridge.id, new Date("2026-05-22T00:03:00.000Z"));
    expect(firstResult).toEqual(expect.objectContaining({
      checked: 1,
      replies: 1,
      approved: 0,
      rejected: 0,
      failed: 0,
    }));

    const [interaction] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId));
    expect(interaction?.status).toBe("pending");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe("Clickup reply received:\n\nMaybe revise section two first.");

    const events = await db.select().from(awaitingHumanBridgeInboundEvents).where(
      eq(awaitingHumanBridgeInboundEvents.bridgeId, bridge.id),
    );
    expect(events).toHaveLength(1);

    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, seeded.agentId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.payload).toMatchObject({
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      mutation: "comment",
    });

    const [updatedBridge] = await db.select().from(awaitingHumanBridges).where(eq(awaitingHumanBridges.id, bridge.id));
    expect(updatedBridge).toEqual(expect.objectContaining({
      status: "waiting_for_human",
      closeOutcome: null,
    }));

    const secondResult = await service.pollBridge(bridge.id, new Date("2026-05-22T00:04:00.000Z"));
    expect(secondResult.failed).toBe(0);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("accepts the interaction, wakes the agent, and closes the bridge on approval", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({
          status: "ok",
          detail: "ok",
          events: [
            {
              kind: "reply",
              externalEventId: "reply-1",
              externalThreadId: "thread-1",
              externalMessageId: "message-1",
              body: "Approve",
              receivedAt: new Date("2026-05-22T00:02:00.000Z"),
              metadata: { clickupReplyId: "reply-1", resolutionSource: "clickup_reply" },
            },
          ],
        })),
        close: vi.fn(async () => {}),
      }),
    });

    const bridge = await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });

    await service.pollActiveBridges(new Date("2026-05-22T00:03:00.000Z"));

    const [interaction] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId));
    expect(interaction?.status).toBe("accepted");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe("Clickup reply received:\n\nApprove");

    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, seeded.agentId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.payload).toMatchObject({
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      interactionStatus: "accepted",
    });

    const [updatedBridge] = await db.select().from(awaitingHumanBridges).where(eq(awaitingHumanBridges.id, bridge.id));
    expect(updatedBridge).toEqual(expect.objectContaining({
      status: "closed",
      closeOutcome: "approved",
    }));
  });

  it("dedupes an approval signal if closeBridge fails after the transaction commits", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({
          status: "ok",
          detail: "ok",
          events: [
            {
              kind: "reply",
              externalEventId: "reply-1",
              externalThreadId: "thread-1",
              externalMessageId: "message-1",
              body: "Approve",
              receivedAt: new Date("2026-05-22T00:02:00.000Z"),
              metadata: { clickupReplyId: "reply-1", resolutionSource: "clickup_reply" },
            },
          ],
        })),
        close: vi.fn(async () => {}),
      }),
    });

    const bridge = await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });

    const originalCloseBridge = service.closeBridge.bind(service);
    let failCloseBridgeOnce = true;
    const closeBridgeSpy = vi.spyOn(service, "closeBridge").mockImplementation(async (...args: Parameters<typeof originalCloseBridge>) => {
      if (failCloseBridgeOnce) {
        failCloseBridgeOnce = false;
        throw new Error("bridge close failed");
      }
      return originalCloseBridge(...args);
    });

    const first = await service.pollActiveBridges(new Date("2026-05-22T00:03:00.000Z"));
    expect(first.failed).toBe(1);

    const [interactionAfterFirstPoll] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId));
    expect(interactionAfterFirstPoll?.status).toBe("accepted");

    const commentsAfterFirstPoll = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(commentsAfterFirstPoll).toHaveLength(1);
    expect(commentsAfterFirstPoll[0]?.body).toBe("Clickup reply received:\n\nApprove");

    const wakesAfterFirstPoll = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, seeded.agentId));
    expect(wakesAfterFirstPoll).toHaveLength(1);

    const inboundAfterFirstPoll = await db.select().from(awaitingHumanBridgeInboundEvents)
      .where(eq(awaitingHumanBridgeInboundEvents.bridgeId, bridge.id));
    expect(inboundAfterFirstPoll).toHaveLength(1);

    const second = await service.pollActiveBridges(new Date("2026-05-22T00:09:00.000Z"));
    expect(second.approved).toBe(0);
    expect(closeBridgeSpy).toHaveBeenCalledTimes(1);

    const [interactionAfterSecondPoll] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId));
    expect(interactionAfterSecondPoll?.status).toBe("accepted");

    const wakesAfterSecondPoll = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, seeded.agentId));
    expect(wakesAfterSecondPoll).toHaveLength(1);

    const inboundAfterSecondPoll = await db.select().from(awaitingHumanBridgeInboundEvents)
      .where(eq(awaitingHumanBridgeInboundEvents.bridgeId, bridge.id));
    expect(inboundAfterSecondPoll).toHaveLength(1);

    const commentsAfterSecondPoll = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(commentsAfterSecondPoll).toHaveLength(1);

    const [updatedBridge] = await db.select().from(awaitingHumanBridges).where(eq(awaitingHumanBridges.id, bridge.id));
    expect(updatedBridge).toEqual(expect.objectContaining({
      status: "closed",
      closeOutcome: "approved",
    }));

    closeBridgeSpy.mockRestore();
  });

  it("dedupes a reject signal if closeBridge fails after the transaction commits", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({
          status: "ok",
          detail: "ok",
          events: [
            {
              kind: "reject_signal",
              externalEventId: "reject-1",
              externalThreadId: "thread-1",
              externalMessageId: "message-1",
              body: "No, change the plan.",
              receivedAt: new Date("2026-05-22T00:02:00.000Z"),
              metadata: { resolutionSource: "clickup_reply" },
            },
          ],
        })),
        close: vi.fn(async () => {}),
      }),
    });

    const bridge = await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });

    const originalCloseBridge = service.closeBridge.bind(service);
    let failCloseBridgeOnce = true;
    const closeBridgeSpy = vi.spyOn(service, "closeBridge").mockImplementation(async (...args: Parameters<typeof originalCloseBridge>) => {
      if (failCloseBridgeOnce) {
        failCloseBridgeOnce = false;
        throw new Error("bridge close failed");
      }
      return originalCloseBridge(...args);
    });

    const first = await service.pollActiveBridges(new Date("2026-05-22T00:03:00.000Z"));
    expect(first.failed).toBe(1);

    const [interactionAfterFirstPoll] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId));
    expect(interactionAfterFirstPoll?.status).toBe("rejected");

    const commentsAfterFirstPoll = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(commentsAfterFirstPoll).toHaveLength(1);
    expect(commentsAfterFirstPoll[0]?.body).toBe("Clickup reply received:\n\nNo, change the plan.");

    const inboundAfterFirstPoll = await db.select().from(awaitingHumanBridgeInboundEvents)
      .where(eq(awaitingHumanBridgeInboundEvents.bridgeId, bridge.id));
    expect(inboundAfterFirstPoll).toHaveLength(1);

    const second = await service.pollActiveBridges(new Date("2026-05-22T00:09:00.000Z"));
    expect(second.rejected).toBe(0);
    expect(closeBridgeSpy).toHaveBeenCalledTimes(1);

    const [interactionAfterSecondPoll] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId));
    expect(interactionAfterSecondPoll?.status).toBe("rejected");

    const inboundAfterSecondPoll = await db.select().from(awaitingHumanBridgeInboundEvents)
      .where(eq(awaitingHumanBridgeInboundEvents.bridgeId, bridge.id));
    expect(inboundAfterSecondPoll).toHaveLength(1);

    const commentsAfterSecondPoll = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(commentsAfterSecondPoll).toHaveLength(1);

    const [updatedBridge] = await db.select().from(awaitingHumanBridges).where(eq(awaitingHumanBridges.id, bridge.id));
    expect(updatedBridge).toEqual(expect.objectContaining({
      status: "closed",
      closeOutcome: "rejected",
    }));

    closeBridgeSpy.mockRestore();
  });

  it("delegates approval wakes through requestWakeup when provided", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const requestWakeup = vi.fn(async () => {});
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({
          status: "ok",
          detail: "ok",
          events: [
            {
              kind: "approval_signal",
              externalEventId: "approval-1",
              externalThreadId: "thread-1",
              externalMessageId: "message-1",
              body: "Approve",
              metadata: { resolutionSource: "clickup_reply" },
            },
          ],
        })),
        close: vi.fn(async () => {}),
      }),
      requestWakeup,
    });

    const bridge = await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });

    await service.pollActiveBridges(new Date("2026-05-22T00:03:00.000Z"));

    expect(requestWakeup).toHaveBeenCalledTimes(1);
    expect(requestWakeup).toHaveBeenCalledWith(expect.objectContaining({
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      payload: expect.objectContaining({
        issueId: seeded.issueId,
        interactionId: seeded.interactionId,
        interactionStatus: "accepted",
      }),
    }));

    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, seeded.agentId));
    expect(wakes).toHaveLength(0);
  });

  it("rejects the interaction, wakes the agent, and closes the bridge on rejection", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({
          status: "ok",
          detail: "ok",
          events: [
            {
              kind: "reject_signal",
              externalEventId: "reject-1",
              externalThreadId: "thread-1",
              externalMessageId: "message-1",
              body: "No, change the plan.",
              receivedAt: new Date("2026-05-22T00:02:00.000Z"),
            },
          ],
        })),
        close: vi.fn(async () => {}),
      }),
    });

    const bridge = await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });

    await service.pollActiveBridges(new Date("2026-05-22T00:03:00.000Z"));

    const [interaction] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId));
    expect(interaction?.status).toBe("rejected");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe("Clickup reply received:\n\nNo, change the plan.");

    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, seeded.agentId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.payload).toMatchObject({
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      interactionStatus: "rejected",
    });

    const [updatedBridge] = await db.select().from(awaitingHumanBridges).where(eq(awaitingHumanBridges.id, bridge.id));
    expect(updatedBridge).toEqual(expect.objectContaining({
      status: "closed",
      closeOutcome: "rejected",
      closeReason: "No, change the plan.",
    }));
  });

  it("wakes the current assignee, not the original bridge agent, on rejection after reassignment", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const reassignedAgentId = randomUUID();
    await db.insert(agents).values({
      id: reassignedAgentId,
      companyId: seeded.companyId,
      name: "Reassigned reviewer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.update(issues).set({
      assigneeAgentId: reassignedAgentId,
    }).where(eq(issues.id, seeded.issueId));

    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({
          status: "ok",
          detail: "ok",
          events: [
            {
              kind: "reject_signal",
              externalEventId: "reject-1",
              externalThreadId: "thread-1",
              externalMessageId: "message-1",
              body: "No, change the plan.",
              receivedAt: new Date("2026-05-22T00:02:00.000Z"),
            },
          ],
        })),
        close: vi.fn(async () => {}),
      }),
    });

    const bridge = await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });

    await service.pollActiveBridges(new Date("2026-05-22T00:03:00.000Z"));

    const reassignedWakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, reassignedAgentId));
    expect(reassignedWakes).toHaveLength(1);
    expect(reassignedWakes[0]?.payload).toMatchObject({
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      interactionStatus: "rejected",
      mutation: "interaction",
    });

    const originalWakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, seeded.agentId));
    expect(originalWakes).toHaveLength(0);

    const [updatedBridge] = await db.select().from(awaitingHumanBridges).where(eq(awaitingHumanBridges.id, bridge.id));
    expect(updatedBridge).toEqual(expect.objectContaining({
      status: "closed",
      closeOutcome: "rejected",
    }));
  });

  it("wakes the original bridge agent, not the reassigned assignee, after a reply on reassignment", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const reassignedAgentId = randomUUID();
    await db.insert(agents).values({
      id: reassignedAgentId,
      companyId: seeded.companyId,
      name: "Reassigned reviewer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.update(issues).set({
      assigneeAgentId: reassignedAgentId,
    }).where(eq(issues.id, seeded.issueId));

    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({
          status: "ok",
          detail: "ok",
          events: [
            {
              kind: "reply",
              externalEventId: "reject-1",
              externalThreadId: "thread-1",
              externalMessageId: "message-1",
              body: "Change please revise the plan.",
              metadata: { clickupReplyId: "reject-1" },
              receivedAt: new Date("2026-05-22T00:02:00.000Z"),
            },
          ],
        })),
        close: vi.fn(async () => {}),
      }),
    });

    await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });

    await service.pollActiveBridges(new Date("2026-05-22T00:03:00.000Z"));

    const reassignedWakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, reassignedAgentId));
    expect(reassignedWakes).toHaveLength(1);
    expect(reassignedWakes[0]?.payload).toMatchObject({
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      interactionStatus: "rejected",
      mutation: "interaction",
    });

    const originalWakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, seeded.agentId));
    expect(originalWakes).toHaveLength(0);
  });

  it("retries a rejected signal after the wakeup insert fails instead of parking the interaction", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    let failWakeupInsert = true;
    const requestWakeup = vi.fn(async () => {
      if (failWakeupInsert) {
        failWakeupInsert = false;
        throw new Error("agent wakeup insert failed");
      }
    });
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      requestWakeup,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({
          status: "ok",
          detail: "ok",
          events: [
            {
              kind: "reject_signal",
              externalEventId: "reject-1",
              externalThreadId: "thread-1",
              externalMessageId: "message-1",
              body: "No, change the plan.",
              receivedAt: new Date("2026-05-22T00:02:00.000Z"),
            },
          ],
        })),
        close: vi.fn(async () => {}),
      }),
    });

    const bridge = await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });

    const firstResult = await service.pollActiveBridges(new Date("2026-05-22T00:03:00.000Z"));
    expect(firstResult.failed).toBe(1);

    const [interactionAfterFailure] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId));
    expect(interactionAfterFailure?.status).toBe("pending");

    const wakesAfterFailure = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, seeded.agentId));
    expect(wakesAfterFailure).toHaveLength(0);

    const inboundAfterFailure = await db.select().from(awaitingHumanBridgeInboundEvents).where(eq(awaitingHumanBridgeInboundEvents.bridgeId, bridge.id));
    expect(inboundAfterFailure).toHaveLength(0);

    const secondResult = await service.pollActiveBridges(new Date("2026-05-22T00:09:00.000Z"));
    expect(secondResult.rejected).toBe(1);

    const [interactionAfterRetry] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId));
    expect(interactionAfterRetry?.status).toBe("rejected");

    expect(requestWakeup).toHaveBeenCalledTimes(2);
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, seeded.agentId));
    expect(wakes).toHaveLength(0);

    const inboundEvents = await db.select().from(awaitingHumanBridgeInboundEvents).where(eq(awaitingHumanBridgeInboundEvents.bridgeId, bridge.id));
    expect(inboundEvents).toHaveLength(1);

    const [updatedBridge] = await db.select().from(awaitingHumanBridges).where(eq(awaitingHumanBridges.id, bridge.id));
    expect(updatedBridge).toEqual(expect.objectContaining({
      status: "closed",
      closeOutcome: "rejected",
    }));
  });

  it("retries an approval signal after the inbound event insert fails instead of logging a stuck 409 loop", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({
          status: "ok",
          detail: "ok",
          events: [
            {
              kind: "approval_signal",
              externalEventId: "approval-1",
              externalThreadId: "thread-1",
              externalMessageId: "message-1",
              body: "Approve",
              receivedAt: new Date("2026-05-22T00:02:00.000Z"),
            },
          ],
        })),
        close: vi.fn(async () => {}),
      }),
    });

    const bridge = await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });

    const originalTransaction = db.transaction.bind(db);
    let failCommitOnce = true;
    const transactionSpy = vi.spyOn(db as any, "transaction").mockImplementation((callback: any) =>
      originalTransaction(async (tx: any) => {
        const result = await callback(tx);
        if (failCommitOnce) {
          failCommitOnce = false;
          throw new Error("inbound event insert failed");
        }
        return result;
      }),
    );

    const firstResult = await service.pollActiveBridges(new Date("2026-05-22T00:03:00.000Z"));
    expect(firstResult.failed).toBe(1);

    const [interactionAfterFailure] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId));
    expect(interactionAfterFailure?.status).toBe("pending");

    const wakesAfterFailure = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, seeded.agentId));
    expect(wakesAfterFailure).toHaveLength(0);

    const inboundAfterFailure = await db.select().from(awaitingHumanBridgeInboundEvents).where(eq(awaitingHumanBridgeInboundEvents.bridgeId, bridge.id));
    expect(inboundAfterFailure).toHaveLength(0);

    const secondResult = await service.pollActiveBridges(new Date("2026-05-22T00:09:00.000Z"));
    expect(secondResult.approved).toBe(1);

    const [interactionAfterRetry] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId));
    expect(interactionAfterRetry?.status).toBe("accepted");

    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, seeded.agentId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.payload).toMatchObject({
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      interactionStatus: "accepted",
    });

    const inboundEvents = await db.select().from(awaitingHumanBridgeInboundEvents).where(eq(awaitingHumanBridgeInboundEvents.bridgeId, bridge.id));
    expect(inboundEvents).toHaveLength(1);

    const [updatedBridge] = await db.select().from(awaitingHumanBridges).where(eq(awaitingHumanBridges.id, bridge.id));
    expect(updatedBridge).toEqual(expect.objectContaining({
      status: "closed",
      closeOutcome: "approved",
    }));

    transactionSpy.mockRestore();
  });

  it("imports a reject signal, moves the issue back to todo, and records the reply", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({
          status: "ok",
          detail: "ok",
          events: [
            {
              kind: "reject_signal",
              externalEventId: "reject-1",
              externalThreadId: "thread-1",
              externalMessageId: "message-1",
              body: "No, change the plan.",
            },
          ],
        })),
        close: vi.fn(async () => {}),
      }),
    });

    const bridge = await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });

    const result = await service.pollActiveBridges(new Date("2026-05-22T00:03:00.000Z"));

    expect(result.rejected).toBe(1);

    const [interaction] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId));
    expect(interaction?.status).toBe("rejected");

    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(updatedIssue).toMatchObject({
      id: seeded.issueId,
      status: "todo",
      assigneeAgentId: seeded.agentId,
    });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("No, change the plan.");

    const events = await db.select().from(activityLog).where(eq(activityLog.entityId, seeded.issueId));
    expect(events.some((event) => event.action === "issue.comment_added")).toBe(true);

    const [updatedBridge] = await db.select().from(awaitingHumanBridges).where(eq(awaitingHumanBridges.id, bridge.id));
    expect(updatedBridge).toEqual(expect.objectContaining({
      status: "closed",
      closeOutcome: "rejected",
    }));

    const inboundEvents = await db.select().from(awaitingHumanBridgeInboundEvents).where(eq(awaitingHumanBridgeInboundEvents.bridgeId, bridge.id));
    expect(inboundEvents).toHaveLength(1);
  });

  it("skips re-rejecting a replayed reject signal after the event was already recorded", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({
          status: "ok",
          detail: "ok",
          events: [
            {
              kind: "reject_signal",
              externalEventId: "reject-1",
              externalThreadId: "thread-1",
              externalMessageId: "message-1",
              body: "No, change the plan.",
            },
          ],
        })),
        close: vi.fn(async () => {}),
      }),
    });

    const bridge = await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });

    await interactionsSvc.rejectInteraction({
      id: seeded.issueId,
      companyId: seeded.companyId,
    }, seeded.interactionId, {
      reason: "No, change the plan.",
    }, {
      actorType: "system",
    });

    await db.insert(awaitingHumanBridgeInboundEvents).values({
      bridgeId: bridge.id,
      interactionId: seeded.interactionId,
      eventKind: "reject_signal",
      externalEventId: "reject-1",
      externalMessageId: "message-1",
      externalThreadId: "thread-1",
      payload: { body: "No, change the plan." },
    });

    const result = await service.pollActiveBridges(new Date("2026-05-22T00:03:00.000Z"));

    expect(result.rejected).toBe(0);
    const [updatedBridge] = await db.select().from(awaitingHumanBridges).where(eq(awaitingHumanBridges.id, bridge.id));
    expect(updatedBridge).toEqual(expect.objectContaining({
      status: "closed",
      closeOutcome: "rejected",
    }));
    const inboundEvents = await db.select().from(awaitingHumanBridgeInboundEvents).where(eq(awaitingHumanBridgeInboundEvents.bridgeId, bridge.id));
    expect(inboundEvents).toHaveLength(1);
  });

  it("expires an overdue bridge, rejects the interaction, and wakes the agent", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const [issueBefore] = await db.select({ updatedAt: issues.updatedAt }).from(issues).where(eq(issues.id, seeded.issueId));
    const close = vi.fn(async () => {});
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({ status: "ok" as const, detail: "ok", events: [] as AwaitingHumanBridgePollEvent[] })),
        close,
      }),
    });

    const bridge = await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });

    await db.update(awaitingHumanBridges).set({
      createdAt: new Date("2026-05-21T00:00:00.000Z"),
      updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    }).where(eq(awaitingHumanBridges.id, bridge.id));

    await service.expireWaitingBridges(new Date("2026-05-22T12:00:00.000Z"), 60 * 60 * 1000);
    await service.expireWaitingBridges(new Date("2026-05-22T12:05:00.000Z"), 60 * 60 * 1000);

    const [interaction] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId));
    expect(interaction?.status).toBe("rejected");

    const [updatedBridge] = await db.select().from(awaitingHumanBridges).where(eq(awaitingHumanBridges.id, bridge.id));
    expect(updatedBridge).toEqual(expect.objectContaining({
      status: "closed",
      closeOutcome: "expired",
    }));

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Awaiting human bridge timed out");

    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(updatedIssue?.status).toBe("todo");
    expect(updatedIssue && issueBefore && updatedIssue.updatedAt.getTime()).toBeGreaterThan(issueBefore.updatedAt.getTime());

    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, seeded.agentId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.payload).toMatchObject({
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      interactionStatus: "rejected",
      mutation: "interaction",
    });

    const events = await db.select().from(activityLog).where(eq(activityLog.entityId, seeded.issueId));
    expect(events.some((event) => event.action === "issue.comment_added")).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("expires a pending_delivery bridge after the timeout so it does not stay stranded", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({ status: "ok" as const, detail: "ok", events: [] as AwaitingHumanBridgePollEvent[] })),
        close: vi.fn(async () => {}),
      }),
    });

    const [bridge] = await db.insert(awaitingHumanBridges).values({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      provider: "clickup",
      status: "pending_delivery",
      createdAt: new Date("2026-05-21T00:00:00.000Z"),
      updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    }).returning();

    await service.expireWaitingBridges(new Date("2026-05-22T12:00:00.000Z"), 60 * 60 * 1000);

    const [updatedBridge] = await db.select().from(awaitingHumanBridges).where(eq(awaitingHumanBridges.id, bridge.id));
    expect(updatedBridge).toEqual(expect.objectContaining({
      status: "closed",
      closeOutcome: "expired",
    }));

    const [interaction] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId));
    expect(interaction?.status).toBe("rejected");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Awaiting human bridge timed out");
  });

  it("expires a stale failed bridge delivery and skips retry once the issue closes", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const send = vi.fn(async () => {
      throw new Error("clickup send failed");
    });
    const close = vi.fn(async () => {});
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send,
        poll: vi.fn(async () => ({ status: "ok" as const, detail: "ok", events: [] as AwaitingHumanBridgePollEvent[] })),
        close,
      }),
    });

    await expect(service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    })).rejects.toThrow("clickup send failed");

    const [failedBridge] = await db.select().from(awaitingHumanBridges).where(eq(awaitingHumanBridges.interactionId, seeded.interactionId));
    expect(failedBridge).toEqual(expect.objectContaining({
      status: "failed",
      lastError: "clickup send failed",
    }));

    await db.update(awaitingHumanBridges).set({
      createdAt: new Date("2026-05-21T00:00:00.000Z"),
      updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    }).where(eq(awaitingHumanBridges.id, failedBridge!.id));

    await service.expireWaitingBridges(new Date("2026-05-22T12:00:00.000Z"), 60 * 60 * 1000);

    const [updatedBridge] = await db.select().from(awaitingHumanBridges).where(eq(awaitingHumanBridges.id, failedBridge!.id));
    expect(updatedBridge).toEqual(expect.objectContaining({
      status: "closed",
      closeOutcome: "expired",
      closeReason: "Awaiting human bridge failed to deliver before a human response was received.",
      lastError: "clickup send failed",
    }));

    const [interaction] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId));
    expect(interaction?.status).toBe("rejected");

    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue?.status).toBe("todo");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Awaiting human bridge failed to deliver");

    const events = await db.select().from(activityLog).where(eq(activityLog.entityId, seeded.issueId));
    expect(events.some((event) => event.action === "issue.awaiting_human.bridge_open_failed")).toBe(true);

    const retry = await service.retryFailedBridgeOpenings();
    expect(retry).toEqual({
      checked: 1,
      reopened: 0,
      failed: 0,
      skipped: 1,
      issueIds: [],
      interactionIds: [],
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);

    const [closedBridge] = await db.select().from(awaitingHumanBridges).where(eq(awaitingHumanBridges.id, failedBridge!.id));
    expect(closedBridge).toEqual(expect.objectContaining({
      status: "closed",
      closeOutcome: "expired",
      lastError: "clickup send failed",
    }));
  });

  it("continues expiring later bridges when one bridge fails to close", async () => {
    const seededOne = await seedAwaitingHumanInteraction();
    const seededTwo = await seedAwaitingHumanInteraction();
    let failingBridgeId: string | null = null;
    const close = vi.fn(async ({ bridgeId }: { bridgeId: string }) => {
      if (bridgeId === failingBridgeId) {
        throw new Error("clickup bridge close failed");
      }
    });
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({ status: "ok" as const, detail: "ok", events: [] as AwaitingHumanBridgePollEvent[] })),
        close,
      }),
    });

    const bridgeOne = await service.openOrReuseForInteraction({
      companyId: seededOne.companyId,
      issueId: seededOne.issueId,
      interactionId: seededOne.interactionId,
      agentId: seededOne.agentId,
      ...approvalNotification(),
    });
    const bridgeTwo = await service.openOrReuseForInteraction({
      companyId: seededTwo.companyId,
      issueId: seededTwo.issueId,
      interactionId: seededTwo.interactionId,
      agentId: seededTwo.agentId,
      ...approvalNotification(),
    });

    failingBridgeId = bridgeOne.id;

    await db.update(awaitingHumanBridges).set({
      createdAt: new Date("2026-05-21T00:00:00.000Z"),
      updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    }).where(eq(awaitingHumanBridges.id, bridgeOne.id));
    await db.update(awaitingHumanBridges).set({
      createdAt: new Date("2026-05-21T00:00:00.000Z"),
      updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    }).where(eq(awaitingHumanBridges.id, bridgeTwo.id));

    await service.expireWaitingBridges(new Date("2026-05-22T12:00:00.000Z"), 60 * 60 * 1000);

    const [updatedOne] = await db.select().from(awaitingHumanBridges).where(eq(awaitingHumanBridges.id, bridgeOne.id));
    const [updatedTwo] = await db.select().from(awaitingHumanBridges).where(eq(awaitingHumanBridges.id, bridgeTwo.id));
    expect(updatedOne).toEqual(expect.objectContaining({
      status: "closed",
      closeOutcome: "expired",
    }));
    expect(updatedTwo).toEqual(expect.objectContaining({
      status: "closed",
      closeOutcome: "expired",
    }));

    const commentsOne = await db.select().from(issueComments).where(eq(issueComments.issueId, seededOne.issueId));
    const commentsTwo = await db.select().from(issueComments).where(eq(issueComments.issueId, seededTwo.issueId));
    expect(commentsOne).toHaveLength(1);
    expect(commentsTwo).toHaveLength(1);

    const eventsOne = await db.select().from(activityLog).where(eq(activityLog.entityId, seededOne.issueId));
    expect(eventsOne.some((event) => event.action === "issue.awaiting_human.bridge_expire_failed")).toBe(false);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("backs off polling when a bridge poll throws so it does not retry every heartbeat", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => {
          throw new Error("awaiting-human-bridge-disabled");
        }),
        close: vi.fn(async () => {}),
      }),
    });

    const bridge = await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });

    const now = new Date("2026-05-22T00:03:00.000Z");
    await db.update(awaitingHumanBridges).set({
      nextPollAt: new Date("2026-05-22T00:00:00.000Z"),
    }).where(eq(awaitingHumanBridges.id, bridge.id));

    const result = await service.pollActiveBridges(now);

    expect(result.failed).toBe(1);
    const [updatedBridge] = await db.select().from(awaitingHumanBridges).where(eq(awaitingHumanBridges.id, bridge.id));
    expect(updatedBridge).toEqual(expect.objectContaining({
      status: "waiting_for_human",
      lastError: "awaiting-human-bridge-disabled",
    }));
    expect(updatedBridge?.nextPollAt && updatedBridge.nextPollAt.getTime()).toBeGreaterThan(now.getTime());
  });

  it("writes the timeout comment only once when wakeup fails during expiry", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const requestWakeup = vi.fn(async () => {
      throw new Error("wakeup failed");
    });
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({ status: "ok" as const, detail: "ok", events: [] as AwaitingHumanBridgePollEvent[] })),
        close: vi.fn(async () => {}),
      }),
      requestWakeup,
    });

    const bridge = await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });

    await db.update(awaitingHumanBridges).set({
      createdAt: new Date("2026-05-21T00:00:00.000Z"),
      updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    }).where(eq(awaitingHumanBridges.id, bridge.id));

    await service.expireWaitingBridges(new Date("2026-05-22T12:00:00.000Z"), 60 * 60 * 1000);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Awaiting human bridge timed out");
    expect(requestWakeup).toHaveBeenCalledTimes(1);
  });

  it("wakes the agent and logs a stuck expiration when both rejection attempts fail", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const close = vi.fn(async () => {});
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({ status: "ok" as const, detail: "ok", events: [] as AwaitingHumanBridgePollEvent[] })),
        close,
      }),
    });

    const bridge = await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });

    const originalTransaction = db.transaction.bind(db);
    const transactionSpy = vi.spyOn(db as any, "transaction").mockImplementation((callback: any) =>
      originalTransaction(async (tx: any) => {
        const originalTxUpdate = tx.update.bind(tx);
        tx.update = ((table: any) => {
          if (table === issueThreadInteractions) {
            return {
              set: () => ({
                where: () => ({
                  returning: async () => {
                    throw new Error("interaction update failed");
                  },
                }),
              }),
            } as any;
          }
          return originalTxUpdate(table);
        }) as any;
        return callback(tx);
      }),
    );

    await db.update(awaitingHumanBridges).set({
      createdAt: new Date("2026-05-21T00:00:00.000Z"),
      updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    }).where(eq(awaitingHumanBridges.id, bridge.id));

    await service.expireWaitingBridges(new Date("2026-05-22T12:00:00.000Z"), 60 * 60 * 1000);

    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, seeded.agentId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.payload).toMatchObject({
      bridgeId: bridge.id,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      interactionStatus: null,
      mutation: "interaction",
      expirationReason: "Awaiting human bridge timed out before a human response was received.",
    });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Awaiting human bridge timed out");

    const [interaction] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, seeded.interactionId));
    expect(interaction?.status).toBe("pending");

    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue?.status).toBe("awaiting_human");

    const [updatedBridge] = await db.select().from(awaitingHumanBridges).where(eq(awaitingHumanBridges.id, bridge.id));
    expect(updatedBridge).toEqual(expect.objectContaining({
      status: "closed",
      closeOutcome: "expired",
    }));

    const events = await db.select().from(activityLog).where(eq(activityLog.entityId, seeded.issueId));
    expect(events.some((event) => event.action === "issue.awaiting_human.bridge_expire_stuck")).toBe(true);

    transactionSpy.mockRestore();
  });

  it("closes the bridge even if adapter cleanup fails once", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    let shouldFailClose = true;
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({
          status: "ok",
          detail: "ok",
          events: [
            {
              kind: "approval_signal",
              externalEventId: "approval-1",
              externalThreadId: "thread-1",
              externalMessageId: "message-1",
              body: "Approve",
            },
          ],
        })),
        close: vi.fn(async () => {
          if (shouldFailClose) {
            shouldFailClose = false;
            throw new Error("awaiting-human-bridge-disabled");
          }
        }),
      }),
    });

    const bridge = await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });

    await service.pollActiveBridges(new Date("2026-05-22T00:03:00.000Z"));
    await service.pollActiveBridges(new Date("2026-05-22T00:09:00.000Z"));

    const [interaction] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, seeded.interactionId));
    expect(interaction?.status).toBe("accepted");
    const [updatedBridge] = await db.select().from(awaitingHumanBridges).where(eq(awaitingHumanBridges.id, bridge.id));
    expect(updatedBridge).toEqual(expect.objectContaining({
      status: "closed",
      closeOutcome: "approved",
    }));
    const inboundEvents = await db.select().from(awaitingHumanBridgeInboundEvents).where(eq(awaitingHumanBridgeInboundEvents.bridgeId, bridge.id));
    expect(inboundEvents).toHaveLength(1);
  });

  it("marks the bridge failed and records visible evidence when the provider poll fails", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({
          status: "failed",
          detail: "clickup poll failed: 500",
          events: [],
        })),
        close: vi.fn(async () => {}),
      }),
    });

    const bridge = await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });

    const result = await service.pollBridge(bridge.id, new Date("2026-05-22T00:03:00.000Z"));

    expect(result.failed).toBe(1);
    const [updatedBridge] = await db.select().from(awaitingHumanBridges).where(eq(awaitingHumanBridges.id, bridge.id));
    expect(updatedBridge).toEqual(expect.objectContaining({
      status: "failed",
      lastError: "clickup poll failed: 500",
    }));

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Awaiting human bridge failed");

    const events = await db.select().from(activityLog).where(eq(activityLog.entityId, seeded.issueId));
    expect(events.some((event) => event.action === "issue.comment_added")).toBe(true);
  });

  it("closes waiting ClickUp bridges when the issue is already terminal", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const poll = vi.fn(async () => ({
      status: "ok" as const,
      detail: "ok",
      events: [],
    }));
    const close = vi.fn(async () => {});
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll,
        close,
      }),
    });

    const bridge = await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });

    await db.update(issues).set({
      status: "done",
      completedAt: new Date("2026-05-22T00:02:00.000Z"),
    }).where(eq(issues.id, seeded.issueId));

    const result = await service.pollBridge(bridge.id, new Date("2026-05-22T00:03:00.000Z"));

    expect(poll).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(result.skipped).toBe(1);

    const [updatedBridge] = await db.select().from(awaitingHumanBridges).where(eq(awaitingHumanBridges.id, bridge.id));
    expect(updatedBridge).toEqual(expect.objectContaining({
      status: "closed",
      closeOutcome: "superseded",
      closeReason: "Issue already marked done.",
    }));
  });

  it("supports manual close through the bridge service", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const close = vi.fn(async () => {});
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({ status: "ok" as const, detail: "ok", events: [] as AwaitingHumanBridgePollEvent[] })),
        close,
      }),
    });

    const bridge = await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });

    await service.closeBridge({
      bridgeId: bridge.id,
      outcome: "cancelled",
      reason: "Operator cancelled the bridge.",
    });

    const [updatedBridge] = await db.select().from(awaitingHumanBridges).where(eq(awaitingHumanBridges.id, bridge.id));
    expect(updatedBridge).toEqual(expect.objectContaining({
      status: "closed",
      closeOutcome: "cancelled",
      closeReason: "Operator cancelled the bridge.",
    }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("limits active bridge polling batches to 200 rows", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const send = vi.fn(async () => ({
      externalThreadId: "thread-1",
      externalMessageId: "message-1",
      nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
    }));
    const poll = vi.fn(async () => ({
      status: "ok" as const,
      detail: "ok",
      events: [],
    }));
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send,
        poll,
        close: vi.fn(async () => {}),
      }),
    });

    const interactionIds = [seeded.interactionId];
    for (let index = 0; index < 200; index += 1) {
      const interaction = await interactionsSvc.create({
        id: seeded.issueId,
        companyId: seeded.companyId,
      }, {
        kind: "request_confirmation",
        continuationPolicy: "wake_assignee_on_accept",
        payload: {
          version: 1,
          prompt: `Approve bridge ${index}?`,
        },
      }, {
        agentId: seeded.agentId,
      });
      interactionIds.push(interaction.id);
    }

    for (const interactionId of interactionIds) {
      await service.openOrReuseForInteraction({
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        interactionId,
        agentId: seeded.agentId,
        ...approvalNotification(),
      });
    }

    const now = new Date("2026-05-22T00:03:00.000Z");
    await service.pollActiveBridges(now);

    expect(poll).toHaveBeenCalledTimes(200);

    const remainingReadyRows = await db.select().from(awaitingHumanBridges).where(and(
      eq(awaitingHumanBridges.status, "waiting_for_human"),
      lte(awaitingHumanBridges.nextPollAt, now),
    ));
    expect(remainingReadyRows).toHaveLength(1);
  });

  it("continues polling later bridges when one bridge poll throws", async () => {
    const seededOne = await seedAwaitingHumanInteraction();
    const seededTwo = await seedAwaitingHumanInteraction();
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({ status: "ok" as const, detail: "ok", events: [] as AwaitingHumanBridgePollEvent[] })),
        close: vi.fn(async () => {}),
      }),
    });

    const pollBridge = vi.fn(async (bridgeId: string) => {
      if (bridgeId === bridgeOne.id) {
        throw new Error("409 conflict");
      }
      return {
        checked: 1,
        approved: 1,
        rejected: 0,
        replies: 0,
        noSignal: 0,
        failed: 0,
        skipped: 0,
        approvedIssueIds: [seededTwo.issueId],
        approvedInteractionIds: [seededTwo.interactionId],
      };
    });
    (service as any).pollBridge = pollBridge;

    const bridgeOne = await service.openOrReuseForInteraction({
      companyId: seededOne.companyId,
      issueId: seededOne.issueId,
      interactionId: seededOne.interactionId,
      agentId: seededOne.agentId,
      ...approvalNotification(),
    });
    const bridgeTwo = await service.openOrReuseForInteraction({
      companyId: seededTwo.companyId,
      issueId: seededTwo.issueId,
      interactionId: seededTwo.interactionId,
      agentId: seededTwo.agentId,
      ...approvalNotification(),
    });

    await db.update(awaitingHumanBridges).set({
      nextPollAt: new Date("2026-05-22T00:00:00.000Z"),
    }).where(eq(awaitingHumanBridges.id, bridgeOne.id));
    await db.update(awaitingHumanBridges).set({
      nextPollAt: new Date("2026-05-22T00:00:00.000Z"),
    }).where(eq(awaitingHumanBridges.id, bridgeTwo.id));

    const result = await service.pollActiveBridges(new Date("2026-05-22T00:03:00.000Z"));

    expect(pollBridge).toHaveBeenCalledTimes(2);
    expect(result.failed).toBe(1);
    expect(result.approved).toBe(1);
    expect(result.approvedIssueIds).toContain(seededTwo.issueId);
  });

  it("creates a new bridge cycle after a bridge closed or failed", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: `thread-${Math.random()}`,
          externalMessageId: `message-${Math.random()}`,
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({ status: "ok" as const, detail: "ok", events: [] as AwaitingHumanBridgePollEvent[] })),
        close: vi.fn(async () => {}),
      }),
    });

    const first = await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });
    await service.closeBridge({
      bridgeId: first.id,
      outcome: "expired",
      reason: "Timed out.",
    });

    const second = await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });

    expect(second.id).not.toBe(first.id);
    const rows = await db.select().from(awaitingHumanBridges)
      .where(eq(awaitingHumanBridges.interactionId, seeded.interactionId));
    expect(rows).toHaveLength(2);
  });

  it("skips re-accepting a replayed approval signal after the event was already recorded", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({
          status: "ok",
          detail: "ok",
          events: [
            {
              kind: "approval_signal",
              externalEventId: "approval-1",
              externalThreadId: "thread-1",
              externalMessageId: "message-1",
              body: "Approve",
            },
          ],
        })),
        close: vi.fn(async () => {}),
      }),
    });

    const bridge = await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });

    await interactionsSvc.acceptInteraction({
      id: seeded.issueId,
      companyId: seeded.companyId,
      goalId: seeded.goalId,
      projectId: null,
    }, seeded.interactionId, {}, {
      actorType: "system",
    });

    await db.insert(awaitingHumanBridgeInboundEvents).values({
      bridgeId: bridge.id,
      interactionId: seeded.interactionId,
      eventKind: "approval_signal",
      externalEventId: "approval-1",
      externalMessageId: "message-1",
      externalThreadId: "thread-1",
      payload: { body: "Approve" },
    });

    const result = await service.pollActiveBridges(new Date("2026-05-22T00:03:00.000Z"));

    expect(result.approved).toBe(0);
    const [updatedBridge] = await db.select().from(awaitingHumanBridges).where(eq(awaitingHumanBridges.id, bridge.id));
    expect(updatedBridge).toEqual(expect.objectContaining({
      status: "closed",
      closeOutcome: "approved",
    }));
    const inboundEvents = await db.select().from(awaitingHumanBridgeInboundEvents).where(eq(awaitingHumanBridgeInboundEvents.bridgeId, bridge.id));
    expect(inboundEvents).toHaveLength(1);
  });

  it("treats enqueued ClickUp deliveries as delivered handoffs and skips other non-ClickUp deliveries", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({ status: "ok" as const, detail: "ok", events: [] as AwaitingHumanBridgePollEvent[] })),
        close: vi.fn(async () => {}),
      }),
    });

    const result = await service.reconcileDeliveredInteractions([
      {
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        interactionId: seeded.interactionId,
        assigneeAgentId: seeded.agentId,
        createdByAgentId: seeded.agentId,
        handoffDetails: {
          notificationDelivery: {
            status: "enqueued",
            channel: "clickup-chat",
            externalId: "message-42",
          },
        },
      },
      {
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        interactionId: seeded.interactionId,
        assigneeAgentId: seeded.agentId,
        createdByAgentId: seeded.agentId,
        handoffDetails: {
          notificationDelivery: {
            status: "sent",
            channel: "email",
            externalId: "message-42",
          },
        },
      },
    ]);

    expect(result).toEqual({
      checked: 1,
      approved: 0,
      rejected: 0,
      replies: 0,
      noSignal: 1,
      failed: 0,
      skipped: 1,
      approvedIssueIds: [],
      approvedInteractionIds: [],
    });

    const rows = await db.select().from(awaitingHumanBridges)
      .where(eq(awaitingHumanBridges.interactionId, seeded.interactionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.externalMessageId).toBe("message-42");
  });

  it("skips polling an existing delivered bridge until nextPollAt", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const poll = vi.fn(async () => {
      throw new Error("bridge polled too early");
    });
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-42",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll,
        close: vi.fn(async () => {}),
      }),
    });

    const bridge = await service.openForPendingInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
    });
    expect(bridge).not.toBeNull();

    const nextPollAt = new Date(Date.now() + 10 * 60_000);
    await db.update(awaitingHumanBridges).set({
      nextPollAt,
    }).where(eq(awaitingHumanBridges.id, bridge!.id));

    const result = await service.reconcileDeliveredInteractions([
      {
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        interactionId: seeded.interactionId,
        assigneeAgentId: seeded.agentId,
        createdByAgentId: seeded.agentId,
        handoffDetails: {
          notificationDelivery: {
            status: "sent",
            channel: "clickup-chat",
            externalId: "message-42",
          },
        },
      },
    ]);

    expect(poll).not.toHaveBeenCalled();
    expect(result).toEqual({
      checked: 0,
      approved: 0,
      rejected: 0,
      replies: 0,
      noSignal: 0,
      failed: 0,
      skipped: 1,
      approvedIssueIds: [],
      approvedInteractionIds: [],
    });
  });

  it("reconciles an eligible delivered interaction through the bridge and aggregates the poll result", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-42",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({
          status: "ok",
          detail: "ok",
          events: [
            {
              kind: "reply",
              externalEventId: "reply-1",
              externalThreadId: "thread-1",
              externalMessageId: "message-42",
              body: "Change please fix the title first.",
              metadata: { clickupReplyId: "reply-1" },
            },
          ],
        })),
        close: vi.fn(async () => {}),
      }),
    });

    const result = await service.reconcileDeliveredInteractions([
      {
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        interactionId: seeded.interactionId,
        assigneeAgentId: seeded.agentId,
        createdByAgentId: seeded.agentId,
        handoffDetails: {
          notificationDelivery: {
            status: "sent",
            channel: "clickup-chat",
            externalId: "message-42",
          },
        },
      },
    ]);

    expect(result).toEqual({
      checked: 1,
      approved: 0,
      rejected: 1,
      replies: 0,
      noSignal: 0,
      failed: 0,
      skipped: 0,
      approvedIssueIds: [],
      approvedInteractionIds: [],
    });

    const [interaction] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId));
    expect(interaction?.status).toBe("rejected");

    const rows = await db.select().from(awaitingHumanBridges)
      .where(eq(awaitingHumanBridges.interactionId, seeded.interactionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.externalMessageId).toBe("message-42");
    expect(rows[0]).toEqual(expect.objectContaining({
      status: "closed",
      closeOutcome: "rejected",
    }));
  });

  it("continues reconciling later delivered interactions when one bridge candidate fails", async () => {
    const first = await seedAwaitingHumanInteraction();
    const second = await seedAwaitingHumanInteraction();
    let pollCalls = 0;
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const reconciliationStartedAt = Date.now();
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async ({ interactionId }) => ({
          externalThreadId: `thread-${interactionId}`,
          externalMessageId: `message-${interactionId}`,
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => {
          pollCalls += 1;
          if (pollCalls === 1) {
            throw new Error("clickup poll exploded");
          }
          return {
            status: "ok" as const,
            detail: "ok",
            events: [
              {
                kind: "reply" as const,
                externalEventId: "reply-2",
                externalThreadId: "thread-2",
                externalMessageId: "message-2",
                body: "Reject",
              },
            ],
          };
        }),
        close: vi.fn(async () => {}),
      }),
    });

    const result = await service.reconcileDeliveredInteractions([
      {
        companyId: first.companyId,
        issueId: first.issueId,
        interactionId: first.interactionId,
        assigneeAgentId: first.agentId,
        createdByAgentId: first.agentId,
        handoffDetails: {
          notificationDelivery: {
            status: "sent",
            channel: "clickup-chat",
            externalId: "message-first",
          },
        },
      },
      {
        companyId: second.companyId,
        issueId: second.issueId,
        interactionId: second.interactionId,
        assigneeAgentId: second.agentId,
        createdByAgentId: second.agentId,
        handoffDetails: {
          notificationDelivery: {
            status: "sent",
            channel: "clickup-chat",
            externalId: "message-second",
          },
        },
      },
    ]);

    expect(result).toEqual({
      checked: 1,
      approved: 0,
      rejected: 1,
      replies: 0,
      noSignal: 0,
      failed: 1,
      skipped: 0,
      approvedIssueIds: [],
      approvedInteractionIds: [],
    });

    const secondComments = await db.select().from(issueComments).where(eq(issueComments.issueId, second.issueId));
    expect(secondComments).toHaveLength(1);
    expect(secondComments[0]?.body).toContain("Reject");
    expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({
      companyId: first.companyId,
      issueId: first.issueId,
      interactionId: first.interactionId,
      bridgeId: expect.any(String),
      err: expect.any(Error),
    }), "failed to reconcile delivered awaiting human interaction");

    const firstBridge = await db.select().from(awaitingHumanBridges)
      .where(eq(awaitingHumanBridges.interactionId, first.interactionId));
    expect(firstBridge).toHaveLength(1);
    expect(firstBridge[0]).toEqual(expect.objectContaining({
      lastError: "clickup poll exploded",
    }));
    expect(firstBridge[0]?.nextPollAt?.getTime()).toBeGreaterThan(reconciliationStartedAt + (4 * 60_000));

    const secondInteraction = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, second.interactionId))
      .then((rows) => rows[0] ?? null);
    expect(secondInteraction?.status).toBe("rejected");
  });

  it("finds persisted pending awaiting-human confirmations and reconciles them end to end", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-42",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({
          status: "ok",
          detail: "ok",
          events: [
            {
              kind: "approval_signal",
              externalEventId: "approval-1",
              externalThreadId: "thread-1",
              externalMessageId: "message-42",
              body: "Approve",
              metadata: { resolutionSource: "clickup_reply" },
            },
          ],
        })),
        close: vi.fn(async () => {}),
      }),
    });

    await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });

    const result = await service.reconcilePendingConfirmations();

    expect(result.checked).toBe(1);
    expect(result.approved).toBe(1);
    expect(result.issueIds).toEqual([seeded.issueId]);
    expect(result.interactionIds).toEqual([seeded.interactionId]);
  });

  it("counts rejected pending confirmations when reconciling pending bridges", async () => {
    const seeded = await seedAwaitingHumanInteraction();
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      hasAdapter: () => true,
      resolveAdapter: () => ({
        send: vi.fn(async () => ({
          externalThreadId: "thread-1",
          externalMessageId: "message-42",
          nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
        })),
        poll: vi.fn(async () => ({
          status: "ok",
          detail: "ok",
          events: [
            {
              kind: "reject_signal",
              externalEventId: "reject-1",
              externalThreadId: "thread-1",
              externalMessageId: "message-42",
              body: "No, please revise it.",
              metadata: { resolutionSource: "clickup_reply" },
            },
          ],
        })),
        close: vi.fn(async () => {}),
      }),
    });

    await service.openOrReuseForInteraction({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      agentId: seeded.agentId,
      ...approvalNotification(),
    });

    const result = await service.reconcilePendingConfirmations();

    expect(result.checked).toBe(1);
    expect(result.rejected).toBe(1);
    expect(result.approved).toBe(0);
    expect(result.noApproval).toBe(0);
  });
});
