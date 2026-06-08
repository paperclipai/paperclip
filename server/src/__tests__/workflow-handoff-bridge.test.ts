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
  sendAwaitingHumanNotification: vi.fn(),
  logActivity: vi.fn(async () => {}),
}));

vi.mock("../services/clickup-awaiting-human-transport.js", () => ({
  addClickUpChatMessageReaction: mocks.addClickUpChatMessageReaction,
  deleteClickUpChatMessageReaction: mocks.deleteClickUpChatMessageReaction,
  detectClickUpAwaitingHumanBridgeEvents: mocks.detectClickUpAwaitingHumanBridgeEvents,
  sendAwaitingHumanNotification: mocks.sendAwaitingHumanNotification,
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

async function insertWaitingWorkflowBridge(
  db: ReturnType<typeof createDb>,
  input: { runStatus: string; runError: string | null },
) {
  const companyId = randomUUID();
  const workflowId = randomUUID();
  const runId = randomUUID();
  const phaseId = randomUUID();
  const handoffId = randomUUID();
  const bridgeId = randomUUID();

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
    promptMarkdown: "Approve Manila?",
  });
  await db.insert(workflowHandoffBridges).values({
    id: bridgeId,
    companyId,
    workflowRunId: runId,
    workflowHandoffId: handoffId,
    provider: "clickup",
    status: "waiting_for_human",
    externalMessageId: "message-1",
    nextPollAt: new Date(0),
  });

  return { runId, phaseId, handoffId, bridgeId };
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

  it("rejects replies if the workflow becomes terminal after polling", async () => {
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

    const [handoff] = await db.select().from(workflowHandoffs).where(eq(workflowHandoffs.id, handoffId));
    expect(handoff?.status).toBe("cancelled");
    expect(handoff?.responseMarkdown).toBeNull();

    const [bridge] = await db.select().from(workflowHandoffBridges).where(eq(workflowHandoffBridges.id, bridgeId));
    expect(bridge?.status).toBe("closed");
    expect(bridge?.closeOutcome).toBe("failed");
    expect(bridge?.nextPollAt).toBeNull();
  });
});
