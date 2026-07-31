import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  workflowHandoffBridges,
  workflowHandoffs,
  workflowRunPhases,
  workflowRuns,
  workflows,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mocks = vi.hoisted(() => ({
  addClickUpChatMessageReaction: vi.fn(async () => ({
    status: "sent",
    detail: "sent",
  })),
  deleteClickUpChatMessageReaction: vi.fn(async () => ({
    status: "sent",
    detail: "deleted",
  })),
  detectClickUpAwaitingHumanBridgeEvents: vi.fn(),
  detectClickUpAwaitingHumanBridgeEventsAfterMessage: vi.fn(),
  sendAwaitingHumanNotification: vi.fn(),
  sendAwaitingHumanNotificationReply: vi.fn(),
  logActivity: vi.fn(async () => {}),
}));

vi.mock("../services/clickup-awaiting-human-transport.js", () => ({
  addClickUpChatMessageReaction: mocks.addClickUpChatMessageReaction,
  deleteClickUpChatMessageReaction: mocks.deleteClickUpChatMessageReaction,
  detectClickUpAwaitingHumanBridgeEvents: mocks.detectClickUpAwaitingHumanBridgeEvents,
  detectClickUpAwaitingHumanBridgeEventsAfterMessage: mocks.detectClickUpAwaitingHumanBridgeEventsAfterMessage,
  sendAwaitingHumanNotification: mocks.sendAwaitingHumanNotification,
  sendAwaitingHumanNotificationReply: mocks.sendAwaitingHumanNotificationReply,
}));

vi.mock("../services/awaiting-human-settings.js", () => ({
  awaitingHumanSettingsService: () => ({
    resolveClickUpRuntimeConfig: async () => ({
      enabled: true,
      provider: "clickup",
      personalToken: "token-123",
      workspaceId: "workspace-1",
      channelId: "channel-1",
      attachmentTaskId: "task-sink-1",
    }),
  }),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mocks.logActivity,
}));

