import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueCreateIdempotencyKeys,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  ISSUE_CREATE_IDEMPOTENCY_KEY_RETENTION_DAYS,
  issueService,
} from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue create deduplication route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("issue create deduplication routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-create-deduplication-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueCreateIdempotencyKeys);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedParent(companyId: string) {
    const [parent] = await db.insert(issues).values({
      companyId,
      title: "Parent issue",
      status: "todo",
      priority: "medium",
    }).returning();
    return parent;
  }

  async function seedAgent(companyId: string, name: string) {
    const [agent] = await db.insert(agents).values({
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    return agent;
  }

  it("rejects an ineligible approval participant when a policy is created or patched", async () => {
    const companyId = await seedCompany();
    const coder = await seedAgent(companyId, "Coder");
    const qa = await seedAgent(companyId, "QA");
    const app = createApp();
    const executionPolicy = {
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: qa.id }] },
        { type: "approval", participants: [{ type: "agent", agentId: coder.id }] },
      ],
    };

    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Reject invalid policy on create", assigneeAgentId: coder.id, executionPolicy })
      .expect(400);
    expect(await db.select().from(issues)).toHaveLength(0);

    const [existing] = await db.insert(issues).values({
      companyId,
      title: "Reject invalid policy on patch",
      status: "todo",
      priority: "medium",
      assigneeAgentId: coder.id,
    }).returning();

    await request(app)
      .patch(`/api/issues/${existing.id}`)
      .send({ executionPolicy })
      .expect(400);
    const [persisted] = await db.select().from(issues).where(eq(issues.id, existing.id));
    expect(persisted.executionPolicy).toBeNull();

    await request(app)
      .patch(`/api/issues/${existing.id}`)
      .send({
        status: "done",
        assigneeAgentId: qa.id,
        executionPolicy: {
          mode: "normal",
          stages: [
            {
              type: "review",
              participants: [{ type: "agent", agentId: qa.id }],
            },
            {
              type: "approval",
              participants: [{ type: "agent", agentId: coder.id }],
            },
          ],
        },
      })
      .expect(400);
    const [unchanged] = await db.select().from(issues).where(eq(issues.id, existing.id));
    expect(unchanged).toMatchObject({
      status: "todo",
      assigneeAgentId: coder.id,
      executionPolicy: null,
    });

    const validPolicy = {
      stages: [{ type: "approval", participants: [{ type: "agent", agentId: qa.id }] }],
    };
    const [assigneeOnlyPatch] = await db.insert(issues).values({
      companyId,
      title: "Reject assignee-only invalidation",
      status: "todo",
      priority: "medium",
      assigneeAgentId: coder.id,
      executionPolicy: validPolicy,
    }).returning();
    await request(app)
      .patch(`/api/issues/${assigneeOnlyPatch.id}`)
      .send({ assigneeAgentId: qa.id })
      .expect(400);
    const [assigneeOnlyPersisted] = await db.select().from(issues).where(eq(issues.id, assigneeOnlyPatch.id));
    expect(assigneeOnlyPersisted.assigneeAgentId).toBe(coder.id);

    const activeReviewStageId = randomUUID();
    const nullReturnPolicy = {
      stages: [
        {
          id: activeReviewStageId,
          type: "review",
          participants: [{ type: "agent", agentId: qa.id }],
        },
        {
          id: randomUUID(),
          type: "approval",
          participants: [{ type: "agent", agentId: coder.id }],
        },
      ],
    };
    const [nullReturnAssignee] = await db.insert(issues).values({
      companyId,
      title: "Allow a null workflow return assignee",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: coder.id,
      executionState: {
        status: "pending",
        currentStageId: activeReviewStageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qa.id },
        returnAssignee: null,
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).returning();
    await request(app)
      .patch(`/api/issues/${nullReturnAssignee.id}`)
      .send({ executionPolicy: nullReturnPolicy })
      .expect(200);
  });

  it("serializes approval-policy narrowing with reassignment so they cannot jointly strand an approval", async () => {
    const companyId = await seedCompany();
    const coder = await seedAgent(companyId, "Coder");
    const qa = await seedAgent(companyId, "QA");
    const app = createApp();
    const [issue] = await db.insert(issues).values({
      companyId,
      title: "Serialize approval eligibility",
      status: "todo",
      priority: "medium",
      assigneeAgentId: coder.id,
      executionPolicy: {
        stages: [
          {
            type: "approval",
            participants: [
              { type: "agent", agentId: coder.id },
              { type: "agent", agentId: qa.id },
            ],
          },
        ],
      },
    }).returning();
    const advisoryLockKey = 28510960;
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION paperclip_test_pause_approval_policy_narrowing()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF NEW.execution_policy IS DISTINCT FROM OLD.execution_policy THEN
          PERFORM pg_advisory_xact_lock(${advisoryLockKey});
          PERFORM pg_sleep(1);
        END IF;
        RETURN NEW;
      END
      $function$;
      CREATE TRIGGER paperclip_test_pause_approval_policy_narrowing
      BEFORE UPDATE ON issues
      FOR EACH ROW EXECUTE FUNCTION paperclip_test_pause_approval_policy_narrowing();
    `));

    try {
      const narrowing = request(app)
        .patch(`/api/issues/${issue!.id}`)
        .send({
          executionPolicy: {
            stages: [{ type: "approval", participants: [{ type: "agent", agentId: qa.id }] }],
          },
        })
        .then((response) => response);

      let narrowingPaused = false;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const lockAvailable = await db.transaction(async (tx) => {
          const [result] = await tx.execute<{ acquired: boolean }>(
            sql`SELECT pg_try_advisory_lock(${advisoryLockKey}) AS acquired`,
          );
          if (result?.acquired) {
            await tx.execute(sql`SELECT pg_advisory_unlock(${advisoryLockKey})`);
          }
          return result?.acquired ?? false;
        });
        if (!lockAvailable) {
          narrowingPaused = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(narrowingPaused).toBe(true);

      let reassignmentFinished = false;
      const reassignment = request(app)
        .patch(`/api/issues/${issue!.id}`)
        .send({ assigneeAgentId: qa.id })
        .then((response) => {
          reassignmentFinished = true;
          return response;
        });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(reassignmentFinished).toBe(false);

      const [narrowed, reassigned] = await Promise.all([narrowing, reassignment]);
      expect.soft([narrowed.status, reassigned.status].sort()).toEqual([200, 400]);

      const [persisted] = await db.select().from(issues).where(eq(issues.id, issue!.id));
      expect.soft(persisted.assigneeAgentId).toBe(coder.id);
      expect.soft(persisted.executionPolicy).toMatchObject({
        stages: [{ type: "approval", participants: [{ type: "agent", agentId: qa.id }] }],
      });
    } finally {
      await db.execute(sql.raw(`
        DROP TRIGGER IF EXISTS paperclip_test_pause_approval_policy_narrowing ON issues;
        DROP FUNCTION IF EXISTS paperclip_test_pause_approval_policy_narrowing();
      `));
    }
  }, 20_000);

  it("rejects a workflow restart whose transition was planned from a stale policy", async () => {
    const companyId = await seedCompany();
    const coder = await seedAgent(companyId, "Coder");
    const qa = await seedAgent(companyId, "QA");
    const security = await seedAgent(companyId, "Security");
    const reviewStageId = randomUUID();
    const approvalStageId = randomUUID();
    const app = createApp();
    const [issue] = await db.insert(issues).values({
      companyId,
      title: "Restart from a current policy",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: coder.id,
      executionPolicy: {
        stages: [
          {
            id: reviewStageId,
            type: "review",
            participants: [{ type: "agent", agentId: qa.id }],
          },
          {
            id: approvalStageId,
            type: "approval",
            participants: [{ type: "agent", agentId: qa.id }],
          },
        ],
      },
      executionState: {
        status: "changes_requested",
        currentStageId: reviewStageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qa.id },
        returnAssignee: { type: "agent", agentId: coder.id },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: "changes_requested",
      },
    }).returning();
    const advisoryLockKey = 28510961;
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION paperclip_test_pause_restart_policy_update()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF NEW.execution_policy IS DISTINCT FROM OLD.execution_policy THEN
          PERFORM pg_advisory_xact_lock(${advisoryLockKey});
          PERFORM pg_sleep(1);
        END IF;
        RETURN NEW;
      END
      $function$;
      CREATE TRIGGER paperclip_test_pause_restart_policy_update
      BEFORE UPDATE ON issues
      FOR EACH ROW EXECUTE FUNCTION paperclip_test_pause_restart_policy_update();
    `));

    try {
      const policyUpdate = request(app)
        .patch(`/api/issues/${issue!.id}`)
        .send({
          executionPolicy: {
            stages: [
              {
                id: reviewStageId,
                type: "review",
                participants: [{ type: "agent", agentId: security.id }],
              },
              {
                id: approvalStageId,
                type: "approval",
                participants: [{ type: "agent", agentId: qa.id }],
              },
            ],
          },
        })
        .then((response) => response);

      let policyUpdatePaused = false;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const lockAvailable = await db.transaction(async (tx) => {
          const [result] = await tx.execute<{ acquired: boolean }>(
            sql`SELECT pg_try_advisory_lock(${advisoryLockKey}) AS acquired`,
          );
          if (result?.acquired) {
            await tx.execute(sql`SELECT pg_advisory_unlock(${advisoryLockKey})`);
          }
          return result?.acquired ?? false;
        });
        if (!lockAvailable) {
          policyUpdatePaused = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(policyUpdatePaused).toBe(true);

      let restartFinished = false;
      const restart = request(app)
        .patch(`/api/issues/${issue!.id}`)
        .send({ status: "done" })
        .then((response) => {
          restartFinished = true;
          return response;
        });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(restartFinished).toBe(false);

      const [updatedPolicy, restarted] = await Promise.all([policyUpdate, restart]);
      expect.soft([updatedPolicy.status, restarted.status].sort()).toEqual([200, 409]);

      const [persisted] = await db.select().from(issues).where(eq(issues.id, issue!.id));
      expect.soft(persisted.executionPolicy).toMatchObject({
        stages: [
          { participants: [{ type: "agent", agentId: security.id }] },
          { participants: [{ type: "agent", agentId: qa.id }] },
        ],
      });
      expect.soft(persisted.executionState).toMatchObject({
        status: "changes_requested",
        currentParticipant: { type: "agent", agentId: qa.id },
      });
    } finally {
      await db.execute(sql.raw(`
        DROP TRIGGER IF EXISTS paperclip_test_pause_restart_policy_update ON issues;
        DROP FUNCTION IF EXISTS paperclip_test_pause_restart_policy_update();
      `));
    }
  }, 20_000);

  it("rejects a workflow start whose transition was planned from a stale policy", async () => {
    const companyId = await seedCompany();
    const coder = await seedAgent(companyId, "Coder");
    const qa = await seedAgent(companyId, "QA");
    const security = await seedAgent(companyId, "Security");
    const app = createApp();
    const [issue] = await db.insert(issues).values({
      companyId,
      title: "Start from a current policy",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: coder.id,
      executionPolicy: {
        stages: [
          { type: "review", participants: [{ type: "agent", agentId: qa.id }] },
          { type: "approval", participants: [{ type: "agent", agentId: qa.id }] },
        ],
      },
    }).returning();
    const advisoryLockKey = 28510962;
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION paperclip_test_pause_start_policy_update()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF NEW.execution_policy IS DISTINCT FROM OLD.execution_policy THEN
          PERFORM pg_advisory_xact_lock(${advisoryLockKey});
          PERFORM pg_sleep(1);
        END IF;
        RETURN NEW;
      END
      $function$;
      CREATE TRIGGER paperclip_test_pause_start_policy_update
      BEFORE UPDATE ON issues
      FOR EACH ROW EXECUTE FUNCTION paperclip_test_pause_start_policy_update();
    `));

    try {
      const policyUpdate = request(app)
        .patch(`/api/issues/${issue!.id}`)
        .send({
          executionPolicy: {
            stages: [
              { type: "review", participants: [{ type: "agent", agentId: security.id }] },
              { type: "approval", participants: [{ type: "agent", agentId: qa.id }] },
            ],
          },
        })
        .then((response) => response);

      let policyUpdatePaused = false;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const lockAvailable = await db.transaction(async (tx) => {
          const [result] = await tx.execute<{ acquired: boolean }>(
            sql`SELECT pg_try_advisory_lock(${advisoryLockKey}) AS acquired`,
          );
          if (result?.acquired) {
            await tx.execute(sql`SELECT pg_advisory_unlock(${advisoryLockKey})`);
          }
          return result?.acquired ?? false;
        });
        if (!lockAvailable) {
          policyUpdatePaused = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(policyUpdatePaused).toBe(true);

      let workflowStartFinished = false;
      const workflowStart = request(app)
        .patch(`/api/issues/${issue!.id}`)
        .send({ status: "done" })
        .then((response) => {
          workflowStartFinished = true;
          return response;
        });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(workflowStartFinished).toBe(false);

      const [updatedPolicy, started] = await Promise.all([policyUpdate, workflowStart]);
      expect.soft([updatedPolicy.status, started.status].sort()).toEqual([200, 409]);

      const [persisted] = await db.select().from(issues).where(eq(issues.id, issue!.id));
      expect.soft(persisted.status).toBe("in_progress");
      expect.soft(persisted.executionState).toBeNull();
      expect.soft(persisted.executionPolicy).toMatchObject({
        stages: [
          { participants: [{ type: "agent", agentId: security.id }] },
          { participants: [{ type: "agent", agentId: qa.id }] },
        ],
      });
    } finally {
      await db.execute(sql.raw(`
        DROP TRIGGER IF EXISTS paperclip_test_pause_start_policy_update ON issues;
        DROP FUNCTION IF EXISTS paperclip_test_pause_start_policy_update();
      `));
    }
  }, 20_000);

  it("allows unrelated status changes for legacy invalid policies but still rejects workflow starts", async () => {
    const companyId = await seedCompany();
    const coder = await seedAgent(companyId, "Coder");
    const legacyInvalidPolicy = {
      stages: [{ type: "approval", participants: [{ type: "agent", agentId: coder.id }] }],
    };
    const [legacyStatusIssue, legacyWorkflowStartIssue] = await db.insert(issues).values([
      {
        companyId,
        title: "Legacy invalid policy status transition",
        status: "todo",
        priority: "medium",
        assigneeAgentId: coder.id,
        executionPolicy: legacyInvalidPolicy,
      },
      {
        companyId,
        title: "Legacy invalid policy workflow start",
        status: "todo",
        priority: "medium",
        assigneeAgentId: coder.id,
        executionPolicy: legacyInvalidPolicy,
      },
    ]).returning();
    const app = createApp();

    const unrelatedStatus = await request(app)
      .patch(`/api/issues/${legacyStatusIssue!.id}`)
      .send({ status: "cancelled" });
    expect.soft(unrelatedStatus.status).toBe(200);
    expect.soft((await db.select().from(issues).where(eq(issues.id, legacyStatusIssue!.id)))[0]).toMatchObject({
      status: "cancelled",
    });

    const workflowStart = await request(app)
      .patch(`/api/issues/${legacyWorkflowStartIssue!.id}`)
      .send({ status: "done" });
    expect.soft(workflowStart.status).toBe(400);
  });

  it("replays the existing issue for the same company idempotency key", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();

    const first = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Prepare release", idempotencyKey: "run-1:prepare-release" })
      .expect(201);
    const replay = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        parentId: parent.id,
        title: "Different retry payload",
        idempotencyKey: "run-1:prepare-release",
        allowDuplicate: true,
      })
      .expect(200);

    expect(replay.body).toMatchObject({
      id: first.body.id,
      title: "Prepare release",
      deduplicated: true,
      deduplicationReason: "idempotency_key",
    });
    expect(await db.select().from(issueCreateIdempotencyKeys)).toHaveLength(1);
  });

  it("expires old idempotency keys before replay lookup", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();
    const oldIssueId = randomUUID();
    const idempotencyKey = "run-1:expired-retry";
    const expiredCreatedAt = new Date(
      Date.now() - (ISSUE_CREATE_IDEMPOTENCY_KEY_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000,
    );
    await db.insert(issues).values({
      id: oldIssueId,
      companyId,
      parentId: parent.id,
      title: "Expired retry target",
      status: "todo",
      priority: "medium",
    });
    await db.insert(issueCreateIdempotencyKeys).values({
      companyId,
      idempotencyKey,
      issueId: oldIssueId,
      createdAt: expiredCreatedAt,
    });

    const recreated = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Expired retry creates new work", idempotencyKey })
      .expect(201);

    const rows = await db.select().from(issueCreateIdempotencyKeys);
    expect(recreated.body.id).not.toBe(oldIssueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyId,
      idempotencyKey,
      issueId: recreated.body.id,
    });
  });

  it("returns a recent open sibling whose normalized title matches", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();

    const first = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Create   a single PR" })
      .expect(201);
    const duplicate = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "  create a SINGLE pr  " })
      .expect(200);

    expect(duplicate.body).toMatchObject({
      id: first.body.id,
      deduplicated: true,
      deduplicationReason: "recent_open_title",
    });
  });

  it("serializes keyed and title-only creates for the same issue", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();

    const [keyed, titleOnly] = await Promise.all([
      request(app)
        .post(`/api/companies/${companyId}/issues`)
        .send({ parentId: parent.id, title: "Coordinate launch", idempotencyKey: "run-2:coordinate-launch" }),
      request(app)
        .post(`/api/companies/${companyId}/issues`)
        .send({ parentId: parent.id, title: "Coordinate launch" }),
    ]);

    expect([keyed.status, titleOnly.status].sort()).toEqual([200, 201]);
    expect(keyed.body.id).toBe(titleOnly.body.id);
    expect([keyed, titleOnly].find((response) => response.status === 200)?.body).toMatchObject({
      deduplicated: true,
      deduplicationReason: "recent_open_title",
    });
    expect(await db.select().from(issues).where(eq(issues.parentId, parent.id))).toHaveLength(1);
    expect(await db.select().from(issueCreateIdempotencyKeys)).toEqual([
      expect.objectContaining({ issueId: keyed.body.id, idempotencyKey: "run-2:coordinate-launch" }),
    ]);

    const replay = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Different title", idempotencyKey: "run-2:coordinate-launch" })
      .expect(200);
    expect(replay.body).toMatchObject({
      id: keyed.body.id,
      deduplicated: true,
      deduplicationReason: "idempotency_key",
    });
  });

  it("allows an explicit duplicate create", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();

    const first = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Investigate incident" })
      .expect(201);
    const duplicate = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Investigate incident", allowDuplicate: true })
      .expect(201);

    expect(duplicate.body.id).not.toBe(first.body.id);
  });

  it("does not apply the route soft guard to internal service creates", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const svc = issueService(db);

    const first = await svc.create(companyId, {
      parentId: parent.id,
      title: "System-generated follow-up",
      status: "todo",
      priority: "medium",
    });
    const second = await svc.create(companyId, {
      parentId: parent.id,
      title: "System-generated follow-up",
      status: "todo",
      priority: "medium",
    });

    expect(second.id).not.toBe(first.id);
  });

  it("does not let closed or older issues block a recreate", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();
    const oldIssueId = randomUUID();
    const closedIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: oldIssueId,
        companyId,
        parentId: parent.id,
        title: "Retry old work",
        status: "todo",
        priority: "medium",
        createdAt: new Date(Date.now() - 49 * 60 * 60 * 1000),
      },
      {
        id: closedIssueId,
        companyId,
        parentId: parent.id,
        title: "Retry closed work",
        status: "done",
        priority: "medium",
      },
    ]);

    const recreatedOld = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Retry old work" })
      .expect(201);
    const recreatedClosed = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Retry closed work" })
      .expect(201);

    expect(recreatedOld.body.id).not.toBe(oldIssueId);
    expect(recreatedClosed.body.id).not.toBe(closedIssueId);
  });

  it("stores the request run header on manual creates", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();
    const runId = randomUUID();
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Creating agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
    });

    const response = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ parentId: parent.id, title: "Attributed create" })
      .expect(201);
    const [created] = await db.select().from(issues).where(eq(issues.id, response.body.id));

    expect(created.originKind).toBe("manual");
    expect(created.originRunId).toBe(runId);
  });
});
