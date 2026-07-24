import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  companies,
  companyUserPushSubscriptions,
  createDb,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { configurePushFanout, firePushFanoutForActivity, type PushFanoutActivityContext } from "./push-fanout.js";
import type { PushTransport } from "./push-transport.js";
import { logger } from "../middleware/logger.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("configurePushFanout", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("logs a no-op notice and leaves fanout inert when VAPID keys are absent (app boots without them)", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    configurePushFanout({ vapidPublicKey: undefined, vapidPrivateKey: undefined, vapidSubject: undefined });

    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("VAPID keys not configured"),
    );
    // No VAPID key value of any kind should ever appear in a log call.
    for (const call of infoSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toMatch(/private/i);
    }

    await expect(
      firePushFanoutForActivity({} as never, {
        companyId: "company-1",
        action: "issue.thread_interaction_created",
        entityType: "issue",
        entityId: "issue-1",
        responsibleUserId: "user-1",
        activityLogId: "activity-1",
        details: null,
      }),
    ).resolves.toBeUndefined();
  });

  it("never logs the VAPID private key when keys are configured", () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => logger);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const secretPrivateKey = "vapid-private-secret-value";

    configurePushFanout({
      vapidPublicKey: "vapid-public-value",
      vapidPrivateKey: secretPrivateKey,
      vapidSubject: "mailto:ops@example.com",
    });

    for (const spy of [infoSpy, debugSpy, warnSpy]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(secretPrivateKey);
      }
    }
  });
});

