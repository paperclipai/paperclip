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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-unpicked-sweep-"));
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

describe("sweepUnpickedAssignments", () => {
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
    // Use TRUNCATE CASCADE to handle complex FK chains from enqueueWakeup side effects.
    await db.execute(
      sql`TRUNCATE issues, heartbeat_run_events, heartbeat_runs, agent_wakeup_requests, agent_runtime_state, agent_task_sessions, company_skills, agents, companies CASCADE`,
    );
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  async function seedIssueFixture(overrides?: {
    agentStatus?: string;
    issueStatus?: string;
    executionRunId?: string | null;
    executionLockedAt?: Date | null;
    checkoutRunId?: string | null;
    updatedAt?: Date;
    activationRetriggerCount?: number;
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
      status: overrides?.agentStatus ?? "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    // If we need a heartbeat run for executionRunId, insert one
    let runId: string | null = null;
    if (overrides?.executionRunId) {
      runId = overrides.executionRunId;
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "running",
        source: "assignment",
        startedAt: new Date(),
      });
    }

    const nineMinutesAgo = new Date(Date.now() - 9 * 60 * 1000);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test issue",
      status: overrides?.issueStatus ?? "in_progress",
      assigneeAgentId: agentId,
      executionRunId: runId,
      executionLockedAt: overrides?.executionLockedAt ?? null,
      checkoutRunId: overrides?.checkoutRunId ?? null,
      updatedAt: overrides?.updatedAt ?? nineMinutesAgo,
      activationRetriggerCount: overrides?.activationRetriggerCount ?? 0,
      identifier: `${issuePrefix}-1`,
      issueNumber: 1,
    });

    return { companyId, agentId, issueId };
  }

  it("retriggers an actionable issue past the SLA with no run", async () => {
    const { issueId } = await seedIssueFixture();

    // Verify the column exists and is 0
    const [before] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(before.activationRetriggerCount).toBe(0);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepUnpickedAssignments();
    expect(result.retriggered).toBe(1);

    // Verify the retrigger count was incremented
    const [updated] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(updated.activationRetriggerCount).toBe(1);

    // Verify a wakeup was enqueued
    const wakeups = await db.select().from(agentWakeupRequests);
    expect(wakeups.length).toBeGreaterThanOrEqual(1);
    const wakeup = wakeups.find((w) => w.reason === "unpicked_assignment_retrigger");
    expect(wakeup).toBeTruthy();
  });

  it("skips an issue that already has an executionRunId", async () => {
    await seedIssueFixture({ executionRunId: randomUUID() });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepUnpickedAssignments();
    expect(result.retriggered).toBe(0);
  });

  it("skips an issue updated recently (within SLA window)", async () => {
    await seedIssueFixture({ updatedAt: new Date() }); // just now

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepUnpickedAssignments();
    expect(result.retriggered).toBe(0);
  });

  it("skips an issue that has reached max retrigger count", async () => {
    await seedIssueFixture({ activationRetriggerCount: 5 });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepUnpickedAssignments();
    expect(result.retriggered).toBe(0);
  });

  it("skips an issue assigned to a non-dispatchable agent", async () => {
    await seedIssueFixture({ agentStatus: "paused" });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepUnpickedAssignments();
    expect(result.retriggered).toBe(0);
  });
});
