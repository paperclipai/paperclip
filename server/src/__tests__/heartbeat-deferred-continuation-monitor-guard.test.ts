import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { and, eq } from "drizzle-orm";
import { WebSocketServer } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres deferred continuation monitor guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000, intervalMs = 50) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition");
}

async function closeDbClient(db: ReturnType<typeof createDb> | undefined) {
  await db?.$client?.end?.({ timeout: 0 });
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

describeEmbeddedPostgres("deferred continuation wake monitor guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-continuation-guard-");
    db = createDb(started.connectionString);
    tempDb = started;
  }, 120_000);

  afterAll(async () => {
    await closeDbClient(db);
    await tempDb?.cleanup();
  });

  afterEach(() => {
    runningProcesses.clear();
  });

  async function seedCompanyAgentIssue(gatewayUrl: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Gateway Agent",
      role: "engineer",
      status: "idle",
      adapterType: "openclaw_gateway",
      adapterConfig: {
        url: gatewayUrl,
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
      title: "Monitor-parked issue",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId };
  }

  async function startLiveRunViaCommentWake(
    heartbeat: ReturnType<typeof heartbeatService>,
    input: { companyId: string; agentId: string; issueId: string },
  ) {
    const comment = await db
      .insert(issueComments)
      .values({
        companyId: input.companyId,
        issueId: input.issueId,
        authorUserId: "user-1",
        body: "Start work",
      })
      .returning()
      .then((rows) => rows[0]);

    const run = await heartbeat.wakeup(input.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: input.issueId, commentId: comment.id },
      contextSnapshot: {
        issueId: input.issueId,
        taskId: input.issueId,
        commentId: comment.id,
        wakeReason: "issue_commented",
      },
      requestedByActorType: "user",
      requestedByActorId: "user-1",
    });
    expect(run).not.toBeNull();
    return run!;
  }

  function insertDeferredContinuationWake(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    retryOfRunId: string;
  }) {
    return db
      .insert(agentWakeupRequests)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_execution_deferred",
        payload: {
          issueId: input.issueId,
          retryOfRunId: input.retryOfRunId,
          _paperclipWakeContext: {
            issueId: input.issueId,
            taskId: input.issueId,
            wakeReason: "issue_continuation_needed",
            retryReason: "issue_continuation_needed",
            source: "issue.productive_terminal_continuation_recovery",
            retryOfRunId: input.retryOfRunId,
          },
        },
        status: "deferred_issue_execution",
        requestedByActorType: "system",
        requestedByActorId: null,
      })
      .returning()
      .then((rows) => rows[0]);
  }

  it("drops a deferred system continuation wake instead of promoting it while the issue is parked on a future monitor", async () => {
    const gateway = await createControlledGatewayServer();
    const heartbeat = heartbeatService(db);

    try {
      const seeded = await seedCompanyAgentIssue(gateway.url);
      const firstRun = await startLiveRunViaCommentWake(heartbeat, seeded);
      await waitFor(() => gateway.getAgentPayloads().length === 1);

      const monitorNextCheckAt = new Date(Date.now() + 48 * 60 * 60_000);
      await db
        .update(issues)
        .set({ monitorNextCheckAt, updatedAt: new Date() })
        .where(eq(issues.id, seeded.issueId));

      const deferred = await insertDeferredContinuationWake({
        ...seeded,
        retryOfRunId: firstRun.id,
      });

      await heartbeat.cancelRun(firstRun.id);

      await waitFor(async () => {
        const row = await db
          .select({ status: agentWakeupRequests.status })
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, deferred.id))
          .then((rows) => rows[0] ?? null);
        return row?.status === "cancelled";
      });

      const suppressed = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, deferred.id))
        .then((rows) => rows[0]);
      expect(suppressed.status).toBe("cancelled");
      expect(suppressed.error).toContain("parked on a monitor");
      expect(suppressed.error).toContain(monitorNextCheckAt.toISOString());

      // No promoted run fired: the only run for this agent is the cancelled one.
      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, seeded.agentId));
      expect(runs).toHaveLength(1);
      expect(runs[0]?.id).toBe(firstRun.id);
      expect(gateway.getAgentPayloads()).toHaveLength(1);

      // The monitor stays armed so it still owns the next wake.
      const issueRow = await db
        .select({ monitorNextCheckAt: issues.monitorNextCheckAt })
        .from(issues)
        .where(eq(issues.id, seeded.issueId))
        .then((rows) => rows[0]);
      expect(issueRow.monitorNextCheckAt?.getTime()).toBe(monitorNextCheckAt.getTime());
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 120_000);

  it("still promotes a deferred continuation wake when the issue has no armed monitor", async () => {
    const gateway = await createControlledGatewayServer();
    const heartbeat = heartbeatService(db);

    try {
      const seeded = await seedCompanyAgentIssue(gateway.url);
      const firstRun = await startLiveRunViaCommentWake(heartbeat, seeded);
      await waitFor(() => gateway.getAgentPayloads().length === 1);

      const deferred = await insertDeferredContinuationWake({
        ...seeded,
        retryOfRunId: firstRun.id,
      });

      await heartbeat.cancelRun(firstRun.id);

      await waitFor(() => gateway.getAgentPayloads().length === 2, 30_000);

      const promoted = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, deferred.id))
        .then((rows) => rows[0]);
      // The promoted run may already have claimed/finished the wake by the time
      // we look, so assert the promotion happened rather than a specific stage.
      expect(promoted.reason).toBe("issue_execution_promoted");
      expect(["queued", "claimed", "completed"]).toContain(promoted.status);

      gateway.releaseFirstWait();
      await waitFor(async () => {
        const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, seeded.agentId));
        return runs.length === 2 && runs.every((run) => ["cancelled", "succeeded"].includes(run.status));
      }, 90_000);
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 120_000);

  it("still promotes a deferred user comment wake while the issue is parked on a future monitor", async () => {
    const gateway = await createControlledGatewayServer();
    const heartbeat = heartbeatService(db);

    try {
      const seeded = await seedCompanyAgentIssue(gateway.url);
      const firstRun = await startLiveRunViaCommentWake(heartbeat, seeded);
      await waitFor(() => gateway.getAgentPayloads().length === 1);

      await db
        .update(issues)
        .set({
          monitorNextCheckAt: new Date(Date.now() + 48 * 60 * 60_000),
          updatedAt: new Date(),
        })
        .where(eq(issues.id, seeded.issueId));

      const followupComment = await db
        .insert(issueComments)
        .values({
          companyId: seeded.companyId,
          issueId: seeded.issueId,
          authorUserId: "user-1",
          body: "Queued follow-up",
        })
        .returning()
        .then((rows) => rows[0]);

      const followupRun = await heartbeat.wakeup(seeded.agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId: seeded.issueId, commentId: followupComment.id },
        contextSnapshot: {
          issueId: seeded.issueId,
          taskId: seeded.issueId,
          commentId: followupComment.id,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      });
      expect(followupRun).toBeNull();

      const deferredCommentWake = await db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, seeded.companyId),
            eq(agentWakeupRequests.agentId, seeded.agentId),
            eq(agentWakeupRequests.status, "deferred_issue_execution"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      expect(deferredCommentWake).not.toBeNull();

      await heartbeat.cancelRun(firstRun.id);

      await waitFor(() => gateway.getAgentPayloads().length === 2, 30_000);
      expect(String(gateway.getAgentPayloads()[1]?.message ?? "")).toContain("Queued follow-up");

      gateway.releaseFirstWait();
      await waitFor(async () => {
        const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, seeded.agentId));
        return runs.length === 2 && runs.every((run) => ["cancelled", "succeeded"].includes(run.status));
      }, 90_000);
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 120_000);
});
