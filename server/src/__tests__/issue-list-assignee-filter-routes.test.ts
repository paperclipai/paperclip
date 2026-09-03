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
  });

  it("keeps valid UUID filters working with status, limit, and search", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const parentId = randomUUID();
    const rootId = randomUUID();
    const labelId = randomUUID();
    const matchingIssueId = randomUUID();
    const otherIssueId = randomUUID();

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
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Filtered project",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "local_path",
      cwd: "/tmp/paperclip-issue-list-project",
      isPrimary: true,
    });
    await db.insert(executionWorkspaces).values({
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
    });
    await db.insert(issues).values([
      {
        id: rootId,
        companyId,
        title: "Root",
        status: "todo",
        priority: "medium",
      },
      {
        id: parentId,
        companyId,
        title: "Parent",
        status: "todo",
        priority: "medium",
        parentId: rootId,
      },
      {
        id: matchingIssueId,
        companyId,
        title: "Needle issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        createdByAgentId: agentId,
        projectId,
        projectWorkspaceId: workspaceId,
        executionWorkspaceId,
        parentId,
      },
      {
        id: otherIssueId,
        companyId,
        title: "Needle issue other",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        createdByAgentId: agentId,
        projectId,
        projectWorkspaceId: workspaceId,
        executionWorkspaceId,
        parentId,
      },
    ]);
    await db.insert(labels).values({
      id: labelId,
      companyId,
      name: "Needle",
      color: "#2563eb",
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: matchingIssueId,
      agentId,
    });
    await db.insert(issueLabels).values({ companyId, issueId: matchingIssueId, labelId });

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({
        status: "todo",
        assigneeAgentId: agentId,
        participantAgentId: agentId,
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
