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
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  heartbeatRunEvents,
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-heartbeat-archived-"));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
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

describe("heartbeat skips archived companies", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  async function seedAgent(opts: { companyStatus?: string; agentStatus?: string; lastHeartbeatAt?: Date } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      status: opts.companyStatus ?? "active",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: opts.agentStatus ?? "running",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
      lastHeartbeatAt: opts.lastHeartbeatAt ?? new Date("2026-01-01T00:00:00.000Z"),
    });

    return { companyId, agentId };
  }

  it("tickTimers does not enqueue runs for agents in archived companies", async () => {
    const heartbeat = heartbeatService(db);

    // Active company — should be scheduled
    const active = await seedAgent({ companyStatus: "active" });
    // Archived company — should be skipped
    const archived = await seedAgent({ companyStatus: "archived" });

    const result = await heartbeat.tickTimers(new Date());

    // Only the active company agent should be checked
    expect(result.checked).toBe(1);

    // Verify a wakeup was created only for the active company agent
    const wakeups = await db.select().from(agentWakeupRequests);
    const wakeupAgentIds = wakeups.map((w) => w.agentId);
    expect(wakeupAgentIds).toContain(active.agentId);
    expect(wakeupAgentIds).not.toContain(archived.agentId);
  });

  it("enqueueWakeup rejects wakeup for agents in archived companies", async () => {
    const heartbeat = heartbeatService(db);
    const { agentId } = await seedAgent({ companyStatus: "archived" });

    await expect(
      heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual" }),
    ).rejects.toThrow(/archived/i);
  });

  it("resumeQueuedRuns skips queued runs for agents in archived companies", async () => {
    const heartbeat = heartbeatService(db);
    const { companyId, agentId } = await seedAgent({ companyStatus: "active" });

    // Manually insert a queued run
    const runId = randomUUID();
    const wakeupId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupId,
      companyId,
      agentId,
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      payload: {},
      status: "claimed",
      runId,
      claimedAt: new Date(),
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "timer",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: wakeupId,
      contextSnapshot: {},
    });

    // Now archive the company
    await db.update(companies).set({ status: "archived" }).where(eq(companies.id, companyId));

    // resumeQueuedRuns should not start the run because the company is now archived
    await heartbeat.resumeQueuedRuns();

    // Run should still be queued (not started)
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run.status).toBe("queued");
  });
});
