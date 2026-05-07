import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const mockLoggerWarn = vi.fn();

vi.mock("../middleware/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat tickTimers tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat tickTimers", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-ticktimers-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.execute("TRUNCATE TABLE heartbeat_runs, agents, companies CASCADE");
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 20_000);

  async function createCompany() {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Test Company",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  async function createAgent(overrides: {
    status?: string;
    heartbeat?: Record<string, unknown>;
    lastHeartbeatAt?: Date | null;
    createdAt?: Date;
  } = {}) {
    const now = new Date();
    const agentId = randomUUID();
    const runtimeConfig: Record<string, unknown> = {};
    if (overrides.heartbeat) {
      runtimeConfig.heartbeat = overrides.heartbeat;
    }

    const lastHeartbeatAt = overrides.lastHeartbeatAt === undefined ? now : overrides.lastHeartbeatAt;

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Test Agent",
      adapterType: "claude-local",
      status: overrides.status ?? "idle",
      createdAt: overrides.createdAt ?? now,
      updatedAt: now,
      lastHeartbeatAt,
      runtimeConfig,
    });
    return agentId;
  }

  describe("agent status filtering", () => {
    it("skips error status agents from heartbeat wakeups", async () => {
      await createCompany();
      const now = new Date();

      await createAgent({
        status: "error",
        heartbeat: { enabled: true, intervalSec: 60 },
        lastHeartbeatAt: new Date(now.getTime() - 120_000),
      });

      await createAgent({
        status: "idle",
        heartbeat: { enabled: true, intervalSec: 60 },
        lastHeartbeatAt: new Date(now.getTime() - 120_000),
      });

      const result = await heartbeat.tickTimers(now);

      expect(result.checked).toBe(1);
      expect(result.enqueued).toBe(1);
    });

    it("skips agents in non-invokable states: paused, terminated, pending_approval, error", async () => {
      await createCompany();
      const now = new Date();

      const nonInvokableStatuses = ["paused", "terminated", "pending_approval", "error"];
      for (const status of nonInvokableStatuses) {
        await createAgent({
          status,
          heartbeat: { enabled: true, intervalSec: 60 },
          lastHeartbeatAt: new Date(now.getTime() - 120_000),
        });
      }

      await createAgent({
        status: "idle",
        heartbeat: { enabled: true, intervalSec: 60 },
        lastHeartbeatAt: new Date(now.getTime() - 120_000),
      });

      const result = await heartbeat.tickTimers(now);

      expect(result.checked).toBe(1);
      expect(result.enqueued).toBe(1);
    });
  });

  describe("agent filtering", () => {
    it("counts only active agents with enabled heartbeat policy as checked", async () => {
      await createCompany();
      const now = new Date();

      await createAgent({
        status: "idle",
        heartbeat: { enabled: true, intervalSec: 60 },
        lastHeartbeatAt: new Date(now.getTime() - 120_000),
      });

      await createAgent({
        status: "paused",
        heartbeat: { enabled: true, intervalSec: 60 },
        lastHeartbeatAt: new Date(now.getTime() - 120_000),
      });

      await createAgent({
        status: "terminated",
        heartbeat: { enabled: true, intervalSec: 60 },
        lastHeartbeatAt: new Date(now.getTime() - 120_000),
      });

      await createAgent({
        status: "pending_approval",
        heartbeat: { enabled: true, intervalSec: 60 },
        lastHeartbeatAt: new Date(now.getTime() - 120_000),
      });

      await createAgent({
        status: "idle",
        heartbeat: { enabled: false, intervalSec: 60 },
        lastHeartbeatAt: new Date(now.getTime() - 120_000),
      });

      await createAgent({
        status: "idle",
        heartbeat: { enabled: true, intervalSec: 0 },
        lastHeartbeatAt: new Date(now.getTime() - 120_000),
      });

      const result = await heartbeat.tickTimers(now);

      expect(result.checked).toBe(1);
      expect(result.enqueued).toBe(1);
      expect(result.skipped).toBe(0);
    });

    it("skips agents whose timer has not elapsed", async () => {
      await createCompany();
      const now = new Date();

      await createAgent({
        status: "idle",
        heartbeat: { enabled: true, intervalSec: 300 },
        lastHeartbeatAt: new Date(now.getTime() - 60_000),
      });

      const result = await heartbeat.tickTimers(now);

      expect(result.checked).toBe(1);
      expect(result.enqueued).toBe(0);
      expect(result.skipped).toBe(0);
    });

    it("enqueues wakeup for agents whose timer has elapsed", async () => {
      await createCompany();
      const now = new Date();

      const agentId = await createAgent({
        status: "idle",
        heartbeat: { enabled: true, intervalSec: 60 },
        lastHeartbeatAt: new Date(now.getTime() - 120_000),
      });

      const result = await heartbeat.tickTimers(now);

      expect(result.checked).toBe(1);
      expect(result.enqueued).toBe(1);
      expect(result.skipped).toBe(0);

      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      expect(runs.length).toBe(1);
      expect(["queued", "running"]).toContain(runs[0]?.status);
    });
  });

  describe("parallel execution", () => {
    it("processes multiple agents in parallel", async () => {
      await createCompany();
      const now = new Date();

      const agentIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const id = await createAgent({
          status: "idle",
          heartbeat: { enabled: true, intervalSec: 60 },
          lastHeartbeatAt: new Date(now.getTime() - 120_000 - i * 1000),
        });
        agentIds.push(id);
      }

      const result = await heartbeat.tickTimers(now);

      expect(result.checked).toBe(5);
      expect(result.enqueued).toBe(5);
      expect(result.skipped).toBe(0);

      for (const agentId of agentIds) {
        const runs = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.agentId, agentId));
        expect(runs.length).toBe(1);
      }
    });

    it("uses createdAt as baseline when lastHeartbeatAt is null", async () => {
      await createCompany();
      const now = new Date();

      await createAgent({
        status: "idle",
        heartbeat: { enabled: true, intervalSec: 60 },
        lastHeartbeatAt: null,
        createdAt: new Date(now.getTime() - 120_000),
      });

      const result = await heartbeat.tickTimers(now);

      expect(result.checked).toBe(1);
      expect(result.enqueued).toBe(1);
    });
  });

  describe("error handling", () => {
    it("handles subsequent ticks for same agent (may coalesce or skip)", async () => {
      await createCompany();
      const now = new Date();

      const agentId = await createAgent({
        status: "idle",
        heartbeat: { enabled: true, intervalSec: 60 },
        lastHeartbeatAt: new Date(now.getTime() - 120_000),
      });

      const result1 = await heartbeat.tickTimers(now);
      expect(result1.enqueued).toBe(1);

      const result2 = await heartbeat.tickTimers(now);
      expect(result2.checked).toBe(1);

      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      expect(runs.length).toBe(1);
    });
  });

  describe("edge cases", () => {
    it("returns zeros when no agents exist", async () => {
      await createCompany();
      const now = new Date();

      const result = await heartbeat.tickTimers(now);

      expect(result.checked).toBe(0);
      expect(result.enqueued).toBe(0);
      expect(result.skipped).toBe(0);
    });

    it("handles agents with missing heartbeat policy gracefully", async () => {
      await createCompany();
      const now = new Date();

      await createAgent({
        status: "idle",
        heartbeat: null as unknown as Record<string, unknown>,
        lastHeartbeatAt: new Date(now.getTime() - 120_000),
      });

      const result = await heartbeat.tickTimers(now);

      expect(result.checked).toBe(0);
      expect(result.enqueued).toBe(0);
      expect(result.skipped).toBe(0);
    });

    it("enqueues wakeups with correct source and trigger details", async () => {
      await createCompany();
      const now = new Date();

      const agentId = await createAgent({
        status: "idle",
        heartbeat: { enabled: true, intervalSec: 60 },
        lastHeartbeatAt: new Date(now.getTime() - 120_000),
      });

      await heartbeat.tickTimers(now);

      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));

      expect(runs.length).toBe(1);
      expect(runs[0]?.invocationSource).toBe("timer");
    });
  });
});
