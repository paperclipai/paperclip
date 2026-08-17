import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  FEEDBACK_DELIVERY_RECOVERY_ACTION_KIND,
  FEEDBACK_DELIVERY_RECOVERY_CAUSE,
} from "../services/recovery/feedback-delivery.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres feedback-delivery retry route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("issue feedback-delivery retry routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-feedback-delivery-retry-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "board-user",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "admin", status: "active" }],
        isInstanceAdmin: false,
        source: "session",
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedExhaustedDelivery(input: { agentStatus?: string; withAgent?: boolean } = {}) {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const agentId = input.withAgent === false ? null : randomUUID();
    const rootWakeupRequestId = randomUUID();
    const sourceCommentId = randomUUID();
    const issuePrefix = `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    if (agentId) {
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: input.agentStatus ?? "paused",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Feedback delivery exhausted",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: issueId,
      kind: FEEDBACK_DELIVERY_RECOVERY_ACTION_KIND,
      status: "active",
      ownerType: agentId ? "agent" : "board",
      ownerAgentId: agentId,
      previousOwnerAgentId: agentId,
      returnOwnerAgentId: agentId,
      cause: FEEDBACK_DELIVERY_RECOVERY_CAUSE,
      fingerprint: `feedback_delivery:${companyId}:${issueId}:${agentId ?? "missing"}:${rootWakeupRequestId}`,
      evidence: {
        rootWakeupRequestId,
        outstandingCommentIds: [sourceCommentId],
      },
      nextAction: "Deliver the outstanding feedback",
      attemptCount: 1,
      maxAttempts: 1,
    });

    return { companyId, issueId };
  }

  it("returns a paused reason instead of leaking the wakeup 409", async () => {
    const { companyId, issueId } = await seedExhaustedDelivery({ agentStatus: "paused" });

    const res = await request(createApp(companyId))
      .post(`/api/issues/${issueId}/feedback-delivery/retry`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      outcome: "no_invokable_assignee",
      reason: "paused",
      message: "This delivery's agent is paused. Unpause the agent before retrying.",
    });
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(await db.select().from(activityLog)).toHaveLength(0);
  });

  it("distinguishes a missing assignee from a paused one", async () => {
    const { companyId, issueId } = await seedExhaustedDelivery({ withAgent: false });

    const res = await request(createApp(companyId))
      .post(`/api/issues/${issueId}/feedback-delivery/retry`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      outcome: "no_invokable_assignee",
      reason: "missing",
      message: "This delivery has no agent to retry against. Reassign the task first.",
    });
  });
});
