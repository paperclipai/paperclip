import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  applyPendingMigrations,
  companies,
  createDb,
  ensurePostgresDatabase,
  issueComments,
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-retire-relays-"));
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

describe("retireResolvedRelayIssues", () => {
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
      sql`TRUNCATE issues, issue_comments, heartbeat_run_events, heartbeat_runs, agent_wakeup_requests, agent_runtime_state, agent_task_sessions, company_skills, activity_log, agents, companies CASCADE`,
    );
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  async function seedRelayFixture({
    relayTitle,
    relayStatus = "in_progress",
    targetIdentifier,
    targetStatus,
  }: {
    relayTitle: string;
    relayStatus?: string;
    targetIdentifier: string;
    targetStatus: string;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const targetId = randomUUID();
    const relayId = randomUUID();

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
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: targetId,
      companyId,
      title: "Target issue",
      status: targetStatus,
      assigneeAgentId: agentId,
      identifier: targetIdentifier,
      issueNumber: 1,
      ...(targetStatus === "done" ? { completedAt: new Date() } : {}),
      ...(targetStatus === "cancelled" ? { cancelledAt: new Date() } : {}),
    });

    await db.insert(issues).values({
      id: relayId,
      companyId,
      title: relayTitle,
      status: relayStatus,
      assigneeAgentId: agentId,
      identifier: `${issuePrefix}-2`,
      issueNumber: 2,
    });

    return { relayId, targetId, companyId };
  }

  it("marks direct relay work as done when the target lane is already in_review", async () => {
    const { relayId } = await seedRelayFixture({
      relayTitle: "DLD-2808 QA routing: post comment + patch status",
      targetIdentifier: "DLD-2808",
      targetStatus: "in_review",
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.retireResolvedRelayIssues();
    expect(result).toEqual({ retired: 1, done: 1, cancelled: 0 });

    const [relay] = await db.select().from(issues).where(eq(issues.id, relayId));
    expect(relay.status).toBe("done");
    expect(relay.completedAt).not.toBeNull();

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, relayId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Closing as done");
    expect(comments[0]?.body).toContain("DLD-2808");

    const logs = await db.select().from(activityLog).where(eq(activityLog.entityId, relayId));
    expect(logs.some((entry) => entry.action === "issue.updated")).toBe(true);
  });

  it("cancels escalation/lock workaround lanes once the target has advanced", async () => {
    const { relayId } = await seedRelayFixture({
      relayTitle: "[ESCALATION] DLD-2865 task_bound_scope double-gate",
      targetIdentifier: "DLD-2865",
      targetStatus: "in_review",
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.retireResolvedRelayIssues();
    expect(result).toEqual({ retired: 1, done: 0, cancelled: 1 });

    const [relay] = await db.select().from(issues).where(eq(issues.id, relayId));
    expect(relay.status).toBe("cancelled");
    expect(relay.cancelledAt).not.toBeNull();
  });

  it("does not retire normal issues or relays whose target has not advanced", async () => {
    const fixtureA = await seedRelayFixture({
      relayTitle: "Implement data export for DLD-3000",
      targetIdentifier: "DLD-3000",
      targetStatus: "in_review",
    });
    const fixtureB = await seedRelayFixture({
      relayTitle: "DLD-2808 QA routing: post comment + patch status",
      targetIdentifier: "DLD-2808",
      targetStatus: "in_progress",
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.retireResolvedRelayIssues();
    expect(result).toEqual({ retired: 0, done: 0, cancelled: 0 });

    const [normalIssue] = await db.select().from(issues).where(eq(issues.id, fixtureA.relayId));
    const [activeRelay] = await db.select().from(issues).where(eq(issues.id, fixtureB.relayId));
    expect(normalIssue.status).toBe("in_progress");
    expect(activeRelay.status).toBe("in_progress");
  });
});
