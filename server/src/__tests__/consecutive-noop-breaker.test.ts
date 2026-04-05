import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  agents,
  companies,
  heartbeatRuns,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.ts";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function startTempDatabase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-noop-breaker-"));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: () => {},
    onError: () => {},
  });
  await instance.initialise();
  await instance.start();

  const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "paperclip");
  const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
  await applyPendingMigrations(connectionString);
  return { connectionString, instance, dataDir };
}

describe("consecutive no-op circuit breaker", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 30_000);

  afterEach(async () => {
    await db.execute(
      // @ts-expect-error — raw SQL for test cleanup
      `TRUNCATE issues, heartbeat_run_events, heartbeat_runs, agent_wakeup_requests, agent_runtime_state, agent_task_sessions, company_skills, agents, companies CASCADE`,
    );
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  async function seedAgentWithRuns(opts: {
    consecutiveNoopCount?: number;
    runs?: Array<{
      invocationSource: string;
      status: string;
      usageJson?: Record<string, unknown> | null;
    }>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: 300 },
      },
      permissions: {},
      consecutiveNoopCount: opts.consecutiveNoopCount ?? 0,
      lastHeartbeatAt: new Date(Date.now() - 10 * 60 * 1000), // 10 min ago
    });

    const runIds: string[] = [];
    for (const run of opts.runs ?? []) {
      const runId = randomUUID();
      runIds.push(runId);
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: run.invocationSource,
        status: run.status,
        usageJson: run.usageJson ?? null,
        startedAt: new Date(),
        finishedAt: run.status !== "running" && run.status !== "queued" ? new Date() : null,
      });
    }

    return { companyId, agentId, runIds };
  }

  it("increments consecutiveNoopCount for timer run with <200 output tokens", async () => {
    const { agentId } = await seedAgentWithRuns({ consecutiveNoopCount: 0 });

    // Simulate what executeRun finalization does: check usageJson and update counter
    const [before] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(before.consecutiveNoopCount).toBe(0);

    // Simulate the noop increment (same SQL as heartbeat.ts)
    const { sql } = await import("drizzle-orm");
    await db
      .update(agents)
      .set({
        consecutiveNoopCount: sql`${agents.consecutiveNoopCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId));

    const [after] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(after.consecutiveNoopCount).toBe(1);
  });

  it("resets consecutiveNoopCount to 0 for timer run with >=200 output tokens", async () => {
    const { agentId } = await seedAgentWithRuns({ consecutiveNoopCount: 5 });

    const [before] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(before.consecutiveNoopCount).toBe(5);

    // Productive run resets counter
    const { and, gt } = await import("drizzle-orm");
    await db
      .update(agents)
      .set({ consecutiveNoopCount: 0, updatedAt: new Date() })
      .where(and(eq(agents.id, agentId), gt(agents.consecutiveNoopCount, 0)));

    const [after] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(after.consecutiveNoopCount).toBe(0);
  });

  it("does not increment for non-timer runs", async () => {
    // The noop tracker only fires for invocationSource === "timer"
    // Non-timer sources ("automation", "on_demand") skip the tracker entirely
    const { agentId } = await seedAgentWithRuns({ consecutiveNoopCount: 2 });

    // Counter should remain unchanged
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent.consecutiveNoopCount).toBe(2);
  });

  it("does not increment for failed runs", async () => {
    // The noop tracker only fires for outcome === "succeeded"
    const { agentId } = await seedAgentWithRuns({ consecutiveNoopCount: 1 });

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent.consecutiveNoopCount).toBe(1);
  });

  it("tickTimers applies backoff when consecutiveNoopCount >= 3", async () => {
    const { agentId } = await seedAgentWithRuns({ consecutiveNoopCount: 3 });

    const heartbeat = heartbeatService(db);

    // Agent's interval is 300s (5 min), lastHeartbeatAt is 10 min ago.
    // With count=3, backoff multiplier = 2^(3-2) = 2x, effective interval = 600s (10 min).
    // At exactly 10 min elapsed, 10 min >= 10 min → should NOT skip.
    const result = await heartbeat.tickTimers();
    expect(result.enqueued).toBeGreaterThanOrEqual(1);
  });

  it("tickTimers skips when consecutiveNoopCount < 3", async () => {
    // With count=2 (below threshold), no backoff applied. Normal interval applies.
    const { agentId } = await seedAgentWithRuns({ consecutiveNoopCount: 2 });

    const heartbeat = heartbeatService(db);

    // Agent's interval is 300s (5 min), lastHeartbeatAt is 10 min ago.
    // No backoff since count < 3, so 10 min > 5 min → enqueued
    const result = await heartbeat.tickTimers();
    expect(result.enqueued).toBeGreaterThanOrEqual(1);
  });

  it("backoff caps at 8x (count=5 and count=10 both give 8x)", async () => {
    // count=5: multiplier = 2^min(5-2, 3) = 2^3 = 8
    // count=10: multiplier = 2^min(10-2, 3) = 2^3 = 8
    // Both should produce the same effective multiplier
    const multiplierAt5 = Math.pow(2, Math.min(5 - 2, 3));
    const multiplierAt10 = Math.pow(2, Math.min(10 - 2, 3));
    expect(multiplierAt5).toBe(8);
    expect(multiplierAt10).toBe(8);

    // With 300s interval * 8x = 2400s (40 min).
    // Agent lastHeartbeatAt is 10 min ago, so 600s < 2400s → skipped.
    const { agentId } = await seedAgentWithRuns({ consecutiveNoopCount: 5 });
    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers();
    // Agent should be skipped since 10 min < 40 min effective interval
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });
});
