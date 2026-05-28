import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  awaitingHumanBridges,
  awaitingHumanNotificationOutbox,
  companies,
  companyAwaitingHumanSettings,
  createDb,
  issues,
  issueThreadInteractions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { processAwaitingHumanNotificationOutbox } from "../services/awaiting-human-notifications.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { registerAwaitingHumanBridgeAdapter } from "../services/awaiting-human-bridge-registry.js";

await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = describe;

describeEmbeddedPostgres("awaitingHumanNotificationOutbox", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-awaiting-human-notification-outbox-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(awaitingHumanNotificationOutbox);
    await db.delete(awaitingHumanBridges);
    await db.delete(companyAwaitingHumanSettings);
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("delivers outbox row through configured adapter", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
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
      title: "Awaiting human",
      status: "awaiting_human",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const interactionsSvc = issueThreadInteractionService(db);
    const interaction = await interactionsSvc.create(
      { id: issueId, companyId },
      {
        kind: "request_confirmation",
        payload: {
          version: 1,
          prompt: "Approve this plan?",
        },
      },
      { actorType: "agent", agentId },
    );

    await db.insert(companyAwaitingHumanSettings).values({
      companyId,
      enabled: true,
      provider: "clickup",
      providerConfigJson: null,
    });

    await db.insert(awaitingHumanNotificationOutbox).values({
      companyId,
      issueId,
      dedupeKey: "approval-1",
      handoffKind: "request_confirmation",
      status: "pending",
      attempts: 0,
      notification: {
        title: "Awaiting human",
        summary: "Please review.",
        link: "https://bizbox.example/issues/BIZ-35",
        cta: "Reply in Bizbox.",
        labels: ["awaiting_human", "request_confirmation"],
        interactionId: interaction.id,
      },
    });

    const send = vi.fn(async () => ({
      externalThreadId: "message-42",
      externalMessageId: "message-42",
      nextPollAt: new Date("2026-05-22T00:01:00.000Z"),
    }));
    registerAwaitingHumanBridgeAdapter("clickup", () => ({
      send,
      poll: vi.fn(async () => ({ status: "ok" as const, detail: "ok", events: [] })),
      close: vi.fn(async () => {}),
    }));

    const result = await processAwaitingHumanNotificationOutbox(db, { limit: 10 });

    expect(result).toEqual({
      processed: 1,
      sent: 1,
      failed: 0,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      companyId,
      issueId,
      interactionId: interaction.id,
      handoffKind: "request_confirmation",
      notification: expect.objectContaining({
        title: "Awaiting human",
        summary: "Please review.",
      }),
    }));

    const [row] = await db.select().from(awaitingHumanNotificationOutbox).where(eq(awaitingHumanNotificationOutbox.issueId, issueId));
    expect(row).toEqual(expect.objectContaining({
      status: "sent",
      clickupMessageId: "message-42",
      lastError: null,
    }));
    const [bridge] = await db.select().from(awaitingHumanBridges).where(eq(awaitingHumanBridges.interactionId, interaction.id));
    expect(bridge).toEqual(expect.objectContaining({
      companyId,
      issueId,
      interactionId: interaction.id,
      provider: "clickup",
      status: "waiting_for_human",
      externalMessageId: "message-42",
    }));
  });
});
