import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  agentRuntimeState,
  awaitingHumanBridgeInboundEvents,
  awaitingHumanBridges,
  companyAwaitingHumanSettings,
  companies,
  createDb,
  goals,
  issueComments,
  issueThreadInteractions,
  issues,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat awaiting-human expiration", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let interactionsSvc!: ReturnType<typeof issueThreadInteractionService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-awaiting-human-expiration-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    interactionsSvc = issueThreadInteractionService(db);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedStaleAwaitingHumanBridge() {
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
    await db.insert(companyAwaitingHumanSettings).values({
      companyId,
      enabled: true,
      provider: "clickup",
      providerConfigJson: null,
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

    const oldTimestamp = new Date(Date.now() - (25 * 60 * 60 * 1000));
    const [bridge] = await db.insert(awaitingHumanBridges).values({
      companyId,
      issueId,
      interactionId: interaction.id,
      agentId,
      provider: "clickup",
      status: "waiting_for_human",
      externalMessageId: "message-42",
      externalThreadId: null,
      nextPollAt: new Date(Date.now() - 1_000),
      createdAt: oldTimestamp,
      updatedAt: oldTimestamp,
    }).returning();

    return { companyId, issueId, agentId, interactionId: interaction.id, bridgeId: bridge.id };
  }

  it("expires stale awaiting-human bridges during heartbeat reconciliation", async () => {
    const seeded = await seedStaleAwaitingHumanBridge();
    globalThis.fetch = vi.fn(() => {
      throw new Error("heartbeat should not poll an expired bridge");
    }) as typeof fetch;

    await heartbeat.reconcileAwaitingHumanApprovals();

    expect(globalThis.fetch).not.toHaveBeenCalled();

    const [bridge] = await db.select().from(awaitingHumanBridges)
      .where(eq(awaitingHumanBridges.id, seeded.bridgeId));
    expect(bridge).toEqual(expect.objectContaining({
      status: "closed",
      closeOutcome: "expired",
    }));

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Awaiting human bridge timed out");

    await new Promise((resolve) => setTimeout(resolve, 250));
  });
});
