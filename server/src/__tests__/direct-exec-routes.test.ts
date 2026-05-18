import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  agents,
  agentWakeupRequests,
  directExecContextBundles,
  directExecThreads,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueLabels,
  labels,
  issues,
} from "@paperclipai/db";
import { DIRECT_EXEC_ANSWER_CATEGORIES, upsertDirectExecContextBundleSchema } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { scrubExpiredDirectExecPayloads } from "../services/direct-exec.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres direct-exec route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("direct-exec context bundle validation", () => {
  const basePayload = {
    sources: [{
      sourceName: "paperclip.issue",
      sourceId: "CAR-1",
      fetchedAt: "2026-05-18T18:00:00.000Z",
      maxAgeSeconds: 60,
    }],
  };

  it("requires named evidence for every answer category when selected", () => {
    for (const category of DIRECT_EXEC_ANSWER_CATEGORIES) {
      expect(upsertDirectExecContextBundleSchema.safeParse({
        ...basePayload,
        answerCategory: category,
        answerEvidence: {},
      }).success).toBe(false);

      expect(upsertDirectExecContextBundleSchema.safeParse({
        ...basePayload,
        answerCategory: category,
        answerEvidence: {
          [category]: [{
            sourceName: "paperclip.issue",
            sourceId: "CAR-1",
            detail: `Evidence for ${category}`,
          }],
        },
      }).success).toBe(true);
    }
  });
});

