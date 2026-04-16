import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { and, asc, eq, or } from "drizzle-orm";
import { WebSocketServer } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  activityLog,
  applyPendingMigrations,
  companies,
  createDb,
  ensurePostgresDatabase,
  getEmbeddedPostgresTestSupport,
  heartbeatRuns,
  issueComments,
  issueRelations,
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-heartbeat-comment-wake-"));
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

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000, intervalMs = 50) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition");
}

async function createControlledGatewayServer() {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const agentPayloads: Array<Record<string, unknown>> = [];
  let firstWaitRelease: (() => void) | null = null;
  let firstWaitGate = new Promise<void>((resolve) => {
    firstWaitRelease = resolve;
  });
  let waitCount = 0;

  wss.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "nonce-123" },
      }),
    );

    socket.on("message", async (raw) => {
      const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
      const frame = JSON.parse(text) as {
        type: string;
        id: string;
        method: string;
        params?: Record<string, unknown>;
      };

      if (frame.type !== "req") return;

      if (frame.method === "connect") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: 3,
              server: { version: "test", connId: "conn-1" },
              features: { methods: ["connect", "agent", "agent.wait"], events: ["agent"] },
              snapshot: { version: 1, ts: Date.now() },
              policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000, tickIntervalMs: 30_000 },
            },
          }),
        );
        return;
      }

      if (frame.method === "agent") {
        agentPayloads.push((frame.params ?? {}) as Record<string, unknown>);
        const runId =
          typeof frame.params?.idempotencyKey === "string"
            ? frame.params.idempotencyKey
            : `run-${agentPayloads.length}`;

        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              runId,
              status: "accepted",
              acceptedAt: Date.now(),
            },
          }),
        );
        return;
      }

      if (frame.method === "agent.wait") {
        waitCount += 1;
        if (waitCount === 1) {
          await firstWaitGate;
        }
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              runId: frame.params?.runId,
              status: "ok",
              startedAt: 1,
              endedAt: 2,
            },
          }),
        );
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve test server address");
  }

  return {
    url: `ws://127.0.0.1:${address.port}`,
    getAgentPayloads: () => agentPayloads,
    releaseFirstWait: () => {
      firstWaitRelease?.();
      firstWaitRelease = null;
      firstWaitGate = Promise.resolve();
    },
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat wake batching tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat comment wake batching", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 45_000);

  afterAll(async () => {
    await waitFor(async () => {
      const activeRuns = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(or(eq(heartbeatRuns.status, "queued"), eq(heartbeatRuns.status, "running")));
      return activeRuns.length === 0;
    }, 15_000);
    await db.$client.end();
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 45_000);

  it("does not count queued backlog against the live run limit", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "Queue Guard Co",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
      });

      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Guarded Agent",
        role: "engineer",
        status: "idle",
        adapterType: "openclaw_gateway",
        adapterConfig: {
          url: "ws://127.0.0.1:9",
        },
        runtimeConfig: {
          heartbeat: {
            maxLiveRuns: 2,
          },
        },
        permissions: {},
      });

      await db.insert(heartbeatRuns).values([
        {
          companyId,
          agentId,
          invocationSource: "on_demand",
          triggerDetail: "manual",
          status: "queued",
          contextSnapshot: { taskId: "seed-queued" },
        },
        {
          companyId,
          agentId,
          invocationSource: "on_demand",
          triggerDetail: "manual",
          status: "running",
          contextSnapshot: { taskId: "seed-running" },
        },
      ]);

      const wakeResult = await heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "manual_probe",
        payload: { probe: true },
        contextSnapshot: { taskId: "new-task" },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      });

      expect(wakeResult).toBeTruthy();

      const liveRuns = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId), or(eq(heartbeatRuns.status, "queued"), eq(heartbeatRuns.status, "running"))));
      expect(liveRuns).toHaveLength(3);

      const skippedWakeups = await db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.agentId, agentId),
            eq(agentWakeupRequests.status, "skipped"),
            eq(agentWakeupRequests.reason, "heartbeat.live_run_limit_reached"),
          ),
        );

      expect(skippedWakeups).toHaveLength(0);
    } finally {
      await db
        .update(heartbeatRuns)
        .set({
          status: "cancelled",
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId), or(eq(heartbeatRuns.status, "queued"), eq(heartbeatRuns.status, "running"))));
    }
  });

  async function seedGatewaySlotOptimizerCompany(gatewayUrl: string) {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const ownerAgentId = randomUUID();
    const followerAgentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Slot Optimizer Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Owner Agent",
        role: "engineer",
        status: "idle",
        adapterType: "openclaw_gateway",
        adapterConfig: {
          url: gatewayUrl,
          headers: {
            "x-openclaw-token": "gateway-token",
          },
          payloadTemplate: {
            message: "owner wake",
          },
          waitTimeoutMs: 2_000,
        },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: followerAgentId,
        companyId,
        name: "Follower Agent",
        role: "engineer",
        status: "idle",
        adapterType: "openclaw_gateway",
        adapterConfig: {
          url: gatewayUrl,
          headers: {
            "x-openclaw-token": "gateway-token",
          },
          payloadTemplate: {
            message: "follower wake",
          },
          waitTimeoutMs: 2_000,
        },
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Same issue slot",
      status: "todo",
      priority: "medium",
      assigneeAgentId: ownerAgentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, issueId, ownerAgentId, followerAgentId };
  }

  it("defers a wake when the same issue has no free slot", async () => {
    const gateway = await createControlledGatewayServer();
    const { companyId, issueId, ownerAgentId, followerAgentId } = await seedGatewaySlotOptimizerCompany(gateway.url);
    const heartbeat = heartbeatService(db);

    try {
      const firstRun = await heartbeat.wakeup(ownerAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_assigned",
        },
        requestedByActorType: "system",
        requestedByActorId: null,
      });

      expect(firstRun).not.toBeNull();
      await waitFor(() => gateway.getAgentPayloads().length === 1);

      const followerWake = await heartbeat.wakeup(followerAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_assigned",
        },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      });

      expect(followerWake).toBeNull();

      const deferredWake = await db
        .select({
          status: agentWakeupRequests.status,
          reason: agentWakeupRequests.reason,
          payload: agentWakeupRequests.payload,
        })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.agentId, followerAgentId),
            eq(agentWakeupRequests.status, "deferred_issue_execution"),
          ),
        )
        .then((rows) => rows[0] ?? null);

      expect(deferredWake?.reason).toBe("issue_execution_deferred");
      expect((deferredWake?.payload as Record<string, unknown> | null)?.issueId).toBe(issueId);

      gateway.releaseFirstWait();

      await waitFor(() => gateway.getAgentPayloads().length >= 2);
      await waitFor(async () => {
        const runs = await db
          .select({ agentId: heartbeatRuns.agentId, status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.companyId, companyId));
        return runs.some((run) => run.agentId === followerAgentId && run.status === "succeeded");
      }, 45_000);

      const promotedWake = await db
        .select({
          status: agentWakeupRequests.status,
          reason: agentWakeupRequests.reason,
        })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.agentId, followerAgentId),
            eq(agentWakeupRequests.reason, "issue_execution_promoted"),
          ),
        )
        .then((rows) => rows[0] ?? null);

      expect(promotedWake?.status).toBe("completed");
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 60_000);

  it("does not steal valid running work when issue_comment_mentioned arrives", async () => {
    const gateway = await createControlledGatewayServer();
    const { companyId, issueId, ownerAgentId, followerAgentId } = await seedGatewaySlotOptimizerCompany(gateway.url);
    const heartbeat = heartbeatService(db);

    try {
      const firstRun = await heartbeat.wakeup(ownerAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_assigned",
        },
        requestedByActorType: "system",
        requestedByActorId: null,
      });

      expect(firstRun).not.toBeNull();
      await waitFor(() => gateway.getAgentPayloads().length === 1);

      const stealAttempt = await heartbeat.wakeup(followerAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_comment_mentioned",
        payload: { issueId },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_comment_mentioned",
        },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      });

      expect(stealAttempt).toBeNull();

      const followerRuns = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, followerAgentId)));
      expect(followerRuns).toHaveLength(0);
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 45_000);

  it("keeps recovered blocked issues blocked during operations sweeps", async () => {
    const companyId = randomUUID();
    const operationsAgentId = randomUUID();
    const sourceIssueId = randomUUID();
    const successorIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Recovery Ops Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: operationsAgentId,
      companyId,
      name: "Operations",
      role: "coo",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        executionBoundary: "orchestrator_only",
      },
      permissions: {},
    });

    await db.insert(issues).values([
      {
        id: sourceIssueId,
        companyId,
        title: "Recovered source issue",
        status: "blocked",
        priority: "high",
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: successorIssueId,
        companyId,
        title: "Successor issue",
        status: "todo",
        priority: "high",
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);

    await db.insert(issueRelations).values({
      companyId,
      issueId: sourceIssueId,
      relatedIssueId: successorIssueId,
      type: "recovered_by",
    });

    const run = await heartbeat.wakeup(operationsAgentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual_probe",
      requestedByActorType: "user",
      requestedByActorId: "user-1",
    });

    expect(run).not.toBeNull();
    await waitFor(async () => {
      const currentRun = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run!.id))
        .then((rows) => rows[0] ?? null);
      return currentRun?.status === "succeeded";
    }, 20_000);

    const sourceIssue = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, sourceIssueId))
      .then((rows) => rows[0] ?? null);

    expect(sourceIssue?.status).toBe("blocked");
  });

  it("excludes user-assigned todo work from operations auto-assignment sweeps", async () => {
    const companyId = randomUUID();
    const operationsAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const humanOwnedIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Human-owned work stays human-owned",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: operationsAgentId,
        companyId,
        name: "Operations",
        role: "coo",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {
          executionBoundary: "orchestrator_only",
        },
        permissions: {},
      },
      {
        id: workerAgentId,
        companyId,
        name: "Engineer",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(issues).values({
      id: humanOwnedIssueId,
      companyId,
      title: "Human-owned TODO should not be auto-assigned to an agent",
      status: "todo",
      priority: "urgent",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const run = await heartbeat.wakeup(operationsAgentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual_probe",
      requestedByActorType: "user",
      requestedByActorId: "user-1",
    });

    expect(run).not.toBeNull();
    await waitFor(async () => {
      const currentRun = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run!.id))
        .then((rows) => rows[0] ?? null);
      return currentRun?.status === "succeeded";
    }, 20_000);

    const persistedIssue = await db
      .select({
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
      })
      .from(issues)
      .where(eq(issues.id, humanOwnedIssueId))
      .then((rows) => rows[0] ?? null);
    const persistedRun = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run!.id))
      .then((rows) => rows[0] ?? null);
    const context = (persistedRun?.contextSnapshot ?? {}) as Record<string, unknown>;
    const sweep = (context.operationsHeartbeatSweep ?? {}) as Record<string, unknown>;

    expect(persistedIssue).toMatchObject({
      assigneeAgentId: null,
      assigneeUserId: "local-board",
    });
    expect(sweep.unassignedOpenCount).toBe(0);
    expect(sweep.targetIssueId).toBeNull();
    expect(sweep.targetMode).toBeNull();
  });

  it("does not auto-reassign cross-agent recovery work during operations sweeps", async () => {
    const companyId = randomUUID();
    const operationsAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const issueId = randomUUID();
    const blockerIssueId = randomUUID();
    const completedRunId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Manual Recovery Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: operationsAgentId,
        companyId,
        name: "Operations",
        role: "coo",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {
          executionBoundary: "orchestrator_only",
        },
        permissions: {},
      },
      {
        id: workerAgentId,
        companyId,
        name: "Product Engineer - App",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values({
      id: completedRunId,
      companyId,
      agentId: workerAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "completed",
      startedAt: new Date("2026-04-01T00:00:00.000Z"),
      finishedAt: new Date("2026-04-01T00:10:00.000Z"),
      contextSnapshot: { issueId },
    });

    await db.insert(issues).values([
      {
        id: blockerIssueId,
        companyId,
        title: "Upstream blocker",
        status: "todo",
        priority: "critical",
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: issueId,
        companyId,
        title: "Blocked assigned issue without recovery truth",
        status: "blocked",
        priority: "high",
        assigneeAgentId: workerAgentId,
        executionRunId: completedRunId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: issueId,
      type: "blocks",
    });

    const run = await heartbeat.wakeup(operationsAgentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual_probe",
      requestedByActorType: "user",
      requestedByActorId: "user-1",
    });

    expect(run).not.toBeNull();
    await waitFor(async () => {
      const currentRun = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run!.id))
        .then((rows) => rows[0] ?? null);
      return currentRun?.status === "succeeded";
    }, 20_000);

    const persistedIssues = await db
      .select({
        id: issues.id,
        assigneeAgentId: issues.assigneeAgentId,
        status: issues.status,
      })
      .from(issues)
      .where(eq(issues.companyId, companyId))
      .orderBy(asc(issues.createdAt));
    const relations = await db
      .select({
        issueId: issueRelations.issueId,
        relatedIssueId: issueRelations.relatedIssueId,
        type: issueRelations.type,
      })
      .from(issueRelations)
      .where(eq(issueRelations.companyId, companyId));
    const comments = await db
      .select({
        body: issueComments.body,
      })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .orderBy(asc(issueComments.createdAt));
    const wakeups = await db
      .select({
        agentId: agentWakeupRequests.agentId,
        reason: agentWakeupRequests.reason,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId))
      .orderBy(asc(agentWakeupRequests.createdAt));

    const persistedIssue = persistedIssues.find((issue) => issue.id === issueId);
    expect(persistedIssue).toMatchObject({
      id: issueId,
      assigneeAgentId: workerAgentId,
      status: "blocked",
    });
    expect(relations).toEqual([
      expect.objectContaining({
        issueId: blockerIssueId,
        relatedIssueId: issueId,
        type: "blocks",
      }),
    ]);
    expect(comments.some((comment) => comment.body?.includes("[operations-heartbeat-recovery]"))).toBe(true);
    expect(comments.some((comment) => comment.body?.includes("[operations-heartbeat-assignment]"))).toBe(false);
    expect(
      wakeups.some((wakeup) => (
        wakeup.agentId === workerAgentId && wakeup.reason === "operations_cross_agent_recovery"
      )),
    ).toBe(true);
  });

  it("wakes idle owned work when the assignee still has free concurrent slots", async () => {
    const companyId = randomUUID();
    const operationsAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const issueId = randomUUID();
    const busyRunId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "Concurrent Idle Wake Co",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
      });

      await db.insert(agents).values([
        {
          id: operationsAgentId,
          companyId,
          name: "Operations",
          role: "coo",
          status: "idle",
          adapterType: "codex_local",
          adapterConfig: {},
          runtimeConfig: {
            executionBoundary: "orchestrator_only",
          },
          permissions: {},
        },
        {
          id: workerAgentId,
          companyId,
          name: "Product Engineer - App",
          role: "engineer",
          status: "idle",
          adapterType: "codex_local",
          adapterConfig: {},
          runtimeConfig: {
            heartbeat: {
              maxConcurrentRuns: 2,
            },
          },
          permissions: {},
        },
      ]);

      await db.insert(heartbeatRuns).values({
        id: busyRunId,
        companyId,
        agentId: workerAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        startedAt: new Date("2026-04-16T10:00:00.000Z"),
        contextSnapshot: { issueId: randomUUID() },
      });

      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Idle assigned work should still wake with spare concurrency",
        status: "todo",
        priority: "high",
        assigneeAgentId: workerAgentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });

      const run = await heartbeat.wakeup(operationsAgentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "manual_probe",
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      });

      expect(run).not.toBeNull();
      await waitFor(async () => {
        const currentRun = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, run!.id))
          .then((rows) => rows[0] ?? null);
        return currentRun?.status === "succeeded";
      }, 20_000);

      const comments = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId))
        .orderBy(asc(issueComments.createdAt));
      const wakeups = await db
        .select({
          agentId: agentWakeupRequests.agentId,
          reason: agentWakeupRequests.reason,
        })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, companyId))
        .orderBy(asc(agentWakeupRequests.createdAt));

      expect(comments.some((comment) => comment.body?.includes("[operations-heartbeat-wakeup]"))).toBe(true);
      expect(
        wakeups.some((wakeup) => (
          wakeup.agentId === workerAgentId && wakeup.reason === "operations_idle_assignment_wakeup"
        )),
      ).toBe(true);
    } finally {
      await db
        .update(heartbeatRuns)
        .set({
          status: "cancelled",
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, busyRunId));
    }
  });

  it("emits only one idle wake per assignee when the sweep exhausts the local slot budget", async () => {
    const companyId = randomUUID();
    const operationsAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const firstIssueId = randomUUID();
    const secondIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Single Slot Idle Wake Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: operationsAgentId,
        companyId,
        name: "Operations",
        role: "coo",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {
          executionBoundary: "orchestrator_only",
        },
        permissions: {},
      },
      {
        id: workerAgentId,
        companyId,
        name: "Product Engineer - App",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            maxConcurrentRuns: 1,
          },
        },
        permissions: {},
      },
    ]);

    await db.insert(issues).values([
      {
        id: firstIssueId,
        companyId,
        title: "First idle assigned issue",
        status: "todo",
        priority: "high",
        assigneeAgentId: workerAgentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: secondIssueId,
        companyId,
        title: "Second idle assigned issue",
        status: "todo",
        priority: "high",
        assigneeAgentId: workerAgentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);

    const run = await heartbeat.wakeup(operationsAgentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual_probe",
      requestedByActorType: "user",
      requestedByActorId: "user-1",
    });

    expect(run).not.toBeNull();
    await waitFor(async () => {
      const currentRun = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run!.id))
        .then((rows) => rows[0] ?? null);
      return currentRun?.status === "succeeded";
    }, 20_000);

    const comments = await db
      .select({
        issueId: issueComments.issueId,
        body: issueComments.body,
      })
      .from(issueComments)
      .where(or(eq(issueComments.issueId, firstIssueId), eq(issueComments.issueId, secondIssueId)))
      .orderBy(asc(issueComments.createdAt));
    const wakeups = await db
      .select({
        agentId: agentWakeupRequests.agentId,
        reason: agentWakeupRequests.reason,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId))
      .orderBy(asc(agentWakeupRequests.createdAt));

    expect(comments.filter((comment) => comment.body?.includes("[operations-heartbeat-wakeup]"))).toHaveLength(1);
    expect(
      wakeups.filter((wakeup) => (
        wakeup.agentId === workerAgentId && wakeup.reason === "operations_idle_assignment_wakeup"
      )),
    ).toHaveLength(1);
  });

  it("skips cross-agent recovery wakes when the target assignee has no free slot", async () => {
    const companyId = randomUUID();
    const operationsAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const issueId = randomUUID();
    const blockerIssueId = randomUUID();
    const completedRunId = randomUUID();
    const busyRunId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "Recovery Capacity Co",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
      });

      await db.insert(agents).values([
        {
          id: operationsAgentId,
          companyId,
          name: "Operations",
          role: "coo",
          status: "idle",
          adapterType: "codex_local",
          adapterConfig: {},
          runtimeConfig: {
            executionBoundary: "orchestrator_only",
          },
          permissions: {},
        },
        {
          id: workerAgentId,
          companyId,
          name: "Product Engineer - App",
          role: "engineer",
          status: "idle",
          adapterType: "codex_local",
          adapterConfig: {},
          runtimeConfig: {
            heartbeat: {
              maxConcurrentRuns: 1,
            },
          },
          permissions: {},
        },
      ]);

      await db.insert(heartbeatRuns).values([
        {
          id: completedRunId,
          companyId,
          agentId: workerAgentId,
          invocationSource: "assignment",
          triggerDetail: "system",
          status: "completed",
          startedAt: new Date("2026-04-01T00:00:00.000Z"),
          finishedAt: new Date("2026-04-01T00:10:00.000Z"),
          contextSnapshot: { issueId },
        },
        {
          id: busyRunId,
          companyId,
          agentId: workerAgentId,
          invocationSource: "assignment",
          triggerDetail: "system",
          status: "running",
          startedAt: new Date("2026-04-16T10:00:00.000Z"),
          contextSnapshot: { issueId: blockerIssueId },
        },
      ]);

      await db.insert(issues).values([
        {
          id: blockerIssueId,
          companyId,
          title: "Upstream blocker",
          status: "todo",
          priority: "critical",
          issueNumber: 1,
          identifier: `${issuePrefix}-1`,
        },
        {
          id: issueId,
          companyId,
          title: "Blocked assigned issue without recovery truth",
          status: "blocked",
          priority: "high",
          assigneeAgentId: workerAgentId,
          executionRunId: completedRunId,
          issueNumber: 2,
          identifier: `${issuePrefix}-2`,
        },
      ]);
      await db.insert(issueRelations).values({
        companyId,
        issueId: blockerIssueId,
        relatedIssueId: issueId,
        type: "blocks",
      });

      const run = await heartbeat.wakeup(operationsAgentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "manual_probe",
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      });

      expect(run).not.toBeNull();
      await waitFor(async () => {
        const currentRun = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, run!.id))
          .then((rows) => rows[0] ?? null);
        return currentRun?.status === "succeeded";
      }, 20_000);

      const comments = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId))
        .orderBy(asc(issueComments.createdAt));
      const wakeups = await db
        .select({
          agentId: agentWakeupRequests.agentId,
          reason: agentWakeupRequests.reason,
        })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, companyId))
        .orderBy(asc(agentWakeupRequests.createdAt));

      expect(comments.some((comment) => comment.body?.includes("[operations-heartbeat-recovery]"))).toBe(false);
      expect(
        wakeups.some((wakeup) => (
          wakeup.agentId === workerAgentId && wakeup.reason === "operations_cross_agent_recovery"
        )),
      ).toBe(false);
    } finally {
      await db
        .update(heartbeatRuns)
        .set({
          status: "cancelled",
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, busyRunId));
    }
  });

  it("batches deferred comment wakes and forwards the ordered batch to the next run", async () => {
    const gateway = await createControlledGatewayServer();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "PrivateClip",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
      });

      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Gateway Agent",
        role: "engineer",
        status: "idle",
        adapterType: "openclaw_gateway",
        adapterConfig: {
          url: gateway.url,
          headers: {
            "x-openclaw-token": "gateway-token",
          },
          payloadTemplate: {
            message: "wake now",
          },
          waitTimeoutMs: 2_000,
        },
        runtimeConfig: {},
        permissions: {},
      });

      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Batch wake comments",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });

      const comment1 = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId,
          authorUserId: "user-1",
          body: "First comment",
        })
        .returning()
        .then((rows) => rows[0]);
      const firstRun = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId, commentId: comment1.id },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          commentId: comment1.id,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      });

      expect(firstRun).not.toBeNull();
      await waitFor(() => gateway.getAgentPayloads().length === 1);

      await db.insert(issueComments).values({
        companyId,
        issueId,
        authorAgentId: agentId,
        createdByRunId: firstRun?.id ?? null,
        body: "Heartbeat acknowledged",
      });

      const comment2 = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId,
          authorUserId: "user-1",
          body: "Second comment",
        })
        .returning()
        .then((rows) => rows[0]);
      const comment3 = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId,
          authorUserId: "user-1",
          body: "Third comment",
        })
        .returning()
        .then((rows) => rows[0]);

      const secondRun = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId, commentId: comment2.id },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          commentId: comment2.id,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      });
      const thirdRun = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId, commentId: comment3.id },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          commentId: comment3.id,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      });

      expect(secondRun).toBeNull();
      expect(thirdRun).toBeNull();

      await waitFor(async () => {
        const deferred = await db
          .select()
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, companyId),
              eq(agentWakeupRequests.agentId, agentId),
              eq(agentWakeupRequests.status, "deferred_issue_execution"),
            ),
          )
          .then((rows) => rows[0] ?? null);
        return Boolean(deferred);
      });

      const deferredWake = await db
          .select()
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, companyId),
              eq(agentWakeupRequests.agentId, agentId),
              eq(agentWakeupRequests.status, "deferred_issue_execution"),
            ),
          )
          .then((rows) => rows[0] ?? null);

      const deferredContext = (deferredWake?.payload as Record<string, unknown> | null)?._paperclipWakeContext as
        | Record<string, unknown>
        | undefined;
      expect(deferredContext?.wakeCommentIds).toEqual([comment2.id, comment3.id]);

      gateway.releaseFirstWait();

      await waitFor(() => gateway.getAgentPayloads().length >= 2);
      await waitFor(async () => {
        const runs = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.agentId, agentId))
          .orderBy(asc(heartbeatRuns.createdAt));
        const promotedBatchRun = runs.find((run) => {
          if (run.retryOfRunId) return false;
          const context = (run.contextSnapshot ?? {}) as Record<string, unknown>;
          return context.commentId === comment3.id;
        });
        return promotedBatchRun?.status === "succeeded";
      }, 45_000);

      const secondPayload = gateway.getAgentPayloads()[1] ?? {};
      expect(secondPayload.paperclip).toMatchObject({
        wake: {
          commentIds: [comment2.id, comment3.id],
          latestCommentId: comment3.id,
        },
      });
      expect(String(secondPayload.message ?? "")).toContain("Second comment");
      expect(String(secondPayload.message ?? "")).toContain("Third comment");
      expect(String(secondPayload.message ?? "")).not.toContain("First comment");
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 60_000);

  it("queues exactly one follow-up run when an issue-bound run exits without a comment", async () => {
    const gateway = await createControlledGatewayServer();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "PrivateClip",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
      });

      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Gateway Agent",
        role: "engineer",
        status: "idle",
        adapterType: "openclaw_gateway",
        adapterConfig: {
          url: gateway.url,
          headers: {
            "x-openclaw-token": "gateway-token",
          },
          payloadTemplate: {
            message: "wake now",
          },
          waitTimeoutMs: 2_000,
        },
        runtimeConfig: {},
        permissions: {},
      });

      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Require a comment",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });

      const firstRun = await heartbeat.wakeup(agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_assigned",
        },
        requestedByActorType: "system",
        requestedByActorId: null,
      });

      expect(firstRun).not.toBeNull();
      await waitFor(() => gateway.getAgentPayloads().length === 1);
      gateway.releaseFirstWait();
      await waitFor(async () => {
        const runs = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.agentId, agentId))
          .orderBy(asc(heartbeatRuns.createdAt));
        return (
          runs.length === 2 &&
          runs.every((run) => run.status === "succeeded") &&
          runs[0]?.issueCommentStatus === "retry_queued" &&
          runs[1]?.issueCommentStatus === "retry_exhausted"
        );
      });

      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId))
        .orderBy(asc(heartbeatRuns.createdAt));

      expect(runs).toHaveLength(2);
      expect(runs[0]?.issueCommentStatus).toBe("retry_queued");
      expect(runs[1]?.retryOfRunId).toBe(runs[0]?.id);
      expect(runs[1]?.issueCommentStatus).toBe("retry_exhausted");

      await waitFor(async () => {
        const comments = await db
          .select()
          .from(issueComments)
          .where(eq(issueComments.issueId, issueId));
        return comments.length === 1;
      });

      const comments = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId));
      expect(comments).toHaveLength(1);
      expect(comments[0]?.body).toContain("Run completed without publishing an issue comment");
      expect(comments[0]?.body).toContain("operator recovery");

      await waitFor(async () => {
        const wakeups = await db
          .select()
          .from(agentWakeupRequests)
          .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)));
        return wakeups.length >= 2;
      });

      const payloads = gateway.getAgentPayloads();
      expect(payloads).toHaveLength(2);
      expect(runs[1]?.contextSnapshot).toMatchObject({
        retryReason: "missing_issue_comment",
      });
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 20_000);

  it("does not emit duplicate comment recovery notices when the same issue exhausts twice without new issue comments", async () => {
    const gateway = await createControlledGatewayServer();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "PrivateClip",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
      });

      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Gateway Agent",
        role: "engineer",
        status: "idle",
        adapterType: "openclaw_gateway",
        adapterConfig: {
          url: gateway.url,
          headers: {
            "x-openclaw-token": "gateway-token",
          },
          payloadTemplate: {
            message: "wake now",
          },
          waitTimeoutMs: 2_000,
        },
        runtimeConfig: {},
        permissions: {},
      });

      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Require a comment",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });

      const wakeInput = {
        source: "assignment" as const,
        triggerDetail: "system" as const,
        reason: "issue_assigned",
        payload: { issueId },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_assigned",
        },
        requestedByActorType: "system" as const,
        requestedByActorId: null,
      };

      const firstRun = await heartbeat.wakeup(agentId, wakeInput);
      expect(firstRun).not.toBeNull();

      await waitFor(() => gateway.getAgentPayloads().length === 1);
      gateway.releaseFirstWait();
      await waitFor(async () => {
        const runs = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.agentId, agentId))
          .orderBy(asc(heartbeatRuns.createdAt));
        return (
          runs.length === 2 &&
          runs.every((run) => run.status === "succeeded") &&
          runs[1]?.issueCommentStatus === "retry_exhausted"
        );
      });

      await waitFor(async () => {
        const comments = await db
          .select()
          .from(issueComments)
          .where(eq(issueComments.issueId, issueId));
        const recoveryEvents = await db
          .select()
          .from(activityLog)
          .where(
            and(
              eq(activityLog.companyId, companyId),
              eq(activityLog.entityType, "issue"),
              eq(activityLog.entityId, issueId),
              eq(activityLog.action, "issue.comment_recovery_required"),
            ),
          );
        return comments.length === 1 && recoveryEvents.length === 1;
      });

      const secondRun = await heartbeat.wakeup(agentId, wakeInput);
      expect(secondRun).not.toBeNull();

      await waitFor(() => gateway.getAgentPayloads().length === 4);
      await waitFor(async () => {
        const runs = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.agentId, agentId))
          .orderBy(asc(heartbeatRuns.createdAt));
        return (
          runs.length === 4 &&
          runs.every((run) => run.status === "succeeded") &&
          runs[3]?.issueCommentStatus === "retry_exhausted"
        );
      });

      const comments = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId))
        .orderBy(asc(issueComments.createdAt));
      const recoveryEvents = await db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.entityType, "issue"),
            eq(activityLog.entityId, issueId),
            eq(activityLog.action, "issue.comment_recovery_required"),
          ),
        )
        .orderBy(asc(activityLog.createdAt));

      expect(comments).toHaveLength(1);
      expect(comments[0]?.body).toContain("Run completed without publishing an issue comment");
      expect(recoveryEvents).toHaveLength(1);
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 20_000);
});
