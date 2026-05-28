import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  awaitingHumanBridgeInboundEvents,
  awaitingHumanBridges,
  companies,
  createDb,
  goals,
  issueComments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const replyResolutionFailures = vi.hoisted(() => ({
  answerQuestions: 0,
}));

vi.mock("../services/issue-thread-interactions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issue-thread-interactions.js")>();

  return {
    ...actual,
    issueThreadInteractionService: (db: any, deps?: any) => {
      const service = actual.issueThreadInteractionService(db, deps);
      return {
        ...service,
        answerQuestions: async (...args: any[]) => {
          if (replyResolutionFailures.answerQuestions > 0) {
            replyResolutionFailures.answerQuestions -= 1;
            throw new Error("transient answer failure");
          }
          return service.answerQuestions(...args);
        },
      };
    },
  };
});

import { awaitingHumanBridgeService } from "../services/awaiting-human-bridge.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("awaitingHumanBridgeService reply retries", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-awaiting-human-bridge-retry-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    replyResolutionFailures.answerQuestions = 0;
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
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

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
      identifier: "TES-24",
      title: "Bridge round trip",
      status: "awaiting_human",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const interactionsSvc = issueThreadInteractionService(db);
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

  it("retries the same reply after a transient answerQuestions failure instead of dropping it", async () => {
    const seeded = await seedAskUserQuestionsBinaryInteraction();
    const send = vi.fn(async () => ({
      externalThreadId: "thread-1",
      externalMessageId: "message-1",
      nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
    }));
    const poll = vi.fn(async () => ({
      status: "ok" as const,
      detail: "ok",
      events: [
        {
          kind: "reply" as const,
          externalEventId: "reply-1",
          externalThreadId: "thread-1",
          externalMessageId: "message-1",
          body: "question 1 is yet it got diaplyed",
          metadata: { clickupReplyId: "reply-1" },
        },
      ],
    }));
    const service = awaitingHumanBridgeService(db, {
      resolveProviderForCompany: async () => "clickup",
      resolveAdapter: () => ({
        send,
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

    replyResolutionFailures.answerQuestions = 1;
    await expect(service.pollBridge(bridge!.id, new Date("2026-05-22T00:03:00.000Z")))
      .rejects.toThrow("transient answer failure");

    const inboundAfterFailure = await db.select().from(awaitingHumanBridgeInboundEvents).where(
      eq(awaitingHumanBridgeInboundEvents.bridgeId, bridge!.id),
    );
    expect(inboundAfterFailure).toHaveLength(0);

    const commentsAfterFailure = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(commentsAfterFailure).toHaveLength(0);

    const [interactionAfterFailure] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId));
    expect(interactionAfterFailure?.status).toBe("pending");

    replyResolutionFailures.answerQuestions = 0;
    const second = await service.pollBridge(bridge!.id, new Date("2026-05-22T00:04:00.000Z"));
    expect(second.replies).toBe(1);

    const [updatedInteraction] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId));
    expect(updatedInteraction?.status).toBe("answered");

    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(updatedIssue?.status).toBe("todo");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe("Clickup reply received:\n\nquestion 1 is yet it got diaplyed");

    const inboundEvents = await db.select().from(awaitingHumanBridgeInboundEvents).where(
      eq(awaitingHumanBridgeInboundEvents.bridgeId, bridge!.id),
    );
    expect(inboundEvents).toHaveLength(1);

    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, seeded.agentId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.payload).toMatchObject({
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      interactionStatus: "answered",
      mutation: "interaction",
    });

    const [updatedBridge] = await db.select().from(awaitingHumanBridges).where(eq(awaitingHumanBridges.id, bridge!.id));
    expect(updatedBridge).toEqual(expect.objectContaining({
      status: "closed",
      closeOutcome: "superseded",
    }));
  });
});
