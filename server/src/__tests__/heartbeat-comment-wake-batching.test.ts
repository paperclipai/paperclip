import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { and, asc, eq } from "drizzle-orm";
import { WebSocketServer } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.ts";
import { SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY } from "../services/recovery/index.ts";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.ts";

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

describe("heartbeat comment wake batching", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-comment-wake-");
    db = createDb(started.connectionString);
    tempDb = started;
  }, 120_000);

  afterAll(async () => {
    await closeDbClient(db);
    await tempDb?.cleanup();
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

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Hire an agent",
      status: "blocked",
      priority: "medium",
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
    expect((deferred?.payload as Record<string, unknown>)._paperclipWakeContext).toMatchObject({
      issueId,
      taskId: issueId,
      approvalId: "approval-1",
      approvalStatus: "approved",
      wakeReason: "approval_approved",
    });

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
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

      await waitFor(() => gateway.getAgentPayloads().length === 2);
      await waitFor(async () => {
        const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
        return runs.length === 2 && runs.every((run) => run.status === "succeeded");
      }, 90_000);

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
  }, 120_000);

  it("promotes deferred comment wakes with their comments after the active run is cancelled", async () => {
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
                  { type: "key_value", label: "Cause", value: "successful_run_missing_state" },
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

      await waitFor(() => gateway.getAgentPayloads().length === 2);
      const promotedPayload = gateway.getAgentPayloads()[1] ?? {};
      expect(promotedPayload.paperclip).toMatchObject({
        wake: {
          commentIds: [queuedComment.id],
          latestCommentId: queuedComment.id,
          comments: [
            expect.objectContaining({
              id: queuedComment.id,
              authorType: "user",
              body: "Queued follow-up",
              presentation: expect.objectContaining({
                kind: "system_notice",
                tone: "warning",
              }),
              metadata: expect.objectContaining({
                version: 1,
              }),
            }),
          ],
          commentWindow: {
            requestedCount: 1,
            includedCount: 1,
            missingCount: 0,
          },
        },
      });
      expect(String(promotedPayload.message ?? "")).toContain("Queued follow-up");

      gateway.releaseFirstWait();
      await waitFor(async () => {
        const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
        return runs.length === 2 && runs.every((run) => ["cancelled", "succeeded"].includes(run.status));
      }, 90_000);
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
          .where(eq(heartbeatRuns.agentId, agentId));
        return runs.length === 2 && runs.every((run) => run.status === "succeeded");
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
      expect(secondPayload.paperclip).toMatchObject({
        wake: {
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
        },
      });
      expect(String(secondPayload.message ?? "")).toContain("Please handle this follow-up after you finish");
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
        return runs.length === 2 && runs.every((run) => run.status === "succeeded");
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
      expect(secondPayload.paperclip).toMatchObject({
        wake: {
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
        },
      });
      expect(String(secondPayload.message ?? "")).toContain("please review after I finish");
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
      const firstPayload = gateway.getAgentPayloads()[0] ?? {};
      expect(firstPayload.paperclip).toMatchObject({
        wake: {
          reason: "issue_assigned",
          issue: {
            id: issueId,
            identifier: `${issuePrefix}-1`,
            title: "Require a comment",
            status: "in_progress",
            priority: "medium",
          },
          checkedOutByHarness: true,
          commentIds: [],
        },
      });
      expect(String(firstPayload.message ?? "")).toContain("## Paperclip Wake Payload");
      expect(String(firstPayload.message ?? "")).toContain("Do not switch to another issue until you have handled this wake.");
      expect(String(firstPayload.message ?? "")).toContain("- checkout: already claimed by the harness for this run");
      expect(String(firstPayload.message ?? "")).toContain(
        "The harness already checked out this issue for the current run.",
      );
      expect(String(firstPayload.message ?? "")).toContain(`${issuePrefix}-1 Require a comment`);
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
          .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)));
        return wakeups.length >= 2;
      });

      const payloads = gateway.getAgentPayloads();
      expect(payloads).toHaveLength(2);
      expect(runs[1]?.contextSnapshot).toMatchObject({
        retryReason: "missing_issue_comment",
        modelProfile: "cheap",
      });
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
      expect(issueAfterMention?.executionAgentNameKey).not.toBe("mentioned agent");

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
      expect(missingCommentRetries[0]?.payload).toMatchObject({ modelProfile: "cheap" });
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
        return sourceRun?.status === "succeeded" && sourceRun.issueCommentStatus === "satisfied";
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
          .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)));

        const hasHandoffComment = comments.some((comment) =>
          comment.body === SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY
        );
        const hasHandoffWake = wakeups.some((wakeup) => wakeup.reason === "finish_successful_run_handoff");
        return hasHandoffComment && hasHandoffWake;
      });

      const comments = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId))
        .orderBy(asc(issueComments.createdAt));

      expect(comments.some((comment) => comment.body === "Manual completion comment from the run.")).toBe(true);
      expect(comments.some((comment) =>
        comment.body === SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY
      )).toBe(true);
      expect(comments.every((comment) => !comment.body.startsWith("## Run summary"))).toBe(true);

      const wakeups = await db
        .select()
        .from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)));

      expect(wakeups.some((wakeup) => wakeup.reason === "missing_issue_comment")).toBe(false);
      expect(wakeups.some((wakeup) => wakeup.reason === "finish_successful_run_handoff")).toBe(true);
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 20_000);
});
