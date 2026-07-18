import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  executionWorkspaces,
  fleetPatrolAudit,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { fleetPatrolRemediationRoutes } from "../routes/fleet-patrol-remediation.js";
import { FLEET_PATROL_AGENT_ID } from "../services/fleet-patrol-remediation.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("fleet patrol remediation authorization", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let runId: string;

  const actor = (): Express.Request["actor"] => ({
    type: "agent",
    agentId: FLEET_PATROL_AGENT_ID,
    companyId,
    runId,
    source: "agent_jwt",
    credentialId: "sha256:test-run-credential",
  });

  const createApp = (requestActor = actor()) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = requestActor;
      next();
    });
    app.use("/api", fleetPatrolRemediationRoutes(db));
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-fleet-patrol-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    process.env.PAPERCLIP_FLEET_PATROL_REMEDIATION_ENABLED = "true";
    companyId = randomUUID();
    runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: FLEET_PATROL_AGENT_ID,
      companyId,
      name: "Reliability Engineer",
      role: "reliability",
      status: "active",
      adapterType: "cursor",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: FLEET_PATROL_AGENT_ID,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
    });
  });

  afterEach(async () => {
    delete process.env.PAPERCLIP_FLEET_PATROL_REMEDIATION_ENABLED;
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(heartbeatRuns);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssueLock(status = "failed") {
    const ownerRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: ownerRunId,
      companyId,
      agentId: FLEET_PATROL_AGENT_ID,
      status,
      errorCode: "process_lost",
      invocationSource: "manual",
      finishedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stranded issue",
      status: "in_progress",
      checkoutRunId: ownerRunId,
      executionRunId: ownerRunId,
      executionAgentNameKey: "reliability",
      executionLockedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    return { issueId, ownerRunId };
  }

  it("audits schema-invalid requests before returning 422 without raw bodies or errors", async () => {
    const targetId = randomUUID();
    const secret = "super-secret-token";
    const response = await request(createApp())
      .post("/api/fleet-patrol/remediation")
      .send({ operation: "release_issue_lock", targetId, secret, nested: { rawError: "database exploded" } });

    expect(response.status).toBe(422);
    const row = await db
      .select()
      .from(fleetPatrolAudit)
      .where(eq(fleetPatrolAudit.authenticatedRunId, runId))
      .then((rows) => rows.at(-1)!);
    expect(row).toMatchObject({
      authenticatedAgentId: FLEET_PATROL_AGENT_ID,
      authenticatedRunId: runId,
      companyId,
      operation: "release_issue_lock",
      targetId,
      outcome: "denied",
      reasonCode: "schema_invalid",
      credentialId: "sha256:test-run-credential",
    });
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(JSON.stringify(row)).not.toContain("database exploded");
  });

  it("denies and audits a wrong-company target", async () => {
    const otherCompanyId = randomUUID();
    const otherAgentId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other",
      issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: otherAgentId,
      companyId: otherCompanyId,
      name: "Other agent",
      role: "engineer",
      status: "error",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const response = await request(createApp())
      .post("/api/fleet-patrol/remediation")
      .send({ operation: "clear_agent_error", targetId: otherAgentId });
    expect(response.status).toBe(403);
    expect(response.body.reasonCode).toBe("target_not_found");
  });

  it("denies a signed credential whose run is no longer running", async () => {
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    const response = await request(createApp())
      .post("/api/fleet-patrol/remediation")
      .send({ operation: "release_issue_lock", targetId: randomUUID() });
    expect(response.status).toBe(403);
    expect(response.body.reasonCode).toBe("signed_run_not_running");
  });

  it("clears only a proven process-loss error", async () => {
    const targetId = randomUUID();
    await db.insert(agents).values({
      id: targetId,
      companyId,
      name: "Recoverable target",
      role: "engineer",
      status: "error",
      errorReason: "sensitive provider detail",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: targetId,
      status: "failed",
      errorCode: "process_lost",
      error: "raw error must not enter audit",
      invocationSource: "manual",
      finishedAt: new Date(),
    });

    const response = await request(createApp())
      .post("/api/fleet-patrol/remediation")
      .send({ operation: "clear_agent_error", targetId });
    expect(response.status).toBe(200);
    const target = await db.select().from(agents).where(eq(agents.id, targetId)).then((rows) => rows[0]);
    expect(target).toMatchObject({ status: "idle", errorReason: null });
    const audit = await db.select().from(fleetPatrolAudit).where(eq(fleetPatrolAudit.targetId, targetId));
    expect(JSON.stringify(audit)).not.toContain("sensitive provider detail");
    expect(JSON.stringify(audit)).not.toContain("raw error must not enter audit");
  });

  it("denies an unknown referenced lock-owner status", async () => {
    const { issueId } = await seedIssueLock("provider_limboland");
    const response = await request(createApp())
      .post("/api/fleet-patrol/remediation")
      .send({ operation: "release_issue_lock", targetId: issueId });
    expect(response.status).toBe(409);
    expect(response.body.reasonCode).toBe("lock_owner_unknown_status");
  });

  it("denies an invalid workspace reset while the issue run is active", async () => {
    const issueId = randomUUID();
    const activeRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: activeRunId,
      companyId,
      agentId: FLEET_PATROL_AGENT_ID,
      status: "running",
      errorCode: "workspace_validation_failed",
      invocationSource: "manual",
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Pinned issue",
      status: "in_progress",
      executionRunId: activeRunId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceId: null,
    });
    const response = await request(createApp())
      .post("/api/fleet-patrol/remediation")
      .send({ operation: "reset_workspace_pin", targetId: issueId });
    expect(response.status).toBe(409);
    expect(response.body.reasonCode).toBe("issue_run_active");
  });

  it("resets only the workspace pin after a terminal workspace-validation failure", async () => {
    const issueId = randomUUID();
    const failedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: failedRunId,
      companyId,
      agentId: FLEET_PATROL_AGENT_ID,
      status: "failed",
      errorCode: "workspace_validation_failed",
      invocationSource: "manual",
      finishedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Invalid workspace pin",
      status: "blocked",
      assigneeAgentId: FLEET_PATROL_AGENT_ID,
      executionRunId: failedRunId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceId: null,
    });
    const response = await request(createApp())
      .post("/api/fleet-patrol/remediation")
      .send({ operation: "reset_workspace_pin", targetId: issueId });
    expect(response.status).toBe(200);
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(issue).toMatchObject({
      status: "blocked",
      assigneeAgentId: FLEET_PATROL_AGENT_ID,
      executionWorkspacePreference: "agent_default",
      executionWorkspaceId: null,
    });
  });

  it("does not expand authorization on unrelated agent endpoints", async () => {
    const targetId = randomUUID();
    await db.insert(agents).values({
      id: targetId,
      companyId,
      name: "Target",
      role: "engineer",
      status: "error",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await request(createApp()).post(`/api/agents/${targetId}/clear-error`).send({}).expect(403);
  });

  it("serializes a genuinely concurrent stale-evidence race", async () => {
    const { issueId } = await seedIssueLock();
    const app = createApp();
    const [first, second] = await Promise.all([
      request(app).post("/api/fleet-patrol/remediation").send({
        operation: "release_issue_lock",
        targetId: issueId,
      }),
      request(app).post("/api/fleet-patrol/remediation").send({
        operation: "release_issue_lock",
        targetId: issueId,
      }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect([first.body.reasonCode, second.body.reasonCode]).toContain("lock_missing");
  });

  it("keeps the capability default-off", async () => {
    delete process.env.PAPERCLIP_FLEET_PATROL_REMEDIATION_ENABLED;
    const response = await request(createApp())
      .post("/api/fleet-patrol/remediation")
      .send({ operation: "release_issue_lock", targetId: randomUUID() });
    expect(response.status).toBe(403);
    expect(response.body.reasonCode).toBe("capability_disabled");
  });

  it("keeps denial audit immutable and records all attribution fields", async () => {
    const targetId = randomUUID();
    await request(createApp())
      .post("/api/fleet-patrol/remediation")
      .send({ operation: "release_issue_lock", targetId })
      .expect(403);

    const row = await db
      .select()
      .from(fleetPatrolAudit)
      .where(eq(fleetPatrolAudit.authenticatedRunId, runId))
      .then((rows) => rows.at(-1)!);
    expect(row).toMatchObject({
      companyId,
      authenticatedAgentId: FLEET_PATROL_AGENT_ID,
      authenticatedRunId: runId,
      apiKeyId: "sha256:test-run-credential",
      credentialId: "sha256:test-run-credential",
      operation: "release_issue_lock",
      targetType: "issue",
      targetId,
      reasonCode: "target_not_found",
    });
    await expect(
      db.delete(fleetPatrolAudit).where(eq(fleetPatrolAudit.id, row.id)),
    ).rejects.toThrow();
  });
});
