import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  awaitingHumanNotificationOutbox,
  companies,
  createDb,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { processAwaitingHumanNotificationOutbox } from "../services/awaiting-human-notifications.js";

const originalFetch = globalThis.fetch;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = describe.skip;

describeEmbeddedPostgres("awaitingHumanNotificationOutbox", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-awaiting-human-notification-outbox-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    delete process.env.CLICKUP_PERSONAL_TOKEN;
    delete process.env.CLICKUP_WORKSPACE_ID;
    delete process.env.CLICKUP_AWAITING_HUMAN_CHANNEL_ID;
    await db.delete(awaitingHumanNotificationOutbox);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("delivers an outbox row with legacy env config when no company awaiting-human settings row exists", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Awaiting human",
      status: "todo",
      priority: "medium",
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
      },
    });

    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";
    process.env.CLICKUP_AWAITING_HUMAN_CHANNEL_ID = "channel-1";

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { id: "message-42" } }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await processAwaitingHumanNotificationOutbox(db, { limit: 10 });

    expect(result).toEqual({
      processed: 1,
      sent: 1,
      failed: 0,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clickup.com/api/v3/workspaces/workspace-1/chat/channels/channel-1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "token-123",
        }),
      }),
    );

    const [row] = await db.select().from(awaitingHumanNotificationOutbox).where(eq(awaitingHumanNotificationOutbox.issueId, issueId));
    expect(row).toEqual(expect.objectContaining({
      status: "sent",
      clickupMessageId: "message-42",
      lastError: null,
    }));
  });
});
