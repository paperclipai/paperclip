import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  applyPendingMigrations,
  companies,
  createDb,
  ensurePostgresDatabase,
  heartbeatRuns,
  type Db,
} from "@paperclipai/db";
import {
  DEFAULT_ORPHANED_RUN_STALE_THRESHOLD_MS,
  heartbeatService,
} from "../services/heartbeat.js";

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

const tempPaths: string[] = [];
const runningInstances: EmbeddedPostgresInstance[] = [];
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

async function createTempDatabase(): Promise<string> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-heartbeat-reaper-"));
  tempPaths.push(dataDir);
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
  runningInstances.push(instance);

  const adminUrl = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminUrl, "paperclip");
  return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
}

async function createTestDb(): Promise<Db> {
  const connectionString = await createTempDatabase();
  await applyPendingMigrations(connectionString);
  return createDb(connectionString);
}

function buildIssuePrefix() {
  return `T${randomUUID().replace(/-/g, "").slice(0, 7).toUpperCase()}`;
}

async function seedHeartbeatRun(
  db: Db,
  input: {
    runStatus: "queued" | "running";
    wakeupStatus: "queued" | "claimed";
    agentStatus: "idle" | "running";
    updatedAt: Date;
  },
) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const wakeupId = randomUUID();
  const runId = randomUUID();
  const now = new Date();

  await db.insert(companies).values({
    id: companyId,
    name: "Heartbeat Test Co",
    issuePrefix: buildIssuePrefix(),
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Worker",
    role: "engineer",
    status: input.agentStatus,
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
  });
  await db.insert(agentWakeupRequests).values({
    id: wakeupId,
    companyId,
    agentId,
    source: "on_demand",
    status: input.wakeupStatus,
    requestedAt: now,
    claimedAt: input.wakeupStatus === "claimed" ? now : null,
  });
  await db.insert(heartbeatRuns).values({
    id: runId,
    companyId,
    agentId,
    invocationSource: "on_demand",
    status: input.runStatus,
    wakeupRequestId: wakeupId,
    startedAt: now,
    updatedAt: input.updatedAt,
  });

  return { agentId, wakeupId, runId };
}

afterEach(async () => {
  while (runningInstances.length > 0) {
    const instance = runningInstances.pop();
    if (!instance) continue;
    await instance.stop();
  }
  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (!tempPath) continue;
    fs.rmSync(tempPath, { recursive: true, force: true });
  }
});

describe("heartbeatService.reapOrphanedRuns", () => {
  it(
    "does not fail a recently updated running run when startup recovery uses the default threshold",
    async () => {
      const db = await createTestDb();
      const { runId } = await seedHeartbeatRun(db, {
        runStatus: "running",
        wakeupStatus: "claimed",
        agentStatus: "running",
        updatedAt: new Date(),
      });

      const heartbeat = heartbeatService(db);
      const result = await heartbeat.reapOrphanedRuns();

      expect(result).toEqual({ reaped: 0, runIds: [] });

      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));
      expect(run?.status).toBe("running");
    },
    20_000,
  );

  it(
    "reaps a stale running run once it is past the default threshold",
    async () => {
      const db = await createTestDb();
      const staleUpdatedAt = new Date(Date.now() - DEFAULT_ORPHANED_RUN_STALE_THRESHOLD_MS - 1_000);
      const { agentId, wakeupId, runId } = await seedHeartbeatRun(db, {
        runStatus: "running",
        wakeupStatus: "claimed",
        agentStatus: "running",
        updatedAt: staleUpdatedAt,
      });

      const heartbeat = heartbeatService(db);
      const result = await heartbeat.reapOrphanedRuns();

      expect(result.reaped).toBe(1);
      expect(result.runIds).toEqual([runId]);

      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));
      expect(run?.status).toBe("failed");
      expect(run?.errorCode).toBe("process_lost");

      const [wakeup] = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupId));
      expect(wakeup?.status).toBe("failed");

      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, agentId));
      expect(agent?.status).toBe("error");
    },
    20_000,
  );

  it(
    "leaves queued runs alone so startup recovery can resume them separately",
    async () => {
      const db = await createTestDb();
      const oldUpdatedAt = new Date(Date.now() - DEFAULT_ORPHANED_RUN_STALE_THRESHOLD_MS - 1_000);
      const { runId } = await seedHeartbeatRun(db, {
        runStatus: "queued",
        wakeupStatus: "queued",
        agentStatus: "idle",
        updatedAt: oldUpdatedAt,
      });

      const heartbeat = heartbeatService(db);
      const result = await heartbeat.reapOrphanedRuns({ staleThresholdMs: 0 });

      expect(result).toEqual({ reaped: 0, runIds: [] });

      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));
      expect(run?.status).toBe("queued");
    },
    20_000,
  );
});
