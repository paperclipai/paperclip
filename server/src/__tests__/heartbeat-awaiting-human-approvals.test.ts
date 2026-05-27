import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  awaitingHumanBridgeInboundEvents,
  awaitingHumanBridges,
  companyAwaitingHumanSettings,
  companySecretVersions,
  companySecrets,
  companies,
  createDb,
  companySkills,
  environmentLeases,
  goals,
  heartbeatRunEvents,
  heartbeatRuns,
  agentRuntimeState,
  instanceSettings,
  issueComments,
  issueDocuments,
  issueThreadInteractions,
  issues,
  documentRevisions,
  documents,
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
import { secretService } from "../services/secrets.js";

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
const describeEmbeddedPostgres = describe.skip;

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
    await db.execute(sql`
      truncate table
        ${activityLog},
        ${heartbeatRunEvents},
        ${agentRuntimeState},
        ${heartbeatRuns},
        ${agentWakeupRequests},
        ${awaitingHumanBridgeInboundEvents},
        ${awaitingHumanBridges},
        ${environmentLeases},
        ${companyAwaitingHumanSettings},
        ${companySecretVersions},
        ${companySecrets},
        ${companySkills},
        ${issueDocuments},
        ${documents},
        ${issueThreadInteractions},
        ${issueComments},
        ${issues},
        ${goals},
        ${documentRevisions},
        ${agents},
        ${instanceSettings},
        ${companies}
      restart identity cascade
    `);
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
    const secrets = secretService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const secret = await secrets.create(companyId, {
      name: "clickup-personal-token",
      provider: "local_encrypted",
      value: "token-123",
    });
    await db.insert(companyAwaitingHumanSettings).values({
      companyId,
      enabled: true,
      provider: "clickup",
      providerConfigJson: {
        authTokenRef: { type: "secret_ref", secretId: secret.id, version: "latest" },
        workspaceId: "workspace-1",
        channelId: "channel-1",
      },
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

    await db.insert(awaitingHumanBridges).values({
      companyId,
      issueId,
      interactionId: interaction.id,
      agentId,
      provider: "clickup",
      status: "waiting_for_human",
      externalMessageId: opts && "externalId" in opts ? opts.externalId : "message-42",
      externalThreadId: null,
      nextPollAt: new Date(Date.now() - 1_000),
    });

    return { companyId, goalId, issueId, agentId, interactionId: interaction.id };
  }

  it("accepts a pending confirmation when a ClickUp reply is detected and does not duplicate on rerun", async () => {
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
    const bridges = await db.select().from(awaitingHumanBridges)
      .where(eq(awaitingHumanBridges.interactionId, seeded.interactionId));
    expect(bridges).toHaveLength(1);
    expect(bridges[0]).toEqual(expect.objectContaining({
      externalMessageId: "message-42",
      status: "closed",
      closeOutcome: "approved",
    }));

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
    const seeded = await seedAwaitingHumanConfirmation();
    globalThis.fetch = vi.fn()
      .mockImplementationOnce(async () => ({
        ok: true,
        json: async () => ({ data: [] }),
      }))
      .mockImplementation(async () => ({
        ok: true,
        json: async () => ({ data: [{ reaction: "heavy_check_mark", count: 1 }] }),
      })) as typeof fetch;

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

  it("imports non-approval ClickUp replies as comments and leaves the bridge open", async () => {
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
      }) as typeof fetch;

    const first = await heartbeat.reconcileAwaitingHumanApprovals();
    const second = await heartbeat.reconcileAwaitingHumanApprovals();

    expect(first.approved).toBe(0);
    expect(first.rejected).toBe(0);
    expect(first.replies).toBe(1);
    expect(second.approved).toBe(0);
    expect(second.rejected).toBe(0);
    expect(second.replies).toBe(0);

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

    const updatedIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, seeded.issueId))
      .then((rows) => rows[0] ?? null);
    expect(updatedIssue?.status).toBe("awaiting_human");

    const wakes = await waitForWakeup(seeded.agentId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.payload).toMatchObject({
      issueId: seeded.issueId,
      interactionId: seeded.interactionId,
      commentId: comments[0]?.id,
      mutation: "comment",
    });

    const [updatedBridge] = await db
      .select()
      .from(awaitingHumanBridges)
      .where(eq(awaitingHumanBridges.interactionId, seeded.interactionId));
    expect(updatedBridge).toEqual(expect.objectContaining({
      status: "waiting_for_human",
      closeOutcome: null,
    }));

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

  it("imports multiple non-approval replies as comments while leaving the bridge open", async () => {
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
      }) as typeof fetch;

    const first = await heartbeat.reconcileAwaitingHumanApprovals();
    const second = await heartbeat.reconcileAwaitingHumanApprovals();

    expect(first.approved).toBe(0);
    expect(first.rejected).toBe(0);
    expect(first.replies).toBe(2);
    expect(second.approved).toBe(0);
    expect(second.rejected).toBe(0);
    expect(second.replies).toBe(0);

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(2);
    expect(comments.map((comment) => comment.body)).toEqual([
      "ClickUp reply received:\n\nPlease revise the title.",
      "ClickUp reply received:\n\nAlso add the rollback note.",
    ]);

    const interaction = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId))
      .then((rows) => rows[0] ?? null);
    expect(interaction?.status).toBe("pending");

    const updatedIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, seeded.issueId))
      .then((rows) => rows[0] ?? null);
    expect(updatedIssue?.status).toBe("awaiting_human");

    const wakes = await waitForWakeup(seeded.agentId);
    expect(wakes).toHaveLength(2);

    const [updatedBridge] = await db
      .select()
      .from(awaitingHumanBridges)
      .where(eq(awaitingHumanBridges.interactionId, seeded.interactionId));
    expect(updatedBridge).toEqual(expect.objectContaining({
      status: "waiting_for_human",
      closeOutcome: null,
    }));
  });

  it("imports a non-approval reply without enqueuing a wake when the issue moved to backlog first", async () => {
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
    expect(result.rejected).toBe(0);
    expect(result.replies).toBe(1);
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);

    const interaction = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId))
      .then((rows) => rows[0] ?? null);
    expect(interaction?.status).toBe("pending");

    const updatedIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, seeded.issueId))
      .then((rows) => rows[0] ?? null);
    expect(updatedIssue?.status).toBe("backlog");

    const [updatedBridge] = await db
      .select()
      .from(awaitingHumanBridges)
      .where(eq(awaitingHumanBridges.interactionId, seeded.interactionId));
    expect(updatedBridge).toEqual(expect.objectContaining({
      status: "waiting_for_human",
      closeOutcome: null,
    }));

    const wakes = await waitForWakeup(seeded.agentId, 250);
    expect(wakes).toHaveLength(0);
  });

  it("imports a non-approval reply without enqueuing a wake when the issue closes first", async () => {
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
    expect(result.rejected).toBe(0);
    expect(result.replies).toBe(1);
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);

    const interaction = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId))
      .then((rows) => rows[0] ?? null);
    expect(interaction?.status).toBe("pending");

    const updatedIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, seeded.issueId))
      .then((rows) => rows[0] ?? null);
    expect(updatedIssue?.status).toBe("done");

    const [updatedBridge] = await db
      .select()
      .from(awaitingHumanBridges)
      .where(eq(awaitingHumanBridges.interactionId, seeded.interactionId));
    expect(updatedBridge).toEqual(expect.objectContaining({
      status: "waiting_for_human",
      closeOutcome: null,
    }));

    const wakes = await waitForWakeup(seeded.agentId, 250);
    expect(wakes).toHaveLength(0);
  });

  it("does not accept a pending confirmation for neutral or negative reactions", async () => {
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
    const seeded = await seedAwaitingHumanConfirmation({ externalId: null });
    globalThis.fetch = vi.fn() as typeof fetch;

    const result = await heartbeat.reconcileAwaitingHumanApprovals();

    expect(result.approved).toBe(0);
    expect(result.checked).toBe(1);
    expect(result.skipped).toBeGreaterThan(0);
    const interaction = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, seeded.interactionId))
      .then((rows) => rows[0] ?? null);
    expect(interaction?.status).toBe("pending");
  });

});
