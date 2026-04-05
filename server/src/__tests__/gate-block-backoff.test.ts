import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  agents,
  agentWakeupRequests,
  companies,
  heartbeatRuns,
  issues,
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-gate-block-"));
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

describe("gate-block backoff", () => {
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

  async function seedIssueWithGateBlocks(overrides?: {
    gateBlockCount?: number;
    issueStatus?: string;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      issuePrefix,
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
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test issue",
      status: overrides?.issueStatus ?? "in_progress",
      assigneeAgentId: agentId,
      gateBlockCount: overrides?.gateBlockCount ?? 0,
      identifier: `${issuePrefix}-1`,
      issueNumber: 1,
    });

    return { companyId, agentId, issueId };
  }

  it("skips issue-specific wakeup when gateBlockCount >= 3", async () => {
    const { agentId, issueId } = await seedIssueWithGateBlocks({ gateBlockCount: 3 });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "test",
      reason: "assignment",
      contextSnapshot: { issueId },
    });

    // Should be skipped due to gate block backoff
    expect(result).toBeNull();

    // Verify the skipped wakeup request was recorded
    const wakeups = await db.select().from(agentWakeupRequests);
    const skipped = wakeups.find((w) => w.reason?.startsWith("gate_block_backoff"));
    expect(skipped).toBeTruthy();
    expect(skipped!.status).toBe("skipped");
  });

  it("allows issue-specific wakeup when gateBlockCount < 3", async () => {
    const { agentId, issueId } = await seedIssueWithGateBlocks({ gateBlockCount: 2 });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "test",
      reason: "assignment",
      contextSnapshot: { issueId },
    });

    // Should NOT be skipped — count is below threshold
    expect(result).not.toBeNull();
  });

  it("counter increments via SQL", async () => {
    const { issueId } = await seedIssueWithGateBlocks({ gateBlockCount: 0 });

    // Simulate 3 gate blocks
    for (let i = 0; i < 3; i++) {
      await db.update(issues).set({
        gateBlockCount: sql`${issues.gateBlockCount} + 1`,
      }).where(eq(issues.id, issueId));
    }

    const [updated] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(updated.gateBlockCount).toBe(3);
  });

  it("counter resets on assignee change", async () => {
    const { issueId, companyId } = await seedIssueWithGateBlocks({ gateBlockCount: 5 });

    // Create a new agent to reassign to
    const newAgentId = randomUUID();
    await db.insert(agents).values({
      id: newAgentId,
      companyId,
      name: "NewAgent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    // Simulate what PATCH handler does on assignee change
    await db.update(issues).set({
      assigneeAgentId: newAgentId,
      gateBlockCount: 0,
      activationRetriggerCount: 0,
    }).where(eq(issues.id, issueId));

    const [updated] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(updated.gateBlockCount).toBe(0);
    expect(updated.assigneeAgentId).toBe(newAgentId);
  });

  it("counter resets on status change", async () => {
    const { issueId } = await seedIssueWithGateBlocks({
      gateBlockCount: 4,
      issueStatus: "in_progress",
    });

    // Simulate what PATCH handler does on status change
    await db.update(issues).set({
      status: "in_review",
      gateBlockCount: 0,
    }).where(eq(issues.id, issueId));

    const [updated] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(updated.gateBlockCount).toBe(0);
    expect(updated.status).toBe("in_review");
  });

  it("timer wakes bypass the issue-specific gate check (no issueId)", async () => {
    // Timer wakes go through the non-issue pathway in enqueueWakeup.
    // Even if the agent has issues with high gateBlockCount, timer wakes
    // should still fire since they have no issueId.
    const { agentId } = await seedIssueWithGateBlocks({ gateBlockCount: 10 });

    // Update lastHeartbeatAt to be old enough to trigger
    await db.update(agents).set({
      lastHeartbeatAt: new Date(Date.now() - 10 * 60 * 1000),
    }).where(eq(agents.id, agentId));

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers();

    // Timer wake should still fire (no issueId → bypasses gate check)
    expect(result.enqueued).toBeGreaterThanOrEqual(1);
  });
});
