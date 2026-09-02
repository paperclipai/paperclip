import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  createDb,
  decisionQueueItems,
  decisionQueues,
  decisionTriage,
  decisionTriageEvents,
  issueThreadInteractions,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import type { AttentionItem } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { decisionQueueRoutes } from "../routes/decision-queues.js";
import { decisionQueueService } from "../services/decision-queues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres decision queue tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("decision queue routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-decision-queues-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(decisionTriageEvents);
    await db.delete(decisionQueueItems);
    await db.delete(decisionTriage);
    await db.delete(decisionQueues);
    await db.delete(activityLog);
    await db.delete(issueThreadInteractions);
    await db.delete(issueWorkProducts);
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const interactionId = randomUUID();
    const approvalId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Decision Queue Co",
      issuePrefix: "DQC",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Prioritizer",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "DQC-1",
      title: "Review the rollout",
      status: "in_review",
      assigneeAgentId: agentId,
    });
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "ask_user_questions",
      status: "pending",
      payload: { version: 1, questions: [] } as never,
    });
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      status: "pending",
      payload: {},
    });
    return { companyId, agentId, issueId, interactionId, approvalId };
  }

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    testApp.use("/api", decisionQueueRoutes(db));
    testApp.use(errorHandler);
    return testApp;
  }

  function boardActor(companyId: string, userId = "board-user") {
    return {
      type: "board",
      source: "local_implicit",
      userId,
      companyIds: [companyId],
      isInstanceAdmin: false,
    };
  }

  function agentActor(companyId: string, agentId: string) {
    return {
      type: "agent",
      source: "agent_key",
      companyId,
      agentId,
      keyId: null,
      keyScope: { kind: "standard" },
      runId: null,
    };
  }

  it("creates idempotently, patches, lists by updated time, and audits queue mutations", async () => {
    const { companyId } = await seed();
    const board = boardActor(companyId);
    const first = await request(app(board)).post(`/api/companies/${companyId}/decision-queues`).send({
      key: "launches",
      title: "Launches",
      description: "Ship decisions",
    }).expect(201);
    const repeated = await request(app(board)).post(`/api/companies/${companyId}/decision-queues`).send({
      key: "launches",
      title: "Ignored duplicate title",
    }).expect(200);

    expect(repeated.body.id).toBe(first.body.id);
    expect(repeated.body.title).toBe("Launches");
    expect(repeated.body.itemCount).toBe(0);

    const patched = await request(app(board))
      .patch(`/api/companies/${companyId}/decision-queues/launches`)
      .send({ title: "Launch desk", retentionDays: 45 })
      .expect(200);
    expect(patched.body).toMatchObject({ title: "Launch desk", retentionDays: 45 });

    await request(app(board)).post(`/api/companies/${companyId}/decision-queues`).send({
      key: "older",
      title: "Older",
    }).expect(201);
    const listed = await request(app(board)).get(`/api/companies/${companyId}/decision-queues`).expect(200);
    expect(listed.body.map((queue: { key: string }) => queue.key)).toEqual(["older", "launches"]);
    const seedRules = await request(app(board))
      .get(`/api/companies/${companyId}/decision-queue-seed-rules`)
      .expect(200);
    expect(seedRules.body.map((seed: { key: string }) => seed.key)).toEqual(["prs", "plans", "questions"]);

    const events = await db.select().from(decisionTriageEvents)
      .where(eq(decisionTriageEvents.queueId, first.body.id));
    expect(events.map((event) => event.action)).toEqual(["queue.created", "queue.updated"]);
    expect(events.every((event) => event.actorUserId === "board-user")).toBe(true);
  });

  it("adds and removes three attention source kinds and hides board-only membership from agents", async () => {
    const { companyId, agentId, issueId, interactionId, approvalId } = await seed();
    const board = boardActor(companyId);
    await request(app(board)).post(`/api/companies/${companyId}/decision-queues`).send({
      key: "triage",
      title: "Triage",
    }).expect(201);

    for (const source of [
      { sourceKind: "approval", sourceId: approvalId },
      { sourceKind: "issue_thread_interaction", sourceId: interactionId },
      { sourceKind: "review", sourceId: issueId },
    ]) {
      await request(app(board))
        .post(`/api/companies/${companyId}/decision-queues/triage/items`)
        .send(source)
        .expect(201);
    }

    const items = await request(app(board))
      .get(`/api/companies/${companyId}/decision-queues/triage/items`)
      .expect(200);
    expect(items.body).toHaveLength(3);
    const repeated = await request(app(board)).post(`/api/companies/${companyId}/decision-queues`).send({
      key: "triage",
      title: "Ignored duplicate title",
    }).expect(200);
    expect(repeated.body.itemCount).toBe(3);

    const agentList = await request(app(agentActor(companyId, agentId)))
      .get(`/api/companies/${companyId}/decision-queues`)
      .expect(200);
    expect(agentList.body[0].itemCount).toBe(2);
    const agentItems = await request(app(agentActor(companyId, agentId)))
      .get(`/api/companies/${companyId}/decision-queues/triage/items`)
      .expect(200);
    expect(agentItems.body.map((item: { sourceKind: string }) => item.sourceKind).sort()).toEqual([
      "issue_thread_interaction",
      "review",
    ]);
    await request(app(agentActor(companyId, agentId)))
      .delete(`/api/companies/${companyId}/decision-queues/triage/items/approval/${approvalId}`)
      .expect(404);

    await request(app(board))
      .delete(`/api/companies/${companyId}/decision-queues/triage/items/review/${issueId}`)
      .send({ reason: "Handled in the release review" })
      .expect(200);
    expect(await db.select().from(decisionQueueItems).where(and(
      eq(decisionQueueItems.companyId, companyId),
      eq(decisionQueueItems.sourceKind, "review"),
    ))).toHaveLength(0);
    const removalAudit = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.action, "decision_queue_item.removed"),
    )).then((rows) => rows[0]);
    expect(removalAudit?.details).toMatchObject({
      sourceKind: "review",
      sourceId: issueId,
      reason: "Handled in the release review",
    });
    const removalEvent = await db.select().from(decisionTriageEvents).where(and(
      eq(decisionTriageEvents.companyId, companyId),
      eq(decisionTriageEvents.sourceKind, "review"),
      eq(decisionTriageEvents.sourceId, issueId),
      eq(decisionTriageEvents.action, "queue_item.removed"),
    )).then((rows) => rows[0]);
    expect(removalEvent?.details).toEqual({ reason: "Handled in the release review" });

    await db.delete(approvals).where(eq(approvals.id, approvalId));
    await request(app(board))
      .delete(`/api/companies/${companyId}/decision-queues/triage/items/approval/${approvalId}`)
      .expect(200);
    expect(await db.select().from(decisionQueueItems).where(and(
      eq(decisionQueueItems.companyId, companyId),
      eq(decisionQueueItems.sourceKind, "approval"),
    ))).toHaveLength(0);
  });

  it("materializes data-backed starter queues from plan, question, and pull-request signals", async () => {
    const { companyId, issueId, interactionId } = await seed();
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "pull_request",
      provider: "github",
      title: "PR 42",
      status: "open",
    });

    function attentionItem(input: {
      sourceKind: AttentionItem["sourceKind"];
      sourceId: string;
      subjectKind: AttentionItem["subject"]["kind"];
      metadata?: Record<string, unknown>;
      issueId?: string;
    }): AttentionItem {
      return {
        id: `${input.sourceKind}:${input.sourceId}`,
        companyId,
        sourceKind: input.sourceKind,
        subject: {
          kind: input.subjectKind,
          id: input.sourceId,
          companyId,
          title: "Seed candidate",
          identifier: null,
          status: "pending",
          href: null,
          metadata: input.metadata,
        },
        whyNow: "test",
        decisionVerbs: [],
        inlineResolvable: true,
        entryRule: "test",
        exitRule: "test",
        dedupKey: `${input.sourceKind}:${input.sourceId}`,
        dismissalKey: `${input.sourceKind}:${input.sourceId}`,
        dismissal: null,
        severity: "medium",
        rank: 1,
        activityAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        relatedIssue: input.issueId ? {
          kind: "issue",
          id: input.issueId,
          companyId,
          title: "Issue",
          identifier: "DQC-1",
          status: "in_review",
          href: null,
        } : null,
        project: null,
        workspace: null,
        detail: null,
        trainingExampleId: null,
      };
    }

    const planId = randomUUID();
    const candidates = [
      attentionItem({ sourceKind: "review", sourceId: issueId, subjectKind: "issue", issueId }),
      attentionItem({
        sourceKind: "issue_thread_interaction",
        sourceId: planId,
        subjectKind: "interaction",
        metadata: { kind: "request_confirmation", isPlanTarget: true, issueId },
        issueId,
      }),
      attentionItem({
        sourceKind: "issue_thread_interaction",
        sourceId: interactionId,
        subjectKind: "interaction",
        metadata: { kind: "ask_user_questions", issueId },
        issueId,
      }),
    ];
    await decisionQueueService(db).materializeSeededQueues(companyId, candidates);

    const queues = await db.select().from(decisionQueues).where(eq(decisionQueues.companyId, companyId));
    expect(queues.map((queue) => queue.key).sort()).toEqual(["plans", "prs", "questions"]);
    expect(queues.every((queue) => queue.seedRulesEnabled && queue.seedRules.length === 1)).toBe(true);
    const seededItems = await db.select({ queueId: decisionQueueItems.queueId })
      .from(decisionQueueItems)
      .where(eq(decisionQueueItems.companyId, companyId));
    expect(seededItems).toHaveLength(5);
    const prQueue = queues.find((queue) => queue.key === "prs")!;
    expect(seededItems.filter((item) => item.queueId === prQueue.id)).toHaveLength(3);

    const firstEvents = await db.select().from(decisionTriageEvents)
      .where(eq(decisionTriageEvents.companyId, companyId));
    const firstActivity = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const firstUpdatedAt = new Map(queues.map((queue) => [queue.key, queue.updatedAt.toISOString()]));
    await decisionQueueService(db).materializeSeededQueues(companyId, candidates);
    const unchangedQueues = await db.select().from(decisionQueues).where(eq(decisionQueues.companyId, companyId));
    expect(unchangedQueues.every((queue) => queue.updatedAt.toISOString() === firstUpdatedAt.get(queue.key))).toBe(true);
    expect(await db.select().from(decisionTriageEvents).where(eq(decisionTriageEvents.companyId, companyId)))
      .toHaveLength(firstEvents.length);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, companyId)))
      .toHaveLength(firstActivity.length);

    const questionsQueue = queues.find((queue) => queue.key === "questions")!;
    await db.update(decisionQueues).set({ seedRulesEnabled: false }).where(eq(decisionQueues.id, questionsQueue.id));
    await decisionQueueService(db).materializeSeededQueues(companyId, [attentionItem({
      sourceKind: "issue_thread_interaction",
      sourceId: randomUUID(),
      subjectKind: "interaction",
      metadata: { kind: "ask_user_questions", issueId },
      issueId,
    })]);
    expect(await db.select().from(decisionQueueItems).where(eq(decisionQueueItems.queueId, questionsQueue.id)))
      .toHaveLength(1);
  });

  it("records agent decide-by, preserves override history, and exposes the board override attribution", async () => {
    const { companyId, agentId, issueId } = await seed();
    const agent = agentActor(companyId, agentId);
    const board = boardActor(companyId, "override-user");

    const agentSet = await request(app(agent))
      .put(`/api/companies/${companyId}/decision-triage/review/${issueId}`)
      .send({ decideBy: "today", snoozedUntil: "2026-08-03T12:00:00.000Z" })
      .expect(200);
    expect(agentSet.body).toMatchObject({
      decideBy: "today",
      setByType: "agent",
      setByAgentId: agentId,
      version: 1,
    });

    const overridden = await request(app(board))
      .put(`/api/companies/${companyId}/decision-triage/review/${issueId}`)
      .send({ decideBy: "2026-08-08", snoozedUntil: null })
      .expect(200);
    expect(overridden.body).toMatchObject({
      decideBy: "2026-08-08",
      setByType: "user",
      setByUserId: "override-user",
      version: 2,
    });

    const events = await db.select().from(decisionTriageEvents).where(and(
      eq(decisionTriageEvents.companyId, companyId),
      eq(decisionTriageEvents.sourceKind, "review"),
      eq(decisionTriageEvents.sourceId, issueId),
    ));
    expect(events).toHaveLength(2);
    expect(events[0]?.actorAgentId).toBe(agentId);
    expect(events[1]?.actorUserId).toBe("override-user");
    expect(events[1]?.details).toMatchObject({ previousDecideBy: "today", decideBy: "2026-08-08" });

    const current = await db.select().from(decisionTriage).where(eq(decisionTriage.sourceId, issueId));
    expect(current[0]?.setByUserId).toBe("override-user");
  });

  it("serializes concurrent partial triage updates without losing state or reusing a version", async () => {
    const { companyId, issueId } = await seed();
    const board = boardActor(companyId);
    const [decideByResult, snoozeResult] = await Promise.all([
      request(app(board))
        .put(`/api/companies/${companyId}/decision-triage/review/${issueId}`)
        .send({ decideBy: "today" }),
      request(app(board))
        .put(`/api/companies/${companyId}/decision-triage/review/${issueId}`)
        .send({ snoozedUntil: "2026-08-03T12:00:00.000Z" }),
    ]);

    expect(decideByResult.status).toBe(200);
    expect(snoozeResult.status).toBe(200);
    expect([decideByResult.body.version, snoozeResult.body.version].sort()).toEqual([1, 2]);

    const current = await request(app(board))
      .get(`/api/companies/${companyId}/decision-triage/review/${issueId}`)
      .expect(200);
    expect(current.body).toMatchObject({
      decideBy: "today",
      snoozedUntil: "2026-08-03T12:00:00.000Z",
      version: 2,
    });
    const events = await db.select().from(decisionTriageEvents).where(and(
      eq(decisionTriageEvents.companyId, companyId),
      eq(decisionTriageEvents.sourceKind, "review"),
      eq(decisionTriageEvents.sourceId, issueId),
    ));
    expect(events.map((event) => event.details.version).sort()).toEqual([1, 2]);
  });

  it("rejects task-bridge JWTs and returns the same 404 for missing and unauthorized sources", async () => {
    const { companyId, agentId, approvalId } = await seed();
    const bridge = {
      ...agentActor(companyId, agentId),
      source: "agent_jwt",
      keyId: randomUUID(),
      keyScope: { kind: "task_bridge", parentIssueId: randomUUID() },
    };
    await request(app(bridge)).post(`/api/companies/${companyId}/decision-queues`).send({
      key: "blocked",
      title: "Blocked",
    }).expect(403);
    const skillTest = {
      ...agentActor(companyId, agentId),
      source: "agent_jwt",
      keyScope: { kind: "skill_test", issueId: randomUUID() },
    };
    await request(app(skillTest)).post(`/api/companies/${companyId}/decision-queues`).send({
      key: "skill-test-blocked",
      title: "Skill test blocked",
    }).expect(403);

    await request(app(boardActor(companyId))).post(`/api/companies/${companyId}/decision-queues`).send({
      key: "secure",
      title: "Secure",
    }).expect(201);
    const standardAgent = app(agentActor(companyId, agentId));
    const unauthorized = await request(standardAgent)
      .post(`/api/companies/${companyId}/decision-queues/secure/items`)
      .send({ sourceKind: "approval", sourceId: approvalId })
      .expect(404);
    const missing = await request(standardAgent)
      .post(`/api/companies/${companyId}/decision-queues/secure/items`)
      .send({ sourceKind: "approval", sourceId: randomUUID() })
      .expect(404);
    expect(unauthorized.body).toEqual(missing.body);
  });
});
