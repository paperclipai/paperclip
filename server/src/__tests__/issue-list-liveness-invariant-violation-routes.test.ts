import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  issueRelations,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

// AGE-755: a non-terminal issue (todo/in_progress/in_review/blocked) with no
// assigneeAgentId/assigneeUserId, no scheduled monitor, and no live (non
// done/cancelled) blocker is stranded -- nothing will ever wake it. This
// covers the three known-stranded shapes from the board sweep:
//   1. todo, never assigned
//   2. in_review after a changes_requested outcome cleared assigneeAgentId
//   3. blocked with an empty/all-resolved blockedByIssueIds

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue list route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue list routes livenessInvariantViolation filter", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-list-liveness-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function uniqueIssuePrefix() {
    return `P${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: "cloud-user-1",
      membershipRole: "owner",
      grantedByUserId: null,
    });
    return companyId;
  }

  it("flags a todo issue with no assignee and no monitor (shape 1)", async () => {
    const companyId = await seedCompany();
    const strandedId = randomUUID();
    const healthyAssignedId = randomUUID();
    const agentId = randomUUID();

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Owner Agent",
      role: "engineer",
      adapter: "claude_local",
      status: "active",
    });

    await db.insert(issues).values([
      {
        id: strandedId,
        companyId,
        title: "Stranded todo, never assigned",
        status: "todo",
        priority: "medium",
      },
      {
        id: healthyAssignedId,
        companyId,
        title: "Healthy todo, has an assignee",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ livenessInvariantViolation: "true", limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((issue: { id: string }) => issue.id)).toEqual([strandedId]);
  });

  it("flags an in_review issue left assignee-less after a changes_requested outcome (shape 2)", async () => {
    const companyId = await seedCompany();
    const strandedId = randomUUID();

    await db.insert(issues).values({
      id: strandedId,
      companyId,
      title: "In review, changes_requested cleared the assignee",
      status: "in_review",
      priority: "high",
      assigneeAgentId: null,
      assigneeUserId: null,
      executionState: {
        outcome: "changes_requested",
        returnAssignee: { type: "agent", agentId: randomUUID() },
      },
    });

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ livenessInvariantViolation: "true", limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((issue: { id: string }) => issue.id)).toEqual([strandedId]);
  });

  it("flags a blocked issue whose blockedByIssueIds are empty/all resolved (shape 3)", async () => {
    const companyId = await seedCompany();
    const strandedId = randomUUID();
    const stillBlockedId = randomUUID();
    const resolvedBlockerId = randomUUID();
    const liveBlockerId = randomUUID();
    const liveBlockerAssigneeId = randomUUID();

    await db.insert(agents).values({
      id: liveBlockerAssigneeId,
      companyId,
      name: "Blocker Owner Agent",
      role: "engineer",
      adapter: "claude_local",
      status: "active",
    });

    await db.insert(issues).values([
      {
        id: strandedId,
        companyId,
        title: "Blocked with no live blockers left",
        status: "blocked",
        priority: "medium",
      },
      {
        id: resolvedBlockerId,
        companyId,
        title: "Former blocker, now done",
        status: "done",
        priority: "medium",
      },
      {
        id: stillBlockedId,
        companyId,
        title: "Genuinely blocked, blocker still open",
        status: "blocked",
        priority: "medium",
      },
      {
        id: liveBlockerId,
        companyId,
        // Assigned so this itself does not independently trip the invariant --
        // its only role here is to be a genuinely live blocker for stillBlockedId.
        title: "Live blocker, still open",
        status: "todo",
        priority: "medium",
        assigneeAgentId: liveBlockerAssigneeId,
      },
    ]);

    // strandedId's only blocker relation points at a done issue -- stale/resolved,
    // so strandedId has no *live* blocker despite status=blocked.
    await db.insert(issueRelations).values({
      companyId,
      issueId: resolvedBlockerId,
      relatedIssueId: strandedId,
      type: "blocks",
    });
    // stillBlockedId has a genuinely live (todo) blocker and must NOT be flagged.
    await db.insert(issueRelations).values({
      companyId,
      issueId: liveBlockerId,
      relatedIssueId: stillBlockedId,
      type: "blocks",
    });

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ livenessInvariantViolation: "true", limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((issue: { id: string }) => issue.id)).toEqual([strandedId]);
  });

  it("returns 400 for a malformed livenessInvariantViolation flag", async () => {
    const companyId = await seedCompany();

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ livenessInvariantViolation: "not-a-bool", limit: "20" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "livenessInvariantViolation must be true or false when provided",
    });
  });
});
