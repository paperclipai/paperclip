import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { sql } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => null,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping timer-suppression tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("lastTimerHeartbeatAt timer-suppression fix", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-timer-suppression-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.execute(sql`TRUNCATE companies CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(opts?: {
    lastHeartbeatAt?: Date | null;
    lastTimerHeartbeatAt?: Date | null;
    intervalSec?: number;
    status?: string;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: opts?.status ?? "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: opts?.intervalSec ?? 3600,
        },
      },
      permissions: {},
      lastHeartbeatAt: opts?.lastHeartbeatAt ?? null,
      lastTimerHeartbeatAt: opts?.lastTimerHeartbeatAt ?? null,
    });

    return { companyId, agentId };
  }

  async function seedOrphanedRun(opts: {
    companyId: string;
    agentId: string;
    invocationSource: string;
  }) {
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: opts.companyId,
      agentId: opts.agentId,
      source: opts.invocationSource,
      triggerDetail: "system",
      reason: opts.invocationSource === "timer" ? "heartbeat_timer" : "issue_assigned",
      payload: {},
      status: "claimed",
      runId,
      claimedAt: new Date(),
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: opts.companyId,
      agentId: opts.agentId,
      invocationSource: opts.invocationSource,
      triggerDetail: "system",
      status: "running",
      wakeupRequestId,
      contextSnapshot: {},
      processPid: 999_999_999,
      processLossRetryCount: 1,
      startedAt: new Date(),
      updatedAt: new Date(),
    });

    return { runId };
  }

  describe("tickTimers baseline", () => {
    it("uses lastTimerHeartbeatAt instead of lastHeartbeatAt when both are set", async () => {
      const now = new Date("2026-04-01T12:00:00.000Z");
      const recentEventHeartbeat = new Date("2026-04-01T11:55:00.000Z");
      const oldTimerHeartbeat = new Date("2026-04-01T10:00:00.000Z");

      await seedAgent({
        lastHeartbeatAt: recentEventHeartbeat,
        lastTimerHeartbeatAt: oldTimerHeartbeat,
        intervalSec: 3600,
      });

      const svc = heartbeatService(db);
      const result = await svc.tickTimers(now);

      expect(result.enqueued).toBe(1);
    });

    it("skips when lastTimerHeartbeatAt is recent even if lastHeartbeatAt is old", async () => {
      const now = new Date("2026-04-01T12:00:00.000Z");
      const recentTimerHeartbeat = new Date("2026-04-01T11:30:00.000Z");

      await seedAgent({
        lastHeartbeatAt: new Date("2026-04-01T08:00:00.000Z"),
        lastTimerHeartbeatAt: recentTimerHeartbeat,
        intervalSec: 3600,
      });

      const svc = heartbeatService(db);
      const result = await svc.tickTimers(now);

      expect(result.enqueued).toBe(0);
    });

    it("falls back to lastHeartbeatAt when lastTimerHeartbeatAt is null", async () => {
      const now = new Date("2026-04-01T12:00:00.000Z");

      await seedAgent({
        lastHeartbeatAt: new Date("2026-04-01T11:30:00.000Z"),
        lastTimerHeartbeatAt: null,
        intervalSec: 3600,
      });

      const svc = heartbeatService(db);
      const result = await svc.tickTimers(now);

      expect(result.enqueued).toBe(0);
    });
  });

  describe("finalizeAgentStatus via reapOrphanedRuns", () => {
    it("event-driven orphan reap does NOT set lastTimerHeartbeatAt", async () => {
      const { companyId, agentId } = await seedAgent({ status: "running" });
      await seedOrphanedRun({ companyId, agentId, invocationSource: "assignment" });

      const svc = heartbeatService(db);
      await svc.reapOrphanedRuns();

      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(agent.lastHeartbeatAt).not.toBeNull();
      expect(agent.lastTimerHeartbeatAt).toBeNull();
    });

    it("timer orphan reap sets lastTimerHeartbeatAt", async () => {
      const { companyId, agentId } = await seedAgent({ status: "running" });
      await seedOrphanedRun({ companyId, agentId, invocationSource: "timer" });

      const svc = heartbeatService(db);
      await svc.reapOrphanedRuns();

      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(agent.lastHeartbeatAt).not.toBeNull();
      expect(agent.lastTimerHeartbeatAt).not.toBeNull();
    });
  });
});
