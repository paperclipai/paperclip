import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { and, asc, eq, sql } from "drizzle-orm";
import { WebSocketServer } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpointResources,
  chatEndpoints,
  chatExternalPrincipals,
  chatIdentityLinks,
  chatMessageLinks,
  chatPublications,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueQuestionResponseDeliveries,
  issueThreadInteractions,
  issues,
  issueTreeHolds,
  nativeRunFinalizations,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { isRetiredExternalChatQuestionSource, questionResponseDeliveryService } from "../services/question-response-delivery.js";
import { SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY } from "../services/recovery/index.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.ts";
import { parseWakePayloadFromMessage } from "./helpers/wake-message.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat comment wake batching tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  intervalMs = 50,
) {
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
              features: {
                methods: ["connect", "agent", "agent.wait"],
                events: ["agent"],
              },
              snapshot: { version: 1, ts: Date.now() },
              policy: {
                maxPayload: 1_000_000,
                maxBufferedBytes: 1_000_000,
                tickIntervalMs: 30_000,
              },
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

describeEmbeddedPostgres("heartbeat comment wake batching", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase(
      "paperclip-heartbeat-comment-wake-",
    );
    db = createDb(started.connectionString);
    tempDb = started;
  }, 120_000);

  afterAll(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    await closeDbClient(db);
    await tempDb?.cleanup();
  });

  afterEach(() => {
    runningProcesses.clear();
  });

  it("defers approval-approved wakes for a running issue so the assignee resumes after the run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

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
      name: "CEO",
      role: "ceo",
      status: "running",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_assigned",
      },
    });
    runningProcesses.set(runId, {
      child: {} as never,
      graceSec: 0,
      processGroupId: null,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Hire an agent",
      status: "blocked",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      executionRunId: runId,
      executionAgentNameKey: "ceo",
      executionLockedAt: new Date(),
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const followupRun = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "approval_approved",
      payload: {
        issueId,
        approvalId: "approval-1",
        approvalStatus: "approved",
      },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        approvalId: "approval-1",
        approvalStatus: "approved",
        wakeReason: "approval_approved",
      },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    expect(followupRun).toBeNull();

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

    expect(deferred).not.toBeNull();
    expect(deferred?.reason).toBe("issue_execution_deferred");
    expect(deferred?.payload).toMatchObject({
      issueId,
      approvalId: "approval-1",
      approvalStatus: "approved",
    });
    expect(
      (deferred?.payload as Record<string, unknown>)._paperclipWakeContext,
    ).toMatchObject({
      issueId,
      taskId: issueId,
      approvalId: "approval-1",
      approvalStatus: "approved",
      wakeReason: "approval_approved",
    });

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(runId);
  });

  it("defers recovery hand-back wakes until the resolving run exits", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const recoveryActionId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

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
      name: "Recovery owner",
      role: "engineer",
      status: "running",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "source_scoped_recovery_action",
      },
    });
    runningProcesses.set(runId, {
      child: {} as never,
      graceSec: 0,
      processGroupId: null,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Resume handed-back work",
      status: "todo",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      executionRunId: runId,
      executionAgentNameKey: "recovery owner",
      executionLockedAt: new Date(),
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const followupRun = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_recovery_action_restored",
      payload: {
        issueId,
        recoveryActionId,
        mutation: "recovery_action_resolution",
      },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        recoveryActionId,
        wakeReason: "issue_recovery_action_restored",
        source: "issue.recovery_action_resolution",
      },
      requestedByActorType: "agent",
      requestedByActorId: agentId,
    });

    expect(followupRun).toBeNull();

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

    expect(deferred).toMatchObject({
      reason: "issue_execution_deferred",
      runId: null,
      payload: expect.objectContaining({
        issueId,
        recoveryActionId,
        mutation: "recovery_action_resolution",
      }),
    });
    expect(
      (deferred?.payload as Record<string, unknown>)._paperclipWakeContext,
    ).toMatchObject({
      issueId,
      taskId: issueId,
      recoveryActionId,
      wakeReason: "issue_recovery_action_restored",
      source: "issue.recovery_action_resolution",
    });

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(runId);
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
        responsibleUserId: "responsible-user",
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

      const deferredContext = (
        deferredWake?.payload as Record<string, unknown> | null
      )?._paperclipWakeContext as Record<string, unknown> | undefined;
      expect(deferredContext?.wakeCommentIds).toEqual([
        comment2.id,
        comment3.id,
      ]);

      gateway.releaseFirstWait();

      await waitFor(() => gateway.getAgentPayloads().length === 2);
      const secondPayload = gateway.getAgentPayloads()[1] ?? {};
      const secondRunId =
        typeof secondPayload.idempotencyKey === "string"
          ? secondPayload.idempotencyKey
          : null;
      if (!secondRunId) {
        throw new Error(
          "Expected forwarded gateway payload to include an idempotencyKey run id",
        );
      }

      await waitFor(async () => {
        const runs = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.agentId, agentId));
        const statusesByRunId = new Map(
          runs.map((run) => [run.id, run.status]),
        );
        return (
          statusesByRunId.get(firstRun!.id) === "succeeded" &&
          statusesByRunId.get(secondRunId) === "succeeded"
        );
      }, 90_000);

      const promotedRun = await db
        .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, secondRunId))
        .then((rows) => rows[0]);
      const promotedTaskMarkdown = String(
        (promotedRun.contextSnapshot as Record<string, unknown> | null)
          ?.paperclipTaskMarkdown ?? "",
      );
      expect(promotedTaskMarkdown).toContain(
        "Pending wake comments (oldest to newest):",
      );
      expect(promotedTaskMarkdown.indexOf("Second comment")).toBeLessThan(
        promotedTaskMarkdown.indexOf("Third comment"),
      );
      expect(promotedTaskMarkdown).not.toContain("First comment");

      expect(secondPayload.paperclip).toBeUndefined();
      const secondWake = parseWakePayloadFromMessage(secondPayload.message);
      expect(secondWake).toMatchObject({
        commentIds: [comment2.id, comment3.id],
        latestCommentId: comment3.id,
      });
      expect(String(secondPayload.message ?? "")).toContain("Second comment");
      expect(String(secondPayload.message ?? "")).toContain("Third comment");
      // A fresh gateway request receives full context; the wake delta stays bounded above.
      expect(String(secondPayload.message ?? "")).toContain("First comment");
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 120_000);

  it("cancels an empty deferred comment wake instead of promoting deleted input", async () => {
    const gateway = await createControlledGatewayServer();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    try {
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
          url: gateway.url,
          headers: { "x-openclaw-token": "gateway-token" },
          payloadTemplate: { message: "wake now" },
          waitTimeoutMs: 2_000,
        },
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Discard deferred follow-up",
        status: "todo",
        priority: "medium",
        responsibleUserId: "responsible-user",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });
      const firstComment = await db
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
        payload: { issueId, commentId: firstComment.id },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          commentId: firstComment.id,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      });
      expect(firstRun).not.toBeNull();
      await waitFor(async () => {
        const current = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, firstRun!.id))
          .then((rows) => rows[0] ?? null);
        return current?.status === "running";
      });

      const discardedComment = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId,
          authorUserId: "user-1",
          body: "Delete this before the current turn finishes",
        })
        .returning()
        .then((rows) => rows[0]);
      expect(
        await heartbeat.wakeup(agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_commented",
          payload: { issueId, commentId: discardedComment.id },
          contextSnapshot: {
            issueId,
            taskId: issueId,
            commentId: discardedComment.id,
            wakeReason: "issue_commented",
          },
          requestedByActorType: "user",
          requestedByActorId: "user-1",
        }),
      ).toBeNull();
      await waitFor(async () =>
        db
          .select({ id: agentWakeupRequests.id })
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, companyId),
              eq(agentWakeupRequests.agentId, agentId),
              eq(agentWakeupRequests.status, "deferred_issue_execution"),
            ),
          )
          .then((rows) => Boolean(rows[0])),
      );
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
        .then((rows) => rows[0]);
      if (!deferredWake) throw new Error("Expected a deferred comment wake");
      await db
        .delete(issueComments)
        .where(eq(issueComments.id, discardedComment.id));

      gateway.releaseFirstWait();
      await waitFor(async () => {
        const wake = await db
          .select({ status: agentWakeupRequests.status })
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, deferredWake.id))
          .then((rows) => rows[0] ?? null);
        return wake?.status === "cancelled";
      }, 90_000);
      await heartbeat.drainActiveRunExecutions();

      expect(gateway.getAgentPayloads()).toHaveLength(1);
      const runs = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      expect(runs.map((run) => run.id)).toEqual([firstRun!.id]);
    } finally {
      gateway.releaseFirstWait();
      await heartbeat.drainActiveRunExecutions();
      await gateway.close();
    }
  }, 120_000);

  it("retains deferred comments for reconciliation after cancelling an unknown provider outcome", async () => {
    const gateway = await createControlledGatewayServer();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    try {
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
        title: "Interrupt queued comment",
        status: "todo",
        priority: "medium",
        responsibleUserId: "responsible-user",
        assigneeAgentId: agentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      });

      const comment1 = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId,
          authorUserId: "user-1",
          body: "Start work",
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

      const queuedComment = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId,
          authorType: "user",
          authorUserId: "user-1",
          body: "Queued follow-up",
          presentation: {
            kind: "system_notice",
            tone: "warning",
            detailsDefaultOpen: false,
          },
          metadata: {
            version: 1,
            sections: [
              {
                rows: [
                  {
                    type: "key_value",
                    label: "Cause",
                    value: "successful_run_missing_state",
                  },
                ],
              },
            ],
          },
        })
        .returning()
        .then((rows) => rows[0]);

      const followupRun = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId, commentId: queuedComment.id },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          commentId: queuedComment.id,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      });

      expect(followupRun).toBeNull();

      await heartbeat.cancelRun(firstRun!.id);

      gateway.releaseFirstWait();
      await heartbeat.reconcileStrandedAssignedIssues();
      expect(gateway.getAgentPayloads()).toHaveLength(1);
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      expect(runs).toEqual([expect.objectContaining({ id: firstRun!.id, status: "cancelled" })]);
      const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
      expect(action).toMatchObject({ cause: "legacy_execution_requires_reconciliation", ownerType: "board", returnOwnerAgentId: agentId });
      const [retained] = await db.select().from(issueComments).where(eq(issueComments.id, queuedComment.id));
      expect(retained?.body).toBe("Queued follow-up");
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
      expect(wakes.some(wake => wake.payload?.commentId === queuedComment.id && wake.status === "deferred_issue_execution")).toBe(true);
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 120_000);

  it("promotes deferred comment wakes after the active run closes the issue", async () => {
    const gateway = await createControlledGatewayServer();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    try {
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
        title: "Reopen after deferred comment",
        status: "todo",
        priority: "medium",
        responsibleUserId: "responsible-user",
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
      await waitFor(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, firstRun!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "running";
      });
      await waitFor(() => gateway.getAgentPayloads().length === 1);

      const comment2 = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId,
          authorUserId: "user-1",
          body: "Please handle this follow-up after you finish",
        })
        .returning()
        .then((rows) => rows[0]);

      const deferredRun = await heartbeat.wakeup(agentId, {
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

      expect(deferredRun).toBeNull();

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

      // Running records admission. Wait for provider acceptance before
      // simulating completion by that provider, or startup correctly rejects
      // the already-closed task before this scenario reaches its follow-up.
      await waitFor(() => gateway.getAgentPayloads().length >= 1);
      await db
        .update(issues)
        .set({
          status: "done",
          completedAt: new Date(),
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, issueId));

      gateway.releaseFirstWait();

      await waitFor(() => gateway.getAgentPayloads().length >= 2, 90_000);
      await waitFor(async () => {
        const runs = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.agentId, agentId))
          .orderBy(asc(heartbeatRuns.createdAt));
        const [initialRun, promotedRun] = runs;
        return (
          initialRun?.id === firstRun?.id &&
          initialRun.status === "succeeded" &&
          promotedRun?.status === "succeeded"
        );
      }, 90_000);

      const reopenedIssue = await db
        .select({
          status: issues.status,
          completedAt: issues.completedAt,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);

      expect(reopenedIssue).toMatchObject({
        status: "in_progress",
        completedAt: null,
      });

      const secondPayload = gateway.getAgentPayloads()[1] ?? {};
      expect(secondPayload.paperclip).toBeUndefined();
      const secondWake = parseWakePayloadFromMessage(secondPayload.message);
      expect(secondWake).toMatchObject({
        reason: "issue_commented",
        commentIds: [comment2.id],
        latestCommentId: comment2.id,
        issue: {
          id: issueId,
          identifier: `${issuePrefix}-1`,
          title: "Reopen after deferred comment",
          status: "in_progress",
          priority: "medium",
        },
      });
      expect(String(secondPayload.message ?? "")).toContain(
        "Please handle this follow-up after you finish",
      );
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 120_000);

  it("does not reopen a finished issue when the deferred comment wake came from another agent", async () => {
    const gateway = await createControlledGatewayServer();
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const mentionedAgentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });

      await db.insert(agents).values([
        {
          id: assigneeAgentId,
          companyId,
          name: "Primary Agent",
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
        },
        {
          id: mentionedAgentId,
          companyId,
          name: "Mentioned Agent",
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
        },
      ]);

      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Do not reopen from agent mention",
        status: "todo",
        priority: "medium",
        responsibleUserId: "responsible-user",
        assigneeAgentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });

      const firstRun = await heartbeat.wakeup(assigneeAgentId, {
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
      await waitFor(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, firstRun!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "running";
      });
      await waitFor(() => gateway.getAgentPayloads().length === 1);

      const comment = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId,
          authorAgentId: assigneeAgentId,
          createdByRunId: firstRun?.id ?? null,
          body: "@Mentioned Agent please review after I finish",
        })
        .returning()
        .then((rows) => rows[0]);

      const deferredRun = await heartbeat.wakeup(mentionedAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_comment_mentioned",
        payload: { issueId, commentId: comment.id },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          commentId: comment.id,
          wakeCommentId: comment.id,
          wakeReason: "issue_comment_mentioned",
          source: "comment.mention",
        },
        requestedByActorType: "agent",
        requestedByActorId: assigneeAgentId,
      });

      expect(deferredRun).toBeNull();

      await waitFor(async () => {
        const deferred = await db
          .select()
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, companyId),
              eq(agentWakeupRequests.agentId, mentionedAgentId),
              eq(agentWakeupRequests.status, "deferred_issue_execution"),
            ),
          )
          .then((rows) => rows[0] ?? null);
        return Boolean(deferred);
      });

      // Running records admission. Wait for provider acceptance before
      // simulating completion by that provider, or startup correctly rejects
      // the already-closed task before this scenario reaches its follow-up.
      await waitFor(() => gateway.getAgentPayloads().length >= 1);
      await db
        .update(issues)
        .set({
          status: "done",
          completedAt: new Date(),
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, issueId));

      gateway.releaseFirstWait();

      await waitFor(() => gateway.getAgentPayloads().length === 2, 90_000);
      await waitFor(async () => {
        const runs = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.companyId, companyId));
        return (
          runs.length === 2 && runs.every((run) => run.status === "succeeded")
        );
      }, 90_000);

      const issueAfterPromotion = await db
        .select({
          status: issues.status,
          completedAt: issues.completedAt,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);

      expect(issueAfterPromotion).toMatchObject({
        status: "done",
      });
      expect(issueAfterPromotion?.completedAt).not.toBeNull();

      const secondPayload = gateway.getAgentPayloads()[1] ?? {};
      expect(secondPayload.paperclip).toBeUndefined();
      const secondWake = parseWakePayloadFromMessage(secondPayload.message);
      expect(secondWake).toMatchObject({
        reason: "issue_comment_mentioned",
        commentIds: [comment.id],
        latestCommentId: comment.id,
        issue: {
          id: issueId,
          identifier: `${issuePrefix}-1`,
          title: "Do not reopen from agent mention",
          status: "done",
          priority: "medium",
        },
      });
      expect(String(secondPayload.message ?? "")).toContain(
        "please review after I finish",
      );
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 120_000);

  it("cancels a deferred wake containing only a comment authored by the closing run", async () => {
    const gateway = await createControlledGatewayServer();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    try {
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
        name: "Local CLI Agent",
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
        title: "Self-comment must not reopen",
        status: "todo",
        priority: "medium",
        responsibleUserId: "responsible-user",
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
      await waitFor(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, firstRun!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "running";
      });
      await waitFor(() => gateway.getAgentPayloads().length === 1);

      // Local-CLI agents post comments under user auth, but stamp the heartbeat
      // run id on each comment via createdByRunId. Simulate that here: a "user"
      // comment that was actually authored by the run that is about to close
      // the issue. Without the Path A guard this would trigger a reopen.
      const selfComment = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId,
          authorUserId: "local-cli-user",
          createdByRunId: firstRun?.id ?? null,
          body: "Closing comment from the same run",
        })
        .returning()
        .then((rows) => rows[0]);

      const deferredRun = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId, commentId: selfComment.id },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          commentId: selfComment.id,
          wakeCommentId: selfComment.id,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "user",
        requestedByActorId: "local-cli-user",
      });

      expect(deferredRun).toBeNull();

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

      // Running records admission. Wait for provider acceptance before
      // simulating completion by that provider, or startup correctly rejects
      // the already-closed task before this scenario reaches its follow-up.
      await waitFor(() => gateway.getAgentPayloads().length >= 1);
      await db
        .update(issues)
        .set({
          status: "done",
          completedAt: new Date(),
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, issueId));

      gateway.releaseFirstWait();

      await waitFor(async () => {
        const run = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, firstRun!.id))
          .then((rows) => rows[0] ?? null);
        const deferred = await db
          .select()
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, companyId),
              eq(agentWakeupRequests.agentId, agentId),
            ),
          )
          .then(
            (rows) =>
              rows.find((request) => request.status === "cancelled") ?? null,
          );
        return (
          run?.status === "succeeded" &&
          deferred?.error ===
            "Deferred wake contained only comments authored by the finishing run"
        );
      }, 90_000);

      expect(gateway.getAgentPayloads()).toHaveLength(1);
      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      expect(runs).toHaveLength(1);

      const issueAfterPromotion = await db
        .select({
          status: issues.status,
          completedAt: issues.completedAt,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);

      expect(issueAfterPromotion).toMatchObject({
        status: "done",
      });
      expect(issueAfterPromotion?.completedAt).not.toBeNull();
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 120_000);

  it("promotes an interaction continuation with its full authoritative source comment after removing a coalesced self-comment", async () => {
    const gateway = await createControlledGatewayServer();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const interactionId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    try {
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
        name: "Local CLI Agent",
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
        title: "Interaction continuation survives self-comment filtering",
        status: "todo",
        priority: "medium",
        responsibleUserId: "responsible-user",
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
      await waitFor(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, firstRun!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "running";
      });

      const selfComment = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId,
          authorUserId: "local-cli-user",
          createdByRunId: firstRun!.id,
          body: "Completion note from the source run",
        })
        .returning()
        .then((rows) => rows[0]);
      const fullSourceInstruction = [
        "Continue the external request after confirmation.",
        "Preserve every requirement from the original provider message, including this deliberately late clause.",
        "TRAILING-INSTRUCTION: reply with the exact final release identifier.",
      ].join("\n");
      const sourceComment = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId,
          authorUserId: "external-user",
          body: fullSourceInstruction,
        })
        .returning()
        .then((rows) => rows[0]);

      expect(
        await heartbeat.wakeup(agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_commented",
          payload: { issueId, commentId: selfComment.id },
          contextSnapshot: {
            issueId,
            taskId: issueId,
            commentId: selfComment.id,
            wakeCommentId: selfComment.id,
            wakeReason: "issue_commented",
          },
          requestedByActorType: "user",
          requestedByActorId: "local-cli-user",
        }),
      ).toBeNull();

      expect(
        await heartbeat.wakeup(agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_commented",
          payload: {
            issueId,
            interactionId,
            interactionKind: "request_confirmation",
            interactionStatus: "accepted",
            sourceCommentId: sourceComment.id,
            wakeCommentId: sourceComment.id,
            wakeCommentIds: [sourceComment.id],
            mutation: "interaction",
          },
          contextSnapshot: {
            issueId,
            taskId: issueId,
            interactionId,
            interactionKind: "request_confirmation",
            interactionStatus: "accepted",
            sourceCommentId: sourceComment.id,
            wakeCommentId: sourceComment.id,
            wakeCommentIds: [sourceComment.id],
            wakeReason: "issue_commented",
            source: "issue.interaction.respond",
          },
          requestedByActorType: "user",
          requestedByActorId: "user-1",
        }),
      ).toBeNull();

      gateway.releaseFirstWait();

      await waitFor(async () => {
        const runs = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.agentId, agentId))
          .orderBy(asc(heartbeatRuns.createdAt));
        return (
          runs.length === 2 &&
          runs[0]?.status === "succeeded" &&
          runs[1]?.status === "succeeded"
        );
      }, 90_000);

      const promotedRun = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId))
        .orderBy(asc(heartbeatRuns.createdAt))
        .then((runs) => runs[1] ?? null);
      expect(promotedRun?.contextSnapshot).toMatchObject({
        interactionId,
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
        sourceCommentId: sourceComment.id,
        wakeCommentId: sourceComment.id,
        wakeCommentIds: [sourceComment.id],
      });
      expect(promotedRun?.contextSnapshot).not.toMatchObject({
        commentId: selfComment.id,
      });
      expect(gateway.getAgentPayloads()).toHaveLength(2);
      const continuationWake = parseWakePayloadFromMessage(
        gateway.getAgentPayloads()[1]?.message,
      );
      expect(continuationWake?.commentIds).toEqual([sourceComment.id]);
      expect(continuationWake?.comments).toEqual([
        expect.objectContaining({
          id: sourceComment.id,
          issueId,
          body: fullSourceInstruction,
          bodyTruncated: false,
        }),
      ]);
      expect(String(gateway.getAgentPayloads()[1]?.message ?? "")).toContain(
        "TRAILING-INSTRUCTION: reply with the exact final release identifier.",
      );
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 120_000);

  it.each(["linked", "revoked", "restart", "unbound_marker", "ordinary_cancellation"] as const)(
    "cancels a parked native chat source and authorizes its dedicated answer continuation (%s)",
    async (identityStatus) => {
      const gateway = await createControlledGatewayServer();
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueId = randomUUID();
      const sourceRunId = randomUUID();
      const userId = `linked-slack-user-${randomUUID()}`;
      const endpointId = randomUUID();
      const conversationId = randomUUID();
      const principalId = randomUUID();
      const deliveryId = randomUUID();
      const applicationId = randomUUID();
      const connectionId = randomUUID();
      const resourceId = randomUUID();
      const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
      const heartbeat = heartbeatService(db);

      try {
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
          name: "Local CLI Agent",
          role: "engineer",
          status: "running",
          adapterType: "openclaw_gateway",
          adapterConfig: {
            url: gateway.url,
            headers: { "x-openclaw-token": "gateway-token" },
            payloadTemplate: { message: "wake now" },
            waitTimeoutMs: 2_000,
          },
          runtimeConfig: {},
          permissions: {},
        });
        await db.insert(issues).values({
          id: issueId,
          companyId,
          title: "Continue an answered Slack question",
          status: "in_progress",
          priority: "medium",
          responsibleUserId: "responsible-user",
          assigneeAgentId: agentId,
          issueNumber: 1,
          identifier: `${issuePrefix}-1`,
        });
        const sourceComment = await db
          .insert(issueComments)
          .values({
            companyId,
            issueId,
            authorType: "user",
            authorUserId: userId,
            body: "Build the release and preserve this full source instruction.",
          })
          .returning()
          .then((rows) => rows[0]!);
        // Model an admitted, linked Slack source, not just an untrusted source
        // string. The real dispatch attestor must reconstruct this durable chain.
        await db.insert(toolApplications).values({
          id: applicationId,
          companyId,
          applicationKey: `chat:slack:${endpointId}`,
          name: "Slack question",
          type: "chat",
          status: "active",
        });
        await db.insert(toolConnections).values({
          id: connectionId,
          companyId,
          applicationId,
          name: "Slack question",
          uid: `chat-slack-${endpointId}`,
          connectionPurpose: "channel",
          transport: "chat_sdk",
          status: "active",
          enabled: true,
        });
        await db.insert(chatEndpoints).values({
          id: endpointId,
          companyId,
          connectionId,
          provider: "slack",
          publicId: randomUUID(),
          assignedAgentId: agentId,
          status: "active",
          providerAccountId: "slack-workspace",
          allowDirectMessages: true,
          allowUnlinkedPeople: false,
        });
        await db.insert(chatEndpointResources).values({
          id: resourceId,
          companyId,
          endpointId,
          type: "direct_message",
          providerResourceId: "slack-person",
          label: "Slack direct message",
          availability: "available",
          enabled: true,
        });
        await db.insert(chatConversations).values({
          id: conversationId,
          companyId,
          endpointId,
          resourceId,
          issueId,
          externalConversationId: "slack-person",
          externalThreadId: "slack:slack-person:1",
          externalLabel: "Slack direct message",
          sessionGeneration: 1,
          isDirectMessage: true,
          state: "active",
        });
        await db.insert(chatExternalPrincipals).values({
          id: principalId,
          companyId,
          provider: "slack",
          providerAccountId: "slack-workspace",
          externalId: "slack-person",
          kind: "user",
        });
        await db.insert(chatIdentityLinks).values({
          companyId,
          endpointId,
          principalId,
          paperclipUserId: userId,
          status: "linked",
        });
        await db.insert(companyMemberships).values({
          companyId,
          principalType: "user",
          principalId: userId,
          status: "active",
          membershipRole: "member",
        });
        await db.insert(chatDeliveries).values({
          id: deliveryId,
          companyId,
          endpointId,
          conversationId,
          principalId,
          providerEventId: "slack-source-message",
          deduplicationKey: "slack-source-message",
          eventKind: "message",
          normalizedEvent: {},
          state: "processed",
          attempts: 1,
          processedAt: new Date(),
        });
        await db.insert(chatMessageLinks).values({
          companyId,
          endpointId,
          conversationId,
          deliveryId,
          commentId: sourceComment.id,
          providerMessageId: "slack-source-message",
          direction: "inbound",
        });
        await db.insert(heartbeatRuns).values({
          id: sourceRunId,
          companyId,
          agentId,
          invocationSource: "assignment",
          triggerDetail: "system",
          status: "running",
          runtimeMode: "native",
          nativeIssueId: issueId,
          driverKind: "codex",
          startedAt: new Date(),
          contextSnapshot: {
            issueId,
            taskId: issueId,
            source: "chat:slack",
            commentId: sourceComment.id,
            wakeCommentId: sourceComment.id,
            wakeCommentIds: [sourceComment.id],
            paperclipHarnessCheckedOut: true,
            paperclipWake: {
              externalChatProvider: "slack",
              checkedOutByHarness: true,
              issue: { id: issueId, workMode: "standard" },
              commentIds: [sourceComment.id],
            },
          },
        });
        await db.insert(nativeRunFinalizations).values({
          runId: sourceRunId,
          companyId,
          issueId,
          phase: "observed",
        });
        await db
          .update(issues)
          .set({
            checkoutRunId: sourceRunId,
            executionRunId: sourceRunId,
            executionAgentNameKey: "localcliagent",
            executionLockedAt: new Date(),
          })
          .where(eq(issues.id, issueId));

        const interactions = issueThreadInteractionService(db);
        const pending = await interactions.create(
          { id: issueId, companyId },
          {
            kind: "ask_user_questions",
            continuationPolicy: "wake_assignee",
            sourceRunId,
            sourceCommentId: sourceComment.id,
            payload: {
              version: 1,
              questions: [
                {
                  id: "release",
                  prompt: "Continue the release?",
                  selectionMode: "single",
                  required: true,
                  options: [{ id: "yes", label: "Yes" }],
                },
              ],
            },
          },
          { agentId, runId: sourceRunId },
        );
        const answered = await interactions.answerQuestions(
          { id: issueId, companyId, status: "in_progress" },
          pending.id,
          { answers: [{ questionId: "release", optionIds: ["yes"] }] },
          { userId },
        );
        const publicationId = randomUUID();
        await db.insert(chatPublications).values({
          id: publicationId,
          companyId,
          endpointId,
          conversationId,
          issueId,
          state: "published",
          idempotencyKey: `question:${answered.id}`,
          providerMessageId: "slack-question-card",
          publishedAt: new Date(),
          payload: {
            text: "Continue the release?",
            interactionId: answered.id,
          },
        });
        await db.insert(chatActions).values({
          companyId,
          endpointId,
          conversationId,
          principalId,
          kind: "question_answer",
          status: "processed",
          providerActionId: `answer:${answered.id}`,
          payload: {
            version: 1,
            interactionId: answered.id,
            publicationId,
            questionId: "release",
            optionId: "yes",
          },
          result: { interactionId: answered.id, interactionStatus: "answered" },
        });
        if (identityStatus === "revoked") {
          await db
            .update(chatIdentityLinks)
            .set({ status: "revoked" })
            .where(
              and(
                eq(chatIdentityLinks.companyId, companyId),
                eq(chatIdentityLinks.principalId, principalId),
              ),
            );
        }
        const retiredScope = { companyId, issueId, agentId, runId: sourceRunId };
        if (identityStatus === "unbound_marker" || identityStatus === "ordinary_cancellation") {
          await heartbeat.cancelRun(sourceRunId, "Fixture cancellation", {
            errorCode: identityStatus === "unbound_marker" ? "external_chat_continuation" : "cancelled",
            resultJson: { interactionId: randomUUID(), externalChatContinuation: true },
            suppressImmediateRecovery: true,
          });
          expect(await isRetiredExternalChatQuestionSource(db, retiredScope)).toBe(false);
          const incidents = await db.select().from(issueRecoveryActions).where(and(
            eq(issueRecoveryActions.companyId, companyId),
            eq(issueRecoveryActions.sourceIssueId, issueId),
          ));
          expect(incidents).toEqual([expect.objectContaining({
            cause: "native_continuation_requires_reconciliation",
          })]);
          expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toHaveLength(0);
          expect(gateway.getAgentPayloads()).toHaveLength(0);
          return;
        }
        let nativeResolverCalls = 0;
        const resolver = async () => {
          nativeResolverCalls += 1;
          return "queued" as const;
        };
        if (identityStatus === "restart") {
          const interruptedDelivery = questionResponseDeliveryService(db, {
            heartbeat: {
              wakeup: heartbeat.wakeup,
              cancelRun: async (...args) => {
                await heartbeat.cancelRun(...args);
                // A lost caller result after the durable cancellation is a
                // restart boundary, not a new failure incident or permission
                // to promote generic work before the dedicated wake exists.
                throw new Error("fixture_cancel_receipt_lost");
              },
            },
            resolveNativeQuestion: resolver,
          });
          expect(await interruptedDelivery.deliver(answered.id)).toBeNull();
          expect(await isRetiredExternalChatQuestionSource(db, retiredScope)).toBe(true);
          await heartbeatService(db).reconcileStrandedAssignedIssues();
          expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toHaveLength(0);
          expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId))).toHaveLength(0);
        }
        const answerDelivery = questionResponseDeliveryService(db, {
          heartbeat,
          resolveNativeQuestion: resolver,
        });
        const outcome = await answerDelivery.deliver(answered.id);

        expect(nativeResolverCalls).toBe(0);
        expect(outcome).toMatchObject({
          status: "fallback_queued",
          mode: "wake_fallback",
        });
        expect(await isRetiredExternalChatQuestionSource(db, retiredScope)).toBe(true);
        expect(await isRetiredExternalChatQuestionSource(db, { ...retiredScope, agentId: randomUUID() })).toBe(false);
        expect(await isRetiredExternalChatQuestionSource(db, { ...retiredScope, issueId: randomUUID() })).toBe(false);
        expect(await db.select().from(issueRecoveryActions).where(and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.fingerprint, `native-continuation:${sourceRunId}`),
        ))).toHaveLength(0);
        const duplicateOutcomes = await Promise.all([answerDelivery.deliver(answered.id), answerDelivery.deliver(answered.id)]);
        expect(duplicateOutcomes.every(value => value?.duplicate === true)).toBe(true);
        expect(await db.select().from(agentWakeupRequests).where(and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.idempotencyKey, `question-response:${answered.id}`),
        ))).toHaveLength(1);
        await expect(
          db
            .select({ status: heartbeatRuns.status })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, sourceRunId)),
        ).resolves.toEqual([{ status: "cancelled" }]);

        let continuationRunId: string | null = null;
        await waitFor(async () => {
          continuationRunId = await db
            .select({ runId: agentWakeupRequests.runId })
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.companyId, companyId),
                eq(
                  agentWakeupRequests.idempotencyKey,
                  `question-response:${answered.id}`,
                ),
              ),
            )
            .then((rows) => rows[0]?.runId ?? null);
          return continuationRunId !== null;
        }, 30_000);
        expect(continuationRunId).not.toBe(sourceRunId);
        if (identityStatus === "revoked") {
          await heartbeat.drainActiveRunExecutions();
          const [deniedRun] = await db
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, continuationRunId!));
          expect(deniedRun).toMatchObject({
            status: "failed",
            error: "reviewed_chat_execution_binding_not_authorized",
            contextSnapshot: expect.objectContaining({
              interactionId: answered.id,
              sourceRunId,
            }),
          });
          expect(deniedRun?.contextSnapshot).not.toHaveProperty(
            "paperclipExternalChatQuestionResponse",
          );
          expect(gateway.getAgentPayloads()).toHaveLength(0);
          return;
        }
        await waitFor(() => gateway.getAgentPayloads().length === 1, 30_000);
        const continuationRun = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, continuationRunId!))
          .then((rows) => rows[0] ?? null);
        expect(continuationRun).toMatchObject({
          status: "running",
          contextSnapshot: expect.objectContaining({
            interactionId: answered.id,
            sourceRunId,
            sourceCommentId: sourceComment.id,
            externalChatContinuation: true,
            wakeCommentId: sourceComment.id,
            wakeCommentIds: [sourceComment.id],
            paperclipExternalChatExecutionBound: true,
            paperclipExternalChatQuestionResponse: expect.objectContaining({
              schema: "paperclip.external_chat_question_response.v1",
              interactionId: answered.id,
              sourceRunId,
              sourceCommentId: sourceComment.id,
              endpointId,
              conversationId,
            }),
          }),
        });
        expect(String(gateway.getAgentPayloads()[0]?.message ?? "")).toContain(
          "preserve this full source instruction",
        );
        expect(String(gateway.getAgentPayloads()[0]?.message ?? "")).toContain(
          "Preserve the original request's exact-output constraints literally.",
        );
        expect(String(gateway.getAgentPayloads()[0]?.message ?? "")).toContain(
          "Do not narrate Paperclip workflow, checkout, status, or completion bookkeeping.",
        );
        const continuationWake = parseWakePayloadFromMessage(
          gateway.getAgentPayloads()[0]?.message,
        );
        expect(continuationWake).toMatchObject({
          externalChatProvider: "slack",
          externalChatExecutionBound: true,
          externalChatQuestionResponse: expect.objectContaining({
            interactionId: answered.id,
            sourceRunId,
            endpointId,
            conversationId,
          }),
          questionResponse: {
            interactionId: answered.id,
            summaryMarkdown:
              "Resolved questions and answers:\n- Continue the release?: Yes",
            truncated: false,
          },
        });

        gateway.releaseFirstWait();
        await waitFor(async () => {
          const run = await db
            .select({ status: heartbeatRuns.status })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, continuationRunId!))
            .then((rows) => rows[0] ?? null);
          return run?.status === "succeeded";
        }, 30_000);
        await waitFor(async () =>
          db
            .select({ executionRunId: issues.executionRunId })
            .from(issues)
            .where(eq(issues.id, issueId))
            .then((rows) => rows[0]?.executionRunId === null),
        );
        await expect(
          db
            .select({ status: issueQuestionResponseDeliveries.status })
            .from(issueQuestionResponseDeliveries)
            .where(
              eq(issueQuestionResponseDeliveries.interactionId, answered.id),
            ),
        ).resolves.toEqual([{ status: "fallback_queued" }]);
        await expect(
          db
            .select({ status: issueThreadInteractions.status })
            .from(issueThreadInteractions)
            .where(eq(issueThreadInteractions.id, answered.id)),
        ).resolves.toEqual([{ status: "answered" }]);
      } finally {
        gateway.releaseFirstWait();
        await heartbeat.drainActiveRunExecutions();
        await gateway.close();
      }
    },
    120_000,
  );

  it("still reopens a finished issue when a deferred batch mixes self-authored and human comments", async () => {
    const gateway = await createControlledGatewayServer();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    try {
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
        name: "Local CLI Agent",
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
        title: "Human follow-up must survive mixed deferred batches",
        status: "todo",
        priority: "medium",
        responsibleUserId: "responsible-user",
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
      await waitFor(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, firstRun!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "running";
      });

      const selfComment = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId,
          authorUserId: "local-cli-user",
          createdByRunId: firstRun?.id ?? null,
          body: "Closing note from the same run",
        })
        .returning()
        .then((rows) => rows[0]);

      const firstDeferredRun = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId, commentId: selfComment.id },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          commentId: selfComment.id,
          wakeCommentId: selfComment.id,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "user",
        requestedByActorId: "local-cli-user",
      });

      expect(firstDeferredRun).toBeNull();

      const humanComment = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId,
          authorUserId: "user-1",
          body: "Real follow-up from a human after the run closes",
        })
        .returning()
        .then((rows) => rows[0]);

      const secondDeferredRun = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId, commentId: humanComment.id },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          commentId: humanComment.id,
          wakeCommentId: humanComment.id,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      });

      expect(secondDeferredRun).toBeNull();

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

      // Running records admission. Wait for provider acceptance before
      // simulating completion by that provider, or startup correctly rejects
      // the already-closed task before this scenario reaches its follow-up.
      await waitFor(() => gateway.getAgentPayloads().length >= 1);
      await db
        .update(issues)
        .set({
          status: "done",
          completedAt: new Date(),
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, issueId));

      gateway.releaseFirstWait();

      await waitFor(() => gateway.getAgentPayloads().length >= 2, 90_000);
      await waitFor(async () => {
        const runs = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.agentId, agentId))
          .orderBy(asc(heartbeatRuns.createdAt));
        const [initialRun, promotedRun] = runs;
        return (
          initialRun?.id === firstRun?.id &&
          initialRun.status === "succeeded" &&
          promotedRun?.status === "succeeded"
        );
      }, 90_000);

      const issueAfterPromotion = await db
        .select({
          status: issues.status,
          completedAt: issues.completedAt,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);

      expect(issueAfterPromotion).toMatchObject({
        status: "in_progress",
        completedAt: null,
      });

      const secondPayload = gateway.getAgentPayloads()[1] ?? {};
      expect(secondPayload.paperclip).toBeUndefined();
      const secondWake = parseWakePayloadFromMessage(secondPayload.message);
      expect(secondWake).toMatchObject({
        reason: "issue_commented",
        commentIds: [humanComment.id],
        latestCommentId: humanComment.id,
        issue: {
          id: issueId,
          identifier: `${issuePrefix}-1`,
          title: "Human follow-up must survive mixed deferred batches",
          status: "in_progress",
          priority: "medium",
        },
      });
      expect(String(secondPayload.message ?? "")).toContain(
        "Real follow-up from a human after the run closes",
      );
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 120_000);

  it("cancels a deferred comment wake when its only queued comment is deleted before promotion", async () => {
    const gateway = await createControlledGatewayServer();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    try {
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
        title: "Deleted follow-up must not reopen",
        status: "todo",
        priority: "medium",
        responsibleUserId: "responsible-user",
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
      await waitFor(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, firstRun!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "running";
      });
      await waitFor(() => gateway.getAgentPayloads().length === 1);

      const queuedComment = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId,
          authorUserId: "user-1",
          body: "Please look at this once you finish",
        })
        .returning()
        .then((rows) => rows[0]);

      const deferredRun = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId, commentId: queuedComment.id },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          commentId: queuedComment.id,
          wakeCommentId: queuedComment.id,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      });

      expect(deferredRun).toBeNull();

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
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.agentId, agentId),
            eq(agentWakeupRequests.status, "deferred_issue_execution"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      const deferredWakeId = deferredWake!.id;

      // The author retracts the comment before the first run finishes, so the
      // real comment-liveness query must find zero live comments left in the
      // queued batch.
      await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, queuedComment.id));

      // Running records admission. Wait for provider acceptance before
      // simulating completion by that provider, or startup correctly rejects
      // the already-closed task before this scenario reaches its follow-up.
      await waitFor(() => gateway.getAgentPayloads().length >= 1);
      await db
        .update(issues)
        .set({
          status: "done",
          completedAt: new Date(),
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, issueId));

      gateway.releaseFirstWait();

      await waitFor(async () => {
        const [wake] = await db
          .select({ status: agentWakeupRequests.status })
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, deferredWakeId));
        return wake?.status === "cancelled";
      }, 90_000);

      const [cancelledWake] = await db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, deferredWakeId));
      expect(cancelledWake).toMatchObject({
        status: "cancelled",
        error: "Queued messages were discarded before promotion",
      });

      // No live comment remained, so the queue must not promote a second run
      // and the issue must stay in the state the first run's completion left it in.
      expect(gateway.getAgentPayloads()).toHaveLength(1);
      const issueAfterCompletion = await db
        .select({ status: issues.status, completedAt: issues.completedAt })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      expect(issueAfterCompletion).toMatchObject({ status: "done" });
      expect(issueAfterCompletion?.completedAt).not.toBeNull();
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 120_000);

  it("cancels a deferred comment wake when its only queued comment was authored by the finishing run", async () => {
    const gateway = await createControlledGatewayServer();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    try {
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
        name: "Local CLI Agent",
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
        title: "Self-authored note must not reopen",
        status: "todo",
        priority: "medium",
        responsibleUserId: "responsible-user",
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
      await waitFor(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, firstRun!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "running";
      });

      const selfComment = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId,
          authorUserId: "local-cli-user",
          createdByRunId: firstRun?.id ?? null,
          body: "Closing note from the same run",
        })
        .returning()
        .then((rows) => rows[0]);

      const deferredRun = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId, commentId: selfComment.id },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          commentId: selfComment.id,
          wakeCommentId: selfComment.id,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "user",
        requestedByActorId: "local-cli-user",
      });

      expect(deferredRun).toBeNull();

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

      const queuedWake = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.agentId, agentId),
            eq(agentWakeupRequests.status, "deferred_issue_execution"),
          ),
        )
        .then((rows) => rows[0] ?? null);

      // Running records admission. Wait for provider acceptance before
      // simulating completion by that provider, or startup correctly rejects
      // the already-closed task before this scenario reaches its follow-up.
      await waitFor(() => gateway.getAgentPayloads().length >= 1);
      await db
        .update(issues)
        .set({
          status: "done",
          completedAt: new Date(),
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, issueId));

      gateway.releaseFirstWait();

      await waitFor(async () => {
        const [wake] = await db
          .select({ status: agentWakeupRequests.status })
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, queuedWake!.id));
        return wake?.status === "cancelled";
      }, 90_000);

      const [cancelledWake] = await db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, queuedWake!.id));
      expect(cancelledWake).toMatchObject({
        status: "cancelled",
        error: "Deferred wake contained only comments authored by the finishing run",
      });

      // The only queued comment came from the run that just finished, so the
      // queue must not promote a second run for the same agent to re-read its
      // own note, and the issue must stay in the state the run's completion left it in.
      expect(gateway.getAgentPayloads()).toHaveLength(1);
      const issueAfterCompletion = await db
        .select({ status: issues.status, completedAt: issues.completedAt })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      expect(issueAfterCompletion).toMatchObject({ status: "done" });
      expect(issueAfterCompletion?.completedAt).not.toBeNull();
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 120_000);

  it("promotes an interaction continuation after removing a coalesced self-authored comment", async () => {
    const gateway = await createControlledGatewayServer();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const interactionId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    try {
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
        name: "Local CLI Agent",
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
        title: "Interaction continuation survives self-comment filtering",
        status: "todo",
        priority: "medium",
        responsibleUserId: "responsible-user",
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
      await waitFor(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, firstRun!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "running";
      });

      const selfComment = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId,
          authorUserId: "local-cli-user",
          createdByRunId: firstRun!.id,
          body: "Completion note from the source run",
        })
        .returning()
        .then((rows) => rows[0]);

      expect(await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId, commentId: selfComment.id },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          commentId: selfComment.id,
          wakeCommentId: selfComment.id,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "user",
        requestedByActorId: "local-cli-user",
      })).toBeNull();

      expect(await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: {
          issueId,
          interactionId,
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
          mutation: "interaction",
        },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          interactionId,
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
          wakeReason: "issue_commented",
          source: "issue.interaction.respond",
        },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      })).toBeNull();

      gateway.releaseFirstWait();

      await waitFor(async () => {
        const runs = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.agentId, agentId))
          .orderBy(asc(heartbeatRuns.createdAt));
        return (
          runs.length === 2 &&
          runs[0]?.status === "succeeded" &&
          runs[1]?.status === "succeeded"
        );
      }, 90_000);

      const promotedRun = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId))
        .orderBy(asc(heartbeatRuns.createdAt))
        .then((runs) => runs[1] ?? null);
      expect(promotedRun?.contextSnapshot).toMatchObject({
        interactionId,
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
      });
      expect(promotedRun?.contextSnapshot).not.toMatchObject({
        wakeCommentIds: expect.anything(),
      });
      expect(promotedRun?.contextSnapshot).not.toMatchObject({
        commentId: selfComment.id,
      });
      expect(gateway.getAgentPayloads()).toHaveLength(2);
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 120_000);

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
        responsibleUserId: "responsible-user",
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
      const firstPayload = gateway.getAgentPayloads()[0] ?? {};
      expect(firstPayload.paperclip).toBeUndefined();
      expect(String(firstPayload.message ?? "")).toContain(
        "## Paperclip Wake Payload",
      );
      expect(String(firstPayload.message ?? "")).toContain(
        "Do not switch to another issue until you have handled this wake.",
      );
      expect(String(firstPayload.message ?? "")).toContain(
        "- checkout: already claimed by the harness for this run",
      );
      expect(String(firstPayload.message ?? "")).toContain(
        "The harness already checked out this issue for the current run.",
      );
      expect(String(firstPayload.message ?? "")).toContain(
        `${issuePrefix}-1 Require a comment`,
      );
      const firstWake = parseWakePayloadFromMessage(firstPayload.message);
      expect(firstWake).toMatchObject({
        reason: "issue_assigned",
        checkedOutByHarness: true,
        commentIds: [],
        issue: {
          id: issueId,
          identifier: `${issuePrefix}-1`,
        },
      });
      const checkedOutIssue = await db
        .select({
          status: issues.status,
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      expect(checkedOutIssue).toMatchObject({
        status: "in_progress",
        checkoutRunId: firstRun?.id,
        executionRunId: firstRun?.id,
      });
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

      const comments = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId));
      expect(comments).toHaveLength(0);

      await waitFor(async () => {
        const wakeups = await db
          .select()
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, companyId),
              eq(agentWakeupRequests.agentId, agentId),
            ),
          );
        return wakeups.length >= 2;
      });

      const payloads = gateway.getAgentPayloads();
      expect(payloads).toHaveLength(2);
      expect(runs[1]?.contextSnapshot).toMatchObject({
        retryReason: "missing_issue_comment",
      });
      expect(runs[1]?.contextSnapshot).not.toHaveProperty("modelProfile");
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 20_000);

  it("defers mentioned-agent wakes while another agent is actively executing the same issue", async () => {
    const gateway = await createControlledGatewayServer();
    const companyId = randomUUID();
    const primaryAgentId = randomUUID();
    const mentionedAgentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });

      await db.insert(agents).values([
        {
          id: primaryAgentId,
          companyId,
          name: "Primary Agent",
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
        },
        {
          id: mentionedAgentId,
          companyId,
          name: "Mentioned Agent",
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
        },
      ]);

      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Prevent concurrent mention execution",
        status: "todo",
        priority: "high",
        responsibleUserId: "responsible-user",
        assigneeAgentId: primaryAgentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });

      const primaryRun = await heartbeat.wakeup(primaryAgentId, {
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

      expect(primaryRun).not.toBeNull();
      await waitFor(() => gateway.getAgentPayloads().length === 1);

      const mentionComment = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId,
          authorUserId: "user-1",
          body: "@Mentioned Agent please inspect this after the current run.",
        })
        .returning()
        .then((rows) => rows[0]);

      const mentionRun = await heartbeat.wakeup(mentionedAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_comment_mentioned",
        payload: { issueId, commentId: mentionComment.id },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          commentId: mentionComment.id,
          wakeCommentId: mentionComment.id,
          wakeReason: "issue_comment_mentioned",
          source: "comment.mention",
        },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      });

      expect(mentionRun).toBeNull();

      await waitFor(async () => {
        const deferred = await db
          .select()
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, companyId),
              eq(agentWakeupRequests.agentId, mentionedAgentId),
              eq(agentWakeupRequests.status, "deferred_issue_execution"),
            ),
          )
          .then((rows) => rows[0] ?? null);
        return Boolean(deferred);
      });

      expect(gateway.getAgentPayloads()).toHaveLength(1);

      gateway.releaseFirstWait();

      await waitFor(async () => {
        const runs = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.agentId, mentionedAgentId))
          .orderBy(asc(heartbeatRuns.createdAt));
        return runs.length === 1 && runs[0]?.status === "succeeded";
      }, 90_000);
      expect(gateway.getAgentPayloads().length).toBeGreaterThanOrEqual(2);

      const mentionedRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, mentionedAgentId))
        .orderBy(asc(heartbeatRuns.createdAt));

      expect(mentionedRuns).toHaveLength(1);
      expect(mentionedRuns[0]?.contextSnapshot).toMatchObject({
        issueId,
        wakeReason: "issue_comment_mentioned",
      });

      const issueAfterMention = await db
        .select({
          assigneeAgentId: issues.assigneeAgentId,
          executionRunId: issues.executionRunId,
          executionAgentNameKey: issues.executionAgentNameKey,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);

      expect(issueAfterMention?.assigneeAgentId).toBe(primaryAgentId);
      expect(issueAfterMention?.executionRunId).not.toBe(mentionedRuns[0]?.id);
      expect(issueAfterMention?.executionAgentNameKey).not.toBe(
        "mentioned agent",
      );

      const primaryRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, primaryAgentId))
        .orderBy(asc(heartbeatRuns.createdAt));
      expect(primaryRuns).toHaveLength(2);
      expect(primaryRuns[0]?.issueCommentStatus).toBe("retry_queued");
      expect(primaryRuns[1]?.retryOfRunId).toBe(primaryRuns[0]?.id);
      expect(primaryRuns[1]?.issueCommentStatus).toBe("retry_exhausted");

      const missingCommentRetries = await db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.agentId, primaryAgentId),
            eq(agentWakeupRequests.reason, "missing_issue_comment"),
          ),
        );
      expect(missingCommentRetries).toHaveLength(1);
      expect(missingCommentRetries[0]?.payload).not.toHaveProperty(
        "modelProfile",
      );
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 120_000);

  it("does not mark a direct mentioned-agent run as the issue execution owner", async () => {
    const gateway = await createControlledGatewayServer();
    const companyId = randomUUID();
    const primaryAgentId = randomUUID();
    const mentionedAgentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });

      await db.insert(agents).values([
        {
          id: primaryAgentId,
          companyId,
          name: "Primary Agent",
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
        },
        {
          id: mentionedAgentId,
          companyId,
          name: "Mentioned Agent",
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
        },
      ]);

      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Mention should not steal execution ownership",
        status: "todo",
        priority: "medium",
        responsibleUserId: "responsible-user",
        assigneeAgentId: primaryAgentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });

      const mentionComment = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId,
          authorUserId: "user-1",
          body: "@Mentioned Agent please inspect this.",
        })
        .returning()
        .then((rows) => rows[0]);

      const mentionRun = await heartbeat.wakeup(mentionedAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_comment_mentioned",
        payload: { issueId, commentId: mentionComment.id },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          commentId: mentionComment.id,
          wakeCommentId: mentionComment.id,
          wakeReason: "issue_comment_mentioned",
          source: "comment.mention",
        },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      });

      expect(mentionRun).not.toBeNull();
      await waitFor(() => gateway.getAgentPayloads().length === 1);

      const issueDuringMention = await db
        .select({
          assigneeAgentId: issues.assigneeAgentId,
          executionRunId: issues.executionRunId,
          executionAgentNameKey: issues.executionAgentNameKey,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);

      expect(issueDuringMention).toMatchObject({
        assigneeAgentId: primaryAgentId,
        executionRunId: null,
        executionAgentNameKey: null,
      });

      gateway.releaseFirstWait();
      await waitFor(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, mentionRun!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "succeeded";
      }, 90_000);

      const issueAfterMention = await db
        .select({
          assigneeAgentId: issues.assigneeAgentId,
          executionRunId: issues.executionRunId,
          executionAgentNameKey: issues.executionAgentNameKey,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);

      expect(issueAfterMention).toMatchObject({
        assigneeAgentId: primaryAgentId,
        executionRunId: null,
        executionAgentNameKey: null,
      });
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 120_000);
  it("treats the automatic run summary as fallback-only when the run already posted a comment", async () => {
    const gateway = await createControlledGatewayServer();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    try {
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
        title: "Use existing comment",
        status: "todo",
        priority: "medium",
        responsibleUserId: "responsible-user",
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

      await db.insert(issueComments).values({
        companyId,
        issueId,
        authorAgentId: agentId,
        authorUserId: null,
        createdByRunId: firstRun!.id,
        body: "Manual completion comment from the run.",
      });

      gateway.releaseFirstWait();

      await waitFor(async () => {
        const runs = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.agentId, agentId));
        const sourceRun = runs.find((run) => run.id === firstRun?.id);
        return (
          sourceRun?.status === "succeeded" &&
          sourceRun.issueCommentStatus === "satisfied"
        );
      });

      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));

      const sourceRun = runs.find((run) => run.id === firstRun?.id);
      expect(sourceRun?.issueCommentStatus).toBe("satisfied");
      expect(sourceRun?.issueCommentSatisfiedByCommentId).not.toBeNull();

      await waitFor(async () => {
        const comments = await db
          .select()
          .from(issueComments)
          .where(eq(issueComments.issueId, issueId));
        const wakeups = await db
          .select()
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, companyId),
              eq(agentWakeupRequests.agentId, agentId),
            ),
          );

        const hasHandoffComment = comments.some(
          (comment) =>
            comment.body === SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY,
        );
        const hasHandoffWake = wakeups.some(
          (wakeup) => wakeup.reason === "finish_successful_run_handoff",
        );
        return hasHandoffComment && hasHandoffWake;
      });

      const comments = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId))
        .orderBy(asc(issueComments.createdAt));

      expect(
        comments.some(
          (comment) =>
            comment.body === "Manual completion comment from the run.",
        ),
      ).toBe(true);
      expect(
        comments.some(
          (comment) =>
            comment.body === SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY,
        ),
      ).toBe(true);
      expect(
        comments.every((comment) => !comment.body.startsWith("## Run summary")),
      ).toBe(true);

      const wakeups = await db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.agentId, agentId),
          ),
        );

      expect(
        wakeups.some((wakeup) => wakeup.reason === "missing_issue_comment"),
      ).toBe(false);
      expect(
        wakeups.some(
          (wakeup) => wakeup.reason === "finish_successful_run_handoff",
        ),
      ).toBe(true);
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 20_000);

  it("fails a deferred wake whose agent no longer exists, then still promotes the next queued wake", async () => {
    const companyId = randomUUID();
    const finishingAgentId = randomUUID();
    const validAgentId = randomUUID();
    const missingAgentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    // Pin scheduling suppression off with the runtimeEnv test seam. Do not rely
    // on the ambient PAPERCLIP_IN_WORKTREE value: startNextQueuedRunForAgent
    // no-ops under suppression and would leave the promoted wake at "queued".
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values([
      {
        id: finishingAgentId,
        companyId,
        name: "Finishing Agent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: validAgentId,
        companyId,
        name: "Assignee Agent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: finishingAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      runtimeMode: "legacy",
      startedAt: new Date(),
      contextSnapshot: { issueId },
      responsibleUserId: "responsible-user",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Continue past a missing deferred agent",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: validAgentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionRunId: runId,
    });

    const missingAgentWakeId = randomUUID();
    // The agent_id foreign key always holds in the running system, so a wake row
    // can never outlive its agent through the application. Bypass the check for
    // this one insert to pin the release code's defensive branch for that state.
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = 'replica'`);
      await tx.insert(agentWakeupRequests).values({
        id: missingAgentWakeId,
        companyId,
        agentId: missingAgentId,
        source: "automation",
        reason: "issue_commented",
        status: "deferred_issue_execution",
        requestedByActorType: "system",
        requestedByActorId: "test",
        requestedAt: new Date("2026-08-22T15:00:00.000Z"),
        payload: { issueId },
      });
    });

    const validWakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: validWakeId,
      companyId,
      agentId: validAgentId,
      source: "automation",
      reason: "issue_commented",
      status: "deferred_issue_execution",
      requestedByActorType: "system",
      requestedByActorId: "test",
      requestedAt: new Date("2026-08-22T15:01:00.000Z"),
      payload: { issueId },
    });

    // A plain legacy cancel now stops promotion early for board reconciliation
    // (see legacyExecutionNeedsReconciliation in legacy-execution-recovery.ts).
    // Cancel as an in-flight workspace wait instead. That shape still reaches
    // the deferred-wake promotion loop under test.
    await heartbeat.cancelRun(runId, undefined, {
      errorCode: "workspace_busy",
      resultJson: {
        executionRecovery: { kind: "workspace_wait", providerWorkStarted: false },
      },
    });

    const [missingAgentWake, validWake, issueRow] = await Promise.all([
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, missingAgentWakeId)).then((rows) => rows[0]),
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, validWakeId)).then((rows) => rows[0]),
      db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]),
    ]);

    expect(missingAgentWake).toMatchObject({
      status: "failed",
      error: "Deferred wake could not be promoted: agent is not invokable",
    });
    // The promotion writes "queued", then releaseIssueExecutionAndPromote
    // immediately calls startNextQueuedRunForAgent for the idle promoted
    // agent, which claims the run in the same call. Assert the settled
    // state, not the intermediate one.
    expect(validWake?.status).toBe("claimed");
    expect(validWake?.runId).not.toBeNull();
    expect(issueRow?.executionRunId).toBe(validWake?.runId);
  });

  it("fails a deferred wake with the same status and error text when its agent belongs to another company", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const finishingAgentId = randomUUID();
    const crossCompanyAgentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const otherIssuePrefix = `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Paperclip",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      },
      {
        id: otherCompanyId,
        name: "Other Paperclip",
        issuePrefix: otherIssuePrefix,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(agents).values([
      {
        id: finishingAgentId,
        companyId,
        name: "Finishing Agent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: crossCompanyAgentId,
        companyId: otherCompanyId,
        name: "Other Company Agent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: finishingAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      runtimeMode: "legacy",
      startedAt: new Date(),
      contextSnapshot: { issueId },
      responsibleUserId: "responsible-user",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cross-company deferred agent",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: finishingAgentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionRunId: runId,
    });
    const wakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId,
      agentId: crossCompanyAgentId,
      source: "automation",
      reason: "issue_commented",
      status: "deferred_issue_execution",
      requestedByActorType: "system",
      requestedByActorId: "test",
      payload: { issueId },
    });

    // A plain legacy cancel now stops promotion early for board reconciliation
    // (see legacyExecutionNeedsReconciliation in legacy-execution-recovery.ts).
    // Cancel as an in-flight workspace wait instead. That shape still reaches
    // the deferred-wake promotion loop under test.
    await heartbeat.cancelRun(runId, undefined, {
      errorCode: "workspace_busy",
      resultJson: {
        executionRecovery: { kind: "workspace_wait", providerWorkStarted: false },
      },
    });

    const wake = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)).then((rows) => rows[0]);
    expect(wake).toMatchObject({
      status: "failed",
      error: "Deferred wake could not be promoted: agent is not invokable",
    });
  });

  it("cancels a deferred wake under an active pause hold, but promotes a verified hold interaction with the hold context", async () => {
    const companyId = randomUUID();
    const finishingAgentId = randomUUID();
    const holdAgentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    // Pin scheduling suppression off with the runtimeEnv test seam. Do not rely
    // on the ambient PAPERCLIP_IN_WORKTREE value: startNextQueuedRunForAgent
    // no-ops under suppression and would leave the promoted wake at "queued".
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values([
      {
        id: finishingAgentId,
        companyId,
        name: "Finishing Agent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: holdAgentId,
        companyId,
        name: "Hold Interaction Agent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: finishingAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      runtimeMode: "legacy",
      startedAt: new Date(),
      contextSnapshot: { issueId },
      responsibleUserId: "responsible-user",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "A pause hold gates a plain wake but not a verified one",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: holdAgentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionRunId: runId,
    });
    const [hold] = await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId: issueId,
      mode: "pause",
      status: "active",
      reason: "Investigating a regression",
    }).returning();

    const plainWakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: plainWakeId,
      companyId,
      agentId: finishingAgentId,
      source: "automation",
      reason: "issue_commented",
      status: "deferred_issue_execution",
      requestedByActorType: "system",
      requestedByActorId: "test",
      requestedAt: new Date("2026-08-22T15:00:00.000Z"),
      payload: { issueId },
    });

    const holdComment = await db.insert(issueComments).values({
      companyId,
      issueId,
      authorUserId: "hold-user",
      body: "Please continue despite the hold",
    }).returning().then((rows) => rows[0]!);
    const verifiedWakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: verifiedWakeId,
      companyId,
      agentId: holdAgentId,
      source: "issue_comment",
      reason: "issue_commented",
      status: "deferred_issue_execution",
      requestedByActorType: "user",
      requestedByActorId: "hold-user",
      requestedAt: new Date("2026-08-22T15:01:00.000Z"),
      payload: {
        issueId,
        commentId: holdComment.id,
        _paperclipWakeContext: {
          wakeReason: "issue_commented",
          source: "issue.comment",
          wakeCommentIds: [holdComment.id],
        },
      },
    });

    // A plain legacy cancel now stops promotion early for board reconciliation
    // (see legacyExecutionNeedsReconciliation in legacy-execution-recovery.ts).
    // Cancel as an in-flight workspace wait instead. That shape still reaches
    // the deferred-wake promotion loop under test.
    await heartbeat.cancelRun(runId, undefined, {
      errorCode: "workspace_busy",
      resultJson: {
        executionRecovery: { kind: "workspace_wait", providerWorkStarted: false },
      },
    });

    const [plainWake, verifiedWake] = await Promise.all([
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, plainWakeId)).then((rows) => rows[0]),
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, verifiedWakeId)).then((rows) => rows[0]),
    ]);
    expect(plainWake).toMatchObject({
      status: "cancelled",
      error: "Deferred wake suppressed by active subtree pause hold",
    });
    // Same settle-then-assert reasoning as the missing-agent test above:
    // the idle promoted agent's run is claimed synchronously.
    expect(verifiedWake?.status).toBe("claimed");
    const promotedRun = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, verifiedWake!.runId!))
      .then((rows) => rows[0]);
    expect(promotedRun?.contextSnapshot).toMatchObject({
      treeHoldInteraction: true,
      activeTreeHold: {
        holdId: hold!.id,
        rootIssueId: issueId,
        mode: "pause",
        reason: "Investigating a regression",
        interaction: true,
      },
    });
  });

  it("rolls back the wake row, the run row, and the issue lock together when the responsible user cannot resolve", async () => {
    const companyId = randomUUID();
    const finishingAgentId = randomUUID();
    const deferredAgentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      // No defaultResponsibleUserId: the company default must not resolve this wake.
    });
    await db.insert(agents).values([
      {
        id: finishingAgentId,
        companyId,
        name: "Finishing Agent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: deferredAgentId,
        companyId,
        name: "Deferred Agent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: finishingAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      runtimeMode: "legacy",
      startedAt: new Date(),
      contextSnapshot: { issueId },
      // No responsibleUserId: the finishing run itself must not resolve this wake.
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "No responsible user can be resolved",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: deferredAgentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionRunId: runId,
      // No responsibleUserId: the issue itself must not resolve this wake.
    });
    const wakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId,
      agentId: deferredAgentId,
      source: "automation",
      reason: "issue_commented",
      status: "deferred_issue_execution",
      requestedByActorType: "system",
      requestedByActorId: "test",
      payload: { issueId },
    });

    // A plain legacy cancel now stops promotion early for board reconciliation
    // (see legacyExecutionNeedsReconciliation in legacy-execution-recovery.ts).
    // Cancel as an in-flight workspace wait instead. That shape still reaches
    // the deferred-wake promotion loop under test.
    await expect(
      heartbeat.cancelRun(runId, undefined, {
        errorCode: "workspace_busy",
        resultJson: {
          executionRecovery: { kind: "workspace_wait", providerWorkStarted: false },
        },
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({ code: "responsible_user_unresolved" }),
    });

    const [wake, issueRow, runs] = await Promise.all([
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)).then((rows) => rows[0]),
      db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]),
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)),
    ]);
    expect(wake?.status).toBe("deferred_issue_execution");
    expect(issueRow?.executionRunId).toBe(runId);
    expect(runs).toHaveLength(1);
  });
});
