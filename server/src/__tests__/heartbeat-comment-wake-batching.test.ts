import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { and, asc, desc, eq, or } from "drizzle-orm";
import { WebSocketServer } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  activityLog,
  applyPendingMigrations,
  companies,
  createDb,
  heartbeatRetryCircuits,
  ensurePostgresDatabase,
  getEmbeddedPostgresTestSupport,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import type { ServerAdapterModule } from "../adapters/index.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService, resolveOperationsHeartbeatTarget } from "../services/heartbeat.ts";
import { logger } from "../middleware/logger.js";

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

async function createControlledGatewayServer(options?: {
  waitPayload?: Record<string, unknown>;
}) {
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
        const payload = {
          runId: frame.params?.runId,
          status: "ok",
          startedAt: 1,
          endedAt: 2,
          ...(options?.waitPayload ?? {}),
        };
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload,
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
  const registeredAdapterTypes = new Set<string>();

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 45_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const adapterType of registeredAdapterTypes) {
      unregisterServerAdapter(adapterType);
    }
    registeredAdapterTypes.clear();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const activeRuns = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(or(eq(heartbeatRuns.status, "queued"), eq(heartbeatRuns.status, "running")));
      if (activeRuns.length === 0) break;
      if (attempt === 0) {
        await db
          .update(heartbeatRuns)
          .set({
            status: "cancelled",
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(or(eq(heartbeatRuns.status, "queued"), eq(heartbeatRuns.status, "running")));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });

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

  function registerTestAdapter(adapter: ServerAdapterModule) {
    unregisterServerAdapter(adapter.type);
    registerServerAdapter(adapter);
    registeredAdapterTypes.add(adapter.type);
    return adapter;
  }

  it("does not count queued backlog against the live run limit", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);
    const infoSpy = vi.spyOn(logger, "info");

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
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          opsEvent: true,
          event: "heartbeat.wakeup.queued",
          companyId,
          agentId,
          reason: "manual_probe",
        }),
        "heartbeat.wakeup.queued",
      );
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
    const infoSpy = vi.spyOn(logger, "info");

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
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          opsEvent: true,
          event: "heartbeat.wakeup.deferred_issue_execution",
          companyId,
          agentId: followerAgentId,
          issueId,
          reason: "issue_assigned",
        }),
        "heartbeat.wakeup.deferred_issue_execution",
      );

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

  it("logs live run limit skips as structured ops events", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);
    const warnSpy = vi.spyOn(logger, "warn");

    await db.insert(companies).values({
      id: companyId,
      name: "Limit Guard Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Limited Agent",
      role: "engineer",
      status: "idle",
      adapterType: "openclaw_gateway",
      adapterConfig: {
        url: "ws://127.0.0.1:9",
      },
      runtimeConfig: {
        heartbeat: {
          maxLiveRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "running",
      contextSnapshot: { taskId: "seed-running" },
    });

    const wakeResult = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual_probe",
      payload: { probe: true },
      contextSnapshot: { taskId: "manual-live-limit" },
      requestedByActorType: "user",
      requestedByActorId: "user-1",
    });

    expect(wakeResult).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        opsEvent: true,
        event: "heartbeat.wakeup.skipped_live_run_limit",
        companyId,
        agentId,
        reason: "manual_probe",
        liveRunLimit: 1,
      }),
      "heartbeat.wakeup.skipped_live_run_limit",
    );
  });

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
    expect(sweep.allOpenIssuesBlocked).toBe(true);
    expect(sweep.blockedReasonCounts).toMatchObject({
      human_owned: 1,
    });
  });

  it("treats pending wakeups as COO slot reservations before assigning unowned work", async () => {
    const companyId = randomUUID();
    const operationsAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const readyIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Pending Wake Reservation Co",
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
        runtimeConfig: {
          heartbeat: {
            maxConcurrentRuns: 1,
          },
        },
        permissions: {},
      },
    ]);

    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: workerAgentId,
      source: "automation",
      triggerDetail: "system",
      reason: "seeded_pending_wake",
      status: "queued",
      payload: { issueId: randomUUID() },
      requestedByActorType: "agent",
      requestedByActorId: operationsAgentId,
    });

    await db.insert(issues).values({
      id: readyIssueId,
      companyId,
      title: "Ready work must not overfill a pending wake slot",
      status: "todo",
      priority: "urgent",
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
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, readyIssueId))
      .then((rows) => rows[0] ?? null);
    const workerWakeups = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, workerAgentId)))
      .orderBy(asc(agentWakeupRequests.createdAt));
    const persistedRun = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run!.id))
      .then((rows) => rows[0] ?? null);
    const context = (persistedRun?.contextSnapshot ?? {}) as Record<string, unknown>;
    const sweep = (context.operationsHeartbeatSweep ?? {}) as Record<string, unknown>;

    expect(persistedIssue?.assigneeAgentId).toBeNull();
    expect(workerWakeups.map((wakeup) => wakeup.reason)).toEqual(["seeded_pending_wake"]);
    expect(sweep.assignedIssueCount).toBe(0);
    expect(sweep.blockedReasonCounts).toMatchObject({
      no_free_slot: 1,
    });
  });

  it("counts unassigned QA-like work without QA capacity as specialist capability-blocked", async () => {
    const companyId = randomUUID();
    const operationsAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const qaLikeIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "QA capability blocked work",
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
      id: qaLikeIssueId,
      companyId,
      title: "QA release validation",
      description: "Verify release candidate and post QA verdict.",
      status: "backlog",
      priority: "high",
      assigneeAgentId: null,
      assigneeUserId: null,
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
      })
      .from(issues)
      .where(eq(issues.id, qaLikeIssueId))
      .then((rows) => rows[0] ?? null);
    const persistedRun = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run!.id))
      .then((rows) => rows[0] ?? null);
    const context = (persistedRun?.contextSnapshot ?? {}) as Record<string, unknown>;
    const sweep = (context.operationsHeartbeatSweep ?? {}) as Record<string, unknown>;
    const operationsFlow = (sweep.operationsFlow ?? {}) as Record<string, unknown>;

    expect(persistedIssue?.assigneeAgentId ?? null).toBeNull();
    expect(sweep.targetIssueId).toBeNull();
    expect(sweep.allOpenIssuesBlocked).toBe(true);
    expect(sweep.blockedReasonCounts).toMatchObject({
      capability_blocked_specialist: 1,
    });
    expect(operationsFlow).toMatchObject({
      readyIssueCount: 1,
      residualReadyIssueCount: 0,
      blockedReasonCounts: {
        capability_blocked_specialist: 1,
      },
      freeSlotsByRole: {
        engineer: 1,
      },
      unusedCapacityReasons: {
        engineer: "no_matching_capability",
      },
      invariantBreaches: [],
    });
  });

  it("removes stale engineer ownership from QA-like work when no QA capacity exists", async () => {
    const companyId = randomUUID();
    const operationsAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const qaLikeIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "QA stale owner repair",
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
      id: qaLikeIssueId,
      companyId,
      title: "QA release validation",
      description: "Verify release candidate and post QA verdict.",
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

    const persistedIssue = await db
      .select({
        assigneeAgentId: issues.assigneeAgentId,
        status: issues.status,
      })
      .from(issues)
      .where(eq(issues.id, qaLikeIssueId))
      .then((rows) => rows[0] ?? null);
    expect(persistedIssue).toMatchObject({
      assigneeAgentId: null,
      status: "todo",
    });
  });

  it("stabilizes finalizable review work before assigning new backlog in the same COO sweep", async () => {
    const companyId = randomUUID();
    const operationsAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const engineerAgentId = randomUUID();
    const reviewIssueId = randomUUID();
    const backlogIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Fixed Point Recovery Co",
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
        id: qaAgentId,
        companyId,
        name: "QA Runner",
        role: "qa",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: engineerAgentId,
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

    await db.insert(issues).values([
      {
        id: reviewIssueId,
        companyId,
        title: "Release candidate is waiting for QA closeout",
        status: "in_review",
        priority: "high",
        assigneeAgentId: qaAgentId,
        qaReviewerAgentId: qaAgentId,
        workIntent: "delivery",
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: backlogIssueId,
        companyId,
        title: "Backlog issue should start once review closes",
        status: "backlog",
        priority: "medium",
        assigneeAgentId: null,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);

    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId: reviewIssueId,
      body: [
        "[QA PASS]",
        "[RELEASE CONFIRMED]",
        "",
        "Smart Review Summary",
        "Root cause: recovery must finalize the stale QA row before assigning new work.",
        "Fix: converge the queue to a stable state inside the same COO sweep.",
        "Verification: TYPECHECK pass, TESTS pass, BUILD pass, SMOKE pass.",
        "",
        "[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]",
      ].join("\n"),
      authorAgentId: qaAgentId,
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

    const [reviewIssue, backlogIssue, persistedRun, engineerWake] = await Promise.all([
      db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, reviewIssueId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId })
        .from(issues)
        .where(eq(issues.id, backlogIssueId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run!.id))
        .then((rows) => rows[0] ?? null),
      db
        .select({
          agentId: agentWakeupRequests.agentId,
          reason: agentWakeupRequests.reason,
          status: agentWakeupRequests.status,
          payload: agentWakeupRequests.payload,
        })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, engineerAgentId))
        .orderBy(desc(agentWakeupRequests.createdAt))
        .then((rows) => rows[0] ?? null),
    ]);

    const sweep = ((persistedRun?.contextSnapshot ?? {}) as Record<string, Record<string, unknown>>)
      .operationsHeartbeatSweep ?? {};

    expect(reviewIssue).toMatchObject({ status: "done" });
    expect(backlogIssue).toMatchObject({
      status: "todo",
      assigneeAgentId: engineerAgentId,
    });
    expect(engineerWake).toMatchObject({
      agentId: engineerAgentId,
      reason: "operations_assignment",
    });
    expect(["queued", "claimed", "running", "completed"]).toContain(engineerWake?.status);
    expect((engineerWake?.payload as Record<string, unknown> | null)?.issueId).toBe(backlogIssueId);
    expect(sweep).toMatchObject({
      finalizedIssueCount: 1,
      assignedIssueCount: 1,
      assignmentWakeupCount: 1,
      stabilizationPassCount: 1,
    });
  });

  it("logs issue.updated activity when operations heartbeat demotes fake WIP", async () => {
    const companyId = randomUUID();
    const operationsAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Operations Activity Co",
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
      id: issueId,
      companyId,
      title: "Issue that only looks in progress",
      status: "in_progress",
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

    const persistedIssue = await db
      .select({
        status: issues.status,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    const issueUpdates = await db
      .select({
        action: activityLog.action,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, "issue.updated"),
        ),
      );

    expect(persistedIssue?.status).toBe("todo");
    expect(issueUpdates).toContainEqual(
      expect.objectContaining({
        action: "issue.updated",
        details: expect.objectContaining({
          source: "operations_heartbeat",
          status: "todo",
          _previous: expect.objectContaining({
            status: "in_progress",
          }),
        }),
      }),
    );
  });

  it("reassigns a non-QA in_review delivery issue to the active pooled QA reviewer", async () => {
    const companyId = randomUUID();
    const operationsAgentId = randomUUID();
    const engineerAgentId = randomUUID();
    const qaReleaseOwnerId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Canonical QA Release Co",
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
        id: engineerAgentId,
        companyId,
        name: "Engineer",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: qaReleaseOwnerId,
        companyId,
        name: "QA and Release Engineer",
        role: "qa",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Feature in_review should route to the pooled QA reviewer",
      status: "in_review",
      priority: "high",
      assigneeAgentId: engineerAgentId,
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

    const updatedIssue = await db
      .select({
        assigneeAgentId: issues.assigneeAgentId,
        qaReviewerAgentId: issues.qaReviewerAgentId,
        status: issues.status,
        executionPolicy: issues.executionPolicy,
        executionState: issues.executionState,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    const persistedRun = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run!.id))
      .then((rows) => rows[0] ?? null);
    const sweep = (persistedRun?.contextSnapshot ?? {}) as Record<string, Record<string, unknown>>;

    expect(updatedIssue).toMatchObject({
      assigneeAgentId: qaReleaseOwnerId,
      qaReviewerAgentId: qaReleaseOwnerId,
      status: "in_review",
      executionPolicy: expect.objectContaining({
        stages: [expect.objectContaining({ type: "review" })],
      }),
      executionState: expect.objectContaining({
        status: "pending",
        currentStageType: "review",
        currentParticipant: expect.objectContaining({ type: "agent", agentId: qaReleaseOwnerId }),
        returnAssignee: expect.objectContaining({ type: "agent", agentId: engineerAgentId }),
      }),
    });
    expect(sweep.operationsHeartbeatSweep?.qaReleaseGateReassignCount).toBe(1);
    expect(sweep.operationsHeartbeatSweep?.qaReleaseGateDemotionCount).toBe(0);
  });

  it("keeps ambiguous in_review delivery issues in review by assigning a pooled QA reviewer", async () => {
    const companyId = randomUUID();
    const operationsAgentId = randomUUID();
    const engineerAgentId = randomUUID();
    const qaOwnerOneId = randomUUID();
    const qaOwnerTwoId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Ambiguous QA Release Co",
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
        id: engineerAgentId,
        companyId,
        name: "Engineer",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: qaOwnerOneId,
        companyId,
        name: "QA and Release Engineer",
        role: "qa",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: qaOwnerTwoId,
        companyId,
        name: "QA and Release Engineer",
        role: "qa",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Feature in_review with ambiguous QA owner roster",
      status: "in_review",
      priority: "high",
      assigneeAgentId: engineerAgentId,
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

    const updatedIssue = await db
      .select({
        assigneeAgentId: issues.assigneeAgentId,
        qaReviewerAgentId: issues.qaReviewerAgentId,
        status: issues.status,
        executionPolicy: issues.executionPolicy,
        executionState: issues.executionState,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    const persistedRun = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run!.id))
      .then((rows) => rows[0] ?? null);
    const sweep = (persistedRun?.contextSnapshot ?? {}) as Record<string, Record<string, unknown>>;
    const expectedQaAssigneeId = [qaOwnerOneId, qaOwnerTwoId].sort()[0];

    expect(updatedIssue).toMatchObject({
      assigneeAgentId: expectedQaAssigneeId,
      qaReviewerAgentId: expectedQaAssigneeId,
      status: "in_review",
      executionPolicy: expect.objectContaining({
        stages: [expect.objectContaining({ type: "review" })],
      }),
      executionState: expect.objectContaining({
        status: "pending",
        currentStageType: "review",
        currentParticipant: expect.objectContaining({ type: "agent", agentId: expectedQaAssigneeId }),
        returnAssignee: expect.objectContaining({ type: "agent", agentId: engineerAgentId }),
      }),
    });
  expect(sweep.operationsHeartbeatSweep?.qaReleaseGateDemotionCount).toBe(0);
  expect(sweep.operationsHeartbeatSweep?.qaReleaseGateReassignCount).toBe(1);
});

it("repairs a QA-owned in_review delivery issue by inferring the builder from activity history", async () => {
  const companyId = randomUUID();
  const operationsAgentId = randomUUID();
  const engineerAgentId = randomUUID();
  const qaReviewerAgentId = randomUUID();
  const issueId = randomUUID();
  const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
  const heartbeat = heartbeatService(db);

  await db.insert(companies).values({
    id: companyId,
    name: "Historical Review Repair Co",
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
      id: engineerAgentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    },
    {
      id: qaReviewerAgentId,
      companyId,
      name: "QA and Release Engineer",
      role: "qa",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    },
  ]);

  await db.insert(issues).values({
    id: issueId,
    companyId,
    title: "QA-owned review row lost execution state",
    status: "in_review",
    priority: "high",
    assigneeAgentId: qaReviewerAgentId,
    issueNumber: 1,
    identifier: `${issuePrefix}-1`,
  });

  await db.insert(activityLog).values({
    companyId,
    actorType: "agent",
    actorId: engineerAgentId,
    entityType: "issue",
    entityId: issueId,
    action: "issue.updated",
    agentId: engineerAgentId,
    details: {
      status: "in_review",
      _previous: {
        status: "in_progress",
        assigneeAgentId: engineerAgentId,
      },
    },
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

  const updatedIssue = await db
    .select({
      assigneeAgentId: issues.assigneeAgentId,
      qaReviewerAgentId: issues.qaReviewerAgentId,
      status: issues.status,
      executionPolicy: issues.executionPolicy,
      executionState: issues.executionState,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .then((rows) => rows[0] ?? null);

  expect(updatedIssue).toMatchObject({
    assigneeAgentId: qaReviewerAgentId,
    qaReviewerAgentId,
    status: "in_review",
    executionPolicy: expect.objectContaining({
      stages: [expect.objectContaining({ type: "review" })],
    }),
    executionState: expect.objectContaining({
      status: "pending",
      currentStageType: "review",
      currentParticipant: expect.objectContaining({ type: "agent", agentId: qaReviewerAgentId }),
      returnAssignee: expect.objectContaining({ type: "agent", agentId: engineerAgentId }),
    }),
  });
});

it("repairs a QA-owned todo delivery issue with completion truth by inferring the builder from ownership history", async () => {
  const companyId = randomUUID();
  const operationsAgentId = randomUUID();
  const engineerAgentId = randomUUID();
  const qaReviewerAgentId = randomUUID();
  const issueId = randomUUID();
  const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
  const heartbeat = heartbeatService(db);

  await db.insert(companies).values({
    id: companyId,
    name: "Legacy Todo Review Repair Co",
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
      id: engineerAgentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    },
    {
      id: qaReviewerAgentId,
      companyId,
      name: "QA Runner",
      role: "qa",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    },
  ]);

  await db.insert(issues).values({
    id: issueId,
    companyId,
    title: "QA-owned todo row lost canonical review state",
    status: "todo",
    priority: "high",
    assigneeAgentId: qaReviewerAgentId,
    issueNumber: 1,
    identifier: `${issuePrefix}-1`,
  });

  await db.insert(issueComments).values({
    companyId,
    issueId,
    authorAgentId: qaReviewerAgentId,
    body: [
      "DONE: Checkout release gate validation is complete.",
      "The old review row lost its reviewer state and needs repair.",
    ].join("\n"),
  });

  await db.insert(activityLog).values({
    companyId,
    actorType: "agent",
    actorId: operationsAgentId,
    entityType: "issue",
    entityId: issueId,
    action: "issue.updated",
    agentId: operationsAgentId,
    details: {
      assigneeAgentId: qaReviewerAgentId,
      _previous: {
        assigneeAgentId: engineerAgentId,
      },
    },
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

  const updatedIssue = await db
    .select({
      assigneeAgentId: issues.assigneeAgentId,
      qaReviewerAgentId: issues.qaReviewerAgentId,
      status: issues.status,
      executionPolicy: issues.executionPolicy,
      executionState: issues.executionState,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .then((rows) => rows[0] ?? null);

  const persistedRun = await db
    .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, run!.id))
    .then((rows) => rows[0] ?? null);
  const sweep = (persistedRun?.contextSnapshot ?? {}) as Record<string, Record<string, unknown>>;

  expect(updatedIssue).toMatchObject({
    assigneeAgentId: qaReviewerAgentId,
    qaReviewerAgentId,
    status: "in_review",
    executionPolicy: expect.objectContaining({
      stages: [expect.objectContaining({ type: "review" })],
    }),
    executionState: expect.objectContaining({
      status: "pending",
      currentStageType: "review",
      currentParticipant: expect.objectContaining({ type: "agent", agentId: qaReviewerAgentId }),
      returnAssignee: expect.objectContaining({ type: "agent", agentId: engineerAgentId }),
    }),
  });
  expect(sweep.operationsHeartbeatSweep?.qaReleaseGateReassignCount).toBe(1);
});

it("reassigns canonical delivery review state when the current QA reviewer becomes ineligible", async () => {
  const companyId = randomUUID();
  const operationsAgentId = randomUUID();
  const engineerAgentId = randomUUID();
  const failedQaReviewerAgentId = randomUUID();
  const healthyQaReviewerAgentId = randomUUID();
  const issueId = randomUUID();
  const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
  const heartbeat = heartbeatService(db);

  await db.insert(companies).values({
    id: companyId,
    name: "Ineligible QA Review Repair Co",
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
      id: engineerAgentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    },
    {
      id: failedQaReviewerAgentId,
      companyId,
      name: "QA and Release Engineer",
      role: "qa",
      status: "error",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    },
    {
      id: healthyQaReviewerAgentId,
      companyId,
      name: "QA Runner",
      role: "qa",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    },
  ]);

  await db.insert(issues).values({
    id: issueId,
    companyId,
    title: "Canonical review row pinned to failed QA reviewer",
    status: "in_review",
    priority: "high",
    assigneeAgentId: failedQaReviewerAgentId,
    qaReviewerAgentId: failedQaReviewerAgentId,
    executionPolicy: {
      mode: "normal",
      commentRequired: true,
      stages: [{
        id: randomUUID(),
        type: "review",
        approvalsNeeded: 1,
        participants: [
          {
            id: randomUUID(),
            type: "agent",
            agentId: failedQaReviewerAgentId,
            userId: null,
          },
          {
            id: randomUUID(),
            type: "agent",
            agentId: healthyQaReviewerAgentId,
            userId: null,
          },
        ],
      }],
    },
    executionState: {
      status: "pending",
      currentStageId: randomUUID(),
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: failedQaReviewerAgentId },
      returnAssignee: { type: "agent", agentId: engineerAgentId, userId: null },
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    },
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

  const updatedIssue = await db
    .select({
      assigneeAgentId: issues.assigneeAgentId,
      qaReviewerAgentId: issues.qaReviewerAgentId,
      status: issues.status,
      executionPolicy: issues.executionPolicy,
      executionState: issues.executionState,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .then((rows) => rows[0] ?? null);

  expect(updatedIssue).toMatchObject({
    assigneeAgentId: healthyQaReviewerAgentId,
    qaReviewerAgentId: healthyQaReviewerAgentId,
    status: "in_review",
    executionPolicy: expect.objectContaining({
      stages: [expect.objectContaining({ type: "review" })],
    }),
    executionState: expect.objectContaining({
      status: "pending",
      currentStageType: "review",
      currentParticipant: expect.objectContaining({ type: "agent", agentId: healthyQaReviewerAgentId }),
      returnAssignee: expect.objectContaining({ type: "agent", agentId: engineerAgentId }),
    }),
  });
});

  it("provisions and assigns a security specialist when a stale security workflow lane has no eligible owner", async () => {
    const companyId = randomUUID();
    const operationsAgentId = randomUUID();
    const ceoAgentId = randomUUID();
    const ctoAgentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Security Workflow Ownership Co",
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
        id: ceoAgentId,
        companyId,
        name: "CEO",
        role: "ceo",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {
          executionBoundary: "orchestrator_only",
        },
        permissions: {},
      },
      {
        id: ctoAgentId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Security: Threat review needs a real owner",
      status: "todo",
      priority: "high",
      assigneeAgentId: ceoAgentId,
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "security",
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

    const updatedIssue = await db
      .select({
        assigneeAgentId: issues.assigneeAgentId,
        status: issues.status,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    const latestComment = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .orderBy(asc(issueComments.createdAt))
      .then((rows) => rows.at(-1) ?? null);
    const provisionedSecurityAgent = await db
      .select({
        id: agents.id,
        status: agents.status,
        role: agents.role,
      })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.role, "security")))
      .then((rows) => rows[0] ?? null);

    const persistedRun = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run!.id))
      .then((rows) => rows[0] ?? null);
    const sweep = (persistedRun?.contextSnapshot ?? {}) as Record<string, Record<string, unknown>>;

    expect(provisionedSecurityAgent).toMatchObject({
      role: "security",
    });
    expect(["idle", "running"]).toContain(provisionedSecurityAgent?.status);
    expect(updatedIssue).toMatchObject({
      assigneeAgentId: provisionedSecurityAgent?.id,
      status: "todo",
    });
    expect(latestComment?.body).toContain("[operations-heartbeat-ownership-correction]");
    expect(latestComment?.body).toContain("Security Engineer");
    expect(sweep.operationsHeartbeatSweep?.ownershipCorrectionCommentCount).toBeGreaterThanOrEqual(1);
  });

  it("provisions and assigns a security specialist for unassigned in_review security workflow lanes", async () => {
    const companyId = randomUUID();
    const operationsAgentId = randomUUID();
    const ctoAgentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Security Review Demotion Co",
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
        id: ctoAgentId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Security: review lane drifted into review without an owner",
      status: "in_review",
      priority: "high",
      assigneeAgentId: null,
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "security",
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

    const updatedIssue = await db
      .select({
        assigneeAgentId: issues.assigneeAgentId,
        status: issues.status,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    const latestComment = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .orderBy(asc(issueComments.createdAt))
      .then((rows) => rows.at(-1) ?? null);
    const provisionedSecurityAgent = await db
      .select({
        id: agents.id,
        status: agents.status,
        role: agents.role,
      })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.role, "security")))
      .then((rows) => rows[0] ?? null);

    expect(updatedIssue).toMatchObject({
      assigneeAgentId: provisionedSecurityAgent?.id,
      status: "todo",
    });
    expect(provisionedSecurityAgent).toMatchObject({
      role: "security",
    });
    expect(["idle", "running"]).toContain(provisionedSecurityAgent?.status);
    expect(latestComment?.body).toContain("[operations-heartbeat-assignment]");
  });

  it("normalizes QA review drift off non-QA workflow lanes before reassigning them", async () => {
    const companyId = randomUUID();
    const operationsAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const securityAgentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Workflow Lane Review Drift Co",
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
        id: qaAgentId,
        companyId,
        name: "QA and Release Engineer",
        role: "qa",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: securityAgentId,
        companyId,
        name: "Security Engineer",
        role: "security",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Security: threat review lane drifted onto pooled QA ownership",
      status: "in_review",
      priority: "high",
      assigneeAgentId: qaAgentId,
      qaReviewerAgentId: qaAgentId,
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "security",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: randomUUID(),
          type: "review",
          approvalsNeeded: 1,
          participants: [
            {
              id: randomUUID(),
              type: "agent",
              agentId: qaAgentId,
              userId: null,
            },
          ],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qaAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: qaAgentId, userId: null },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
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

    const updatedIssue = await db
      .select({
        assigneeAgentId: issues.assigneeAgentId,
        qaReviewerAgentId: issues.qaReviewerAgentId,
        status: issues.status,
        executionPolicy: issues.executionPolicy,
        executionState: issues.executionState,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(updatedIssue).toMatchObject({
      assigneeAgentId: securityAgentId,
      qaReviewerAgentId: null,
      status: "todo",
      executionPolicy: null,
      executionState: null,
    });
  });

  it("normalizes non-delivery review rows back to todo while preserving a healthy engineer owner", async () => {
    const companyId = randomUUID();
    const operationsAgentId = randomUUID();
    const engineerAgentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Ticket Authoring Review Repair Co",
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
        runtimeConfig: { executionBoundary: "orchestrator_only" },
        permissions: {},
      },
      {
        id: engineerAgentId,
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

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "UI Audit - Review and incrementally improve the cart UI in this workspace using Hermes.",
      description: [
        "This is a ticket-authoring task, not an implementation task.",
        "Do not change code. Write implementation tickets only.",
      ].join("\n"),
      status: "in_review",
      priority: "high",
      assigneeAgentId: engineerAgentId,
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

    const updatedIssue = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        qaReviewerAgentId: issues.qaReviewerAgentId,
        executionPolicy: issues.executionPolicy,
        executionState: issues.executionState,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(updatedIssue).toMatchObject({
      status: "todo",
      assigneeAgentId: engineerAgentId,
      qaReviewerAgentId: null,
      executionPolicy: null,
      executionState: null,
    });
  });

  it("normalizes non-delivery trust audits off dead QA owners", async () => {
    const companyId = randomUUID();
    const operationsAgentId = randomUUID();
    const deadQaAgentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Trust Audit Dead Owner Repair Co",
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
        runtimeConfig: { executionBoundary: "orchestrator_only" },
        permissions: {},
      },
      {
        id: deadQaAgentId,
        companyId,
        name: "QA and Release Engineer",
        role: "qa",
        status: "error",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cart trust audit — eliminate any source of doubt",
      description: [
        "This is a trust validation and failure detection exercise.",
        "The audit is not complete until concrete issues are created.",
        "For every P0 and P1 issue: create a NEW issue.",
        "If a problem is found but no ticket is created, the review is incomplete.",
      ].join("\n"),
      status: "in_review",
      priority: "high",
      assigneeAgentId: deadQaAgentId,
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

    const updatedIssue = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        qaReviewerAgentId: issues.qaReviewerAgentId,
        executionPolicy: issues.executionPolicy,
        executionState: issues.executionState,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(updatedIssue).toMatchObject({
      status: "todo",
      assigneeAgentId: null,
      qaReviewerAgentId: null,
      executionPolicy: null,
      executionState: null,
    });
  });

  it("does not target healthy canonical execution review issues for operations heartbeat recovery", async () => {
    const companyId = randomUUID();
    const operationsAgentId = randomUUID();
    const engineerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const assignedReviewIssueId = randomUUID();
    const unassignedBacklogIssueId = randomUUID();
    const activeReviewRunId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Execution Review Skip Co",
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
        id: engineerAgentId,
        companyId,
        name: "Engineer",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: qaAgentId,
        companyId,
        name: "QA Runner",
        role: "qa",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values({
      id: activeReviewRunId,
      companyId,
      agentId: qaAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: assignedReviewIssueId },
    });

    await db.insert(issues).values([
      {
        id: assignedReviewIssueId,
        companyId,
        title: "In-review feature in healthy execution review stage",
        status: "in_review",
        priority: "high",
        assigneeAgentId: qaAgentId,
        executionRunId: activeReviewRunId,
        executionState: {
          status: "pending",
          currentStageId: randomUUID(),
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: qaAgentId, userId: null },
          returnAssignee: { type: "agent", agentId: engineerAgentId, userId: null },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: unassignedBacklogIssueId,
        companyId,
        title: "Ready backlog work remains in queue",
        status: "backlog",
        priority: "high",
        assigneeAgentId: null,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);

    const target = await resolveOperationsHeartbeatTarget(db, {
      companyId,
      operationsAgentId,
    });

    expect(target).toMatchObject({
      issueId: unassignedBacklogIssueId,
      mode: "ready_unassigned",
    });
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

  it("honors fresh operations cooldown markers written by a previous COO owner", async () => {
    const companyId = randomUUID();
    const previousOperationsAgentId = randomUUID();
    const operationsAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "COO Handoff Cooldown Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: previousOperationsAgentId,
        companyId,
        name: "Previous Operations",
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
        runtimeConfig: {
          heartbeat: {
            maxConcurrentRuns: 1,
          },
        },
        permissions: {},
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Idle owned work already nudged by the prior COO",
      status: "todo",
      priority: "high",
      assigneeAgentId: workerAgentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: previousOperationsAgentId,
      body: "[operations-heartbeat-wakeup] [operations-heartbeat-recovery] [@Engineer](agent://test) spare slot available. Please resume work on this assigned issue now.",
      createdAt: new Date(),
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

    const [comments, wakeups] = await Promise.all([
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId))
        .orderBy(asc(issueComments.createdAt)),
      db
        .select({ reason: agentWakeupRequests.reason, agentId: agentWakeupRequests.agentId })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, companyId)),
    ]);

    expect(comments.filter((comment) => comment.body?.includes("[operations-heartbeat-wakeup]"))).toHaveLength(1);
    expect(wakeups.filter((wakeup) => wakeup.agentId === workerAgentId)).toHaveLength(0);
  });

  it("wakes in_review QA work with handoff truth when spare concurrency exists", async () => {
    const companyId = randomUUID();
    const operationsAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const issueId = randomUUID();
    const busyRunId = randomUUID();
    const handoffCommentId = randomUUID();
    const qaAdapterType = "qa_refill_test";
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    try {
      registerTestAdapter({
        type: qaAdapterType,
        execute: async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
        }),
        testEnvironment: async () => ({
          adapterType: qaAdapterType,
          status: "pass",
          checks: [],
          testedAt: new Date(0).toISOString(),
        }),
        supportsLocalAgentJwt: false,
      });

      await db.insert(companies).values({
        id: companyId,
        name: "QA Refill Co",
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
          id: qaAgentId,
          companyId,
          name: "QA and Release Engineer",
          role: "qa",
          status: "idle",
          adapterType: qaAdapterType,
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
        agentId: qaAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        startedAt: new Date("2026-04-16T10:00:00.000Z"),
        contextSnapshot: { issueId: randomUUID() },
      });

      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Feature in_review should refill spare QA slots",
        status: "in_review",
        priority: "high",
        assigneeAgentId: qaAgentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });

      await db.insert(issueComments).values({
        id: handoffCommentId,
        companyId,
        issueId,
        authorAgentId: qaAgentId,
        body: "[READY FOR QA]\nScoped validation requested.",
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

      await waitFor(async () => {
        const qaRefillRun = await db
          .select({
            id: heartbeatRuns.id,
            status: heartbeatRuns.status,
          })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, companyId),
              eq(heartbeatRuns.agentId, qaAgentId),
            ),
          )
          .orderBy(asc(heartbeatRuns.createdAt))
          .then((rows) => rows.find((row) => row.id !== busyRunId) ?? null);
        return qaRefillRun?.status === "succeeded";
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
          wakeup.agentId === qaAgentId && wakeup.reason === "operations_idle_assignment_wakeup"
        )),
      ).toBe(true);
      const qaRuns = await db
        .select({
          id: heartbeatRuns.id,
          status: heartbeatRuns.status,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            eq(heartbeatRuns.agentId, qaAgentId),
          ),
        )
        .orderBy(asc(heartbeatRuns.createdAt));
      expect(qaRuns.filter((run) => run.id !== busyRunId && run.status === "succeeded").length).toBeGreaterThanOrEqual(1);
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

  it("recovers canonical in_review QA work with no linked run even when structured blocker truth bypasses idle refill", async () => {
    const companyId = randomUUID();
    const operationsAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const engineerAgentId = randomUUID();
    const issueId = randomUUID();
    const blockerCommentId = randomUUID();
    const qaAdapterType = "qa_canonical_review_recovery_test";
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    registerTestAdapter({
      type: qaAdapterType,
      execute: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
      }),
      testEnvironment: async () => ({
        adapterType: qaAdapterType,
        status: "pass",
        checks: [],
        testedAt: new Date(0).toISOString(),
      }),
      supportsLocalAgentJwt: false,
    });

    await db.insert(companies).values({
      id: companyId,
      name: "Canonical Review Recovery Co",
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
        id: engineerAgentId,
        companyId,
        name: "Product Engineer",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: qaAgentId,
        companyId,
        name: "QA Runner",
        role: "qa",
        status: "idle",
        adapterType: qaAdapterType,
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            maxConcurrentRuns: 1,
          },
        },
        permissions: {},
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Canonical QA review lost its linked execution run",
      status: "in_review",
      priority: "high",
      assigneeAgentId: qaAgentId,
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qaAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: engineerAgentId, userId: null },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    await db.insert(issueComments).values({
      id: blockerCommentId,
      companyId,
      issueId,
      authorAgentId: qaAgentId,
      body: "BLOCKED: waiting on release notes confirmation before I can close this review.",
      createdAt: new Date("2026-04-15T10:00:00.000Z"),
      updatedAt: new Date("2026-04-15T10:00:00.000Z"),
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

    await waitFor(async () => {
      const qaRecoveryRun = await db
        .select({
          id: heartbeatRuns.id,
          status: heartbeatRuns.status,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            eq(heartbeatRuns.agentId, qaAgentId),
          ),
        )
        .orderBy(asc(heartbeatRuns.createdAt))
        .then((rows) => rows[0] ?? null);
      return qaRecoveryRun?.status === "succeeded";
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

    expect(comments.some((comment) => (
      comment.body?.includes("[operations-heartbeat-recovery]") ||
      comment.body?.includes("[operations-heartbeat-wakeup]") ||
      comment.body?.includes("[operations-heartbeat-ownership-correction]")
    ))).toBe(true);
    expect(
      wakeups.some((wakeup) => (
        wakeup.agentId === qaAgentId &&
        (
          wakeup.reason === "operations_cross_agent_recovery" ||
          wakeup.reason === "operations_idle_assignment_wakeup" ||
          wakeup.reason === "operations_assignment"
        )
      )),
    ).toBe(true);
  });

  it("retries a skipped in_review QA wake once spare concurrency reopens", async () => {
    const companyId = randomUUID();
    const operationsAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const issueId = randomUUID();
    const handoffCommentId = randomUUID();
    const priorOpsCommentId = randomUUID();
    const priorWakeupId = randomUUID();
    const qaAdapterType = "qa_refill_retry_test";
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    registerTestAdapter({
      type: qaAdapterType,
      execute: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
      }),
      testEnvironment: async () => ({
        adapterType: qaAdapterType,
        status: "pass",
        checks: [],
        testedAt: new Date(0).toISOString(),
      }),
      supportsLocalAgentJwt: false,
    });

    await db.insert(companies).values({
      id: companyId,
      name: "QA Refill Retry Co",
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
        id: qaAgentId,
        companyId,
        name: "QA Runner",
        role: "qa",
        status: "idle",
        adapterType: qaAdapterType,
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            maxConcurrentRuns: 2,
          },
        },
        permissions: {},
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Skipped QA wake should refill once capacity reopens",
      status: "in_review",
      priority: "high",
      assigneeAgentId: qaAgentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    await db.insert(issueComments).values([
      {
        id: handoffCommentId,
        companyId,
        issueId,
        authorAgentId: qaAgentId,
        body: "[READY FOR QA]\nScoped validation requested.",
      },
      {
        id: priorOpsCommentId,
        companyId,
        issueId,
        authorAgentId: operationsAgentId,
        body: "[operations-heartbeat-wakeup] [@QA Runner](agent://test) spare QA slot available. Please resume work on this assigned issue now.",
      },
    ]);

    await db.insert(agentWakeupRequests).values({
      id: priorWakeupId,
      companyId,
      agentId: qaAgentId,
      source: "automation",
      triggerDetail: "system",
      reason: "heartbeat.live_run_limit_reached",
      payload: { issueId },
      status: "skipped",
      finishedAt: new Date("2026-04-21T18:00:01.000Z"),
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

    await waitFor(async () => {
      const qaRun = await db
        .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            eq(heartbeatRuns.agentId, qaAgentId),
          ),
        )
        .orderBy(asc(heartbeatRuns.createdAt))
        .then((rows) => rows[0] ?? null);
      return qaRun?.status === "succeeded";
    }, 20_000);

    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .orderBy(asc(issueComments.createdAt));
    const wakeups = await db
      .select({
        reason: agentWakeupRequests.reason,
        status: agentWakeupRequests.status,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId))
      .orderBy(asc(agentWakeupRequests.createdAt));

    expect(comments.filter((comment) => comment.body?.includes("[operations-heartbeat-wakeup]"))).toHaveLength(2);
    expect(
      wakeups.filter((wakeup) => (
        wakeup.reason === "heartbeat.live_run_limit_reached" && wakeup.status === "skipped"
      )),
    ).toHaveLength(1);
    expect(
      wakeups.filter((wakeup) => (
        wakeup.reason === "operations_idle_assignment_wakeup" && wakeup.status === "completed"
      )),
    ).toHaveLength(1);
  }, 20_000);

  it("wakes in_review QA work when completion truth was left behind by a skipped wake", async () => {
    const companyId = randomUUID();
    const operationsAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const issueId = randomUUID();
    const completionCommentId = randomUUID();
    const priorWakeupId = randomUUID();
    const qaAdapterType = "qa_refill_completion_test";
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    registerTestAdapter({
      type: qaAdapterType,
      execute: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
      }),
      testEnvironment: async () => ({
        adapterType: qaAdapterType,
        status: "pass",
        checks: [],
        testedAt: new Date(0).toISOString(),
      }),
      supportsLocalAgentJwt: false,
    });

    await db.insert(companies).values({
      id: companyId,
      name: "QA Completion Refill Co",
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
        id: qaAgentId,
        companyId,
        name: "QA Runner",
        role: "qa",
        status: "idle",
        adapterType: qaAdapterType,
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            maxConcurrentRuns: 2,
          },
        },
        permissions: {},
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Completion truth should not leave review work idle",
      status: "in_review",
      priority: "high",
      assigneeAgentId: qaAgentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    await db.insert(issueComments).values({
      id: completionCommentId,
      companyId,
      issueId,
      authorAgentId: qaAgentId,
      body: "DONE: Validation complete, but the issue still needs follow-up.",
    });

    await db.insert(agentWakeupRequests).values({
      id: priorWakeupId,
      companyId,
      agentId: qaAgentId,
      source: "automation",
      triggerDetail: "system",
      reason: "heartbeat.live_run_limit_reached",
      payload: { issueId },
      status: "skipped",
      finishedAt: new Date("2026-04-21T18:05:01.000Z"),
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

    await waitFor(async () => {
      const qaRun = await db
        .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            eq(heartbeatRuns.agentId, qaAgentId),
          ),
        )
        .orderBy(asc(heartbeatRuns.createdAt))
        .then((rows) => rows[0] ?? null);
      return qaRun?.status === "succeeded";
    }, 20_000);

    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .orderBy(asc(issueComments.createdAt));
    const wakeups = await db
      .select({
        reason: agentWakeupRequests.reason,
        status: agentWakeupRequests.status,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId))
      .orderBy(asc(agentWakeupRequests.createdAt));

    expect(comments.some((comment) => comment.body?.includes("[operations-heartbeat-wakeup]"))).toBe(true);
    expect(
      wakeups.some((wakeup) => (
        wakeup.reason === "operations_idle_assignment_wakeup" && wakeup.status === "completed"
      )),
    ).toBe(true);
  }, 20_000);

  it("wakes in_review QA work from completion truth even without a prior skipped wake", async () => {
    const companyId = randomUUID();
    const operationsAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const issueId = randomUUID();
    const completionCommentId = randomUUID();
    const qaAdapterType = "qa_refill_completion_no_skip_test";
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    registerTestAdapter({
      type: qaAdapterType,
      execute: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
      }),
      testEnvironment: async () => ({
        adapterType: qaAdapterType,
        status: "pass",
        checks: [],
        testedAt: new Date(0).toISOString(),
      }),
      supportsLocalAgentJwt: false,
    });

    await db.insert(companies).values({
      id: companyId,
      name: "QA Completion No Skip Refill Co",
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
        id: qaAgentId,
        companyId,
        name: "QA Runner",
        role: "qa",
        status: "idle",
        adapterType: qaAdapterType,
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            maxConcurrentRuns: 2,
          },
        },
        permissions: {},
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Completion truth should keep review work refillable",
      status: "in_review",
      priority: "high",
      assigneeAgentId: qaAgentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    await db.insert(issueComments).values({
      id: completionCommentId,
      companyId,
      issueId,
      authorAgentId: qaAgentId,
      body: "[QA PASS]\n[RELEASE CONFIRMED]\nVerification complete, but the issue is still open.",
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

    await waitFor(async () => {
      const qaRun = await db
        .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            eq(heartbeatRuns.agentId, qaAgentId),
          ),
        )
        .orderBy(asc(heartbeatRuns.createdAt))
        .then((rows) => rows[0] ?? null);
      return qaRun?.status === "succeeded";
    }, 20_000);

    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .orderBy(asc(issueComments.createdAt));
    const wakeups = await db
      .select({
        reason: agentWakeupRequests.reason,
        status: agentWakeupRequests.status,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId))
      .orderBy(asc(agentWakeupRequests.createdAt));

    expect(comments.some((comment) => comment.body?.includes("[operations-heartbeat-wakeup]"))).toBe(true);
    expect(
      wakeups.some((wakeup) => (
        wakeup.reason === "operations_idle_assignment_wakeup" && wakeup.status === "completed"
      )),
    ).toBe(true);
  }, 20_000);

  it("does not wake a stale routine execution issue when a sibling routine issue is already live", async () => {
    const companyId = randomUUID();
    const operationsAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const staleIssueId = randomUUID();
    const liveIssueId = randomUUID();
    const liveRunId = randomUUID();
    const routineId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "Routine Stale Wake Co",
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
        id: liveRunId,
        companyId,
        agentId: workerAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        startedAt: new Date("2026-04-16T10:00:00.000Z"),
        contextSnapshot: { issueId: liveIssueId },
      });

      await db.insert(issues).values([
        {
          id: staleIssueId,
          companyId,
          title: "Older routine issue should stay dormant",
          status: "todo",
          priority: "high",
          assigneeAgentId: workerAgentId,
          originKind: "routine_execution",
          originId: routineId,
          originRunId: randomUUID(),
          issueNumber: 1,
          identifier: `${issuePrefix}-1`,
        },
        {
          id: liveIssueId,
          companyId,
          title: "Current live routine issue",
          status: "in_progress",
          priority: "high",
          assigneeAgentId: workerAgentId,
          originKind: "routine_execution",
          originId: routineId,
          originRunId: randomUUID(),
          executionRunId: liveRunId,
          executionLockedAt: new Date("2026-04-16T10:00:00.000Z"),
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
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, staleIssueId))
        .orderBy(asc(issueComments.createdAt));
      const wakeups = await db
        .select({
          agentId: agentWakeupRequests.agentId,
          reason: agentWakeupRequests.reason,
        })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, companyId))
        .orderBy(asc(agentWakeupRequests.createdAt));

      expect(comments.some((comment) => comment.body?.includes("[operations-heartbeat-wakeup]"))).toBe(false);
      expect(
        wakeups.some((wakeup) => (
          wakeup.agentId === workerAgentId && wakeup.reason === "operations_idle_assignment_wakeup"
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
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            eq(heartbeatRuns.agentId, workerAgentId),
            or(eq(heartbeatRuns.status, "queued"), eq(heartbeatRuns.status, "running")),
          ),
        );
    }
  });

  it("clears stale sibling routine locks before cross-agent recovery wakes", async () => {
    const companyId = randomUUID();
    const operationsAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const blockerIssueId = randomUUID();
    const staleIssueId = randomUUID();
    const blockedIssueId = randomUUID();
    const staleRunId = randomUUID();
    const routineId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "Routine Recovery Co",
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
        id: staleRunId,
        companyId,
        agentId: workerAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "completed",
        startedAt: new Date("2026-04-16T08:00:00.000Z"),
        finishedAt: new Date("2026-04-16T08:10:00.000Z"),
        contextSnapshot: { issueId: staleIssueId },
      });

      await db.insert(issues).values([
        {
          id: blockerIssueId,
          companyId,
          title: "Restore the blocked dependency",
          status: "todo",
          priority: "medium",
          issueNumber: 1,
          identifier: `${issuePrefix}-1`,
        },
        {
          id: staleIssueId,
          companyId,
          title: "Older routine execution issue with a dead lock",
          status: "todo",
          priority: "high",
          assigneeAgentId: null,
          originKind: "routine_execution",
          originId: routineId,
          originRunId: randomUUID(),
          executionRunId: staleRunId,
          executionLockedAt: new Date("2026-04-16T08:00:00.000Z"),
          issueNumber: 2,
          identifier: `${issuePrefix}-2`,
        },
        {
          id: blockedIssueId,
          companyId,
          title: "Current routine issue that needs recovery",
          status: "blocked",
          priority: "high",
          assigneeAgentId: workerAgentId,
          originKind: "routine_execution",
          originId: routineId,
          originRunId: randomUUID(),
          issueNumber: 3,
          identifier: `${issuePrefix}-3`,
        },
      ]);

      await db.insert(issueRelations).values({
        companyId,
        issueId: blockerIssueId,
        relatedIssueId: blockedIssueId,
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

      const staleIssue = await db
        .select({ executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, staleIssueId))
        .then((rows) => rows[0] ?? null);

      expect(staleIssue?.executionRunId).toBeNull();
    } finally {
      await db
        .update(heartbeatRuns)
        .set({
          status: "cancelled",
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            eq(heartbeatRuns.agentId, workerAgentId),
            or(eq(heartbeatRuns.status, "queued"), eq(heartbeatRuns.status, "running")),
          ),
        );
    }
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

  it("skips cross-agent recovery wakes when the target assignee adapter retry circuit is open", async () => {
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
      name: "Recovery Circuit Co",
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

    await db.insert(heartbeatRetryCircuits).values({
      companyId,
      adapterType: "codex_local",
      state: "open",
      openedAt: new Date("2026-04-16T10:00:00.000Z"),
      openUntil: new Date(Date.now() + 60_000),
      windowStartedAt: new Date("2026-04-16T09:59:00.000Z"),
      windowTotal: 3,
      windowFailures: 3,
      consecutiveFailures: 3,
      cooldownSeconds: 600,
      updatedAt: new Date(),
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
        title: "Blocked assigned issue while the adapter circuit is open",
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
  });

  it("keeps cross-agent recovery single-flight when the issue already has a queued recovery wake", async () => {
    const companyId = randomUUID();
    const operationsAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const issueId = randomUUID();
    const blockerIssueId = randomUUID();
    const completedRunId = randomUUID();
    const existingWakeId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Recovery Single Flight Co",
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
        title: "Blocked assigned issue with an existing queued recovery wake",
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
    await db.insert(agentWakeupRequests).values({
      id: existingWakeId,
      companyId,
      agentId: workerAgentId,
      source: "automation",
      triggerDetail: "system",
      reason: "operations_cross_agent_recovery",
      payload: {
        issueId,
        mutation: "operations_cross_agent_recovery",
      },
      status: "queued",
      idempotencyKey: `operations_cross_agent_recovery:${workerAgentId}:${issueId}`,
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
      .select({
        body: issueComments.body,
      })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .orderBy(asc(issueComments.createdAt));
    const recoveryWakeups = await db
      .select({
        id: agentWakeupRequests.id,
        agentId: agentWakeupRequests.agentId,
        reason: agentWakeupRequests.reason,
      })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, workerAgentId)))
      .orderBy(asc(agentWakeupRequests.createdAt));

    expect(comments.some((comment) => comment.body?.includes("[operations-heartbeat-recovery]"))).toBe(false);
    expect(
      recoveryWakeups.filter((wakeup) => wakeup.reason === "operations_cross_agent_recovery"),
    ).toHaveLength(1);
    expect(recoveryWakeups[0]?.id).toBe(existingWakeId);
  });

  it("ignores quiet issue-scoped runs when queuing cross-agent recovery", async () => {
    const companyId = randomUUID();
    const operationsAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const issueId = randomUUID();
    const blockerIssueId = randomUUID();
    const completedRunId = randomUUID();
    const quietRunningRunId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);
    const quietAt = new Date(Date.now() - 11 * 60_000);

    await db.insert(companies).values({
      id: companyId,
      name: "Quiet Recovery Guard Co",
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
        id: quietRunningRunId,
        companyId,
        agentId: workerAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        errorCode: "process_detached",
        error: "Lost in-memory process handle, but child pid 123 is still alive",
        contextSnapshot: { issueId },
        startedAt: new Date("2026-04-01T00:00:00.000Z"),
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        lastActivityAt: quietAt,
        updatedAt: quietAt,
      },
      {
        id: completedRunId,
        companyId,
        agentId: workerAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "completed",
        startedAt: new Date("2026-04-01T01:00:00.000Z"),
        finishedAt: new Date("2026-04-01T01:10:00.000Z"),
        contextSnapshot: { issueId },
        createdAt: new Date("2026-04-01T01:00:00.000Z"),
        updatedAt: new Date("2026-04-01T01:10:00.000Z"),
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
        title: "Blocked assigned issue with only a quiet stale issue-scoped run",
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
      .select({
        body: issueComments.body,
      })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .orderBy(asc(issueComments.createdAt));
    const recoveryWakeups = await db
      .select({
        id: agentWakeupRequests.id,
        agentId: agentWakeupRequests.agentId,
        reason: agentWakeupRequests.reason,
      })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, workerAgentId)))
      .orderBy(asc(agentWakeupRequests.createdAt));

    expect(comments.some((comment) => comment.body?.includes("[operations-heartbeat-recovery]"))).toBe(true);
    expect(
      recoveryWakeups.filter((wakeup) => wakeup.reason === "operations_cross_agent_recovery"),
    ).toHaveLength(1);
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

  it("closes an in_review issue when a heartbeat-posted canonical QA summary satisfies the QA gate", async () => {
    const qaSummary = [
      "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]",
      "[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]",
      "[QA PASS]",
      "[RELEASE CONFIRMED]",
    ].join("\n");
    const gateway = await createControlledGatewayServer({
      waitPayload: {
        summary: qaSummary,
        result: qaSummary,
      },
    });
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "QA Close Co",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
      });

      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "QA and Release Engineer",
        role: "qa",
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
        title: "QA runtime close path",
        status: "in_review",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });

      const run = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_status_changed",
        payload: { issueId },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_status_changed",
        },
        requestedByActorType: "system",
        requestedByActorId: null,
      });

      expect(run).not.toBeNull();
      await waitFor(() => gateway.getAgentPayloads().length === 1);
      gateway.releaseFirstWait();

      await waitFor(async () => {
        const issue = await db
          .select({ status: issues.status })
          .from(issues)
          .where(eq(issues.id, issueId))
          .then((rows) => rows[0] ?? null);
        return issue?.status === "done";
      });

      const persistedIssue = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      const persistedComments = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId))
        .orderBy(asc(issueComments.createdAt));

      expect(persistedIssue?.status).toBe("done");
      expect(persistedComments.some((comment) => comment.body.includes("[QA PASS]"))).toBe(true);
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 20_000);
});
