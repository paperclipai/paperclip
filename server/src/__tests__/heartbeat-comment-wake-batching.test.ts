import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { and, asc, eq, sql } from "drizzle-orm";
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
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import { runningProcesses } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY } from "../services/recovery/index.ts";
import { LOW_TRUST_QUARANTINED_BODY } from "../services/source-trust.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.ts";
import { parseWakePayloadFromMessage } from "./helpers/wake-message.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat comment wake batching tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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

describeEmbeddedPostgres("heartbeat comment wake batching", () => {
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

      const deferredContext = (deferredWake?.payload as Record<string, unknown> | null)?._paperclipWakeContext as
        | Record<string, unknown>
        | undefined;
      expect(deferredContext?.wakeCommentIds).toEqual([comment2.id, comment3.id]);

      gateway.releaseFirstWait();

      await waitFor(() => gateway.getAgentPayloads().length === 2);
      const secondPayload = gateway.getAgentPayloads()[1] ?? {};
      const secondRunId = typeof secondPayload.idempotencyKey === "string" ? secondPayload.idempotencyKey : null;
      if (!secondRunId) {
        throw new Error("Expected forwarded gateway payload to include an idempotencyKey run id");
      }

      await waitFor(async () => {
        const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
        const statusesByRunId = new Map(runs.map((run) => [run.id, run.status]));
        return statusesByRunId.get(firstRun!.id) === "succeeded" && statusesByRunId.get(secondRunId) === "succeeded";
      }, 90_000);

      expect(secondPayload.paperclip).toBeUndefined();
      const secondWake = parseWakePayloadFromMessage(secondPayload.message);
      expect(secondWake).toMatchObject({
        commentIds: [comment2.id, comment3.id],
        latestCommentId: comment3.id,
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
      expect(promotedPayload.paperclip).toBeUndefined();
      const promotedWake = parseWakePayloadFromMessage(promotedPayload.message);
      expect(promotedWake).toMatchObject({
        commentIds: [queuedComment.id],
        latestCommentId: queuedComment.id,
        requestedCount: 1,
        includedCount: 1,
        missingCount: 0,
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
      expect(String(secondPayload.message ?? "")).toContain("please review after I finish");
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 120_000);

  it("does not reopen a finished issue when the deferred comment wake is self-authored by the closing run", async () => {
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

      // The deferred wake still promotes (so the agent gets the message), but
      // the issue must remain `done` because the only referenced comment is
      // self-authored by the run that is now ending.
      await waitFor(() => gateway.getAgentPayloads().length === 2, 90_000);
      await waitFor(async () => {
        const runs = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.agentId, agentId));
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
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 120_000);

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
        commentIds: [selfComment.id, humanComment.id],
        latestCommentId: humanComment.id,
        issue: {
          id: issueId,
          identifier: `${issuePrefix}-1`,
          title: "Human follow-up must survive mixed deferred batches",
          status: "in_progress",
          priority: "medium",
        },
      });
      expect(String(secondPayload.message ?? "")).toContain("Real follow-up from a human after the run closes");
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
      expect(String(firstPayload.message ?? "")).toContain("## Paperclip Wake Payload");
      expect(String(firstPayload.message ?? "")).toContain("Do not switch to another issue until you have handled this wake.");
      expect(String(firstPayload.message ?? "")).toContain("- checkout: already claimed by the harness for this run");
      expect(String(firstPayload.message ?? "")).toContain(
        "The harness already checked out this issue for the current run.",
      );
      expect(String(firstPayload.message ?? "")).toContain(`${issuePrefix}-1 Require a comment`);
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

  it("promotes a deferred wake parked on a sibling issue that the finalizing run held", async () => {
    const gateway = await createControlledGatewayServer();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const primaryIssueId = randomUUID();
    const siblingIssueId = randomUUID();
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

      await db.insert(issues).values([
        {
          id: primaryIssueId,
          companyId,
          title: "Primary issue",
          status: "todo",
          priority: "medium",
          responsibleUserId: "responsible-user",
          assigneeAgentId: agentId,
          issueNumber: 1,
          identifier: `${issuePrefix}-1`,
        },
        {
          id: siblingIssueId,
          companyId,
          title: "Sibling issue with a parked wake",
          status: "in_progress",
          priority: "medium",
          responsibleUserId: "responsible-user",
          assigneeAgentId: agentId,
          issueNumber: 2,
          identifier: `${issuePrefix}-2`,
        },
      ]);

      const primaryComment = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId: primaryIssueId,
          authorUserId: "user-1",
          body: "Start primary work",
        })
        .returning()
        .then((rows) => rows[0]);
      const firstRun = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId: primaryIssueId, commentId: primaryComment.id },
        contextSnapshot: {
          issueId: primaryIssueId,
          taskId: primaryIssueId,
          commentId: primaryComment.id,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      });

      expect(firstRun).not.toBeNull();
      await waitFor(() => gateway.getAgentPayloads().length === 1);

      // The finalizing run also holds the sibling issue's execution lock — the
      // shape produced when one run ends up referenced by multiple issues (e.g.
      // enqueueWakeup's legacy-run fallback).
      await db
        .update(issues)
        .set({
          executionRunId: firstRun!.id,
          executionAgentNameKey: "gateway agent",
          executionLockedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(issues.id, siblingIssueId));

      const siblingComment = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId: siblingIssueId,
          authorUserId: "user-1",
          body: "Please pick up the sibling issue next",
        })
        .returning()
        .then((rows) => rows[0]);
      const siblingWakeRun = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId: siblingIssueId, commentId: siblingComment.id },
        contextSnapshot: {
          issueId: siblingIssueId,
          taskId: siblingIssueId,
          commentId: siblingComment.id,
          wakeCommentId: siblingComment.id,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      });

      expect(siblingWakeRun).toBeNull();

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

      expect(deferredWake).not.toBeNull();
      expect(deferredWake?.payload).toMatchObject({ issueId: siblingIssueId });

      await heartbeat.cancelRun(firstRun!.id);

      // Finalizing the run must promote the wake parked on the sibling issue,
      // not just wakes parked on the run's context issue.
      const wakeAfterRelease = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, deferredWake!.id))
        .then((rows) => rows[0] ?? null);

      expect(wakeAfterRelease?.reason).toBe("issue_execution_promoted");
      expect(wakeAfterRelease?.status).not.toBe("deferred_issue_execution");
      expect(wakeAfterRelease?.runId).not.toBeNull();

      const promotedRun = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, wakeAfterRelease!.runId!))
        .then((rows) => rows[0] ?? null);

      expect(promotedRun?.agentId).toBe(agentId);
      expect(promotedRun?.contextSnapshot).toMatchObject({ issueId: siblingIssueId });

      await waitFor(() => gateway.getAgentPayloads().length === 2, 90_000);
      await waitFor(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, wakeAfterRelease!.runId!))
          .then((rows) => rows[0] ?? null);
        return run?.status === "succeeded";
      }, 90_000);

      const promotedPayload = gateway.getAgentPayloads()[1] ?? {};
      const promotedWake = parseWakePayloadFromMessage(promotedPayload.message);
      expect(promotedWake).toMatchObject({
        commentIds: [siblingComment.id],
        latestCommentId: siblingComment.id,
        issue: {
          id: siblingIssueId,
          identifier: `${issuePrefix}-2`,
        },
      });
      expect(String(promotedPayload.message ?? "")).toContain("Please pick up the sibling issue next");
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 120_000);

  it("promotes deferred wakes on the context issue and every sibling issue the run held", async () => {
    const gateway = await createControlledGatewayServer();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const primaryIssueId = randomUUID();
    const siblingIssueBId = randomUUID();
    const siblingIssueCId = randomUUID();
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

      await db.insert(issues).values([
        {
          id: primaryIssueId,
          companyId,
          title: "Primary issue",
          status: "todo",
          priority: "medium",
          responsibleUserId: "responsible-user",
          assigneeAgentId: agentId,
          issueNumber: 1,
          identifier: `${issuePrefix}-1`,
        },
        {
          id: siblingIssueBId,
          companyId,
          title: "First sibling issue",
          status: "in_progress",
          priority: "medium",
          responsibleUserId: "responsible-user",
          assigneeAgentId: agentId,
          issueNumber: 2,
          identifier: `${issuePrefix}-2`,
        },
        {
          id: siblingIssueCId,
          companyId,
          title: "Second sibling issue",
          status: "in_progress",
          priority: "medium",
          responsibleUserId: "responsible-user",
          assigneeAgentId: agentId,
          issueNumber: 3,
          identifier: `${issuePrefix}-3`,
        },
      ]);

      const primaryComment = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId: primaryIssueId,
          authorUserId: "user-1",
          body: "Start primary work",
        })
        .returning()
        .then((rows) => rows[0]);
      const firstRun = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId: primaryIssueId, commentId: primaryComment.id },
        contextSnapshot: {
          issueId: primaryIssueId,
          taskId: primaryIssueId,
          commentId: primaryComment.id,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      });

      expect(firstRun).not.toBeNull();
      await waitFor(() => gateway.getAgentPayloads().length === 1);

      // The finalizing run holds the execution lock on both sibling issues in
      // addition to its own context issue.
      await db
        .update(issues)
        .set({
          executionRunId: firstRun!.id,
          executionAgentNameKey: "gateway agent",
          executionLockedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(issues.id, siblingIssueBId));
      await db
        .update(issues)
        .set({
          executionRunId: firstRun!.id,
          executionAgentNameKey: "gateway agent",
          executionLockedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(issues.id, siblingIssueCId));

      // Park one deferred wake on each of the three issues the run holds.
      const issueIdsInWakeOrder = [primaryIssueId, siblingIssueBId, siblingIssueCId];
      for (const issueId of issueIdsInWakeOrder) {
        const comment = await db
          .insert(issueComments)
          .values({
            companyId,
            issueId,
            authorUserId: "user-1",
            body: `Follow-up for ${issueId}`,
          })
          .returning()
          .then((rows) => rows[0]);
        const deferredRun = await heartbeat.wakeup(agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_commented",
          payload: { issueId, commentId: comment.id },
          contextSnapshot: {
            issueId,
            taskId: issueId,
            commentId: comment.id,
            wakeCommentId: comment.id,
            wakeReason: "issue_commented",
          },
          requestedByActorType: "user",
          requestedByActorId: "user-1",
        });
        expect(deferredRun).toBeNull();
      }

      const deferredWakes = await db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.agentId, agentId),
            eq(agentWakeupRequests.status, "deferred_issue_execution"),
          ),
        )
        .orderBy(asc(agentWakeupRequests.requestedAt));

      expect(deferredWakes).toHaveLength(3);
      const wakeIdByIssueId = new Map(
        deferredWakes.map((wake) => [
          (wake.payload as Record<string, unknown>).issueId as string,
          wake.id,
        ]),
      );
      expect([...wakeIdByIssueId.keys()].sort()).toEqual([...issueIdsInWakeOrder].sort());

      await heartbeat.cancelRun(firstRun!.id);

      // Every parked wake must promote in the same finalization: the primary
      // promotion must not skip the sibling drain, and the sibling drain must
      // not stop at its first promotion.
      const promotedRunIdByIssueId = new Map<string, string>();
      for (const issueId of issueIdsInWakeOrder) {
        const wakeAfterRelease = await db
          .select()
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, wakeIdByIssueId.get(issueId)!))
          .then((rows) => rows[0] ?? null);

        expect(wakeAfterRelease?.reason).toBe("issue_execution_promoted");
        expect(wakeAfterRelease?.status).not.toBe("deferred_issue_execution");
        expect(wakeAfterRelease?.runId).not.toBeNull();

        const promotedRun = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, wakeAfterRelease!.runId!))
          .then((rows) => rows[0] ?? null);
        expect(promotedRun?.agentId).toBe(agentId);
        expect(promotedRun?.contextSnapshot).toMatchObject({ issueId });
        promotedRunIdByIssueId.set(issueId, wakeAfterRelease!.runId!);
      }

      await waitFor(async () => {
        const runs = await db
          .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.agentId, agentId));
        const statusesByRunId = new Map(runs.map((run) => [run.id, run.status]));
        return issueIdsInWakeOrder.every(
          (issueId) => statusesByRunId.get(promotedRunIdByIssueId.get(issueId)!) === "succeeded",
        );
      }, 90_000);
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 120_000);

  it("promotes sibling deferred wakes when a workspace-validation failure parks the primary issue blocked", async () => {
    const gateway = await createControlledGatewayServer();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const primaryIssueId = randomUUID();
    const siblingIssueId = randomUUID();
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

      await db.insert(issues).values([
        {
          id: primaryIssueId,
          companyId,
          title: "Primary issue with failing workspace",
          status: "todo",
          priority: "medium",
          responsibleUserId: "responsible-user",
          assigneeAgentId: agentId,
          issueNumber: 1,
          identifier: `${issuePrefix}-1`,
        },
        {
          id: siblingIssueId,
          companyId,
          title: "Sibling issue parked behind the failing run",
          status: "in_progress",
          priority: "medium",
          responsibleUserId: "responsible-user",
          assigneeAgentId: agentId,
          issueNumber: 2,
          identifier: `${issuePrefix}-2`,
        },
      ]);

      const primaryComment = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId: primaryIssueId,
          authorUserId: "user-1",
          body: "Start primary work",
        })
        .returning()
        .then((rows) => rows[0]);
      const firstRun = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId: primaryIssueId, commentId: primaryComment.id },
        contextSnapshot: {
          issueId: primaryIssueId,
          taskId: primaryIssueId,
          commentId: primaryComment.id,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      });

      expect(firstRun).not.toBeNull();
      await waitFor(() => gateway.getAgentPayloads().length === 1);

      await db
        .update(issues)
        .set({
          executionRunId: firstRun!.id,
          executionAgentNameKey: "gateway agent",
          executionLockedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(issues.id, siblingIssueId));

      // Park one wake on the primary issue (must stay parked: the recovery flow
      // owns that issue) and one on the sibling (must promote).
      const primaryFollowupComment = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId: primaryIssueId,
          authorUserId: "user-1",
          body: "Primary follow-up parked behind the running lock",
        })
        .returning()
        .then((rows) => rows[0]);
      const primaryDeferredRun = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId: primaryIssueId, commentId: primaryFollowupComment.id },
        contextSnapshot: {
          issueId: primaryIssueId,
          taskId: primaryIssueId,
          commentId: primaryFollowupComment.id,
          wakeCommentId: primaryFollowupComment.id,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      });
      expect(primaryDeferredRun).toBeNull();

      const siblingComment = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId: siblingIssueId,
          authorUserId: "user-1",
          body: "Sibling follow-up parked behind the failing run",
        })
        .returning()
        .then((rows) => rows[0]);
      const siblingWakeRun = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId: siblingIssueId, commentId: siblingComment.id },
        contextSnapshot: {
          issueId: siblingIssueId,
          taskId: siblingIssueId,
          commentId: siblingComment.id,
          wakeCommentId: siblingComment.id,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      });
      expect(siblingWakeRun).toBeNull();

      const deferredWakes = await db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.agentId, agentId),
            eq(agentWakeupRequests.status, "deferred_issue_execution"),
          ),
        )
        .orderBy(asc(agentWakeupRequests.requestedAt));
      expect(deferredWakes).toHaveLength(2);
      const primaryWake = deferredWakes.find(
        (wake) => (wake.payload as Record<string, unknown>).issueId === primaryIssueId,
      );
      const siblingWake = deferredWakes.find(
        (wake) => (wake.payload as Record<string, unknown>).issueId === siblingIssueId,
      );
      expect(primaryWake).not.toBeNull();
      expect(siblingWake).not.toBeNull();

      // Finalize the run as a workspace-validation failure, which routes the
      // primary issue into the blocked-recovery branch.
      await heartbeat.cancelRun(
        firstRun!.id,
        "workspace validation failed before dispatch",
        { errorCode: "workspace_validation_failed" },
      );

      // The sibling's parked wake must promote even though the primary issue
      // took the blocked-recovery return.
      const siblingWakeAfterRelease = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, siblingWake!.id))
        .then((rows) => rows[0] ?? null);
      expect(siblingWakeAfterRelease?.reason).toBe("issue_execution_promoted");
      expect(siblingWakeAfterRelease?.status).not.toBe("deferred_issue_execution");
      expect(siblingWakeAfterRelease?.runId).not.toBeNull();

      const promotedRun = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, siblingWakeAfterRelease!.runId!))
        .then((rows) => rows[0] ?? null);
      expect(promotedRun?.agentId).toBe(agentId);
      expect(promotedRun?.contextSnapshot).toMatchObject({ issueId: siblingIssueId });

      // The primary issue still gets the blocked-recovery treatment. Its own
      // parked wake is NOT promoted (that would race the recovery flow that
      // now owns this issue's lifecycle) but must not be left dangling in
      // `deferred_issue_execution` either, since nothing else ever transitions
      // that status — it is explicitly terminalized as failed instead.
      const primaryAfterRelease = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, primaryIssueId))
        .then((rows) => rows[0] ?? null);
      expect(primaryAfterRelease?.status).toBe("blocked");

      const primaryComments = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, primaryIssueId));
      expect(
        primaryComments.some((comment) => comment.body.includes("issue workspace failed validation")),
      ).toBe(true);

      const primaryWakeAfterRelease = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, primaryWake!.id))
        .then((rows) => rows[0] ?? null);
      expect(primaryWakeAfterRelease?.status).toBe("failed");
      expect(primaryWakeAfterRelease?.status).not.toBe("deferred_issue_execution");
      expect(primaryWakeAfterRelease?.finishedAt).not.toBeNull();
      expect(primaryWakeAfterRelease?.error).toBeTruthy();

      await waitFor(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, siblingWakeAfterRelease!.runId!))
          .then((rows) => rows[0] ?? null);
        return run?.status === "succeeded";
      }, 90_000);
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 120_000);

  it("terminalizes the primary issue's own deferred wake instead of stranding it when workspace validation fails", async () => {
    const gateway = await createControlledGatewayServer();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const primaryIssueId = randomUUID();
    const siblingIssueId = randomUUID();
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

      // A sibling issue is included (held by the same run) purely as a
      // regression guard: its wake must still promote normally in the same
      // finalization that terminalizes the primary issue's own wake.
      await db.insert(issues).values([
        {
          id: primaryIssueId,
          companyId,
          title: "Primary issue with only its own parked wake",
          status: "todo",
          priority: "medium",
          responsibleUserId: "responsible-user",
          assigneeAgentId: agentId,
          issueNumber: 1,
          identifier: `${issuePrefix}-1`,
        },
        {
          id: siblingIssueId,
          companyId,
          title: "Sibling issue that must still promote",
          status: "in_progress",
          priority: "medium",
          responsibleUserId: "responsible-user",
          assigneeAgentId: agentId,
          issueNumber: 2,
          identifier: `${issuePrefix}-2`,
        },
      ]);

      const primaryComment = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId: primaryIssueId,
          authorUserId: "user-1",
          body: "Start primary work",
        })
        .returning()
        .then((rows) => rows[0]);
      const firstRun = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId: primaryIssueId, commentId: primaryComment.id },
        contextSnapshot: {
          issueId: primaryIssueId,
          taskId: primaryIssueId,
          commentId: primaryComment.id,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      });

      expect(firstRun).not.toBeNull();
      await waitFor(() => gateway.getAgentPayloads().length === 1);

      await db
        .update(issues)
        .set({
          executionRunId: firstRun!.id,
          executionAgentNameKey: "gateway agent",
          executionLockedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(issues.id, siblingIssueId));

      const primaryFollowupComment = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId: primaryIssueId,
          authorUserId: "user-1",
          body: "Primary follow-up parked on its own issue",
        })
        .returning()
        .then((rows) => rows[0]);
      const primaryDeferredRun = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId: primaryIssueId, commentId: primaryFollowupComment.id },
        contextSnapshot: {
          issueId: primaryIssueId,
          taskId: primaryIssueId,
          commentId: primaryFollowupComment.id,
          wakeCommentId: primaryFollowupComment.id,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      });
      expect(primaryDeferredRun).toBeNull();

      const siblingComment = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId: siblingIssueId,
          authorUserId: "user-1",
          body: "Sibling follow-up must still promote",
        })
        .returning()
        .then((rows) => rows[0]);
      const siblingWakeRun = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId: siblingIssueId, commentId: siblingComment.id },
        contextSnapshot: {
          issueId: siblingIssueId,
          taskId: siblingIssueId,
          commentId: siblingComment.id,
          wakeCommentId: siblingComment.id,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      });
      expect(siblingWakeRun).toBeNull();

      const deferredWakes = await db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.agentId, agentId),
            eq(agentWakeupRequests.status, "deferred_issue_execution"),
          ),
        )
        .orderBy(asc(agentWakeupRequests.requestedAt));
      expect(deferredWakes).toHaveLength(2);
      const primaryWake = deferredWakes.find(
        (wake) => (wake.payload as Record<string, unknown>).issueId === primaryIssueId,
      );
      const siblingWake = deferredWakes.find(
        (wake) => (wake.payload as Record<string, unknown>).issueId === siblingIssueId,
      );
      expect(primaryWake).not.toBeNull();
      expect(siblingWake).not.toBeNull();

      await heartbeat.cancelRun(
        firstRun!.id,
        "workspace validation failed before dispatch",
        { errorCode: "workspace_validation_failed" },
      );

      // The primary issue's own wake must transition to `failed` with a
      // non-empty error, not sit stranded in `deferred_issue_execution`.
      const primaryWakeAfterRelease = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, primaryWake!.id))
        .then((rows) => rows[0] ?? null);
      expect(primaryWakeAfterRelease?.status).toBe("failed");
      expect(primaryWakeAfterRelease?.status).not.toBe("deferred_issue_execution");
      expect(primaryWakeAfterRelease?.finishedAt).not.toBeNull();
      expect(primaryWakeAfterRelease?.error).toBeTruthy();
      expect(primaryWakeAfterRelease?.error).toContain("Stranded by workspace/configuration validation failure");
      // The primary issue's own wake must never be promoted — that would race
      // the recovery flow that now owns this issue's lifecycle.
      expect(primaryWakeAfterRelease?.reason).not.toBe("issue_execution_promoted");
      expect(primaryWakeAfterRelease?.runId).toBeNull();

      // The primary issue still gets the blocked-recovery treatment exactly
      // as before this fix.
      const primaryAfterRelease = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, primaryIssueId))
        .then((rows) => rows[0] ?? null);
      expect(primaryAfterRelease?.status).toBe("blocked");

      const primaryComments = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, primaryIssueId));
      expect(
        primaryComments.some((comment) => comment.body.includes("issue workspace failed validation")),
      ).toBe(true);

      // Regression guard: the sibling's deferred wake in the same
      // finalization must still promote normally.
      const siblingWakeAfterRelease = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, siblingWake!.id))
        .then((rows) => rows[0] ?? null);
      expect(siblingWakeAfterRelease?.reason).toBe("issue_execution_promoted");
      expect(siblingWakeAfterRelease?.status).not.toBe("deferred_issue_execution");
      expect(siblingWakeAfterRelease?.runId).not.toBeNull();

      const promotedRun = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, siblingWakeAfterRelease!.runId!))
        .then((rows) => rows[0] ?? null);
      expect(promotedRun?.agentId).toBe(agentId);
      expect(promotedRun?.contextSnapshot).toMatchObject({ issueId: siblingIssueId });

      await waitFor(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, siblingWakeAfterRelease!.runId!))
          .then((rows) => rows[0] ?? null);
        return run?.status === "succeeded";
      }, 90_000);
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 120_000);

  it("quotes the pending comment content in the blocked-recovery comment when workspace validation fails", async () => {
    const gateway = await createControlledGatewayServer();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const primaryIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);
    const strandedFeedbackBody =
      "Founder rejected this: the pricing copy on the landing page still says $99 instead of $79 — please fix before shipping.";

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
        id: primaryIssueId,
        companyId,
        title: "Primary issue with a real pending comment",
        status: "todo",
        priority: "medium",
        responsibleUserId: "responsible-user",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });

      const primaryComment = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId: primaryIssueId,
          authorUserId: "user-1",
          body: "Start primary work",
        })
        .returning()
        .then((rows) => rows[0]);
      const firstRun = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId: primaryIssueId, commentId: primaryComment.id },
        contextSnapshot: {
          issueId: primaryIssueId,
          taskId: primaryIssueId,
          commentId: primaryComment.id,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      });

      expect(firstRun).not.toBeNull();
      await waitFor(() => gateway.getAgentPayloads().length === 1);

      // The stranded comment carries real, distinctive content — the thing a
      // human would otherwise have to reconstruct from scratch (BRO-1501).
      const strandedFeedbackComment = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId: primaryIssueId,
          authorUserId: "founder-user",
          body: strandedFeedbackBody,
        })
        .returning()
        .then((rows) => rows[0]);
      const strandedDeferredRun = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId: primaryIssueId, commentId: strandedFeedbackComment.id },
        contextSnapshot: {
          issueId: primaryIssueId,
          taskId: primaryIssueId,
          commentId: strandedFeedbackComment.id,
          wakeCommentId: strandedFeedbackComment.id,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "user",
        requestedByActorId: "founder-user",
      });
      expect(strandedDeferredRun).toBeNull();

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
      expect(deferredWake).not.toBeNull();
      expect(deferredWake?.payload).toMatchObject({ issueId: primaryIssueId });

      // Finalize the run as a workspace-validation failure, which routes the
      // primary issue into the blocked-recovery branch and fails out its own
      // pending deferred wake (round 3's fix).
      await heartbeat.cancelRun(
        firstRun!.id,
        "workspace validation failed before dispatch",
        { errorCode: "workspace_validation_failed" },
      );

      // Round 3's behavior must still hold: the wake is terminalized, not
      // left stranded in `deferred_issue_execution`.
      const wakeAfterRelease = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, deferredWake!.id))
        .then((rows) => rows[0] ?? null);
      expect(wakeAfterRelease?.status).toBe("failed");
      expect(wakeAfterRelease?.status).not.toBe("deferred_issue_execution");
      expect(wakeAfterRelease?.finishedAt).not.toBeNull();
      expect(wakeAfterRelease?.error).toBeTruthy();

      // Round 4: the blocked-recovery comment must quote the actual content
      // of the stranded comment, not just the generic explanation.
      const primaryAfterRelease = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, primaryIssueId))
        .then((rows) => rows[0] ?? null);
      expect(primaryAfterRelease?.status).toBe("blocked");

      const primaryComments = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, primaryIssueId));
      const recoveryComment = primaryComments.find((comment) =>
        comment.body.includes("issue workspace failed validation"),
      );
      expect(recoveryComment).not.toBeUndefined();
      expect(recoveryComment?.body).toContain("Pending feedback that could not be delivered");
      expect(recoveryComment?.body).toContain(strandedFeedbackBody);
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 120_000);

  it("points the recovery wake at the blocked-recovery comment instead of leaving the pending feedback undiscoverable", async () => {
    // Greptile flagged that a workspace-validation recovery wake carries no
    // pending-comment context, so a resumed agent could omit the stranded
    // feedback entirely rather than merely needing to read the thread for
    // it. The content itself was never lost (the previous test proves it's
    // quoted verbatim into a real, permanent comment) -- but nothing pointed
    // the resumed run at that comment. This asserts the recovery wake now
    // carries a direct reference to it.
    const gateway = await createControlledGatewayServer();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const primaryIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);
    const strandedFeedbackBody =
      "Founder rejected this: the pricing copy on the landing page still says $99 instead of $79 — please fix before shipping.";

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
        id: primaryIssueId,
        companyId,
        title: "Primary issue with a real pending comment",
        status: "todo",
        priority: "medium",
        responsibleUserId: "responsible-user",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });

      const primaryComment = await db
        .insert(issueComments)
        .values({ companyId, issueId: primaryIssueId, authorUserId: "user-1", body: "Start primary work" })
        .returning()
        .then((rows) => rows[0]);
      const firstRun = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId: primaryIssueId, commentId: primaryComment.id },
        contextSnapshot: {
          issueId: primaryIssueId,
          taskId: primaryIssueId,
          commentId: primaryComment.id,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      });
      expect(firstRun).not.toBeNull();
      await waitFor(() => gateway.getAgentPayloads().length === 1);

      const strandedFeedbackComment = await db
        .insert(issueComments)
        .values({ companyId, issueId: primaryIssueId, authorUserId: "founder-user", body: strandedFeedbackBody })
        .returning()
        .then((rows) => rows[0]);
      const strandedDeferredRun = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId: primaryIssueId, commentId: strandedFeedbackComment.id },
        contextSnapshot: {
          issueId: primaryIssueId,
          taskId: primaryIssueId,
          commentId: strandedFeedbackComment.id,
          wakeCommentId: strandedFeedbackComment.id,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "user",
        requestedByActorId: "founder-user",
      });
      expect(strandedDeferredRun).toBeNull();

      await heartbeat.cancelRun(
        firstRun!.id,
        "workspace validation failed before dispatch",
        { errorCode: "workspace_validation_failed" },
      );

      const primaryAfterRelease = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, primaryIssueId))
        .then((rows) => rows[0] ?? null);
      expect(primaryAfterRelease?.status).toBe("blocked");

      const primaryComments = await db
        .select({ id: issueComments.id, body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, primaryIssueId));
      const recoveryComment = primaryComments.find((comment) =>
        comment.body.includes("issue workspace failed validation"),
      );
      expect(recoveryComment).not.toBeUndefined();
      expect(recoveryComment?.body).toContain(strandedFeedbackBody);

      const recoveryWake = await db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.reason, "source_scoped_recovery_action"),
            sql`${agentWakeupRequests.payload} ->> 'issueId' = ${primaryIssueId}`,
          ),
        )
        .then((rows) => rows[0] ?? null);
      expect(recoveryWake).not.toBeNull();
      // agent_wakeup_requests only persists `payload`, not `contextSnapshot`
      // (that gets folded into the run's own contextSnapshot once claimed) --
      // payload.commentId is the same field deriveCommentId() falls back to,
      // and is what confirms the reference actually reached the queued wake.
      expect(recoveryWake?.payload).toMatchObject({ commentId: recoveryComment!.id });
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 120_000);

  it("redacts a quarantined stranded comment's body instead of quoting it verbatim in the blocked-recovery comment", async () => {
    const gateway = await createControlledGatewayServer();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const primaryIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);
    const quarantinedFeedbackBody =
      "This body must never reach the recovery comment verbatim — it is quarantined low-trust output.";

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
        id: primaryIssueId,
        companyId,
        title: "Primary issue with a quarantined pending comment",
        status: "todo",
        priority: "medium",
        responsibleUserId: "responsible-user",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });

      const primaryComment = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId: primaryIssueId,
          authorUserId: "user-1",
          body: "Start primary work",
        })
        .returning()
        .then((rows) => rows[0]);
      const firstRun = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId: primaryIssueId, commentId: primaryComment.id },
        contextSnapshot: {
          issueId: primaryIssueId,
          taskId: primaryIssueId,
          commentId: primaryComment.id,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      });

      expect(firstRun).not.toBeNull();
      await waitFor(() => gateway.getAgentPayloads().length === 1);

      const quarantinedComment = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId: primaryIssueId,
          authorAgentId: agentId,
          body: quarantinedFeedbackBody,
          sourceTrust: {
            preset: LOW_TRUST_REVIEW_PRESET,
            disposition: "quarantined",
            sourceIssueId: primaryIssueId,
          },
        })
        .returning()
        .then((rows) => rows[0]);
      const quarantinedDeferredRun = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId: primaryIssueId, commentId: quarantinedComment.id },
        contextSnapshot: {
          issueId: primaryIssueId,
          taskId: primaryIssueId,
          commentId: quarantinedComment.id,
          wakeCommentId: quarantinedComment.id,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "agent",
        requestedByActorId: agentId,
      });
      expect(quarantinedDeferredRun).toBeNull();

      await heartbeat.cancelRun(
        firstRun!.id,
        "workspace validation failed before dispatch",
        { errorCode: "workspace_validation_failed" },
      );

      const primaryAfterRelease = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, primaryIssueId))
        .then((rows) => rows[0] ?? null);
      expect(primaryAfterRelease?.status).toBe("blocked");

      const primaryComments = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, primaryIssueId));
      const recoveryComment = primaryComments.find((comment) =>
        comment.body.includes("issue workspace failed validation"),
      );
      expect(recoveryComment).not.toBeUndefined();
      // The real quarantined body must never appear, redacted or not.
      expect(recoveryComment?.body).not.toContain(quarantinedFeedbackBody);
      // Mirroring redactQuarantinedBodyForHigherTrust elsewhere in the file:
      // the pending-feedback section still appears, but with the placeholder
      // in place of the real content.
      expect(recoveryComment?.body).toContain("Pending feedback that could not be delivered");
      expect(recoveryComment?.body).toContain(LOW_TRUST_QUARANTINED_BODY);
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 120_000);

  it("excludes a soft-deleted stranded comment from the blocked-recovery comment entirely", async () => {
    const gateway = await createControlledGatewayServer();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const primaryIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);
    const deletedFeedbackBody = "This comment was deleted and must not be resurrected into a new comment.";

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
        id: primaryIssueId,
        companyId,
        title: "Primary issue with a soft-deleted pending comment",
        status: "todo",
        priority: "medium",
        responsibleUserId: "responsible-user",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });

      const primaryComment = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId: primaryIssueId,
          authorUserId: "user-1",
          body: "Start primary work",
        })
        .returning()
        .then((rows) => rows[0]);
      const firstRun = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId: primaryIssueId, commentId: primaryComment.id },
        contextSnapshot: {
          issueId: primaryIssueId,
          taskId: primaryIssueId,
          commentId: primaryComment.id,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      });

      expect(firstRun).not.toBeNull();
      await waitFor(() => gateway.getAgentPayloads().length === 1);

      const deletedComment = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId: primaryIssueId,
          authorUserId: "user-1",
          body: deletedFeedbackBody,
          deletedAt: new Date(),
          deletedByType: "user",
          deletedByUserId: "user-1",
        })
        .returning()
        .then((rows) => rows[0]);
      const deletedDeferredRun = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId: primaryIssueId, commentId: deletedComment.id },
        contextSnapshot: {
          issueId: primaryIssueId,
          taskId: primaryIssueId,
          commentId: deletedComment.id,
          wakeCommentId: deletedComment.id,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      });
      expect(deletedDeferredRun).toBeNull();

      await heartbeat.cancelRun(
        firstRun!.id,
        "workspace validation failed before dispatch",
        { errorCode: "workspace_validation_failed" },
      );

      const primaryAfterRelease = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, primaryIssueId))
        .then((rows) => rows[0] ?? null);
      expect(primaryAfterRelease?.status).toBe("blocked");

      const primaryComments = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, primaryIssueId));
      const recoveryComment = primaryComments.find((comment) =>
        comment.body.includes("issue workspace failed validation"),
      );
      expect(recoveryComment).not.toBeUndefined();
      // A soft-deleted comment is excluded entirely: no placeholder, no
      // pending-feedback section at all, since it was the only stranded
      // comment on this issue.
      expect(recoveryComment?.body).not.toContain(deletedFeedbackBody);
      expect(recoveryComment?.body).not.toContain("Pending feedback that could not be delivered");
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 120_000);

  it("drains sibling deferred wakes when the primary issue execution lock moved to a retry run", async () => {
    const gateway = await createControlledGatewayServer();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const retryAgentId = randomUUID();
    const primaryIssueId = randomUUID();
    const siblingIssueId = randomUUID();
    const retryRunId = randomUUID();
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
        },
        {
          id: retryAgentId,
          companyId,
          name: "Retry Agent",
          role: "engineer",
          status: "idle",
          adapterType: "process",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
        },
      ]);

      await db.insert(issues).values([
        {
          id: primaryIssueId,
          companyId,
          title: "Primary issue repointed to retry",
          status: "todo",
          priority: "medium",
          responsibleUserId: "responsible-user",
          assigneeAgentId: agentId,
          issueNumber: 1,
          identifier: `${issuePrefix}-1`,
        },
        {
          id: siblingIssueId,
          companyId,
          title: "Sibling issue must still drain",
          status: "in_progress",
          priority: "medium",
          responsibleUserId: "responsible-user",
          assigneeAgentId: agentId,
          issueNumber: 2,
          identifier: `${issuePrefix}-2`,
        },
      ]);

      const primaryComment = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId: primaryIssueId,
          authorUserId: "user-1",
          body: "Start primary work",
        })
        .returning()
        .then((rows) => rows[0]);
      const firstRun = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId: primaryIssueId, commentId: primaryComment.id },
        contextSnapshot: {
          issueId: primaryIssueId,
          taskId: primaryIssueId,
          commentId: primaryComment.id,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      });

      expect(firstRun).not.toBeNull();
      await waitFor(() => gateway.getAgentPayloads().length === 1);

      await db
        .update(issues)
        .set({
          executionRunId: firstRun!.id,
          executionAgentNameKey: "gateway agent",
          executionLockedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(issues.id, siblingIssueId));

      const siblingComment = await db
        .insert(issueComments)
        .values({
          companyId,
          issueId: siblingIssueId,
          authorUserId: "user-1",
          body: "Sibling follow-up parked behind the running lock",
        })
        .returning()
        .then((rows) => rows[0]);
      const siblingWakeRun = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId: siblingIssueId, commentId: siblingComment.id },
        contextSnapshot: {
          issueId: siblingIssueId,
          taskId: siblingIssueId,
          commentId: siblingComment.id,
          wakeCommentId: siblingComment.id,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      });

      expect(siblingWakeRun).toBeNull();

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

      expect(deferredWake).not.toBeNull();
      expect(deferredWake?.payload).toMatchObject({ issueId: siblingIssueId });

      // Simulate a mid-finalization retry: the primary issue's execution lock
      // now points at a queued retry run instead of the finalizing run.
      await db.insert(heartbeatRuns).values({
        id: retryRunId,
        companyId,
        agentId: retryAgentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        retryOfRunId: firstRun!.id,
        contextSnapshot: {
          issueId: primaryIssueId,
          taskId: primaryIssueId,
          wakeReason: "issue_continuation_needed",
          retryOfRunId: firstRun!.id,
        },
      });
      await db
        .update(issues)
        .set({
          executionRunId: retryRunId,
          executionAgentNameKey: "retry agent",
          updatedAt: new Date(),
        })
        .where(eq(issues.id, primaryIssueId));

      await heartbeat.cancelRun(firstRun!.id);

      // The repointed primary must abort its own drain without stranding the
      // sibling's parked wake.
      const wakeAfterRelease = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, deferredWake!.id))
        .then((rows) => rows[0] ?? null);

      expect(wakeAfterRelease?.reason).toBe("issue_execution_promoted");
      expect(wakeAfterRelease?.status).not.toBe("deferred_issue_execution");
      expect(wakeAfterRelease?.runId).not.toBeNull();

      const promotedRun = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, wakeAfterRelease!.runId!))
        .then((rows) => rows[0] ?? null);

      expect(promotedRun?.agentId).toBe(agentId);
      expect(promotedRun?.contextSnapshot).toMatchObject({ issueId: siblingIssueId });

      // The retry run keeps the primary issue's execution lock untouched.
      const primaryAfterRelease = await db
        .select({
          executionRunId: issues.executionRunId,
          checkoutRunId: issues.checkoutRunId,
        })
        .from(issues)
        .where(eq(issues.id, primaryIssueId))
        .then((rows) => rows[0] ?? null);
      expect(primaryAfterRelease?.executionRunId).toBe(retryRunId);

      const retryRunAfterRelease = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, retryRunId))
        .then((rows) => rows[0] ?? null);
      expect(retryRunAfterRelease?.status).toBe("queued");

      await waitFor(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, wakeAfterRelease!.runId!))
          .then((rows) => rows[0] ?? null);
        return run?.status === "succeeded";
      }, 90_000);
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 120_000);
});