const { workflowHandoffBridgeService } = await import("../services/workflow-handoff-bridge.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workflow handoff bridge tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function insertWorkflowHandoff(
  db: ReturnType<typeof createDb>,
  input: { runStatus: string; runError: string | null; promptMarkdown?: string },
) {
  const companyId = randomUUID();
  const workflowId = randomUUID();
  const runId = randomUUID();
  const phaseId = randomUUID();
  const handoffId = randomUUID();

  await db.insert(companies).values({
    id: companyId,
    name: "Paperclip",
    issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(workflows).values({
    id: workflowId,
    companyId,
    title: "Weather Lookup",
    status: "active",
    runnerType: "google_adk",
    runnerConfig: { agentPath: "/tmp/agent.py" },
    pipelineDefinition: { entrypoint: "agent.py", generatedAt: new Date(0).toISOString(), phases: [] },
    pipelineSourceHash: null,
  });
  await db.insert(workflowRuns).values({
    id: runId,
    companyId,
    workflowId,
    status: input.runStatus,
    inputMarkdown: "weather",
    error: input.runError,
  });
  await db.insert(workflowRunPhases).values({
    id: phaseId,
    companyId,
    workflowRunId: runId,
    phaseKey: "phase-1",
    label: "Phase 1",
    kind: "phase",
    ordinal: 0,
    status: "awaiting_human",
  });
  await db.insert(workflowHandoffs).values({
    id: handoffId,
    companyId,
    workflowRunId: runId,
    phaseKey: "phase-1",
    kind: "approval",
    status: "pending",
    promptMarkdown: input.promptMarkdown ?? "Approve Manila?",
  });

  return { companyId, workflowId, runId, phaseId, handoffId };
}

async function insertWaitingWorkflowBridge(
  db: ReturnType<typeof createDb>,
  input: {
    runStatus: string;
    runError: string | null;
    externalThreadId?: string | null;
    externalMessageId?: string;
  },
) {
  const base = await insertWorkflowHandoff(db, input);
  const bridgeId = randomUUID();

  await db.insert(workflowHandoffBridges).values({
    id: bridgeId,
    companyId: base.companyId,
    workflowRunId: base.runId,
    workflowHandoffId: base.handoffId,
    provider: "clickup",
    status: "waiting_for_human",
    externalMessageId: input.externalMessageId ?? "message-1",
    externalThreadId: input.externalThreadId ?? null,
    nextPollAt: new Date(0),
  });

  return { ...base, bridgeId };
}

describeEmbeddedPostgres("workflowHandoffBridgeService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workflow-handoff-bridge-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await db.delete(workflowHandoffBridges);
    await db.delete(workflowHandoffs);
    await db.delete(workflowRunPhases);
    await db.delete(workflowRuns);
    await db.delete(workflows);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("creates a workflow thread root and posts the first handoff as a reply", async () => {
    const { companyId, runId, handoffId } = await insertWorkflowHandoff(db, {
      runStatus: "awaiting_human",
      runError: null,
      promptMarkdown: "Which city should I check?",
    });
    mocks.sendAwaitingHumanNotification.mockResolvedValueOnce({
      status: "sent",
      channel: "clickup-chat",
      detail: "sent",
      externalId: "thread-root-1",
    });
    mocks.sendAwaitingHumanNotificationReply.mockResolvedValueOnce({
      status: "sent",
      channel: "clickup-chat",
      detail: "sent",
      externalId: "question-reply-1",
    });

    const bridge = await workflowHandoffBridgeService(db).openForHandoff({
      id: handoffId,
      companyId,
      workflowRunId: runId,
      kind: "response",
      promptMarkdown: "Which city should I check?",
    });

    expect(mocks.sendAwaitingHumanNotification).toHaveBeenCalledTimes(1);
    expect(mocks.sendAwaitingHumanNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        notification: expect.objectContaining({
          title: "Workflow handoff: Weather Lookup",
          body: expect.stringContaining("Workflow: Weather Lookup"),
        }),
      }),
      expect.objectContaining({ personalToken: "token-123" }),
    );
    expect(mocks.sendAwaitingHumanNotificationReply).toHaveBeenCalledWith(
      "thread-root-1",
      expect.objectContaining({
        notification: expect.objectContaining({
          body: "Which city should I check?",
        }),
      }),
      expect.objectContaining({ personalToken: "token-123" }),
    );
    expect(bridge?.externalThreadId).toBe("thread-root-1");
    expect(bridge?.externalMessageId).toBe("question-reply-1");
    expect(mocks.addClickUpChatMessageReaction).toHaveBeenCalledWith(
      "question-reply-1",
      "brain_is_thinking",
      expect.objectContaining({ personalToken: "token-123" }),
    );
  });

  it("keeps an opened bridge when open activity logging fails", async () => {
    const { companyId, runId, handoffId } = await insertWorkflowHandoff(db, {
      runStatus: "awaiting_human",
      runError: null,
      promptMarkdown: "Which city should I check?",
    });
    mocks.sendAwaitingHumanNotification.mockResolvedValueOnce({
      status: "sent",
      channel: "clickup-chat",
      detail: "sent",
      externalId: "thread-root-1",
    });
    mocks.sendAwaitingHumanNotificationReply.mockResolvedValueOnce({
      status: "sent",
      channel: "clickup-chat",
      detail: "sent",
      externalId: "question-reply-1",
    });
    mocks.logActivity.mockRejectedValueOnce(new Error("activity log unavailable"));

    const bridge = await workflowHandoffBridgeService(db).openForHandoff({
      id: handoffId,
      companyId,
      workflowRunId: runId,
      kind: "response",
      promptMarkdown: "Which city should I check?",
    });

    expect(bridge).not.toBeNull();
    expect(bridge?.status).toBe("waiting_for_human");
    expect(mocks.addClickUpChatMessageReaction).toHaveBeenCalledWith(
      "question-reply-1",
      "brain_is_thinking",
      expect.objectContaining({ personalToken: "token-123" }),
    );
    expect(mocks.logActivity).toHaveBeenCalledTimes(1);

    const [persistedBridge] = await db.select().from(workflowHandoffBridges).where(eq(workflowHandoffBridges.id, bridge!.id));
    expect(persistedBridge?.status).toBe("waiting_for_human");
  });

  it("reuses the existing workflow thread for later handoffs in the same run", async () => {
    const first = await insertWorkflowHandoff(db, {
      runStatus: "awaiting_human",
      runError: null,
    });
    await db.insert(workflowHandoffBridges).values({
      id: randomUUID(),
      companyId: first.companyId,
      workflowRunId: first.runId,
      workflowHandoffId: first.handoffId,
      provider: "clickup",
      status: "closed",
      closeOutcome: "responded",
      externalThreadId: "thread-root-1",
      externalMessageId: "question-reply-1",
      closedAt: new Date(),
    });
    const secondHandoffId = randomUUID();
    await db.insert(workflowHandoffs).values({
      id: secondHandoffId,
      companyId: first.companyId,
      workflowRunId: first.runId,
      phaseKey: "phase-1",
      kind: "response",
      status: "pending",
      promptMarkdown: "Celsius or Fahrenheit?",
    });
    mocks.sendAwaitingHumanNotificationReply.mockResolvedValueOnce({
      status: "sent",
      channel: "clickup-chat",
      detail: "sent",
      externalId: "question-reply-2",
    });

    const bridge = await workflowHandoffBridgeService(db).openForHandoff({
      id: secondHandoffId,
      companyId: first.companyId,
      workflowRunId: first.runId,
      kind: "response",
      promptMarkdown: "Celsius or Fahrenheit?",
    });

    expect(mocks.sendAwaitingHumanNotification).not.toHaveBeenCalled();
    expect(mocks.sendAwaitingHumanNotificationReply).toHaveBeenCalledWith(
      "thread-root-1",
      expect.anything(),
      expect.objectContaining({ personalToken: "token-123" }),
    );
    expect(bridge?.externalThreadId).toBe("thread-root-1");
    expect(bridge?.externalMessageId).toBe("question-reply-2");
  });

  it("polls threaded bridges from the workflow root and resolves replies after the question marker", async () => {
    const { runId, bridgeId, handoffId } = await insertWaitingWorkflowBridge(db, {
      runStatus: "awaiting_human",
      runError: null,
      externalThreadId: "thread-root-1",
      externalMessageId: "question-reply-1",
    });
    const attachmentUrl = "https://cdn.example.test/hero.png";
    const enrichedReply = `Use this as the hero image.\n\n## Attachments from ClickUp\n1. hero.png: ${attachmentUrl}`;
    mocks.detectClickUpAwaitingHumanBridgeEventsAfterMessage.mockResolvedValueOnce({
      status: "sent",
      detail: "replies-detected",
      events: [{
        kind: "reply",
        externalEventId: "human-reply-1",
        externalThreadId: "thread-root-1",
        externalMessageId: "question-reply-1",
        body: enrichedReply,
        metadata: {
          clickupReplyId: "human-reply-1",
          clickupAttachments: [{
            url: attachmentUrl,
            label: "hero.png",
            mimeType: "image/png",
          }],
        },
      }],
    });

    const result = await workflowHandoffBridgeService(db).pollActiveBridges();

    expect(result.resolved).toBe(1);
    expect(mocks.detectClickUpAwaitingHumanBridgeEventsAfterMessage).toHaveBeenCalledWith(
      "thread-root-1",
      "question-reply-1",
      expect.objectContaining({ personalToken: "token-123" }),
    );
    expect(mocks.detectClickUpAwaitingHumanBridgeEvents).not.toHaveBeenCalled();
    expect(mocks.addClickUpChatMessageReaction).toHaveBeenCalledWith(
      "human-reply-1",
      "white_check_mark",
      expect.objectContaining({ personalToken: "token-123" }),
    );

    const [bridge] = await db.select().from(workflowHandoffBridges).where(eq(workflowHandoffBridges.id, bridgeId));
    expect(bridge?.status).toBe("closed");
    expect(bridge?.closeOutcome).toBe("responded");
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(run?.status).toBe("running");
    const [handoff] = await db.select().from(workflowHandoffs).where(eq(workflowHandoffs.id, handoffId));
    expect(handoff?.responseMarkdown).toBe(enrichedReply);
  });

  it("records missing threaded question markers as poll failures", async () => {
    const { bridgeId } = await insertWaitingWorkflowBridge(db, {
      runStatus: "awaiting_human",
      runError: null,
      externalThreadId: "thread-root-1",
      externalMessageId: "question-reply-1",
    });
    mocks.detectClickUpAwaitingHumanBridgeEventsAfterMessage.mockResolvedValueOnce({
      status: "failed",
      detail: "question-marker-not-found",
      events: [],
    });

    const result = await workflowHandoffBridgeService(db).pollActiveBridges();

    expect(result.failed).toBe(1);
    expect(result.noSignal).toBe(0);

    const [bridge] = await db.select().from(workflowHandoffBridges).where(eq(workflowHandoffBridges.id, bridgeId));
    expect(bridge?.status).toBe("waiting_for_human");
    expect(bridge?.lastError).toBe("question-marker-not-found");
    expect(bridge?.nextPollAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it("still resolves accepted replies when resolution activity logging fails", async () => {
    const { runId, bridgeId } = await insertWaitingWorkflowBridge(db, {
      runStatus: "awaiting_human",
      runError: null,
      externalThreadId: "thread-root-1",
      externalMessageId: "question-reply-1",
    });
    mocks.detectClickUpAwaitingHumanBridgeEventsAfterMessage.mockResolvedValueOnce({
      status: "sent",
      detail: "replies-detected",
      events: [{
        kind: "reply",
        externalEventId: "human-reply-1",
        externalThreadId: "thread-root-1",
        externalMessageId: "question-reply-1",
        body: "Sydney",
        metadata: { clickupReplyId: "human-reply-1" },
      }],
    });
    mocks.logActivity.mockRejectedValueOnce(new Error("activity log unavailable"));

    const result = await workflowHandoffBridgeService(db).pollActiveBridges();

    expect(result.resolved).toBe(1);
    expect(result.failed).toBe(0);
    expect(mocks.addClickUpChatMessageReaction).toHaveBeenCalledWith(
      "human-reply-1",
      "white_check_mark",
      expect.objectContaining({ personalToken: "token-123" }),
    );

    const [bridge] = await db.select().from(workflowHandoffBridges).where(eq(workflowHandoffBridges.id, bridgeId));
    expect(bridge?.status).toBe("closed");
    expect(bridge?.closeOutcome).toBe("responded");
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(run?.status).toBe("running");
  });

  it("closes terminal run bridges without accepting late replies", async () => {
    const { runId, phaseId, handoffId, bridgeId } = await insertWaitingWorkflowBridge(db, {
      runStatus: "failed",
      runError: "Tool failed",
    });

    mocks.detectClickUpAwaitingHumanBridgeEvents.mockResolvedValueOnce({
      status: "sent",
      detail: "ok",
      events: [{
        kind: "reply",
        externalEventId: "reply-1",
        externalMessageId: "message-1",
        body: "yes",
        metadata: { clickupReplyId: "reply-1" },
      }],
    });

    const result = await workflowHandoffBridgeService(db).pollActiveBridges();

    expect(result.checked).toBe(1);
    expect(mocks.detectClickUpAwaitingHumanBridgeEvents).toHaveBeenCalledWith(
      "message-1",
      expect.objectContaining({ personalToken: "token-123" }),
    );
    expect(mocks.detectClickUpAwaitingHumanBridgeEventsAfterMessage).not.toHaveBeenCalled();
    expect(result.failed).toBe(0);
    expect(result.terminalClosed).toBe(1);
    expect(mocks.addClickUpChatMessageReaction).toHaveBeenCalledWith(
      "reply-1",
      "x",
      expect.objectContaining({ personalToken: "token-123" }),
    );
    expect(mocks.addClickUpChatMessageReaction).toHaveBeenCalledWith(
      "message-1",
      "x",
      expect.objectContaining({ personalToken: "token-123" }),
    );
    expect(mocks.addClickUpChatMessageReaction).not.toHaveBeenCalledWith(
      expect.any(String),
      "white_check_mark",
      expect.anything(),
    );

    const [bridge] = await db.select().from(workflowHandoffBridges).where(eq(workflowHandoffBridges.id, bridgeId));
    expect(bridge?.status).toBe("closed");
    expect(bridge?.closeOutcome).toBe("failed");
    expect(bridge?.nextPollAt).toBeNull();

    const [handoff] = await db.select().from(workflowHandoffs).where(eq(workflowHandoffs.id, handoffId));
    expect(handoff?.status).toBe("cancelled");
    expect(handoff?.responseMarkdown).toBeNull();

    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(run?.status).toBe("failed");

    const [phase] = await db.select().from(workflowRunPhases).where(eq(workflowRunPhases.id, phaseId));
    expect(phase?.status).toBe("awaiting_human");
  });

  it("closes timed out terminal bridges as expired and stops polling", async () => {
    const { bridgeId } = await insertWaitingWorkflowBridge(db, {
      runStatus: "failed",
      runError: "Timed out after 86400s",
    });

    mocks.detectClickUpAwaitingHumanBridgeEvents.mockResolvedValueOnce({
      status: "sent",
      detail: "ok",
      events: [],
    });

    const result = await workflowHandoffBridgeService(db).pollActiveBridges();

    expect(result.checked).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.terminalClosed).toBe(1);
    expect(mocks.deleteClickUpChatMessageReaction).toHaveBeenCalledWith(
      "message-1",
      "brain_is_thinking",
      expect.objectContaining({ personalToken: "token-123" }),
    );
    expect(mocks.addClickUpChatMessageReaction).toHaveBeenCalledWith(
      "message-1",
      "x",
      expect.objectContaining({ personalToken: "token-123" }),
    );

    const [bridge] = await db.select().from(workflowHandoffBridges).where(eq(workflowHandoffBridges.id, bridgeId));
    expect(bridge?.status).toBe("closed");
    expect(bridge?.closeOutcome).toBe("expired");
    expect(bridge?.nextPollAt).toBeNull();
  });

  it("closes terminal succeeded bridges with accepted outcome when handoff is already resolved", async () => {
    const { bridgeId, handoffId } = await insertWaitingWorkflowBridge(db, {
      runStatus: "succeeded",
      runError: null,
    });
    await db.update(workflowHandoffs).set({
      status: "approved",
      responseMarkdown: "Looks good",
      decidedByUserId: "clickup_bridge",
      decidedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(workflowHandoffs.id, handoffId));

    mocks.detectClickUpAwaitingHumanBridgeEvents.mockResolvedValueOnce({
      status: "sent",
      detail: "ok",
      events: [{
        kind: "approval_signal",
        externalEventId: "reply-1",
        externalMessageId: "message-1",
        body: "approve",
        metadata: { clickupReplyId: "reply-1" },
      }],
    });

    const result = await workflowHandoffBridgeService(db).pollActiveBridges();

    expect(result.checked).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.terminalClosed).toBe(1);
    expect(mocks.addClickUpChatMessageReaction).toHaveBeenCalledWith(
      "reply-1",
      "white_check_mark",
      expect.objectContaining({ personalToken: "token-123" }),
    );
    expect(mocks.addClickUpChatMessageReaction).toHaveBeenCalledWith(
      "message-1",
      "white_check_mark",
      expect.objectContaining({ personalToken: "token-123" }),
    );
    expect(mocks.addClickUpChatMessageReaction).not.toHaveBeenCalledWith(
      expect.any(String),
      "x",
      expect.anything(),
    );

    const [bridge] = await db.select().from(workflowHandoffBridges).where(eq(workflowHandoffBridges.id, bridgeId));
    expect(bridge?.status).toBe("closed");
    expect(bridge?.closeOutcome).toBe("approved");

    const [handoff] = await db.select().from(workflowHandoffs).where(eq(workflowHandoffs.id, handoffId));
    expect(handoff?.status).toBe("approved");
    expect(handoff?.responseMarkdown).toBe("Looks good");
  });

  it("closes terminal threaded bridges even when the question marker cannot be found", async () => {
    const { bridgeId } = await insertWaitingWorkflowBridge(db, {
      runStatus: "failed",
      runError: "Tool failed",
      externalThreadId: "thread-root-1",
      externalMessageId: "question-reply-1",
    });

    mocks.detectClickUpAwaitingHumanBridgeEventsAfterMessage.mockResolvedValueOnce({
      status: "failed",
      detail: "question-marker-not-found",
      events: [],
    });

    const result = await workflowHandoffBridgeService(db).pollActiveBridges();

    expect(result.checked).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.terminalClosed).toBe(1);
    expect(mocks.detectClickUpAwaitingHumanBridgeEventsAfterMessage).toHaveBeenCalledWith(
      "thread-root-1",
      "question-reply-1",
      expect.objectContaining({ personalToken: "token-123" }),
    );
    expect(mocks.addClickUpChatMessageReaction).toHaveBeenCalledTimes(1);
    expect(mocks.addClickUpChatMessageReaction).toHaveBeenCalledWith(
      "question-reply-1",
      "x",
      expect.objectContaining({ personalToken: "token-123" }),
    );

    const [bridge] = await db.select().from(workflowHandoffBridges).where(eq(workflowHandoffBridges.id, bridgeId));
    expect(bridge?.status).toBe("closed");
    expect(bridge?.closeOutcome).toBe("failed");
    expect(bridge?.lastError).toBe("question-marker-not-found");
    expect(bridge?.nextPollAt).toBeNull();
  });

  it("closes active bridges after direct handoff resolution", async () => {
    const { bridgeId, handoffId } = await insertWaitingWorkflowBridge(db, {
      runStatus: "running",
      runError: null,
    });

    const bridge = await workflowHandoffBridgeService(db).closeResolvedHandoff(handoffId, "approved");

    expect(bridge?.id).toBe(bridgeId);
    expect(bridge?.status).toBe("closed");
    expect(bridge?.closeOutcome).toBe("approved");
    expect(bridge?.nextPollAt).toBeNull();
    expect(mocks.deleteClickUpChatMessageReaction).toHaveBeenCalledWith(
      "message-1",
      "brain_is_thinking",
      expect.objectContaining({ personalToken: "token-123" }),
    );
    expect(mocks.addClickUpChatMessageReaction).toHaveBeenCalledWith(
      "message-1",
      "white_check_mark",
      expect.objectContaining({ personalToken: "token-123" }),
    );
  });

  it("closes stale accepted bridges with accepted reactions", async () => {
    const { bridgeId, handoffId } = await insertWaitingWorkflowBridge(db, {
      runStatus: "running",
      runError: null,
    });
    await db.update(workflowHandoffs).set({
      status: "approved",
      responseMarkdown: "Looks good",
      decidedByUserId: "clickup_bridge",
      decidedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(workflowHandoffs.id, handoffId));

    mocks.detectClickUpAwaitingHumanBridgeEvents.mockResolvedValueOnce({
      status: "sent",
      detail: "ok",
      events: [{
        kind: "approval_signal",
        externalEventId: "reply-1",
        externalMessageId: "message-1",
        body: "approve",
        metadata: { clickupReplyId: "reply-1" },
      }],
    });

    const result = await workflowHandoffBridgeService(db).pollActiveBridges();

    expect(result.resolved).toBe(1);
    expect(result.terminalClosed).toBe(0);
    expect(mocks.addClickUpChatMessageReaction).toHaveBeenCalledWith(
      "reply-1",
      "white_check_mark",
      expect.objectContaining({ personalToken: "token-123" }),
    );
    expect(mocks.addClickUpChatMessageReaction).toHaveBeenCalledWith(
      "message-1",
      "white_check_mark",
      expect.objectContaining({ personalToken: "token-123" }),
    );
    expect(mocks.addClickUpChatMessageReaction).not.toHaveBeenCalledWith(
      expect.any(String),
      "x",
      expect.anything(),
    );

    const [bridge] = await db.select().from(workflowHandoffBridges).where(eq(workflowHandoffBridges.id, bridgeId));
    expect(bridge?.status).toBe("closed");
    expect(bridge?.closeOutcome).toBe("approved");

    const [handoff] = await db.select().from(workflowHandoffs).where(eq(workflowHandoffs.id, handoffId));
    expect(handoff?.status).toBe("approved");
    expect(handoff?.responseMarkdown).toBe("Looks good");
  });

  it("continues polling terminal bridges when terminal cleanup logging fails", async () => {
    const first = await insertWaitingWorkflowBridge(db, {
      runStatus: "failed",
      runError: "Tool failed",
    });
    const second = await insertWaitingWorkflowBridge(db, {
      runStatus: "failed",
      runError: "Tool failed",
    });

    mocks.detectClickUpAwaitingHumanBridgeEvents.mockResolvedValue({
      status: "sent",
      detail: "ok",
      events: [],
    });
    mocks.logActivity.mockRejectedValueOnce(new Error("activity log unavailable"));

    const result = await workflowHandoffBridgeService(db).pollActiveBridges();

    expect(result.checked).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.terminalClosed).toBe(2);

    const [firstBridge] = await db.select().from(workflowHandoffBridges).where(eq(workflowHandoffBridges.id, first.bridgeId));
    const [secondBridge] = await db.select().from(workflowHandoffBridges).where(eq(workflowHandoffBridges.id, second.bridgeId));
    expect(firstBridge?.status).toBe("closed");
    expect(secondBridge?.status).toBe("closed");
  });

  it("continues polling active bridges when poll-failure logging fails", async () => {
    const first = await insertWaitingWorkflowBridge(db, {
      runStatus: "awaiting_human",
      runError: null,
    });
    const second = await insertWaitingWorkflowBridge(db, {
      runStatus: "awaiting_human",
      runError: null,
    });

    mocks.detectClickUpAwaitingHumanBridgeEvents
      .mockRejectedValueOnce(new Error("ClickUp timeout"))
      .mockResolvedValueOnce({
        status: "sent",
        detail: "no-replies",
        events: [],
      });
    mocks.logActivity.mockRejectedValueOnce(new Error("activity log unavailable"));

    const result = await workflowHandoffBridgeService(db).pollActiveBridges();

    expect(result.checked).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.noSignal).toBe(1);

    const [firstBridge] = await db.select().from(workflowHandoffBridges).where(eq(workflowHandoffBridges.id, first.bridgeId));
    const [secondBridge] = await db.select().from(workflowHandoffBridges).where(eq(workflowHandoffBridges.id, second.bridgeId));
    expect(firstBridge?.lastError).toBe("ClickUp timeout");
    expect(secondBridge?.lastError).toBeNull();
  });

  it("rejects replies if the workflow becomes terminal after polling even when closure logging fails", async () => {
    const { runId, handoffId, bridgeId } = await insertWaitingWorkflowBridge(db, {
      runStatus: "awaiting_human",
      runError: null,
    });

    mocks.detectClickUpAwaitingHumanBridgeEvents.mockImplementationOnce(async () => {
      await db.update(workflowRuns).set({
        status: "failed",
        error: "Tool failed",
        finishedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(workflowRuns.id, runId));
      return {
        status: "sent",
        detail: "ok",
        events: [{
          kind: "reply",
          externalEventId: "reply-1",
          externalMessageId: "message-1",
          body: "yes",
          metadata: { clickupReplyId: "reply-1" },
        }],
      };
    });
    mocks.logActivity.mockRejectedValueOnce(new Error("activity log unavailable"));

    const result = await workflowHandoffBridgeService(db).pollActiveBridges();

    expect(result.checked).toBe(1);
    expect(result.resolved).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.terminalClosed).toBe(1);
    expect(mocks.addClickUpChatMessageReaction).toHaveBeenCalledWith(
      "reply-1",
      "x",
      expect.objectContaining({ personalToken: "token-123" }),
    );
    expect(mocks.addClickUpChatMessageReaction).toHaveBeenCalledWith(
      "message-1",
      "x",
      expect.objectContaining({ personalToken: "token-123" }),
    );
    expect(mocks.addClickUpChatMessageReaction).not.toHaveBeenCalledWith(
      expect.any(String),
      "white_check_mark",
      expect.anything(),
    );
    expect(mocks.logActivity).toHaveBeenCalledTimes(1);
    expect(mocks.logActivity).toHaveBeenCalledWith(db, expect.objectContaining({
      action: "workflow.handoff.bridge_closed_terminal",
    }));

    const [handoff] = await db.select().from(workflowHandoffs).where(eq(workflowHandoffs.id, handoffId));
    expect(handoff?.status).toBe("cancelled");
    expect(handoff?.responseMarkdown).toBeNull();

    const [bridge] = await db.select().from(workflowHandoffBridges).where(eq(workflowHandoffBridges.id, bridgeId));
    expect(bridge?.status).toBe("closed");
    expect(bridge?.closeOutcome).toBe("failed");
    expect(bridge?.nextPollAt).toBeNull();
  });
});
