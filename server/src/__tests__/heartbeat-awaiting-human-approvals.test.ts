import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  goals,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
vi.mock("../otel.js", () => ({
  recordComment: vi.fn(),
  recordHumanIntervened: vi.fn(),
  recordIssueCreated: vi.fn(),
  recordIssueStatusChanged: vi.fn(),
  recordIssueStatusCounts: vi.fn(),
  clearIssueStatusCountsForCompany: vi.fn(),
  traceHumanCommentPosted: vi.fn(),
  recordRunStatus: vi.fn(),
}));
import { heartbeatService } from "../services/heartbeat.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const originalFetch = globalThis.fetch;
const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Processed ClickUp approval wake.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: mockTrackAgentFirstHeartbeat,
  };
});

vi.mock("../adapters/index.js", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

vi.mock("../storage/index.js", () => ({
  getStorageService: () => ({}),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat awaiting_human ClickUp approvals", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let interactionsSvc!: ReturnType<typeof issueThreadInteractionService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-clickup-approvals-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    interactionsSvc = issueThreadInteractionService(db);
  }, 20_000);

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    delete process.env.CLICKUP_PERSONAL_TOKEN;
    delete process.env.CLICKUP_WORKSPACE_ID;
    delete process.env.CLICKUP_APPROVAL_POSITIVE_REACTIONS;
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueThreadInteractions);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function waitForWakeup(agentId: string, timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const wakes = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId));
      if (wakes.length > 0) return wakes;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
  }

  async function seedAwaitingHumanConfirmation(opts?: { externalId?: string | null }) {
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
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Approval bridge goal",
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
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: false,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Awaiting approval",
      status: "awaiting_human",
      priority: "medium",
      assigneeUserId: "local-board",
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

    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.awaiting_human.entered",
      entityType: "issue",
      entityId: issueId,
      details: {
        interactionId: interaction.id,
        notificationDelivery: {
          status: "sent",
          channel: "clickup-chat",
          detail: "sent",
          externalId: opts && "externalId" in opts ? opts.externalId : "message-42",
        },
      },
    });

    return { companyId, goalId, issueId, agentId, interactionId: interaction.id };
  }

  it("accepts a pending confirmation when a ClickUp reply is detected and does not duplicate on rerun", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    const seeded = await seedAwaitingHumanConfirmation();
    globalThis.fetch = vi.fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: "reply-1", content: "approved" }] }),
      }) as typeof fetch;

    const first = await heartbeat.reconcileAwaitingHumanApprovals();
    const second = await heartbeat.reconcileAwaitingHumanApprovals();

    expect(first.approved).toBe(1);
    expect(second.approved).toBe(0);

    const interaction = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId))
      .then((rows) => rows[0] ?? null);
    expect(interaction?.status).toBe("accepted");

    const updatedIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, seeded.issueId))
      .then((rows) => rows[0] ?? null);
    expect(updatedIssue?.assigneeAgentId).toBe(seeded.agentId);

    const wakes = await waitForWakeup(seeded.agentId);
    expect(wakes).toHaveLength(1);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(0);

    const acceptedActivity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.thread_interaction_accepted"));
    expect(acceptedActivity).toHaveLength(1);
    expect(acceptedActivity[0]?.details).toMatchObject({
      interactionId: seeded.interactionId,
      resolutionSource: "clickup_reply",
      clickupMessageId: "message-42",
    });
  });

  it("accepts a pending confirmation when a positive ClickUp reaction is detected", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    const seeded = await seedAwaitingHumanConfirmation();
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ reaction: "heavy_check_mark", count: 1 }] }),
      }) as typeof fetch;

    const result = await heartbeat.reconcileAwaitingHumanApprovals();

    expect(result.approved).toBe(1);
    await waitForWakeup(seeded.agentId);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(0);
    const acceptedActivity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.thread_interaction_accepted"));
    expect(acceptedActivity[0]?.details).toMatchObject({
      interactionId: seeded.interactionId,
      resolutionSource: "clickup_reaction",
      clickupMessageId: "message-42",
      clickupReaction: "heavy_check_mark",
    });
  });

  it("forwards non-approval ClickUp replies into issue comments and wakes the creator agent", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    const seeded = await seedAwaitingHumanConfirmation();
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: "reply-1", content: "Please change the rollout title first." }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: "reply-1", content: "Please change the rollout title first." }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [] }),
      }) as typeof fetch;

    const first = await heartbeat.reconcileAwaitingHumanApprovals();
    const second = await heartbeat.reconcileAwaitingHumanApprovals();

    expect(first.approved).toBe(0);
    expect(second.approved).toBe(0);

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.authorAgentId).toBeNull();
    expect(comments[0]?.authorUserId).toBeNull();
    expect(comments[0]?.body).toBe("ClickUp reply received:\n\nPlease change the rollout title first.");

    const interaction = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId))
      .then((rows) => rows[0] ?? null);
    expect(interaction?.status).toBe("pending");

    const wakes = await waitForWakeup(seeded.agentId);
    expect(wakes).toHaveLength(1);

    const commentActivities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.comment_added"));
    expect(commentActivities).toHaveLength(1);
    expect(commentActivities[0]?.details).toMatchObject({
      interactionId: seeded.interactionId,
      clickupMessageId: "message-42",
      clickupReplyId: "reply-1",
      commentId: comments[0]?.id,
    });
  });

  it("forwards multiple distinct non-approval replies only once each", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    const seeded = await seedAwaitingHumanConfirmation();
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { id: "reply-1", content: "Please revise the title." },
            { id: "reply-2", content: "Also add the rollback note." },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { id: "reply-1", content: "Please revise the title." },
            { id: "reply-2", content: "Also add the rollback note." },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [] }),
      }) as typeof fetch;

    await heartbeat.reconcileAwaitingHumanApprovals();
    await heartbeat.reconcileAwaitingHumanApprovals();

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(2);
    expect(comments.map((comment) => comment.body)).toEqual([
      "ClickUp reply received:\n\nPlease revise the title.",
      "ClickUp reply received:\n\nAlso add the rollback note.",
    ]);

    const wakes = await waitForWakeup(seeded.agentId);
    expect(wakes).toHaveLength(2);
  });

  it("does not enqueue a wake when the issue moved to backlog before forwarding the ClickUp reply", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    const seeded = await seedAwaitingHumanConfirmation();
    globalThis.fetch = vi.fn()
      .mockImplementationOnce(async () => {
        await db
          .update(issues)
          .set({ status: "backlog" })
          .where(eq(issues.id, seeded.issueId));
        return {
          ok: true,
          json: async () => ({
            data: [{ id: "reply-1", content: "Please revise the title." }],
          }),
        };
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [] }),
      }) as typeof fetch;

    const result = await heartbeat.reconcileAwaitingHumanApprovals();

    expect(result.approved).toBe(0);
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);

    const wakes = await waitForWakeup(seeded.agentId, 250);
    expect(wakes).toHaveLength(0);
  });

  it("does not enqueue a wake when the issue closes before forwarding the ClickUp reply", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    const seeded = await seedAwaitingHumanConfirmation();
    globalThis.fetch = vi.fn()
      .mockImplementationOnce(async () => {
        await db
          .update(issues)
          .set({ status: "done" })
          .where(eq(issues.id, seeded.issueId));
        return {
          ok: true,
          json: async () => ({
            data: [{ id: "reply-1", content: "Please revise the title." }],
          }),
        };
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [] }),
      }) as typeof fetch;

    const result = await heartbeat.reconcileAwaitingHumanApprovals();

    expect(result.approved).toBe(0);
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);

    const wakes = await waitForWakeup(seeded.agentId, 250);
    expect(wakes).toHaveLength(0);
  });

  it("does not accept a pending confirmation for neutral or negative reactions", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    const seeded = await seedAwaitingHumanConfirmation();
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ reaction: "eyes", count: 2 }, { reaction: "thumbsdown", count: 1 }] }),
      }) as typeof fetch;

    const result = await heartbeat.reconcileAwaitingHumanApprovals();

    expect(result.approved).toBe(0);
    expect(result.checked).toBe(1);
    expect(result.noApproval).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    const interaction = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId))
      .then((rows) => rows[0] ?? null);
    expect(interaction?.status).toBe("pending");
  });

  it("skips candidates that do not have a stored ClickUp message id", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    const seeded = await seedAwaitingHumanConfirmation({ externalId: null });
    globalThis.fetch = vi.fn() as typeof fetch;

    const result = await heartbeat.reconcileAwaitingHumanApprovals();

    expect(result.approved).toBe(0);
    expect(result.checked).toBe(0);
    expect(result.skipped).toBeGreaterThan(0);
    const interaction = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId))
      .then((rows) => rows[0] ?? null);
    expect(interaction?.status).toBe("pending");
  });
});
