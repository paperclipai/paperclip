import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueExecutionDecisions,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

describeEmbeddedPostgres("system-attributed agent JWT issue authorization", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;

  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "agent-jwt-issue-routes-secret";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-jwt-issues-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await db.delete(heartbeatRunEvents);
      await db.delete(activityLog);
      await db.delete(issueExecutionDecisions);
      await db.delete(issueThreadInteractions);
      await db.delete(issues);
      await db.delete(heartbeatRuns);
      await db.delete(agentWakeupRequests);
      await db.delete(agentRuntimeState);
      try {
        await db.delete(agents);
        await db.delete(companies);
        return;
      } catch (error) {
        if (attempt === 9) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousSecret;
  });

  function app() {
    const instance = express();
    instance.use(express.json());
    instance.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
    instance.use("/api", issueRoutes(db, {} as never));
    instance.use(errorHandler);
    return instance;
  }

  it("allows a null-responsible final approver, denies cross-company and same-run acceptance", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const coachId = randomUUID();
    const reviewerId = randomUUID();
    const approverId = randomUUID();
    const sourceRunId = randomUUID();
    const approverRunId = randomUUID();
    const issueId = randomUUID();
    const otherIssueId = randomUUID();
    const interactionId = randomUUID();
    const reviewStageId = randomUUID();
    const approvalStageId = randomUUID();

    await db.insert(companies).values([
      { id: companyId, name: "JWT Company", issuePrefix: "JWT" },
      { id: otherCompanyId, name: "Other Company", issuePrefix: "OTH" },
    ]);
    await db.insert(agents).values([
      {
        id: coachId,
        companyId,
        name: "Reflection Coach",
        role: "general",
        status: "paused",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        metadata: { paperclipBuiltInAgent: { key: "reflection-coach", featureKeys: [] } },
      },
      { id: reviewerId, companyId, name: "QA", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      {
        id: approverId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        metadata: { paperclipBuiltInAgent: { key: "agent-cto", featureKeys: [] } },
      },
    ]);
    await db.insert(heartbeatRuns).values([
      { id: sourceRunId, companyId, agentId: coachId, status: "succeeded", responsibleUserId: null },
      { id: approverRunId, companyId, agentId: approverId, status: "running", responsibleUserId: null },
    ]);
    await db.insert(issues).values([
      {
        id: issueId,
        companyId,
        identifier: "JWT-1",
        issueNumber: 1,
        title: "Apply Reflection Coach proposal",
        status: "in_review",
        priority: "high",
        assigneeAgentId: approverId,
        createdByAgentId: coachId,
        executionPolicy: {
          mode: "auto",
          commentRequired: true,
          stages: [
            { id: reviewStageId, type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: reviewerId }] },
            { id: approvalStageId, type: "approval", approvalsNeeded: 1, participants: [{ type: "agent", agentId: approverId }] },
          ],
        },
        executionState: {
          status: "pending",
          currentStageId: approvalStageId,
          currentStageIndex: 1,
          currentStageType: "approval",
          currentParticipant: { type: "agent", agentId: approverId },
          returnAssignee: { type: "agent", agentId: coachId },
          reviewRequest: null,
          completedStageIds: [reviewStageId],
          lastDecisionId: null,
          lastDecisionOutcome: "approved",
          monitor: null,
        },
      },
      { id: otherIssueId, companyId: otherCompanyId, identifier: "OTH-1", issueNumber: 1, title: "Other", status: "todo", priority: "medium" },
    ]);
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee_on_accept",
      sourceRunId,
      createdByAgentId: coachId,
      payload: {
        version: 1,
        prompt: "Apply the displayed instruction diff?",
        detailsMarkdown: "```diff\n+Require an exact verification command.\n```",
        target: { type: "custom", key: `agent:${coachId}:instructions`, revisionId: "proposal-v1" },
      },
    });

    const token = createLocalAgentJwt(approverId, companyId, "codex_local", approverRunId, null);
    const auth = { Authorization: `Bearer ${token}`, "X-Paperclip-Run-Id": approverRunId };
    expect((await request(app()).get(`/api/issues/${issueId}`).set(auth)).status).toBe(200);
    expect((await request(app()).get(`/api/issues/${otherIssueId}`).set(auth)).status).toBe(404);

    const accepted = await request(app())
      .post(`/api/issues/${issueId}/interactions/${interactionId}/accept`)
      .set(auth)
      .send({});
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ status: "accepted", resolvedByAgentId: approverId });

    const [storedIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(storedIssue).toMatchObject({ status: "todo", assigneeAgentId: coachId, assigneeUserId: null });
    expect(storedIssue?.executionState).toMatchObject({ status: "completed", lastDecisionOutcome: "approved" });

    const repeated = await request(app())
      .post(`/api/issues/${issueId}/interactions/${interactionId}/accept`)
      .set(auth)
      .send({});
    expect(repeated.status).toBe(409);
    expect(repeated.body).toEqual({ error: "Interaction has already been resolved" });
    const decisions = await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, issueId));
    expect(decisions).toHaveLength(1);

    const sameRunInteractionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: sameRunInteractionId,
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee_on_accept",
      sourceRunId: approverRunId,
      createdByAgentId: coachId,
      payload: { version: 1, prompt: "Same run?", detailsMarkdown: "```diff\n+x\n```", target: { type: "custom", key: `agent:${coachId}:instructions`, revisionId: "proposal-v2" } },
    });
    const denied = await request(app())
      .post(`/api/issues/${issueId}/interactions/${sameRunInteractionId}/accept`)
      .set(auth)
      .send({});
    expect(denied.status).toBe(403);
  });

  it("persists a single approval decision when distinct confirmations are accepted concurrently", async () => {
    const companyId = randomUUID();
    const coachId = randomUUID();
    const approverId = randomUUID();
    const firstSourceRunId = randomUUID();
    const secondSourceRunId = randomUUID();
    const approverRunId = randomUUID();
    const issueId = randomUUID();
    const firstInteractionId = randomUUID();
    const secondInteractionId = randomUUID();
    const approvalStageId = randomUUID();

    await db.insert(companies).values({ id: companyId, name: "Race Company", issuePrefix: "RACE" });
    await db.insert(agents).values([
      {
        id: coachId,
        companyId,
        name: "Reflection Coach",
        role: "general",
        status: "paused",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        metadata: { paperclipBuiltInAgent: { key: "reflection-coach", featureKeys: [] } },
      },
      {
        id: approverId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        metadata: { paperclipBuiltInAgent: { key: "agent-cto", featureKeys: [] } },
      },
    ]);
    await db.insert(heartbeatRuns).values([
      { id: firstSourceRunId, companyId, agentId: coachId, status: "succeeded", responsibleUserId: null },
      { id: secondSourceRunId, companyId, agentId: coachId, status: "succeeded", responsibleUserId: null },
      { id: approverRunId, companyId, agentId: approverId, status: "running", responsibleUserId: null },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "RACE-1",
      issueNumber: 1,
      title: "Apply Reflection Coach proposal",
      status: "in_review",
      priority: "high",
      assigneeAgentId: approverId,
      createdByAgentId: coachId,
      executionPolicy: {
        mode: "auto",
        commentRequired: true,
        stages: [
          { id: approvalStageId, type: "approval", approvalsNeeded: 1, participants: [{ type: "agent", agentId: approverId }] },
        ],
      },
      executionState: {
        status: "pending",
        currentStageId: approvalStageId,
        currentStageIndex: 0,
        currentStageType: "approval",
        currentParticipant: { type: "agent", agentId: approverId },
        returnAssignee: { type: "agent", agentId: coachId },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: null,
      },
    });
    await db.insert(issueThreadInteractions).values([
      {
        id: firstInteractionId,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee_on_accept",
        sourceRunId: firstSourceRunId,
        createdByAgentId: coachId,
        payload: {
          version: 1,
          prompt: "Apply proposal one?",
          detailsMarkdown: "```diff\n+one\n```",
          target: { type: "custom", key: `agent:${coachId}:instructions`, revisionId: "proposal-v1" },
        },
      },
      {
        id: secondInteractionId,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee_on_accept",
        sourceRunId: secondSourceRunId,
        createdByAgentId: coachId,
        payload: {
          version: 1,
          prompt: "Apply proposal two?",
          detailsMarkdown: "```diff\n+two\n```",
          target: { type: "custom", key: `agent:${coachId}:instructions`, revisionId: "proposal-v2" },
        },
      },
    ]);

    const token = createLocalAgentJwt(approverId, companyId, "codex_local", approverRunId, null);
    const auth = { Authorization: `Bearer ${token}`, "X-Paperclip-Run-Id": approverRunId };
    const [first, second] = await Promise.all([
      request(app()).post(`/api/issues/${issueId}/interactions/${firstInteractionId}/accept`).set(auth).send({}),
      request(app()).post(`/api/issues/${issueId}/interactions/${secondInteractionId}/accept`).set(auth).send({}),
    ]);

    const statuses = [first!.status, second!.status].sort();
    expect(statuses, JSON.stringify([first!.body, second!.body])).toEqual([200, 409]);

    const decisions = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ stageId: approvalStageId, stageType: "approval", outcome: "approved" });

    const [storedIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(storedIssue?.executionState).toMatchObject({
      status: "completed",
      lastDecisionId: decisions[0]!.id,
      lastDecisionOutcome: "approved",
    });

    const stillPending = await db
      .select({ id: issueThreadInteractions.id, status: issueThreadInteractions.status })
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, issueId));
    expect(stillPending.filter((row) => row.status === "accepted")).toHaveLength(1);
    expect(stillPending.filter((row) => row.status === "pending")).toHaveLength(1);
  });
});
