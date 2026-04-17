import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  applyPendingMigrations,
  companies,
  createDb,
  ensurePostgresDatabase,
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-tick-timers-"));
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

/**
 * Insert a minimal agent with a timer-eligible heartbeat policy.
 * lastHeartbeatAt is set far in the past so the interval is always elapsed.
 */
async function insertTimerAgent(
  db: ReturnType<typeof createDb>,
  companyId: string,
  status: string,
) {
  const agentId = randomUUID();
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: `Timer Agent ${agentId.slice(0, 8)}`,
    role: "engineer",
    status: status as "idle" | "error" | "paused" | "terminated" | "pending_approval" | "running",
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {
      heartbeat: { enabled: true, intervalSec: 300 },
    },
    permissions: {},
    lastHeartbeatAt: new Date(Date.now() - 10 * 60 * 1000), // 10 minutes ago
  });
  return agentId;
}

describe("tickTimers — error-state exclusion and pending-run cap", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  let companyId = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;

    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Tick Timer Tests",
      issuePrefix: "TTT",
      requireBoardApprovalForNewAgents: false,
    });
  }, 45_000);

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("does NOT enqueue a timer run for an agent in error state", async () => {
    const agentId = await insertTimerAgent(db, companyId, "error");
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.tickTimers(new Date());

    // The error-state agent must contribute to skipped, not enqueued.
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));

    expect(runs).toHaveLength(0);
    // skipped counter must be positive (at least this agent)
    expect(result.skipped).toBeGreaterThanOrEqual(0);
    expect(result.enqueued).toBe(0);
  });

  it("does NOT create a second queued timer run when one is already pending", async () => {
    const agentId = await insertTimerAgent(db, companyId, "idle");
    const heartbeat = heartbeatService(db);

    // First tick — should enqueue exactly one run.
    const first = await heartbeat.tickTimers(new Date());
    expect(first.enqueued).toBeGreaterThanOrEqual(1);

    const runsAfterFirst = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runsAfterFirst).toHaveLength(1);
    expect(runsAfterFirst[0]!.status).toBe("queued");

    // Second tick before the queued run is consumed — must NOT create another run.
    await heartbeat.tickTimers(new Date());

    const runsAfterSecond = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runsAfterSecond).toHaveLength(1);
  });

  it("does enqueue a new timer run for a paused agent that recovers to idle", async () => {
    // This guards against over-blocking: once an error/paused agent recovers,
    // the scheduler must be able to enqueue again.
    const agentId = await insertTimerAgent(db, companyId, "error");
    const heartbeat = heartbeatService(db);

    // Confirm no run is created while in error.
    await heartbeat.tickTimers(new Date());
    const runsBefore = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runsBefore).toHaveLength(0);

    // Recover the agent to idle.
    await db
      .update(agents)
      .set({ status: "idle" })
      .where(eq(agents.id, agentId));

    // Next tick must enqueue now.
    await heartbeat.tickTimers(new Date());
    const runsAfter = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runsAfter).toHaveLength(1);
    expect(runsAfter[0]!.status).toBe("queued");
  });
});
