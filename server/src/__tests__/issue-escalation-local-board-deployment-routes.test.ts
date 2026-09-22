import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentApiKeys,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * The board sentinel `local-board` is reachable exactly where the deployment
 * assumes it for every request. These cases drive the real
 * `actorMiddleware` + `issueRoutes` pair, because the defect they cover lived
 * in the seam between them: the middleware replaces a `local_implicit` actor
 * with `agent_key`/`agent_jwt` as soon as a valid bearer arrives — including
 * under `local_trusted` — and a reachability test reading the credential
 * source therefore saw a `local_trusted` request as an authenticated one.
 */

const LOCAL_BOARD_SENTINEL_USER_ID = "local-board";
const MAX_REVIEW_ROUNDS = 3;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres local-board escalation route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("review escalation to the local board sentinel", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-local-board-escalation-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  // Each case seeds its own company and agents under fresh UUIDs, so rows from
  // an earlier case are invisible to it and nothing has to be deleted between
  // cases — which is lucky, because a delete here deadlocks: the PATCH answers
  // before its fire-and-forget wake, and that wake holds the run and agent rows
  // this teardown would be locking in the opposite order. For the same reason
  // the settle has to precede the teardown, or the wake is still mid-query when
  // the pool closes.
  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await tempDb?.cleanup();
  });

  function hashToken(token: string) {
    return createHash("sha256").update(token).digest("hex");
  }

  async function seedEscalationFixture() {
    const companyId = randomUUID();
    const coderAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const memberUserId = `member-${companyId.slice(0, 8)}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Escalation Company",
      issuePrefix: `ESC${companyId.slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: coderAgentId,
        companyId,
        name: "Coder",
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
        name: "Reviewer",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(companyMemberships).values([
      {
        companyId,
        principalType: "user",
        principalId: memberUserId,
        status: "active",
        membershipRole: "operator",
      },
      // In a local_trusted deployment the sentinel owns the company, so
      // assigning a stage to it is a legitimate escalation there. Off that
      // deployment the membership exists too — what is missing is a
      // credential that resolves to it.
      {
        companyId,
        principalType: "user",
        principalId: LOCAL_BOARD_SENTINEL_USER_ID,
        status: "active",
        membershipRole: "owner",
      },
    ]);
    // The bearer path resolves the key's responsible user into a company
    // scope; without the auth row the request is refused before it reaches
    // the transition under test.
    // The sentinel is a fixed id shared by every case, so a second case in this
    // file re-inserts it; the first row already carries the same values.
    await db.insert(authUsers).values([
      {
        id: memberUserId,
        name: "Escalation Member",
        email: `${memberUserId}@example.test`,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      // The sentinel is a real users row; assigning the stage to it is only a
      // dead end because no credential resolves to it off local_trusted.
      {
        id: LOCAL_BOARD_SENTINEL_USER_ID,
        name: "Local Board",
        email: "local-board@paperclip.local",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]).onConflictDoNothing();

    const token = `pc_agent_${randomUUID().replace(/-/g, "")}`;
    await db.insert(agentApiKeys).values({
      id: randomUUID(),
      agentId: qaAgentId,
      companyId,
      name: "Reviewer key",
      keyHash: hashToken(token),
      responsibleUserId: memberUserId,
    });

    const policy = {
      mode: "normal",
      commentRequired: true,
      stages: [
        {
          id: randomUUID(),
          type: "review",
          participants: [{ type: "agent", agentId: qaAgentId }],
        },
      ],
    };
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `ESC-${randomUUID().slice(0, 8)}`,
      title: "Round cap reached",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: qaAgentId,
      // The sentinel is the responsible user, so the round cap has somewhere to
      // escalate to. Whether it is reachable is the deployment's question.
      responsibleUserId: LOCAL_BOARD_SENTINEL_USER_ID,
      createdByUserId: LOCAL_BOARD_SENTINEL_USER_ID,
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0]!.id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qaAgentId },
        returnAssignee: { type: "agent", agentId: coderAgentId },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        changesRequestedCount: MAX_REVIEW_ROUNDS - 1,
      },
    });

    // An agent write is attributed to a heartbeat run bound to the issue, so
    // the cross-issue guard sees an in-issue update rather than a drive-by.
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: qaAgentId,
      status: "running",
      responsibleUserId: memberUserId,
      contextSnapshot: { issueId },
    });

    return { companyId, coderAgentId, qaAgentId, issueId, token, runId };
  }

  function app(deploymentMode: "local_trusted" | "authenticated") {
    const testApp = express();
    testApp.use(express.json());
    testApp.use(actorMiddleware(db, { deploymentMode }));
    testApp.use("/api", issueRoutes(db, {} as never));
    testApp.use(errorHandler);
    return testApp;
  }

  it("keeps the deployment stamp when a bearer credential replaces the actor", async () => {
    const { token } = await seedEscalationFixture();
    const testApp = express();
    testApp.use(express.json());
    testApp.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    testApp.get("/probe", (req, res) => {
      res.json(req.actor);
    });

    const response = await request(testApp)
      .get("/probe")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    // The credential owns `source`; the deployment is a separate fact that
    // must survive it. A reachability rule reading `source` fails here.
    expect(response.body.source).toBe("agent_key");
    expect(response.body.deploymentMode).toBe("local_trusted");
    expect(response.body.type).toBe("agent");
  });

  it("escalates the round cap to the sentinel for a local_trusted agent request", async () => {
    const { qaAgentId, issueId, token, runId } = await seedEscalationFixture();

    await request(app("local_trusted"))
      .patch(`/api/issues/${issueId}`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ status: "in_progress", comment: "Round three feedback — still not converging" })
      .expect(200);

    const updated = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(updated.assigneeUserId).toBe(LOCAL_BOARD_SENTINEL_USER_ID);
    expect(updated.assigneeAgentId).toBeNull();
    expect(updated.executionState).toMatchObject({
      status: "pending",
      currentStageType: "review",
      currentParticipant: { type: "user", userId: LOCAL_BOARD_SENTINEL_USER_ID },
      changesRequestedCount: MAX_REVIEW_ROUNDS,
    });
  });

  it("hands the round back instead of parking it on the sentinel off local_trusted", async () => {
    const { coderAgentId, issueId, token, runId } = await seedEscalationFixture();

    await request(app("authenticated"))
      .patch(`/api/issues/${issueId}`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ status: "in_progress", comment: "Round three feedback — still not converging" })
      .expect(200);

    const updated = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    // Nothing off local_trusted can authenticate as the sentinel, so naming it
    // here would strand the stage. The round returns to the implementer.
    expect(updated.assigneeUserId).toBeNull();
    expect(updated.assigneeAgentId).toBe(coderAgentId);
    expect(updated.executionState).toMatchObject({
      status: "changes_requested",
      changesRequestedCount: MAX_REVIEW_ROUNDS,
    });
  });
});
