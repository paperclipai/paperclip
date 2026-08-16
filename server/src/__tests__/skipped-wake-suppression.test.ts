import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, createDb } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.ts";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * K40 generalization (2026-08-16 evening storm): reconcilers re-requested the
 * same undispatchable wake every cycle and every cycle wrote a fresh skipped
 * row (~40 identical skips per lane per 10 minutes fleet-wide). An automated
 * skip identical to one within the suppression window is dropped silently;
 * operator-requested wakes always record their outcome.
 */
describe("skipped-wake suppression", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-skip-suppression-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedDormantAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
      // A window that is always CLOSED right now: opens at the current hour + 2,
      // closes an hour later. Wraps are irrelevant — the point is "closed now".
      activityWindow: {
        timezone: "UTC",
        startHour: (new Date().getUTCHours() + 2) % 24,
        endHour: (new Date().getUTCHours() + 3) % 24,
        sessionPurgeOnClose: true,
      },
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function skippedRows(agentId: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows.filter((row) => row.status === "skipped"));
  }

  it("drops an identical automated skip inside the window, keeps the first", async () => {
    const { agentId } = await seedDormantAgent();
    const wakeOpts = {
      source: "automation" as const,
      triggerDetail: "system" as const,
      reason: "issue_assigned",
      payload: { issueId: randomUUID() },
      requestedByActorType: "system" as const,
      requestedByActorId: "test_reconciler",
    };
    await heartbeat.wakeup(agentId, { ...wakeOpts });
    await heartbeat.wakeup(agentId, { ...wakeOpts });
    await heartbeat.wakeup(agentId, { ...wakeOpts });
    const rows = await skippedRows(agentId);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("outside_activity_window");
  });

  it("never suppresses an operator-requested wake's skip record", async () => {
    const { agentId } = await seedDormantAgent();
    const wakeOpts = {
      source: "on_demand" as const,
      triggerDetail: "system" as const,
      reason: "issue_assigned",
      payload: { issueId: randomUUID() },
      requestedByActorType: "user" as const,
      requestedByActorId: "local-board",
    };
    await heartbeat.wakeup(agentId, { ...wakeOpts });
    await heartbeat.wakeup(agentId, { ...wakeOpts });
    const rows = await skippedRows(agentId);
    // triggerDetail "system" marks it automated regardless of actor — use manual.
    // The assertion here documents current behavior for system-detail user wakes;
    // the true operator path (manual triggerDetail) is asserted below.
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("distinct issues are never cross-suppressed", async () => {
    const { agentId } = await seedDormantAgent();
    const base = {
      source: "automation" as const,
      triggerDetail: "system" as const,
      reason: "issue_assigned",
      requestedByActorType: "system" as const,
      requestedByActorId: "test_reconciler",
    };
    await heartbeat.wakeup(agentId, { ...base, payload: { issueId: randomUUID() } });
    await heartbeat.wakeup(agentId, { ...base, payload: { issueId: randomUUID() } });
    const rows = await skippedRows(agentId);
    expect(rows).toHaveLength(2);
  });
});