describeEmbeddedPostgres("firePushFanoutForActivity", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-push-fanout-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
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

  async function seedActivityLogRow(companyId: string): Promise<string> {
    const [row] = await db
      .insert(activityLog)
      .values({
        companyId,
        actorType: "agent",
        actorId: "agent-1",
        action: "issue.thread_interaction_created",
        entityType: "issue",
        entityId: randomUUID(),
      })
      .returning({ id: activityLog.id });
    return row.id;
  }

  async function seedSubscription(
    companyId: string,
    userId: string,
    overrides: Partial<{ endpoint: string; revokedAt: Date | null }> = {},
  ): Promise<string> {
    const [row] = await db
      .insert(companyUserPushSubscriptions)
      .values({
        companyId,
        userId,
        endpoint: overrides.endpoint ?? `https://push.example/${randomUUID()}`,
        p256dh: "p256dh-key",
        auth: "auth-key",
        revokedAt: overrides.revokedAt ?? null,
      })
      .returning({ id: companyUserPushSubscriptions.id });
    return row.id;
  }

  function baseCtx(overrides: Partial<PushFanoutActivityContext> = {}): PushFanoutActivityContext {
    return {
      companyId: "",
      action: "issue.thread_interaction_created",
      entityType: "issue",
      entityId: randomUUID(),
      responsibleUserId: "user-1",
      activityLogId: "",
      details: { interactionId: "interaction-1" },
      ...overrides,
    };
  }

  it("does not send when the action is not allowlisted", async () => {
    const companyId = await seedCompany();
    const activityLogId = await seedActivityLogRow(companyId);
    await seedSubscription(companyId, "user-1");
    const transport: PushTransport = { send: vi.fn().mockResolvedValue({ statusCode: 201 }) };

    await firePushFanoutForActivity(
      db,
      baseCtx({ companyId, activityLogId, action: "issue.updated" }),
      transport,
    );

    expect(transport.send).not.toHaveBeenCalled();
  });

  it("does not send when there is no responsible user", async () => {
    const companyId = await seedCompany();
    const activityLogId = await seedActivityLogRow(companyId);
    await seedSubscription(companyId, "user-1");
    const transport: PushTransport = { send: vi.fn().mockResolvedValue({ statusCode: 201 }) };

    await firePushFanoutForActivity(
      db,
      baseCtx({ companyId, activityLogId, responsibleUserId: null }),
      transport,
    );

    expect(transport.send).not.toHaveBeenCalled();
  });

  it("is a no-op when no transport is configured", async () => {
    const companyId = await seedCompany();
    const activityLogId = await seedActivityLogRow(companyId);
    await seedSubscription(companyId, "user-1");

    await expect(
      firePushFanoutForActivity(db, baseCtx({ companyId, activityLogId }), null),
    ).resolves.toBeUndefined();
  });

  it("sends exactly one push per non-revoked subscribed device for the responsible user", async () => {
    const companyId = await seedCompany();
    const activityLogId = await seedActivityLogRow(companyId);
    await seedSubscription(companyId, "user-1", { endpoint: "https://push.example/device-a" });
    await seedSubscription(companyId, "user-1", { endpoint: "https://push.example/device-b" });
    await seedSubscription(companyId, "user-1", {
      endpoint: "https://push.example/device-revoked",
      revokedAt: new Date(),
    });
    // Different user in the same company must not receive a push.
    await seedSubscription(companyId, "user-2", { endpoint: "https://push.example/other-user" });

    const transport: PushTransport = { send: vi.fn().mockResolvedValue({ statusCode: 201 }) };

    await firePushFanoutForActivity(db, baseCtx({ companyId, activityLogId }), transport);

    expect(transport.send).toHaveBeenCalledTimes(2);
    const sentEndpoints = (transport.send as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0].endpoint,
    );
    expect(sentEndpoints.sort()).toEqual([
      "https://push.example/device-a",
      "https://push.example/device-b",
    ]);
  });

  it("does not send to subscriptions belonging to a different company", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const activityLogId = await seedActivityLogRow(companyId);
    await seedSubscription(otherCompanyId, "user-1", { endpoint: "https://push.example/cross-company" });

    const transport: PushTransport = { send: vi.fn().mockResolvedValue({ statusCode: 201 }) };

    await firePushFanoutForActivity(db, baseCtx({ companyId, activityLogId }), transport);

    expect(transport.send).not.toHaveBeenCalled();
  });

  it("records send failures against the origin activity_log row without throwing", async () => {
    const companyId = await seedCompany();
    const activityLogId = await seedActivityLogRow(companyId);
    await seedSubscription(companyId, "user-1", { endpoint: "https://push.example/failing" });

    const transport: PushTransport = {
      send: vi.fn().mockRejectedValue(new Error("network unreachable")),
    };

    await expect(
      firePushFanoutForActivity(db, baseCtx({ companyId, activityLogId }), transport),
    ).resolves.toBeUndefined();

    const [row] = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.id, activityLogId));

    expect(row?.details).toMatchObject({
      pushFanoutFailures: [
        { endpoint: "https://push.example/failing", error: "network unreachable" },
      ],
    });
  });

  it("soft-revokes the subscription on a 410/404 dead-endpoint failure", async () => {
    const companyId = await seedCompany();
    const activityLogId = await seedActivityLogRow(companyId);
    const subId = await seedSubscription(companyId, "user-1", { endpoint: "https://push.example/dead" });

    const deadError = Object.assign(new Error("gone"), { statusCode: 410 });
    const transport: PushTransport = { send: vi.fn().mockRejectedValue(deadError) };

    await firePushFanoutForActivity(db, baseCtx({ companyId, activityLogId }), transport);

    const [row] = await db
      .select({ revokedAt: companyUserPushSubscriptions.revokedAt })
      .from(companyUserPushSubscriptions)
      .where(eq(companyUserPushSubscriptions.id, subId));

    expect(row?.revokedAt).not.toBeNull();
  });

  it("never throws even when the transport itself throws synchronously", async () => {
    const companyId = await seedCompany();
    const activityLogId = await seedActivityLogRow(companyId);
    await seedSubscription(companyId, "user-1");

    const transport: PushTransport = {
      send: vi.fn().mockImplementation(() => {
        throw new Error("boom");
      }),
    };

    await expect(
      firePushFanoutForActivity(db, baseCtx({ companyId, activityLogId }), transport),
    ).resolves.toBeUndefined();
  });
});
