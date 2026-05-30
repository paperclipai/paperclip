import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  STICKY_ERROR_RECOVERY_MIN_AGE_MS,
  heartbeatService,
} from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres sticky-error recovery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat sticky-error recovery sweep", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-sticky-error-recovery-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: "Paperclip",
      issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  async function seedAgent(input: {
    companyId: string;
    status: "idle" | "error" | "paused" | "terminated" | "running" | "pending_approval";
    lastHeartbeatAt: Date | null;
    pauseReason?: string | null;
  }) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId: input.companyId,
      name: `Agent-${id.slice(0, 8)}`,
      role: "engineer",
      status: input.status,
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      lastHeartbeatAt: input.lastHeartbeatAt,
      pauseReason: input.pauseReason ?? null,
      pausedAt: input.pauseReason ? new Date() : null,
    });
    return id;
  }

  it("flips error agents older than the recovery floor back to idle", async () => {
    const companyId = await seedCompany();
    const now = new Date("2026-05-30T20:00:00.000Z");
    const stale = new Date(now.getTime() - (STICKY_ERROR_RECOVERY_MIN_AGE_MS + 60_000));
    const stuckId = await seedAgent({ companyId, status: "error", lastHeartbeatAt: stale });

    const result = await heartbeat.recoverErroredAgents(now);

    expect(result).toEqual({ candidates: 1, recovered: 1 });
    const [after] = await db.select().from(agents).where(eq(agents.id, stuckId));
    expect(after?.status).toBe("idle");
    expect(after?.pauseReason).toBeNull();
    expect(after?.pausedAt).toBeNull();
    // lastHeartbeatAt is intentionally NOT bumped — preserves the original
    // failure timestamp so operators can audit how long the agent was stuck.
    expect(after?.lastHeartbeatAt?.toISOString()).toBe(stale.toISOString());
  });

  it("leaves error agents inside the recovery floor untouched", async () => {
    const companyId = await seedCompany();
    const now = new Date("2026-05-30T20:00:00.000Z");
    const recent = new Date(now.getTime() - (STICKY_ERROR_RECOVERY_MIN_AGE_MS - 60_000));
    const id = await seedAgent({ companyId, status: "error", lastHeartbeatAt: recent });

    const result = await heartbeat.recoverErroredAgents(now);

    expect(result).toEqual({ candidates: 0, recovered: 0 });
    const [after] = await db.select().from(agents).where(eq(agents.id, id));
    expect(after?.status).toBe("error");
  });

  it("does not disturb non-error agents even when they are stale", async () => {
    const companyId = await seedCompany();
    const now = new Date("2026-05-30T20:00:00.000Z");
    const stale = new Date(now.getTime() - (STICKY_ERROR_RECOVERY_MIN_AGE_MS + 3_600_000));
    const pausedId = await seedAgent({
      companyId,
      status: "paused",
      lastHeartbeatAt: stale,
      pauseReason: "manual pause",
    });
    const terminatedId = await seedAgent({ companyId, status: "terminated", lastHeartbeatAt: stale });
    const idleId = await seedAgent({ companyId, status: "idle", lastHeartbeatAt: stale });

    const result = await heartbeat.recoverErroredAgents(now);

    expect(result).toEqual({ candidates: 0, recovered: 0 });
    const rows = await db.select().from(agents);
    const byId = new Map(rows.map((row) => [row.id, row.status]));
    expect(byId.get(pausedId)).toBe("paused");
    expect(byId.get(terminatedId)).toBe("terminated");
    expect(byId.get(idleId)).toBe("idle");
  });

  it("treats missing lastHeartbeatAt by falling back to updatedAt", async () => {
    const companyId = await seedCompany();
    const now = new Date("2026-05-30T20:00:00.000Z");
    const id = await seedAgent({ companyId, status: "error", lastHeartbeatAt: null });
    // Force updatedAt past the recovery floor so the coalesce branch triggers.
    const stale = new Date(now.getTime() - (STICKY_ERROR_RECOVERY_MIN_AGE_MS + 60_000));
    await db.update(agents).set({ updatedAt: stale }).where(eq(agents.id, id));

    const result = await heartbeat.recoverErroredAgents(now);

    expect(result).toEqual({ candidates: 1, recovered: 1 });
    const [after] = await db.select().from(agents).where(eq(agents.id, id));
    expect(after?.status).toBe("idle");
  });

  it("respects the configured batch limit", async () => {
    const companyId = await seedCompany();
    const now = new Date("2026-05-30T20:00:00.000Z");
    const stale = new Date(now.getTime() - (STICKY_ERROR_RECOVERY_MIN_AGE_MS + 60_000));
    for (let i = 0; i < 5; i += 1) {
      await seedAgent({ companyId, status: "error", lastHeartbeatAt: stale });
    }

    const result = await heartbeat.recoverErroredAgents(now, { limit: 2 });

    expect(result).toEqual({ candidates: 2, recovered: 2 });
    const remaining = await db.select().from(agents).where(eq(agents.status, "error"));
    expect(remaining).toHaveLength(3);
  });

  it("writes an activity-log entry per recovered agent", async () => {
    const companyId = await seedCompany();
    const now = new Date("2026-05-30T20:00:00.000Z");
    const stale = new Date(now.getTime() - (STICKY_ERROR_RECOVERY_MIN_AGE_MS + 60_000));
    const id = await seedAgent({ companyId, status: "error", lastHeartbeatAt: stale });

    await heartbeat.recoverErroredAgents(now);

    const entries = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.agentId, id));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: "agent.recovered_from_error",
      actorType: "system",
      actorId: "sticky_error_recovery",
      entityType: "agent",
      entityId: id,
    });
  });

  it("is idempotent across back-to-back sweeps", async () => {
    const companyId = await seedCompany();
    const now = new Date("2026-05-30T20:00:00.000Z");
    const stale = new Date(now.getTime() - (STICKY_ERROR_RECOVERY_MIN_AGE_MS + 60_000));
    await seedAgent({ companyId, status: "error", lastHeartbeatAt: stale });

    const first = await heartbeat.recoverErroredAgents(now);
    const second = await heartbeat.recoverErroredAgents(now);

    expect(first).toEqual({ candidates: 1, recovered: 1 });
    expect(second).toEqual({ candidates: 0, recovered: 0 });
  });
});
