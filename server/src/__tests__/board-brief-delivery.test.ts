import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  authUsers,
  boardBriefAlertEvents,
  boardBriefSnapshots,
  companies,
  companyMemberships,
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { boardBriefDeliveryService } from "../services/board-brief-delivery.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping board brief delivery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("boardBriefDeliveryService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: EmbeddedPostgresTestDatabase | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-board-brief-delivery-");
    db = createDb(tempDb.connectionString);
  }, 45_000);

  afterEach(async () => {
    await db.delete(boardBriefSnapshots);
    await db.delete(boardBriefAlertEvents);
    await db.delete(companyMemberships);
    await db.delete(authUsers);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  }, 45_000);

  it("dedupes unchanged active incidents and sends again after resolve and reopen", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const now = new Date("2026-04-15T12:00:00.000Z");
    const deliveries: Array<{ to: string[]; subject: string }> = [];

    await db.insert(companies).values({
      id: companyId,
      name: "Alert Co",
      issuePrefix: `ALR${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      criticalBoardAlertsEmailEnabled: true,
    });

    await db.insert(authUsers).values({
      id: "user-1",
      name: "Board User",
      email: "board@example.com",
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "user-1",
      status: "active",
      membershipRole: "owner",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Stale COO",
      role: "coo",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 600 } },
      permissions: {},
      lastHeartbeatAt: new Date("2026-04-15T06:00:00.000Z"),
    });

    const delivery = boardBriefDeliveryService(db, {
      sender: {
        sendMail: async ({ to, subject }) => {
          deliveries.push({ to, subject });
        },
      },
    });

    const first = await delivery.tickCriticalAlerts(now);
    expect(first.sent).toBe(1);
    expect(deliveries).toHaveLength(1);

    const alertEventsAfterFirst = await db.select().from(boardBriefAlertEvents);
    expect(alertEventsAfterFirst).toHaveLength(1);
    expect(alertEventsAfterFirst[0]?.status).toBe("active");
    expect(alertEventsAfterFirst[0]?.firstSentAt).not.toBeNull();

    const snapshotsAfterFirst = await db.select().from(boardBriefSnapshots);
    expect(snapshotsAfterFirst).toHaveLength(1);
    expect(snapshotsAfterFirst[0]?.source).toBe("critical_alert");

    const second = await delivery.tickCriticalAlerts(new Date("2026-04-15T12:05:00.000Z"));
    expect(second.sent).toBe(0);
    expect(deliveries).toHaveLength(1);
    expect(await db.select().from(boardBriefSnapshots)).toHaveLength(1);

    await db
      .update(agents)
      .set({ lastHeartbeatAt: new Date("2026-04-15T12:05:00.000Z"), updatedAt: new Date("2026-04-15T12:05:00.000Z") })
      .where(eq(agents.id, agentId));

    const resolved = await delivery.tickCriticalAlerts(new Date("2026-04-15T12:06:00.000Z"));
    expect(resolved.resolved).toBe(1);

    await db
      .update(agents)
      .set({ lastHeartbeatAt: new Date("2026-04-15T08:00:00.000Z"), updatedAt: new Date("2026-04-15T08:00:00.000Z") })
      .where(eq(agents.id, agentId));

    const reopened = await delivery.tickCriticalAlerts(new Date("2026-04-15T13:00:00.000Z"));
    expect(reopened.sent).toBe(1);
    expect(deliveries).toHaveLength(2);
    expect(await db.select().from(boardBriefSnapshots)).toHaveLength(2);
  });
});
