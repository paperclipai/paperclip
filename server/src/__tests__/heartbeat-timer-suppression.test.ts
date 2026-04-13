import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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

  describe("timer no-op detection (checkTimerHasChanges)", () => {
    async function seedCompletedTimerRun(opts: {
      companyId: string;
      agentId: string;
      createdAt: Date;
    }) {
      const runId = randomUUID();
      const wakeupRequestId = randomUUID();

      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId: opts.companyId,
        agentId: opts.agentId,
        source: "timer",
        triggerDetail: "system",
        reason: "heartbeat_timer",
        payload: {},
        status: "claimed",
        runId,
        claimedAt: opts.createdAt,
      });

      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: opts.companyId,
        agentId: opts.agentId,
        invocationSource: "timer",
        triggerDetail: "system",
        status: "completed",
        wakeupRequestId,
        contextSnapshot: {},
        startedAt: opts.createdAt,
        finishedAt: new Date(opts.createdAt.getTime() + 30_000),
        createdAt: opts.createdAt,
        updatedAt: opts.createdAt,
      });

      return { runId, wakeupRequestId };
    }

    async function seedIssue(opts: {
      companyId: string;
      agentId: string;
      updatedAt: Date;
      issueNumber: number;
    }) {
      const issueId = randomUUID();
      const prefix = `T${opts.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

      await db.insert(issues).values({
        id: issueId,
        companyId: opts.companyId,
        title: `Test issue ${opts.issueNumber}`,
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: opts.agentId,
        issueNumber: opts.issueNumber,
        identifier: `${prefix}-${opts.issueNumber}`,
        updatedAt: opts.updatedAt,
      });

      return { issueId };
    }

    async function seedSkippedTimerRequest(opts: {
      companyId: string;
      agentId: string;
      createdAt: Date;
    }) {
      await db.insert(agentWakeupRequests).values({
        companyId: opts.companyId,
        agentId: opts.agentId,
        source: "timer",
        triggerDetail: "system",
        reason: "timer.no_changes",
        payload: {},
        status: "skipped",
        finishedAt: opts.createdAt,
        createdAt: opts.createdAt,
      });
    }

    async function getSkippedTimerRequests(agentId: string) {
      return db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.agentId, agentId),
            eq(agentWakeupRequests.status, "skipped"),
            eq(agentWakeupRequests.reason, "timer.no_changes"),
          ),
        );
    }

    it("skips timer heartbeat when no issues have changed since last timer run", async () => {
      const lastTimerAt = new Date("2026-04-01T10:00:00.000Z");
      const issueOlderThanTimer = new Date("2026-04-01T09:00:00.000Z");

      const { companyId, agentId } = await seedAgent();
      await seedCompletedTimerRun({ companyId, agentId, createdAt: lastTimerAt });
      await seedIssue({
        companyId,
        agentId,
        updatedAt: issueOlderThanTimer,
        issueNumber: 1,
      });

      const svc = heartbeatService(db);
      const result = await svc.wakeup(agentId, {
        source: "timer",
        triggerDetail: "system",
      });

      expect(result).toBeNull();

      const skipped = await getSkippedTimerRequests(agentId);
      expect(skipped.length).toBe(1);
      expect(skipped[0].reason).toBe("timer.no_changes");
    });

    it("runs timer heartbeat when issues have changed since last timer run", async () => {
      const lastTimerAt = new Date("2026-04-01T10:00:00.000Z");
      const issueNewerThanTimer = new Date("2026-04-01T11:00:00.000Z");

      const { companyId, agentId } = await seedAgent();
      await seedCompletedTimerRun({ companyId, agentId, createdAt: lastTimerAt });
      await seedIssue({
        companyId,
        agentId,
        updatedAt: issueNewerThanTimer,
        issueNumber: 1,
      });

      const svc = heartbeatService(db);
      // wakeup will proceed past our check (hasChanges = true) and then
      // fail downstream (no adapter configured etc.) — that's expected.
      // We verify it does NOT return null with a "timer.no_changes" skip.
      try {
        await svc.wakeup(agentId, {
          source: "timer",
          triggerDetail: "system",
        });
      } catch {
        // Expected: the run proceeds past no-op check but fails later
      }

      const skipped = await getSkippedTimerRequests(agentId);
      expect(skipped.length).toBe(0);
    });

    it("always runs first timer heartbeat when no previous timer run exists", async () => {
      const { companyId, agentId } = await seedAgent();
      // No completed timer run seeded — first time ever

      const svc = heartbeatService(db);
      try {
        await svc.wakeup(agentId, {
          source: "timer",
          triggerDetail: "system",
        });
      } catch {
        // Expected: proceeds past no-op check but fails later
      }

      const skipped = await getSkippedTimerRequests(agentId);
      expect(skipped.length).toBe(0);
    });

    it("forces run after 3 consecutive skips (safety valve)", async () => {
      const lastTimerAt = new Date("2026-04-01T10:00:00.000Z");
      const issueOlderThanTimer = new Date("2026-04-01T09:00:00.000Z");

      const { companyId, agentId } = await seedAgent();
      await seedCompletedTimerRun({ companyId, agentId, createdAt: lastTimerAt });
      await seedIssue({
        companyId,
        agentId,
        updatedAt: issueOlderThanTimer,
        issueNumber: 1,
      });

      // Seed 3 consecutive skips after the last completed timer run
      for (let i = 0; i < 3; i++) {
        await seedSkippedTimerRequest({
          companyId,
          agentId,
          createdAt: new Date(lastTimerAt.getTime() + (i + 1) * 60_000),
        });
      }

      const svc = heartbeatService(db);
      // With 3 consecutive skips and no changes, the safety valve should force a run
      try {
        await svc.wakeup(agentId, {
          source: "timer",
          triggerDetail: "system",
        });
      } catch {
        // Expected: proceeds past no-op check but fails later
      }

      // Should not have added another skip — the safety valve forced a run
      const skipped = await getSkippedTimerRequests(agentId);
      expect(skipped.length).toBe(3); // Only the 3 we seeded, no new one
    });

    it("skips when consecutive skips are below the safety valve threshold", async () => {
      const lastTimerAt = new Date("2026-04-01T10:00:00.000Z");
      const issueOlderThanTimer = new Date("2026-04-01T09:00:00.000Z");

      const { companyId, agentId } = await seedAgent();
      await seedCompletedTimerRun({ companyId, agentId, createdAt: lastTimerAt });
      await seedIssue({
        companyId,
        agentId,
        updatedAt: issueOlderThanTimer,
        issueNumber: 1,
      });

      // Only 2 consecutive skips — below the threshold of 3
      for (let i = 0; i < 2; i++) {
        await seedSkippedTimerRequest({
          companyId,
          agentId,
          createdAt: new Date(lastTimerAt.getTime() + (i + 1) * 60_000),
        });
      }

      const svc = heartbeatService(db);
      const result = await svc.wakeup(agentId, {
        source: "timer",
        triggerDetail: "system",
      });

      expect(result).toBeNull();

      // Should have added one more skip (now 3 total)
      const skipped = await getSkippedTimerRequests(agentId);
      expect(skipped.length).toBe(3);
    });
  });
});