describeEmbeddedPostgres("direct-exec routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let app!: express.Express;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-direct-exec-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Direct Exec Co",
      issuePrefix: "DEX",
      requireBoardApprovalForNewAgents: false,
    });
    app = createApp(companyId);
  }, 20_000);

  afterEach(async () => {
    await db.delete(directExecContextBundles);
    await db.delete(directExecThreads);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(issueLabels);
    await db.delete(issues);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(labels);
    await db.delete(agents);
    await db.update(companies).set({ issueCounter: 0 }).where(eq(companies.id, companyId));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(allowedCompanyId: string) {
    const expressApp = express();
    expressApp.use(express.json());
    expressApp.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [allowedCompanyId],
        memberships: [{ companyId: allowedCompanyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: true,
      };
      next();
    });
    expressApp.use("/api", issueRoutes(db, {} as any));
    expressApp.use(errorHandler);
    return expressApp;
  }

  function directExecPayload() {
    return {
      title: "Direct exec CEO question",
      description: "Redacted executive intake",
      source: {
        channel: "telegram",
        chatId: "telegram:6980882002",
        messageId: "6341",
        senderId: "6980882002",
        senderLabel: "Dale Carman",
        surfaceType: "private",
        receivedAt: "2026-05-18T18:42:31.000Z",
      },
      target: {
        alias: "CEO",
        agentIds: [],
      },
      visibility: "private",
      thresholds: {
        responseTimeoutSeconds: 300,
      },
    };
  }

  it("exposes issue origin fields for create, update, read, and list-by-origin", async () => {
    const create = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Origin-backed issue",
        status: "todo",
        priority: "medium",
        originKind: "direct_exec",
        originId: "telegram:private:6341",
        originRunId: "mini-run-1",
      });

    expect(create.status, JSON.stringify(create.body)).toBe(201);
    expect(create.body).toMatchObject({
      originKind: "direct_exec",
      originId: "telegram:private:6341",
      originRunId: "mini-run-1",
    });

    const update = await request(app)
      .patch(`/api/issues/${create.body.id}`)
      .send({ originRunId: "mini-run-2", originFingerprint: "telegram:private:6341" });
    expect(update.status, JSON.stringify(update.body)).toBe(200);
    expect(update.body.originRunId).toBe("mini-run-2");
    expect(update.body.originFingerprint).toBe("telegram:private:6341");

    const list = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ originKind: "direct_exec", originId: "telegram:private:6341" });
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].id).toBe(create.body.id);
  });

  it("creates, reads, lists, and deduplicates direct-exec threads without description lookup", async () => {
    const first = await request(app)
      .post(`/api/companies/${companyId}/direct-exec/threads`)
      .send(directExecPayload());
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({
      created: true,
      duplicate: false,
      thread: {
        originKind: "direct_exec",
        originId: "telegram:telegram:6980882002:6341",
        lifecycle: {
          status: "accepted",
          dedupeKey: "telegram:telegram:6980882002:6341",
          target: { alias: "CEO" },
          visibility: "private",
        },
      },
    });
    expect(first.body.thread.issue).toMatchObject({
      originKind: "direct_exec",
      originId: "telegram:telegram:6980882002:6341",
    });

    const retry = await request(app)
      .post(`/api/companies/${companyId}/direct-exec/threads`)
      .send(directExecPayload());
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body).toMatchObject({
      created: false,
      duplicate: true,
    });
    expect(retry.body.thread.id).toBe(first.body.thread.id);
    expect(retry.body.thread.issueId).toBe(first.body.thread.issueId);

    const issueRows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "direct_exec")));
    expect(issueRows).toHaveLength(1);

    const read = await request(app).get(`/api/direct-exec/threads/${first.body.thread.id}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.id).toBe(first.body.thread.id);

    const listed = await request(app)
      .get(`/api/companies/${companyId}/direct-exec/threads`)
      .query({ originId: first.body.thread.originId });
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].id).toBe(first.body.thread.id);
  });

  it("keeps every direct-exec lifecycle status explicit and transition-checked", async () => {
    const created = await request(app)
      .post(`/api/companies/${companyId}/direct-exec/threads`)
      .send(directExecPayload());
    const threadId = created.body.thread.id;
    const seenStatuses = new Set<string>([created.body.thread.lifecycle.status]);

    for (const status of ["queued", "pending", "completed"] as const) {
      const update = await request(app)
        .patch(`/api/direct-exec/threads/${threadId}/lifecycle`)
        .send({ status });
      expect(update.status, JSON.stringify(update.body)).toBe(200);
      expect(update.body.lifecycle.status).toBe(status);
      seenStatuses.add(update.body.lifecycle.status);
    }

    const rejected = await request(app)
      .patch(`/api/direct-exec/threads/${threadId}/lifecycle`)
      .send({ status: "pending" });
    expect(rejected.status).toBe(409);

    const storedIssue = await db
      .select({ executionState: issues.executionState })
      .from(issues)
      .where(eq(issues.id, created.body.thread.issueId))
      .then((rows) => rows[0]);
    expect((storedIssue.executionState as any).directExec.status).toBe("completed");

    const failed = await request(app)
      .post(`/api/companies/${companyId}/direct-exec/threads`)
      .send({
        ...directExecPayload(),
        source: { ...directExecPayload().source, messageId: "6342" },
      });
    const failedUpdate = await request(app)
      .patch(`/api/direct-exec/threads/${failed.body.thread.id}/lifecycle`)
      .send({ status: "failed", statusReason: "target rejected the request" });
    expect(failedUpdate.status, JSON.stringify(failedUpdate.body)).toBe(200);
    expect(failedUpdate.body.lifecycle.statusReason).toBe("target rejected the request");
    seenStatuses.add(failedUpdate.body.lifecycle.status);

    const paused = await request(app)
      .post(`/api/companies/${companyId}/direct-exec/threads`)
      .send({
        ...directExecPayload(),
        source: { ...directExecPayload().source, messageId: "6343" },
      });
    const pausedUpdate = await request(app)
      .patch(`/api/direct-exec/threads/${paused.body.thread.id}/lifecycle`)
      .send({ status: "paused" });
    expect(pausedUpdate.status, JSON.stringify(pausedUpdate.body)).toBe(200);
    seenStatuses.add(pausedUpdate.body.lifecycle.status);

    const timedOut = await request(app)
      .post(`/api/companies/${companyId}/direct-exec/threads`)
      .send({
        ...directExecPayload(),
        source: { ...directExecPayload().source, messageId: "6344" },
      });
    for (const status of ["queued", "pending", "timed-out"] as const) {
      const update = await request(app)
        .patch(`/api/direct-exec/threads/${timedOut.body.thread.id}/lifecycle`)
        .send({ status });
      expect(update.status, JSON.stringify(update.body)).toBe(200);
      seenStatuses.add(update.body.lifecycle.status);
    }

    expect([...seenStatuses].sort()).toEqual([
      "accepted",
      "completed",
      "failed",
      "paused",
      "pending",
      "queued",
      "timed-out",
    ]);
  });

  it("does not infer a lifecycle from origin fields or trace-like description text", async () => {
    const create = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Trace-only issue",
        description: "direct_exec_trace: status=completed",
        status: "todo",
        priority: "medium",
        originKind: "direct_exec",
        originId: "trace-only",
      });
    expect(create.status, JSON.stringify(create.body)).toBe(201);

    const read = await request(app).get(`/api/issues/${create.body.id}/direct-exec/thread`);
    expect(read.status).toBe(404);
  });

  it("persists context bundles with freshness, unavailable-source, conflict, and evidence metadata", async () => {
    const created = await request(app)
      .post(`/api/companies/${companyId}/direct-exec/threads`)
      .send(directExecPayload());
    const threadId = created.body.thread.id;

    const bundle = await request(app)
      .put(`/api/direct-exec/threads/${threadId}/context-bundle`)
      .send({
        sources: [
          {
            sourceName: "paperclip.issue",
            sourceId: "CAR-1011",
            fetchedAt: "2026-05-18T16:00:00.000Z",
            maxAgeSeconds: 60,
          },
          {
            sourceName: "operator.runtime",
            sourceId: "runtime:papertrade",
            fetchedAt: "2026-05-18T18:00:00.000Z",
            maxAgeSeconds: 60,
            unavailableReason: "runtime id not referenced by the question",
          },
        ],
        conflicts: [{
          field: "status",
          sources: ["checked-in-report", "paperclip.issue"],
          resolution: "live_paperclip",
          evidence: "Live Paperclip issue status outranks cached reports.",
        }],
        answerCategory: "never_saw_it",
        answerEvidence: {
          never_saw_it: [{
            sourceName: "agent_wakeup_requests",
            sourceId: "wakeup:none-before-question",
            detail: "No assignment, mention, wake, inbox, or target-authored comment before the question.",
          }],
        },
      });

    expect(bundle.status, JSON.stringify(bundle.body)).toBe(200);
    expect(bundle.body.sources[0]).toMatchObject({ sourceName: "paperclip.issue", stale: true });
    expect(bundle.body.sources[1]).toMatchObject({
      sourceName: "operator.runtime",
      unavailableReason: "runtime id not referenced by the question",
    });
    expect(bundle.body.conflicts[0]).toMatchObject({
      resolution: "live_paperclip",
      surfaced: true,
    });
    expect(bundle.body.answerEvidence.never_saw_it[0].sourceName).toBe("agent_wakeup_requests");

    const read = await request(app).get(`/api/direct-exec/threads/${threadId}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.lifecycle.contextBundleId).toBe(bundle.body.id);
    expect(read.body.contextBundle.id).toBe(bundle.body.id);
  });

  it("assembles referenced Paperclip issue context inside Paperclip before persisting a bundle", async () => {
    const created = await request(app)
      .post(`/api/companies/${companyId}/direct-exec/threads`)
      .send(directExecPayload());
    const threadId = created.body.thread.id;

    const referencedIssueId = randomUUID();
    const documentId = randomUUID();
    const targetAgentId = randomUUID();
    const executionRunId = randomUUID();
    const labelId = randomUUID();
    await db.insert(agents).values({
      id: targetAgentId,
      companyId,
      name: "CEO",
      role: "executive",
      adapterType: "process",
    });
    await db.insert(heartbeatRuns).values({
      id: executionRunId,
      companyId,
      agentId: targetAgentId,
      status: "completed",
      invocationSource: "wakeup",
      triggerDetail: "direct-exec issue context",
    });
    await db.insert(issues).values({
      id: referencedIssueId,
      companyId,
      identifier: "CAR-1011",
      title: "CEO follow-up",
      description: "Redacted issue context",
      status: "blocked",
      priority: "high",
      assigneeAgentId: targetAgentId,
      executionRunId,
    });
    await db.insert(labels).values({
      id: labelId,
      companyId,
      name: "executive",
      color: "#0f766e",
    });
    await db.insert(issueLabels).values({
      companyId,
      issueId: referencedIssueId,
      labelId,
    });
    await db.insert(issueComments).values({
      companyId,
      issueId: referencedIssueId,
      body: "Target-authored detail is intentionally not copied into the direct-exec test assertion.",
      authorType: "agent",
      authorAgentId: targetAgentId,
      createdByRunId: executionRunId,
    });
    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Evidence note",
      latestBody: "Redacted document body",
      latestRevisionNumber: 1,
      format: "markdown",
    });
    await db.insert(issueDocuments).values({
      companyId,
      issueId: referencedIssueId,
      documentId,
      key: "evidence",
    });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: targetAgentId,
      source: "direct_exec",
      triggerDetail: "CAR-1011",
      payload: { issueId: referencedIssueId },
      status: "claimed",
      runId: executionRunId,
    });

    const bundle = await request(app)
      .post(`/api/direct-exec/threads/${threadId}/context-bundle/assemble`)
      .send({
        issueRefs: ["CAR-1011"],
        targetAgentIds: [targetAgentId],
        answerCategory: "did_not_act",
        answerEvidence: {
          did_not_act: [{
            sourceName: "paperclip.issue",
            sourceId: "CAR-1011",
            detail: "Referenced issue status is blocked and no later target action is present.",
          }],
        },
      });

    expect(bundle.status, JSON.stringify(bundle.body)).toBe(200);
    expect(bundle.body.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceName: "paperclip.issue", sourceId: "CAR-1011", stale: false }),
    ]));
    expect(bundle.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceName: "paperclip.issue",
        kind: "issue",
        data: expect.objectContaining({
          identifier: "CAR-1011",
          status: "blocked",
          assigneeAgentId: targetAgentId,
          executionRunId,
          labelNames: ["executive"],
        }),
      }),
      expect.objectContaining({
        sourceName: "paperclip.issue.comments",
        kind: "comments",
        data: expect.objectContaining({ comments: expect.arrayContaining([expect.objectContaining({ authorType: "agent" })]) }),
      }),
      expect.objectContaining({
        sourceName: "paperclip.issue.documents",
        kind: "documents",
        data: expect.objectContaining({ documents: expect.arrayContaining([expect.objectContaining({ key: "evidence" })]) }),
      }),
      expect.objectContaining({
        sourceName: "agent_wakeup_requests",
        kind: "wakeups",
        data: expect.objectContaining({ wakeups: expect.arrayContaining([expect.objectContaining({ runId: executionRunId })]) }),
      }),
      expect.objectContaining({
        sourceName: "heartbeat_runs",
        kind: "runs",
        data: expect.objectContaining({ runs: expect.arrayContaining([expect.objectContaining({ id: executionRunId })]) }),
      }),
      expect.objectContaining({
        sourceName: "target_agent.heartbeat_runs",
        sourceId: targetAgentId,
        kind: "runs",
        data: expect.objectContaining({ runs: expect.arrayContaining([expect.objectContaining({ id: executionRunId })]) }),
      }),
    ]));
  });

  it("scrubs expired direct-exec payload fields while preserving delivery receipts and document revision hygiene", async () => {
    const rawMarker = "RAW_TELEGRAM_AND_CONTEXT_PAYLOAD_DO_NOT_COPY";
    const created = await request(app)
      .post(`/api/companies/${companyId}/direct-exec/threads`)
      .send({
        ...directExecPayload(),
        description: "Redacted executive intake; raw text omitted by policy.",
        retentionExpiresAt: "2026-05-18T18:00:00.000Z",
        scrubStatus: "pending",
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const threadId = created.body.thread.id;

    const queued = await request(app)
      .patch(`/api/direct-exec/threads/${threadId}/lifecycle`)
      .send({
        status: "queued",
        deliveryReceipts: [{
          id: "telegram-delivery-1",
          channel: "telegram",
          targetId: "telegram:6980882002",
          deliveredAt: "2026-05-18T18:01:00.000Z",
          status: "delivered",
        }],
      });
    expect(queued.status, JSON.stringify(queued.body)).toBe(200);
    expect(queued.body.lifecycle.deliveryReceipts).toHaveLength(1);

    const bundle = await request(app)
      .put(`/api/direct-exec/threads/${threadId}/context-bundle`)
      .send({
        sources: [{
          sourceName: "paperclip.issue",
          sourceId: "CAR-1011",
          fetchedAt: "2026-05-18T18:01:00.000Z",
          maxAgeSeconds: 60,
        }],
        items: [{
          sourceName: "paperclip.issue",
          sourceId: "CAR-1011",
          kind: "raw_context_payload",
          data: { raw: rawMarker },
        }],
        conflicts: [{
          field: "body",
          sources: ["telegram", "paperclip.issue"],
          resolution: "unresolved",
          evidence: rawMarker,
        }],
        answerCategory: "did_not_act",
        answerEvidence: {
          did_not_act: [{
            sourceName: "paperclip.issue",
            sourceId: "CAR-1011",
            detail: rawMarker,
          }],
        },
      });
    expect(bundle.status, JSON.stringify(bundle.body)).toBe(200);

    const beforeDocs = await db.select({ latestBody: documents.latestBody }).from(documents);
    const beforeRevisions = await db.select({ body: documentRevisions.body }).from(documentRevisions);
    expect(JSON.stringify({ beforeDocs, beforeRevisions })).not.toContain(rawMarker);

    const scrub = await scrubExpiredDirectExecPayloads(db, { now: new Date("2026-05-18T19:00:00.000Z") });
    expect(scrub.scrubbedThreadIds).toEqual([threadId]);
    expect(scrub.scrubbedContextBundleCount).toBe(1);

    const read = await request(app).get(`/api/direct-exec/threads/${threadId}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.lifecycle).toMatchObject({
      status: "queued",
      scrubStatus: "scrubbed",
      deliveryReceipts: [{
        id: "telegram-delivery-1",
        channel: "telegram",
        targetId: "telegram:6980882002",
        deliveredAt: "2026-05-18T18:01:00.000Z",
        status: "delivered",
        error: null,
      }],
    });
    expect(read.body.contextBundle).toMatchObject({
      sources: [expect.objectContaining({ sourceName: "paperclip.issue", sourceId: "CAR-1011" })],
      items: [],
      conflicts: [],
      answerEvidence: {},
    });
    expect(JSON.stringify(read.body.contextBundle)).not.toContain(rawMarker);

    const issueRow = await db
      .select({ executionState: issues.executionState })
      .from(issues)
      .where(eq(issues.id, created.body.thread.issueId))
      .then((rows) => rows[0]);
    expect((issueRow.executionState as any).directExec).toMatchObject({
      status: "queued",
      scrubStatus: "scrubbed",
      deliveryReceiptIds: ["telegram-delivery-1"],
    });
  });
});
