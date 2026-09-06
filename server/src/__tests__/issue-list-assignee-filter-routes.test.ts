import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
  goals,
  heartbeatRuns,
  issueLabels,
  issueRelations,
  issues,
  labels,
  principalPermissionGrants,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import {
  __clearIssueListResponseCacheForTests,
  __getIssueListResponseCacheSizeForTests,
  ISSUE_LIST_SERVER_CACHE_MAX_ENTRIES,
  issueRoutes,
} from "../routes/issues.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { issueService } from "../services/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { resolveRequiredSuccessfulRunHandoffOnValidPath } from "../services/successful-run-handoff-state.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue list route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue list routes assigneeAgentId filter", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-list-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    __clearIssueListResponseCacheForTests();
    await db.delete(issueLabels);
    await db.delete(issues);
    await db.delete(labels);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(goals);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(
    companyId: string,
    opts: Parameters<typeof issueRoutes>[2] = {},
  ) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const userId = req.header("x-test-user-id") ?? "cloud-user-1";
      (req as any).actor = {
        type: "board",
        userId,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active", principalId: userId }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, opts));
    app.use(errorHandler);
    return app;
  }


  function uniqueIssuePrefix() {
    return `P${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
  }

  async function seedCloudTenantMember(companyId: string, userId = "cloud-user-1") {
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: userId,
      membershipRole: "owner",
      grantedByUserId: null,
    });
  }

  it("returns only unassigned issues for assigneeAgentId=null", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const assignedIssueId = randomUUID();
    const unassignedIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "Assignee",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: assignedIssueId,
        companyId,
        title: "Assigned issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId,
      },
      {
        id: unassignedIssueId,
        companyId,
        title: "Unassigned issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: null,
      },
    ]);

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "todo", assigneeAgentId: "null", limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((issue: { id: string }) => issue.id)).toEqual([unassignedIssueId]);
  });

  it("returns compact issue list rows with recovery chips but without detail-only fields", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Recovery owner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Compact issue",
      description: "This long detail belongs on the issue detail endpoint, not the board list.",
      status: "todo",
      priority: "medium",
      billingCode: "product",
    });
    const recoveryAction = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId,
      sourceIssueId: issueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:compact-route",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.successful_run_handoff_required",
      entityType: "issue",
      entityId: issueId,
      agentId: ownerAgentId,
      runId: null,
      details: {
        sourceRunId,
        detectedProgressSummary: "Implemented the requested change without choosing a disposition.",
      },
    });

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ view: "compact", limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers.etag).toMatch(/^"compact-issues:/);
    expect(res.headers["cache-control"]).toBe("private, must-revalidate");
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: issueId,
      companyId,
      title: "Compact issue",
      description: "This long detail belongs on the issue detail endpoint, not the board list.",
      status: "todo",
      priority: "medium",
      billingCode: "product",
      activeRecoveryAction: {
        id: recoveryAction.id,
        sourceIssueId: issueId,
        ownerAgentId,
        kind: "missing_disposition",
      },
      successfulRunHandoff: {
        state: "required",
        required: true,
        hasLiveContinuation: false,
        sourceRunId,
        assigneeAgentId: ownerAgentId,
      },
    });
    expect(res.body[0]).not.toHaveProperty("workProducts");
    expect(res.body[0]).not.toHaveProperty("project");
    expect(res.body[0]).not.toHaveProperty("goal");
  });

  it("marks a required successful-run handoff live while a run targets the issue", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Assignee",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Live handoff issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.successful_run_handoff_required",
      entityType: "issue",
      entityId: issueId,
      agentId,
      details: { sourceRunId: randomUUID() },
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { taskId: issueId },
    });

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ view: "compact", limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body[0]?.successfulRunHandoff).toMatchObject({
      state: "required",
      required: true,
      hasLiveContinuation: true,
      liveRunId: runId,
    });
  });

  it("marks an escalated successful-run handoff live while a run targets the issue", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Assignee",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Escalated handoff issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.successful_run_handoff_escalated",
      entityType: "issue",
      entityId: issueId,
      agentId,
      details: { sourceRunId: randomUUID() },
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { taskId: issueId },
    });

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ view: "compact", limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body[0]?.successfulRunHandoff).toMatchObject({
      state: "escalated",
      required: false,
      hasLiveContinuation: true,
      liveRunId: runId,
    });
  });

  it("logs resolved when a valid-path skip closes a stale required handoff", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const resolverRunId = randomUUID();
    const sourceRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Assignee",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: resolverRunId,
      companyId,
      agentId,
      status: "succeeded",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `${uniqueIssuePrefix()}-1`,
      title: "Stale handoff",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "heartbeat",
      action: "issue.successful_run_handoff_required",
      entityType: "issue",
      entityId: issueId,
      agentId,
      details: { sourceRunId },
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
    });

    await expect(resolveRequiredSuccessfulRunHandoffOnValidPath(db, {
      companyId,
      issueId,
      issueIdentifier: "PAP-1",
      agentId,
      runId: resolverRunId,
      skipReason: "persisted issue monitor owns the next action",
    })).resolves.toBe(true);

    const resolved = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.find((row) => row.action === "issue.successful_run_handoff_resolved"));
    expect(resolved).toMatchObject({
      runId: resolverRunId,
      details: {
        sourceRunId,
        resolvedByRunId: resolverRunId,
        resolvedBySkipReason: "persisted issue monitor owns the next action",
      },
    });
  });

  it("returns 304 for unchanged compact issue list ETags", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cached compact issue",
      status: "todo",
      priority: "medium",
    });

    const app = createApp(companyId);
    const first = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ view: "compact", limit: "20" });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.headers.etag).toBeTruthy();

    const second = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ view: "compact", limit: "20" })
      .set("If-None-Match", first.headers.etag);

    expect(second.status).toBe(304);
    expect(second.text).toBe("");
  });

  it("coalesces simultaneous identical compact issue-list requests into one service computation", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    let computeCount = 0;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Coalesced issue",
      status: "todo",
      priority: "medium",
    });

    const app = createApp(companyId, {
      issueListDiagnostics: {
        async onComputeStart() {
          computeCount += 1;
          await new Promise((resolve) => setTimeout(resolve, 50));
        },
      },
    });
    const responses = await Promise.all(Array.from({ length: 10 }, () =>
      request(app)
        .get(`/api/companies/${companyId}/issues`)
        .query({ view: "compact", limit: "20" })
    ));

    expect(responses.every((res) => res.status === 200)).toBe(true);
    expect(responses.map((res) => res.body.map((issue: { id: string }) => issue.id))).toEqual(
      Array.from({ length: 10 }, () => [issueId]),
    );
    expect(computeCount).toBe(1);
    expect(responses.some((res) => res.headers["x-paperclip-request-cache"] === "coalesced")).toBe(true);
  });

  it("keeps compact issue-list cache keys separated by board user identity", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    let computeCount = 0;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId, "cloud-user-1");
    await seedCloudTenantMember(companyId, "cloud-user-2");
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Separated issue",
      status: "todo",
      priority: "medium",
    });

    const app = createApp(companyId, {
      issueListDiagnostics: {
        async onComputeStart() {
          computeCount += 1;
          await new Promise((resolve) => setTimeout(resolve, 40));
        },
      },
    });
    const [first, second] = await Promise.all([
      request(app)
        .get(`/api/companies/${companyId}/issues`)
        .set("X-Test-User-Id", "cloud-user-1")
        .query({ view: "compact", limit: "20" }),
      request(app)
        .get(`/api/companies/${companyId}/issues`)
        .set("X-Test-User-Id", "cloud-user-2")
        .query({ view: "compact", limit: "20" }),
    ]);

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(computeCount).toBe(2);
    expect(first.headers["x-paperclip-request-cache"]).toBe("miss");
    expect(second.headers["x-paperclip-request-cache"]).toBe("miss");
  });

  it("serves repeated compact issue-list requests from the short server cache", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    let computeCount = 0;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cached issue",
      status: "todo",
      priority: "medium",
    });

    const app = createApp(companyId, {
      issueListDiagnostics: {
        onComputeStart() {
          computeCount += 1;
        },
      },
    });
    const first = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ view: "compact", limit: "20" });
    const second = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ view: "compact", limit: "20" });

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(computeCount).toBe(1);
    expect(first.headers["x-paperclip-request-cache"]).toBe("miss");
    expect(second.headers["x-paperclip-request-cache"]).toBe("hit");
  });

  it("bounds compact issue-list server cache entries", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Bounded cache issue",
      status: "todo",
      priority: "medium",
    });

    const app = createApp(companyId);
    for (let index = 0; index < ISSUE_LIST_SERVER_CACHE_MAX_ENTRIES + 5; index += 1) {
      const res = await request(app)
        .get(`/api/companies/${companyId}/issues`)
        .query({ view: "compact", limit: "20", q: `cache-key-${index}` });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }

    expect(__getIssueListResponseCacheSizeForTests()).toBe(ISSUE_LIST_SERVER_CACHE_MAX_ENTRIES);
  });

  it("logs request_storm_detected for identical in-flight compact issue-list fanout without query values", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const stormEvents: unknown[] = [];

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Storm issue",
      status: "todo",
      priority: "medium",
    });

    const app = createApp(companyId, {
      issueListDiagnostics: {
        async onComputeStart() {
          await new Promise((resolve) => setTimeout(resolve, 50));
        },
        onStormDetected(event) {
          stormEvents.push(event);
        },
      },
    });
    const responses = await Promise.all(Array.from({ length: 5 }, () =>
      request(app)
        .get(`/api/companies/${companyId}/issues`)
        .set("Referer", "http://localhost:3100/issues?q=do-not-log-this")
        .set("X-Paperclip-Tab-Visible", "visible")
        .query({ view: "compact", limit: "20", q: "do-not-log-this" })
    ));

    expect(responses.every((res) => res.status === 200)).toBe(true);
    expect(stormEvents).toHaveLength(1);
    expect(stormEvents[0]).toMatchObject({
      event: "request_storm_detected",
      route: "GET /api/companies/:companyId/issues",
      companyId,
      visibilityHint: "visible",
      referer: "/issues",
    });
    expect((stormEvents[0] as { queryKeys: string[] }).queryKeys).toEqual(
      expect.arrayContaining(["limit", "q", "view"]),
    );
    expect(JSON.stringify(stormEvents[0])).not.toContain("do-not-log-this");
  });

  it("keeps UUID assignee filtering behavior unchanged", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const otherAgentId = randomUUID();
    const assignedIssueId = randomUUID();
    const otherIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(agents).values([
      {
        id: assigneeAgentId,
        companyId,
        name: "Assignee",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "Other",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values([
      {
        id: assignedIssueId,
        companyId,
        title: "Assigned issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId,
      },
      {
        id: otherIssueId,
        companyId,
        title: "Other issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: otherAgentId,
      },
    ]);

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "todo", assigneeAgentId, limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((issue: { id: string }) => issue.id)).toEqual([assignedIssueId]);
  });

  it("returns 400 for malformed UUID issue list filters", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);

    const app = createApp(companyId);
    const params = [
      "assigneeAgentId",
      "participantAgentId",
      "goalId",
      "createdByAgentId",
      "projectId",
      "workspaceId",
      "executionWorkspaceId",
      "parentId",
      "descendantOf",
      "labelId",
    ] as const;

    for (const param of params) {
      const res = await request(app)
        .get(`/api/companies/${companyId}/issues`)
        .query({ status: "todo", [param]: "bad", limit: "20" });

      expect(res.status, `${param}: ${JSON.stringify(res.body)}`).toBe(400);
      expect(res.body).toMatchObject({
        error: param === "assigneeAgentId"
          ? "assigneeAgentId must be a UUID or 'null'"
          : `${param} must be a UUID`,
      });
      expect(res.body).not.toHaveProperty("issues");
    }

    // The empty skip exempts one value and only one. `"null"` is the token most
    // likely to be folded into it — `assigneeAgentId` genuinely does accept it —
    // and a skip widened that far turns each of these into a silently ignored
    // filter instead of a 400.
    for (const param of params) {
      if (param === "assigneeAgentId") continue;
      const res = await request(app)
        .get(`/api/companies/${companyId}/issues`)
        .query({ status: "todo", [param]: "null", limit: "20" });

      expect(res.status, `${param}: ${JSON.stringify(res.body)}`).toBe(400);
      expect(res.body).toMatchObject({ error: `${param} must be a UUID` });
    }
  });

  it("returns 400 for malformed UUID issue count filters", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);

    const app = createApp(companyId);

    // Control: the same route without a UUID filter must stay green, otherwise
    // a blanket 400 would make the loop below prove nothing.
    const baseline = await request(app)
      .get(`/api/companies/${companyId}/issues/count`)
      .query({ attention: "blocked" });
    expect(baseline.status, JSON.stringify(baseline.body)).toBe(200);
    expect(baseline.body).toMatchObject({ count: 0 });

    // `goalId` and `createdByAgentId` are deliberately absent: they are in
    // `ISSUE_LIST_UUID_FILTER_NAMES` but not `ISSUE_COUNT_UUID_FILTER_NAMES`, so
    // the count route never parses them and `?goalId=bad` is a 200 here.
    const params = [
      "assigneeAgentId",
      "participantAgentId",
      "projectId",
      "workspaceId",
      "executionWorkspaceId",
      "parentId",
      "descendantOf",
      "labelId",
    ] as const;

    for (const param of params) {
      const res = await request(app)
        .get(`/api/companies/${companyId}/issues/count`)
        .query({ attention: "blocked", [param]: "bad" });

      expect(res.status, `${param}: ${JSON.stringify(res.body)}`).toBe(400);
      expect(res.body).toMatchObject({
        error: param === "assigneeAgentId"
          ? "assigneeAgentId must be a UUID or 'null'"
          : `${param} must be a UUID`,
      });
      expect(res.body).not.toHaveProperty("count");
    }

    const aliasRes = await request(app)
      .get(`/api/companies/${companyId}/issues/count`)
      .query({ attention: "blocked", parentIssueId: "bad" });
    expect(aliasRes.status, JSON.stringify(aliasRes.body)).toBe(400);
    expect(aliasRes.body).toMatchObject({ error: "parentIssueId must be a UUID" });

    // A malformed `parentIssueId` that `parentId` supersedes is never read, so it
    // must stay 200 exactly as it was before this guard existed. Validating it
    // would 400 a request that has always succeeded.
    const supersededAliasRes = await request(app)
      .get(`/api/companies/${companyId}/issues/count`)
      .query({ attention: "blocked", parentId: randomUUID(), parentIssueId: "bad" });
    expect(supersededAliasRes.status, JSON.stringify(supersededAliasRes.body)).toBe(200);
    expect(supersededAliasRes.body).toMatchObject({ count: 0 });

    const nullAssigneeRes = await request(app)
      .get(`/api/companies/${companyId}/issues/count`)
      .query({ attention: "blocked", assigneeAgentId: "null" });
    expect(nullAssigneeRes.status, JSON.stringify(nullAssigneeRes.body)).toBe(200);
    expect(nullAssigneeRes.body).toMatchObject({ count: 0 });

    // Pin that asymmetry as an assertion rather than only as the comment above.
    // Adding either name to `ISSUE_COUNT_UUID_FILTER_NAMES` turns each of these
    // long-standing 200s into a 400 — a caller-visible contract change that has
    // to be a deliberate edit to this test, not a silent widening.
    for (const unguarded of ["goalId", "createdByAgentId"] as const) {
      const res = await request(app)
        .get(`/api/companies/${companyId}/issues/count`)
        .query({ attention: "blocked", [unguarded]: "bad" });
      expect(res.status, `${unguarded}: ${JSON.stringify(res.body)}`).toBe(200);
      expect(res.body).toMatchObject({ count: 0 });
    }
  });

  it("treats an empty UUID filter value as absent on both routes", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const blockedIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Assignee",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: issueId,
        companyId,
        title: "Visible issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked issue",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);
    // The blocked-inbox count only counts issues that carry blocked attention,
    // so the count control below needs a real `blocks` edge to be non-zero.
    await db.insert(issueRelations).values({
      id: randomUUID(),
      companyId,
      issueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const app = createApp(companyId);
    const params = [
      "assigneeAgentId",
      "participantAgentId",
      "goalId",
      "createdByAgentId",
      "projectId",
      "workspaceId",
      "executionWorkspaceId",
      "parentId",
      "descendantOf",
      "labelId",
    ] as const;

    // Control: the unfiltered responses must be non-empty, or "empty value means
    // absent" and "empty value filtered everything out" would look identical.
    const listBaseline = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "todo", limit: "20" });
    expect(listBaseline.status, JSON.stringify(listBaseline.body)).toBe(200);
    const baselineIds = listBaseline.body.map((issue: { id: string }) => issue.id);
    expect(baselineIds).toEqual([issueId]);

    for (const param of params) {
      const res = await request(app)
        .get(`/api/companies/${companyId}/issues`)
        .query({ status: "todo", [param]: "", limit: "20" });

      expect(res.status, `${param}: ${JSON.stringify(res.body)}`).toBe(200);
      expect(res.body.map((issue: { id: string }) => issue.id), param).toEqual(baselineIds);
    }

    // `parentId ?? parentIssueId` resolves on presence, not on emptiness: a
    // present-but-empty `parentId` suppresses the alias, so this shape has
    // always been the unfiltered 200.
    const supersededAliasRes = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "todo", parentId: "", parentIssueId: randomUUID(), limit: "20" });
    expect(supersededAliasRes.status, JSON.stringify(supersededAliasRes.body)).toBe(200);
    expect(supersededAliasRes.body.map((issue: { id: string }) => issue.id)).toEqual(baselineIds);

    const countBaseline = await request(app)
      .get(`/api/companies/${companyId}/issues/count`)
      .query({ attention: "blocked" });
    expect(countBaseline.status, JSON.stringify(countBaseline.body)).toBe(200);
    const baselineCount = countBaseline.body.count as number;
    expect(baselineCount).toBeGreaterThan(0);

    for (const param of params) {
      const res = await request(app)
        .get(`/api/companies/${companyId}/issues/count`)
        .query({ attention: "blocked", [param]: "" });

      expect(res.status, `${param}: ${JSON.stringify(res.body)}`).toBe(200);
      expect(res.body.count, param).toBe(baselineCount);
    }

    const countAliasRes = await request(app)
      .get(`/api/companies/${companyId}/issues/count`)
      .query({ attention: "blocked", parentId: "", parentIssueId: randomUUID() });
    expect(countAliasRes.status, JSON.stringify(countAliasRes.body)).toBe(200);
    expect(countAliasRes.body.count).toBe(baselineCount);

    // The empty value must drop the filter, not become a filter that matches
    // nothing: a real UUID on the same param still bites.
    const filteredRes = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "todo", projectId: randomUUID(), limit: "20" });
    expect(filteredRes.status, JSON.stringify(filteredRes.body)).toBe(200);
    expect(filteredRes.body).toEqual([]);

    // The service is reachable directly, not only through these two routes, so
    // `assertValidUuidFilter` has to agree with the query builders next to it:
    // empty is absent, non-empty text still throws.
    const svc = issueService(db);
    const serviceFilterNames = [
      "participantAgentId",
      "goalId",
      "createdByAgentId",
      "projectId",
      "workspaceId",
      "executionWorkspaceId",
      "parentId",
      "descendantOf",
      "labelId",
    ] as const;
    for (const name of serviceFilterNames) {
      const rows = await svc.list(companyId, { status: "todo", [name]: "", limit: 20 });
      expect(rows.map((row: { id: string }) => row.id), name).toEqual([issueId]);
      await expect(
        svc.list(companyId, { status: "todo", [name]: "bad", limit: 20 }),
      ).rejects.toThrow(`${name} must be a UUID`);
      // A whitespace-only value is truthy, so the query builders would send it
      // to a uuid comparison as-is. It has to be rejected, not exempted.
      await expect(
        svc.list(companyId, { status: "todo", [name]: " ", limit: 20 }),
      ).rejects.toThrow(`${name} must be a UUID`);
    }
  });

  it("pins every UUID filter value class on both routes", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const blockedIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Assignee",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: issueId,
        companyId,
        title: "Visible issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked issue",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);
    // The blocked-inbox count only counts issues carrying blocked attention, so
    // the count control needs a real `blocks` edge to be non-zero.
    await db.insert(issueRelations).values({
      id: randomUUID(),
      companyId,
      issueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const app = createApp(companyId);
    const listPath = `/api/companies/${companyId}/issues`;
    const countPath = `/api/companies/${companyId}/issues/count`;
    // `parentIssueId` is in these lists on purpose. It is not a member of
    // `ISSUE_LIST_UUID_FILTER_NAMES` — it is the `parentId` alias, normalized by
    // its own second `.trim()`/`isUuidLike` pair in the guard's alias branch.
    // Nothing in the main name loop reaches that branch, so it is only pinned if
    // the value axis walks the alias by name. It is last in each list because
    // `parentId` must stay absent from the same request for the alias to be read.
    const listParams = [
      "assigneeAgentId",
      "participantAgentId",
      "goalId",
      "createdByAgentId",
      "projectId",
      "workspaceId",
      "executionWorkspaceId",
      "parentId",
      "descendantOf",
      "labelId",
      "parentIssueId",
    ] as const;
    const countParams = [
      "assigneeAgentId",
      "participantAgentId",
      "projectId",
      "workspaceId",
      "executionWorkspaceId",
      "parentId",
      "descendantOf",
      "labelId",
      "parentIssueId",
    ] as const;
    const errorFor = (param: string) =>
      param === "assigneeAgentId" ? "assigneeAgentId must be a UUID or 'null'" : `${param} must be a UUID`;

    // The name axis is already covered by the tests above. This one walks the
    // value axis, which is where the guard actually decides: blank, padded-valid,
    // non-empty-invalid, and non-string. Each class below kills a mutation that
    // the name loops leave alive.
    const listBaseline = await request(app).get(listPath).query({ status: "todo", limit: "20" });
    expect(listBaseline.status, JSON.stringify(listBaseline.body)).toBe(200);
    const baselineIds = listBaseline.body.map((issue: { id: string }) => issue.id);
    expect(baselineIds).toEqual([issueId]);

    const countBaseline = await request(app).get(countPath).query({ attention: "blocked" });
    expect(countBaseline.status, JSON.stringify(countBaseline.body)).toBe(200);
    const baselineCount = countBaseline.body.count as number;
    expect(baselineCount).toBeGreaterThan(0);

    // Class 1 — blank. These all trim to empty, so the guard must read them as
    // "filter absent" and return the same unfiltered 200 the empty string gets.
    // Delete the guard's `.trim()` and ` ` is a length-1 non-UUID: 400 instead.
    for (const param of listParams) {
      for (const value of [" ", "\t\n"]) {
        const res = await request(app).get(listPath).query({ status: "todo", [param]: value, limit: "20" });
        const label = `${param}=${JSON.stringify(value)}: ${JSON.stringify(res.body)}`;
        expect(res.status, label).toBe(200);
        expect(res.body.map((issue: { id: string }) => issue.id), label).toEqual(baselineIds);
      }
    }
    for (const param of countParams) {
      for (const value of [" ", "\t\n"]) {
        const res = await request(app).get(countPath).query({ attention: "blocked", [param]: value });
        const label = `${param}=${JSON.stringify(value)}: ${JSON.stringify(res.body)}`;
        expect(res.status, label).toBe(200);
        expect(res.body.count, label).toBe(baselineCount);
      }
    }

    // Class 2 — a valid UUID with surrounding whitespace. `isUuidLike` trims
    // internally and returns true, so without the guard's own `.trim()` the
    // padded string is what reaches Postgres: `22P02 invalid input syntax for
    // type uuid`, surfaced as a 500. Compare against the unpadded response
    // rather than an expected page, so the pin holds whatever each filter
    // matches today.
    for (const param of listParams) {
      const value = randomUUID();
      const clean = await request(app).get(listPath).query({ status: "todo", [param]: value, limit: "20" });
      expect(clean.status, `${param}: ${JSON.stringify(clean.body)}`).toBe(200);
      for (const padded of [`${value} `, ` ${value}`]) {
        const res = await request(app).get(listPath).query({ status: "todo", [param]: padded, limit: "20" });
        const label = `${param}=${JSON.stringify(padded)}: ${JSON.stringify(res.body)}`;
        expect(res.status, label).toBe(200);
        expect(res.body, label).toEqual(clean.body);
      }
    }
    for (const param of countParams) {
      const value = randomUUID();
      const clean = await request(app).get(countPath).query({ attention: "blocked", [param]: value });
      expect(clean.status, `${param}: ${JSON.stringify(clean.body)}`).toBe(200);
      for (const padded of [`${value} `, ` ${value}`]) {
        const res = await request(app).get(countPath).query({ attention: "blocked", [param]: padded });
        const label = `${param}=${JSON.stringify(padded)}: ${JSON.stringify(res.body)}`;
        expect(res.status, label).toBe(200);
        expect(res.body, label).toEqual(clean.body);
      }
    }

    // Class 3 — non-empty text that is not a UUID. `"x"` is length 1 and
    // `"undefined"` is the other token an over-wide empty-skip swallows; both
    // have to 400 rather than drop the filter. (`"null"` is pinned above.)
    for (const value of ["x", "undefined"]) {
      for (const param of listParams) {
        const res = await request(app).get(listPath).query({ status: "todo", [param]: value, limit: "20" });
        const label = `${param}=${value}: ${JSON.stringify(res.body)}`;
        expect(res.status, label).toBe(400);
        expect(res.body, label).toMatchObject({ error: errorFor(param) });
        expect(res.body, label).not.toHaveProperty("issues");
      }
      for (const param of countParams) {
        const res = await request(app).get(countPath).query({ attention: "blocked", [param]: value });
        const label = `${param}=${value}: ${JSON.stringify(res.body)}`;
        expect(res.status, label).toBe(400);
        expect(res.body, label).toMatchObject({ error: errorFor(param) });
        expect(res.body, label).not.toHaveProperty("count");
      }
    }

    // Class 4 — a repeated query param. Express parses `?projectId=a&projectId=b`
    // into an array, and the non-string arm is the only thing between that array
    // and a dropped filter: turn its 400 into a `continue` and the request comes
    // back 200 with the filter silently gone.
    for (const param of listParams) {
      const res = await request(app)
        .get(listPath)
        .query({ status: "todo", limit: "20" })
        .query(`${param}=${randomUUID()}&${param}=${randomUUID()}`);
      const label = `${param} repeated: ${JSON.stringify(res.body)}`;
      expect(res.status, label).toBe(400);
      expect(res.body, label).toMatchObject({ error: errorFor(param) });
      expect(res.body, label).not.toHaveProperty("issues");
    }
    for (const param of countParams) {
      const res = await request(app)
        .get(countPath)
        .query({ attention: "blocked" })
        .query(`${param}=${randomUUID()}&${param}=${randomUUID()}`);
      const label = `${param} repeated: ${JSON.stringify(res.body)}`;
      expect(res.status, label).toBe(400);
      expect(res.body, label).toMatchObject({ error: errorFor(param) });
      expect(res.body, label).not.toHaveProperty("count");
    }

    // Class 5 — the `null` token is case-folded. `assigneeAgentId` is the one
    // filter that accepts a non-UUID value, and it accepts it only through
    // `.toLowerCase()`. Drop that call and `NULL` stops being the null token,
    // falls through to `isUuidLike`, and 400s a request that returns 200 today.
    // Compare against the lowercase response so the pin holds whatever the
    // null-assignee page contains.
    for (const path of [listPath, countPath] as const) {
      const base = path === listPath ? { status: "todo", limit: "20" } : { attention: "blocked" };
      const lower = await request(app).get(path).query({ ...base, assigneeAgentId: "null" });
      expect(lower.status, `${path}: ${JSON.stringify(lower.body)}`).toBe(200);
      for (const token of ["NULL", "Null"]) {
        const res = await request(app).get(path).query({ ...base, assigneeAgentId: token });
        const label = `${path} assigneeAgentId=${token}: ${JSON.stringify(res.body)}`;
        expect(res.status, label).toBe(200);
        expect(res.body, label).toEqual(lower.body);
      }
    }
  });

  it("keeps valid UUID filters working with status, limit, and search", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const participantAgentId = randomUUID();
    const otherAgentId = randomUUID();
    const projectId = randomUUID();
    const otherProjectId = randomUUID();
    const workspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const otherExecutionWorkspaceId = randomUUID();
    const labelId = randomUUID();
    const otherLabelId = randomUUID();
    const rootId = randomUUID();
    const parentId = randomUUID();
    const siblingParentId = randomUUID();
    const outsideParentId = randomUUID();
    const matchingIssueId = randomUUID();
    // One decoy per filter. Each decoy differs from the matching issue on
    // exactly the one column its filter reads, so dropping any single filter's
    // wiring lets that decoy through and turns this test red.
    const decoyIssueIds = {
      assigneeAgentId: randomUUID(),
      participantAgentId: randomUUID(),
      projectId: randomUUID(),
      workspaceId: randomUUID(),
      executionWorkspaceId: randomUUID(),
      parentId: randomUUID(),
      descendantOf: randomUUID(),
      labelId: randomUUID(),
    } as const;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(agents).values([
      {
        id: assigneeAgentId,
        companyId,
        name: "Assignee",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: participantAgentId,
        companyId,
        name: "Participant",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "Other",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(projects).values([
      { id: projectId, companyId, name: "Filtered project", status: "in_progress" },
      { id: otherProjectId, companyId, name: "Other project", status: "in_progress" },
    ]);
    await db.insert(projectWorkspaces).values([
      {
        id: workspaceId,
        companyId,
        projectId,
        name: "Primary",
        sourceType: "local_path",
        cwd: "/tmp/paperclip-issue-list-project",
        isPrimary: true,
      },
      {
        id: otherWorkspaceId,
        companyId,
        projectId: otherProjectId,
        name: "Other primary",
        sourceType: "local_path",
        cwd: "/tmp/paperclip-issue-list-project-other",
        isPrimary: true,
      },
    ]);
    await db.insert(executionWorkspaces).values([
      {
        id: executionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId: workspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Execution workspace",
        status: "active",
        providerType: "local_fs",
        cwd: "/tmp/paperclip-issue-list-execution",
      },
      {
        id: otherExecutionWorkspaceId,
        companyId,
        projectId: otherProjectId,
        projectWorkspaceId: otherWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Other execution workspace",
        status: "active",
        providerType: "local_fs",
        cwd: "/tmp/paperclip-issue-list-execution-other",
      },
    ]);

    const matchingShape = {
      companyId,
      status: "todo",
      priority: "medium",
      assigneeAgentId,
      createdByAgentId: assigneeAgentId,
      projectId,
      projectWorkspaceId: workspaceId,
      executionWorkspaceId,
      parentId,
    } as const;

    await db.insert(issues).values([
      { id: rootId, companyId, title: "Root", status: "todo", priority: "medium" },
      { id: parentId, companyId, title: "Parent", status: "todo", priority: "medium", parentId: rootId },
      {
        id: siblingParentId,
        companyId,
        title: "Sibling parent",
        status: "todo",
        priority: "medium",
        parentId: rootId,
      },
      { id: outsideParentId, companyId, title: "Outside parent", status: "todo", priority: "medium" },
      { ...matchingShape, id: matchingIssueId, title: "Needle issue" },
      // differs only on assigneeAgentId
      {
        ...matchingShape,
        id: decoyIssueIds.assigneeAgentId,
        title: "Needle decoy assignee",
        assigneeAgentId: otherAgentId,
      },
      // differs only in having no activity from participantAgentId (added below)
      { ...matchingShape, id: decoyIssueIds.participantAgentId, title: "Needle decoy participant" },
      // differs only on projectId
      {
        ...matchingShape,
        id: decoyIssueIds.projectId,
        title: "Needle decoy project",
        projectId: otherProjectId,
      },
      // differs only on projectWorkspaceId, which is what workspaceId reads
      {
        ...matchingShape,
        id: decoyIssueIds.workspaceId,
        title: "Needle decoy workspace",
        projectWorkspaceId: otherWorkspaceId,
      },
      // differs only on executionWorkspaceId
      {
        ...matchingShape,
        id: decoyIssueIds.executionWorkspaceId,
        title: "Needle decoy execution workspace",
        executionWorkspaceId: otherExecutionWorkspaceId,
      },
      // differs only on parentId, and stays inside rootId's subtree so
      // descendantOf cannot mask a dropped parentId filter
      {
        ...matchingShape,
        id: decoyIssueIds.parentId,
        title: "Needle decoy parent",
        parentId: siblingParentId,
      },
      // sits outside rootId's subtree; only descendantOf excludes it once
      // parentId is dropped from the query below
      {
        ...matchingShape,
        id: decoyIssueIds.descendantOf,
        title: "Needle decoy descendant",
        parentId: outsideParentId,
      },
      // differs only in carrying otherLabelId instead of labelId (added below)
      { ...matchingShape, id: decoyIssueIds.labelId, title: "Needle decoy label" },
    ]);
    await db.insert(labels).values([
      { id: labelId, companyId, name: "Needle", color: "#2563eb" },
      { id: otherLabelId, companyId, name: "Haystack", color: "#dc2626" },
    ]);

    const decoyIssueIdList = Object.values(decoyIssueIds);
    // Every row except the participant decoy has activity from participantAgentId,
    // so participantAgentId is the only filter that removes that decoy.
    await db.insert(activityLog).values([
      ...[matchingIssueId, ...decoyIssueIdList]
        .filter((issueId) => issueId !== decoyIssueIds.participantAgentId)
        .map((issueId) => ({
          companyId,
          actorType: "agent" as const,
          actorId: participantAgentId,
          action: "issue.updated",
          entityType: "issue",
          entityId: issueId,
          agentId: participantAgentId,
        })),
      {
        companyId,
        actorType: "agent" as const,
        actorId: otherAgentId,
        action: "issue.updated",
        entityType: "issue",
        entityId: decoyIssueIds.participantAgentId,
        agentId: otherAgentId,
      },
    ]);
    // Same shape for labelId: only the label decoy is missing the filtered label.
    await db.insert(issueLabels).values([
      ...[matchingIssueId, ...decoyIssueIdList]
        .filter((issueId) => issueId !== decoyIssueIds.labelId)
        .map((issueId) => ({ companyId, issueId, labelId })),
      { companyId, issueId: decoyIssueIds.labelId, labelId: otherLabelId },
    ]);

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({
        status: "todo",
        assigneeAgentId,
        participantAgentId,
        projectId,
        workspaceId,
        executionWorkspaceId,
        parentId,
        descendantOf: rootId,
        labelId,
        q: "Needle",
        limit: "20",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((issue: { id: string }) => issue.id)).toEqual([matchingIssueId]);

    // descendantOf and parentId both read issues.parentId, so a descendantOf
    // decoy cannot differ from the matching issue on descendantOf alone. Drop
    // parentId from the query and descendantOf becomes the only filter that
    // excludes the out-of-subtree decoy.
    const withoutParentIdRes = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({
        status: "todo",
        assigneeAgentId,
        participantAgentId,
        projectId,
        workspaceId,
        executionWorkspaceId,
        descendantOf: rootId,
        labelId,
        q: "Needle",
        limit: "20",
      });

    expect(withoutParentIdRes.status, JSON.stringify(withoutParentIdRes.body)).toBe(200);
    expect(withoutParentIdRes.body.map((issue: { id: string }) => issue.id).sort()).toEqual(
      [matchingIssueId, decoyIssueIds.parentId].sort(),
    );
  });

  it("keeps parentId precedence over the parentIssueId alias when both are present", async () => {
    const companyId = randomUUID();
    const parentId = randomUUID();
    const aliasParentId = randomUUID();
    const parentChildIssueId = randomUUID();
    const aliasChildIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(issues).values([
      {
        id: parentId,
        companyId,
        title: "Canonical parent",
        status: "todo",
        priority: "medium",
      },
      {
        id: aliasParentId,
        companyId,
        title: "Alias parent",
        status: "todo",
        priority: "medium",
      },
      {
        id: parentChildIssueId,
        companyId,
        title: "Canonical child",
        status: "todo",
        priority: "medium",
        parentId,
      },
      {
        id: aliasChildIssueId,
        companyId,
        title: "Alias child",
        status: "todo",
        priority: "medium",
        parentId: aliasParentId,
      },
    ]);

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "todo", parentId, parentIssueId: aliasParentId, limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((issue: { id: string }) => issue.id)).toEqual([parentChildIssueId]);

    // Precedence also decides validation: a malformed alias that `parentId`
    // supersedes is never read, so it must not turn a 200 into a 400.
    const malformedAliasRes = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "todo", parentId, parentIssueId: "bad", limit: "20" });

    expect(malformedAliasRes.status, JSON.stringify(malformedAliasRes.body)).toBe(200);
    expect(malformedAliasRes.body.map((issue: { id: string }) => issue.id)).toEqual([
      parentChildIssueId,
    ]);

    // But with no canonical `parentId` to supersede it, the alias is the value
    // that reaches the query, so it must still be rejected at the boundary.
    const aliasOnlyRes = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "todo", parentIssueId: "bad", limit: "20" });

    expect(aliasOnlyRes.status, JSON.stringify(aliasOnlyRes.body)).toBe(400);
    expect(aliasOnlyRes.body).toMatchObject({ error: "parentIssueId must be a UUID" });
  });

  it("filters issue lists by goalId and createdByAgentId", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const otherGoalId = randomUUID();
    const creatorAgentId = randomUUID();
    const otherAgentId = randomUUID();
    const matchingIssueId = randomUUID();
    const wrongGoalIssueId = randomUUID();
    const wrongCreatorIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(goals).values([
      {
        id: goalId,
        companyId,
        title: "Goal",
        status: "active",
        level: "company",
      },
      {
        id: otherGoalId,
        companyId,
        title: "Other goal",
        status: "active",
        level: "company",
      },
    ]);
    await db.insert(agents).values([
      {
        id: creatorAgentId,
        companyId,
        name: "Creator",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "Other",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values([
      {
        id: matchingIssueId,
        companyId,
        title: "Matching issue",
        status: "todo",
        priority: "medium",
        goalId,
        createdByAgentId: creatorAgentId,
      },
      {
        id: wrongGoalIssueId,
        companyId,
        title: "Wrong goal issue",
        status: "todo",
        priority: "medium",
        goalId: otherGoalId,
        createdByAgentId: creatorAgentId,
      },
      {
        id: wrongCreatorIssueId,
        companyId,
        title: "Wrong creator issue",
        status: "todo",
        priority: "medium",
        goalId,
        createdByAgentId: otherAgentId,
      },
    ]);

    const app = createApp(companyId);
    const filtered = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "todo", goalId, createdByAgentId: creatorAgentId, limit: "20" });
    const nonexistent = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "todo", goalId: randomUUID(), limit: "20" });

    expect(filtered.status, JSON.stringify(filtered.body)).toBe(200);
    expect(filtered.body.map((issue: { id: string }) => issue.id)).toEqual([matchingIssueId]);
    expect(nonexistent.status, JSON.stringify(nonexistent.body)).toBe(200);
    expect(nonexistent.body).toEqual([]);
  });

  it("returns opt-in live descendant counts for offscreen live descendants only", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();
    const grandchildIssueId = randomUUID();
    const hiddenChildIssueId = randomUUID();
    const crossCompanyChildIssueId = randomUUID();
    const rootRunId = randomUUID();
    const grandchildRunId = randomUUID();
    const hiddenRunId = randomUUID();
    const crossCompanyRunId = randomUUID();

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Paperclip",
        issuePrefix: uniqueIssuePrefix(),
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other Company",
        issuePrefix: uniqueIssuePrefix(),
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await seedCloudTenantMember(companyId);
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "Assignee",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId: otherCompanyId,
        name: "Other",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: rootRunId,
        companyId,
        agentId,
        status: "running",
        contextSnapshot: { issueId: rootIssueId },
      },
      {
        id: grandchildRunId,
        companyId,
        agentId,
        status: "queued",
        contextSnapshot: { issueId: grandchildIssueId },
      },
      {
        id: hiddenRunId,
        companyId,
        agentId,
        status: "running",
        contextSnapshot: { issueId: hiddenChildIssueId },
      },
      {
        id: crossCompanyRunId,
        companyId: otherCompanyId,
        agentId: otherAgentId,
        status: "running",
        contextSnapshot: { issueId: crossCompanyChildIssueId },
      },
    ]);
    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        title: "Blocked parent",
        status: "blocked",
        priority: "critical",
        executionRunId: rootRunId,
        assigneeAgentId: agentId,
      },
      {
        id: childIssueId,
        companyId,
        title: "Offscreen child",
        status: "todo",
        priority: "medium",
        parentId: rootIssueId,
        assigneeAgentId: agentId,
      },
      {
        id: grandchildIssueId,
        companyId,
        title: "Offscreen live grandchild",
        status: "todo",
        priority: "medium",
        parentId: childIssueId,
        executionRunId: grandchildRunId,
        assigneeAgentId: agentId,
      },
      {
        id: hiddenChildIssueId,
        companyId,
        title: "Hidden live child",
        status: "todo",
        priority: "medium",
        parentId: rootIssueId,
        executionRunId: hiddenRunId,
        hiddenAt: new Date("2026-07-02T00:00:00.000Z"),
        assigneeAgentId: agentId,
      },
      {
        id: crossCompanyChildIssueId,
        companyId: otherCompanyId,
        title: "Cross-company live child",
        status: "todo",
        priority: "medium",
        parentId: rootIssueId,
        executionRunId: crossCompanyRunId,
        assigneeAgentId: otherAgentId,
      },
    ]);

    const app = createApp(companyId);
    const withoutSummary = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "blocked", limit: "20" });

    expect(withoutSummary.status, JSON.stringify(withoutSummary.body)).toBe(200);
    expect(withoutSummary.body).toHaveLength(1);
    expect(withoutSummary.body[0].id).toBe(rootIssueId);
    expect(withoutSummary.body[0].liveDescendantCount).toBeUndefined();

    const withSummary = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "blocked", includeLiveDescendantSummary: "true", limit: "20" });

    expect(withSummary.status, JSON.stringify(withSummary.body)).toBe(200);
    expect(withSummary.body).toHaveLength(1);
    expect(withSummary.body[0]).toMatchObject({
      id: rootIssueId,
      liveDescendantCount: 1,
    });
  });

  it("does not recurse forever when live descendant summaries encounter a parent cycle", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const parentIssueId = randomUUID();
    const childIssueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Assignee",
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
      contextSnapshot: { issueId: childIssueId },
    });
    await db.insert(issues).values([
      {
        id: parentIssueId,
        companyId,
        title: "Cycle parent",
        status: "blocked",
        priority: "medium",
        parentId: childIssueId,
        assigneeAgentId: agentId,
      },
      {
        id: childIssueId,
        companyId,
        title: "Cycle live child",
        status: "in_progress",
        priority: "medium",
        parentId: parentIssueId,
        executionRunId: runId,
        assigneeAgentId: agentId,
      },
    ]);

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "blocked", includeLiveDescendantSummary: "true", limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: parentIssueId,
      liveDescendantCount: 1,
    });
  });
});
