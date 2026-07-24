import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companyUserPushSubscriptions, createDb, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { logActivity } from "../services/activity-log.js";
import { pushSubscriptionService } from "../services/push-subscriptions.js";
import { setPushTransportForTests } from "../services/push-fanout.js";
import type { PushTransport } from "../services/push-transport.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function waitFor(assertion: () => void, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (err) {
      if (Date.now() - start > timeoutMs) throw err;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

describeEmbeddedPostgres("subscribe -> issue.thread_interaction_created -> push fanout", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-push-fanout-integration-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(() => {
    setPushTransportForTests(null);
  });

  async function seedCompany(): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    return companyId;
  }

  it("delivers a push to a subscribed device when a thread interaction is created for that user", async () => {
    const companyId = await seedCompany();
    await pushSubscriptionService(db).subscribe(companyId, "user-1", {
      endpoint: "https://push.example/integration-device",
      p256dh: "p256dh-key",
      auth: "auth-key",
    });

    const transport: PushTransport = { send: vi.fn().mockResolvedValue({ statusCode: 201 }) };
    setPushTransportForTests(transport);

    const issueId = randomUUID();
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: "user-1",
      action: "issue.thread_interaction_created",
      entityType: "issue",
      entityId: issueId,
      details: {
        interactionId: "interaction-1",
        interactionKind: "request_confirmation",
        interactionStatus: "pending",
      },
    });

    await waitFor(() => {
      expect(transport.send).toHaveBeenCalledTimes(1);
    });
    const call = (transport.send as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toMatchObject({ endpoint: "https://push.example/integration-device" });
  });

  it("does not fire a push for non-allowlisted actions even with an active subscription", async () => {
    const companyId = await seedCompany();
    await pushSubscriptionService(db).subscribe(companyId, "user-1", {
      endpoint: "https://push.example/integration-device-2",
      p256dh: "p256dh-key",
      auth: "auth-key",
    });

    const transport: PushTransport = { send: vi.fn().mockResolvedValue({ statusCode: 201 }) };
    setPushTransportForTests(transport);

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: "user-1",
      action: "issue.updated",
      entityType: "issue",
      entityId: randomUUID(),
      details: {},
    });

    // Give the fire-and-forget hook a beat to run (it should be a no-op).
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(transport.send).not.toHaveBeenCalled();
  });
});
