import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentContracts,
  agents,
  approvals,
  autonomyEvidenceEntries,
  autonomyIncidents,
  companies,
  createDb,
  issueRelations,
  issues,
  lanePolicies,
} from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../../__tests__/helpers/embedded-postgres.js";
import { autonomyKernelService } from "../index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres autonomy preflight tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("autonomy kernel preflight gates", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: Db;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("autonomy-kernel-preflight");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(autonomyEvidenceEntries);
    await db.delete(approvals);
    await db.delete(autonomyIncidents);
    await db.delete(agentContracts);
    await db.delete(issueRelations);
    await db.delete(lanePolicies);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany(id = randomUUID()) {
    await db.insert(companies).values({
      id,
      name: `Company ${id.slice(0, 8)}`,
      status: "active",
      issuePrefix: id.slice(0, 8).toUpperCase(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return id;
  }

  async function seedRunnable(options: { agent?: Partial<typeof agents.$inferInsert>; contract?: Partial<typeof agentContracts.$inferInsert>; lane?: Partial<typeof lanePolicies.$inferInsert> } = {}) {
    const companyId = await seedCompany();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const now = new Date();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Builder",
      role: "builder",
      status: "idle",
      adapterType: "process",
      createdAt: now,
      updatedAt: now,
      ...options.agent,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Build feature",
      status: "todo",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${companyId.slice(0, 8).toUpperCase()}-1`,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(lanePolicies).values({
      id: randomUUID(),
      companyId,
      laneKey: "default",
      laneName: "Default",
      isDefault: true,
      status: "healthy",
      maxConcurrentRuns: 1,
      maxManagerRuns: 0,
      allowParallelWithDependencyProof: false,
      allowRetry: false,
      maxRetryAttempts: 0,
      allowedAgentIds: [],
      allowedIssueTypes: [],
      allowedEvidenceTypes: [],
      policy: {},
      createdAt: now,
      updatedAt: now,
      ...options.lane,
    });
    await db.insert(agentContracts).values({
      id: randomUUID(),
      companyId,
      agentId,
      laneKey: "default",
      name: "Builder contract",
      version: 1,
      status: "active",
      allowedIssueTypes: [],
      requiredEvidenceTypes: ["diff"],
      allowedEvidenceTypes: ["diff", "test_run"],
      requiresApprovalFor: [],
      activatedAt: now,
      createdAt: now,
      updatedAt: now,
      ...options.contract,
    });
    return { companyId, agentId, issueId, runId: randomUUID() };
  }

  it("allows a run when every preflight gate passes", async () => {
    const ids = await seedRunnable();
    const svc = autonomyKernelService(db);

    const decision = await svc.preflightRun({ ...ids, laneKey: "default" });

    expect(decision).toMatchObject({ status: "allow", incidentIds: [], approvalGateIds: [] });
  });

  it("denies auth gate failures and creates an auth incident", async () => {
    const ids = await seedRunnable();
    const svc = autonomyKernelService(db, {
      preflightChecks: {
        auth: () => ({ status: "deny", reason: "agent token stale", incidentType: "AGENT_API_UNAUTHORIZED" }),
      },
    });

    const decision = await svc.preflightRun({ ...ids, laneKey: "default" });

    expect(decision.status).toBe("deny");
    expect(decision.incidentIds).toHaveLength(1);
    const rows = await db.select().from(autonomyIncidents);
    expect(rows[0]).toMatchObject({ type: "AGENT_API_UNAUTHORIZED", sourceType: "external" });
  });

  it("denies budget hard stops and creates a lane-stop incident", async () => {
    const ids = await seedRunnable({ agent: { budgetMonthlyCents: 100, spentMonthlyCents: 100 } });
    const svc = autonomyKernelService(db);

    const decision = await svc.preflightRun({ ...ids, laneKey: "default" });

    expect(decision.status).toBe("deny");
    const [incident] = await db.select().from(autonomyIncidents);
    expect(incident).toMatchObject({ type: "LANE_BUDGET_EXCEEDED", severity: "critical", stopsLane: true });
  });

  it("denies non-runnable agent status", async () => {
    const ids = await seedRunnable({ agent: { status: "paused", pauseReason: "operator paused", pausedAt: new Date() } });
    const svc = autonomyKernelService(db);

    const decision = await svc.preflightRun({ ...ids, laneKey: "default" });

    expect(decision.status).toBe("deny");
    const [incident] = await db.select().from(autonomyIncidents);
    expect(incident?.type).toBe("AUTH_STALE_AGENT_CODEX");
  });

  it("denies missing workspaces when a workspace is required", async () => {
    const ids = await seedRunnable();
    const svc = autonomyKernelService(db);

    const decision = await svc.preflightRun({ ...ids, laneKey: "default", requiresWorkspace: true });

    expect(decision.status).toBe("deny");
    const [incident] = await db.select().from(autonomyIncidents);
    expect(incident?.type).toBe("WORKSPACE_MISSING");
  });

  it("blocks runs with open dependency blockers", async () => {
    const ids = await seedRunnable();
    const blockerId = randomUUID();
    await db.insert(issues).values({
      id: blockerId,
      companyId: ids.companyId,
      title: "Blocking task",
      status: "todo",
      issueNumber: 2,
      identifier: `${ids.companyId.slice(0, 8).toUpperCase()}-2`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(issueRelations).values({
      id: randomUUID(),
      companyId: ids.companyId,
      issueId: blockerId,
      relatedIssueId: ids.issueId,
      type: "blocks",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const svc = autonomyKernelService(db);

    const decision = await svc.preflightRun({ ...ids, laneKey: "default" });

    expect(decision.status).toBe("blocked");
    expect(decision.incidentIds).toEqual([]);
  });

  it("blocks stopped lanes before contract authorization", async () => {
    const ids = await seedRunnable({ lane: { status: "stopped", statusReason: "incident stop", stoppedAt: new Date() } });
    const svc = autonomyKernelService(db);

    const decision = await svc.preflightRun({ ...ids, laneKey: "default" });

    expect(decision).toMatchObject({ status: "blocked", reason: "incident stop" });
  });

  it("denies runs without an active agent contract", async () => {
    const ids = await seedRunnable({ contract: { status: "draft" } });
    const svc = autonomyKernelService(db);

    const decision = await svc.preflightRun({ ...ids, laneKey: "default" });

    expect(decision.status).toBe("deny");
    const [incident] = await db.select().from(autonomyIncidents);
    expect(incident).toMatchObject({ type: "ISSUE_CONTRACT_MISSING", stopsLane: true });
  });

  it("returns approval_required and creates a visible approval row for approval gates", async () => {
    const ids = await seedRunnable({ contract: { requiresApprovalFor: ["deploy_production"] } });
    const svc = autonomyKernelService(db);

    const decision = await svc.preflightRun({ ...ids, laneKey: "default", governedAction: "deploy_production" });

    expect(decision.status).toBe("approval_required");
    expect(decision.approvalGateIds).toHaveLength(1);
    const [approval] = await db.select().from(approvals);
    expect(approval).toMatchObject({ type: "autonomy_preflight_gate", status: "pending", requestedByAgentId: ids.agentId });
    expect(approval?.payload).toMatchObject({ kind: "autonomy_preflight_gate", governedAction: "deploy_production" });
  });

  it("exposes visible approval gate summaries in the autonomy inbox", async () => {
    const ids = await seedRunnable({ contract: { requiresApprovalFor: ["deploy_production"] } });
    const svc = autonomyKernelService(db);

    await svc.preflightRun({ ...ids, laneKey: "default", governedAction: "deploy_production" });
    const [item] = await svc.getAutonomyInbox(ids.companyId);

    expect(item).toMatchObject({
      kind: "approval_gate",
      title: "Autonomy approval required",
      summary: "Approval required for deploy_production",
      laneKey: "default",
      runId: ids.runId,
      issueId: ids.issueId,
      agentId: ids.agentId,
    });
    expect(item?.approvalGate).toMatchObject({
      governedAction: "deploy_production",
      approvalId: item.id,
      requestedByAgentId: ids.agentId,
      acceptActionLabel: "Approve autonomous run",
      rejectActionLabel: "Deny autonomous run",
    });
  });

  it("exposes incidents, evidence validation rows, and lane blocks in the autonomy inbox", async () => {
    const ids = await seedRunnable({
      lane: {
        status: "stopped",
        statusReason: "operator evidence gate stop",
        stoppedAt: new Date(),
      },
    });
    const now = new Date();
    const incidentId = randomUUID();
    const evidenceId = randomUUID();
    const svc = autonomyKernelService(db);

    await db.insert(autonomyIncidents).values({
      id: incidentId,
      companyId: ids.companyId,
      type: "EVIDENCE_VALIDATION_FAILED",
      severity: "error",
      status: "open",
      laneKey: "default",
      runId: null,
      issueId: ids.issueId,
      agentId: ids.agentId,
      sourceType: "agent",
      sourceId: ids.agentId,
      title: "Evidence validation failed",
      message: "Required test evidence was rejected",
      remediation: "Attach a passing test run",
      stopsLane: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(autonomyEvidenceEntries).values({
      id: evidenceId,
      companyId: ids.companyId,
      type: "test_run",
      status: "rejected",
      verdict: "fail",
      laneKey: "default",
      runId: null,
      issueId: ids.issueId,
      agentId: ids.agentId,
      sourceType: "agent",
      sourceId: ids.agentId,
      title: "Vitest evidence",
      summary: "preflight.test.ts failed",
      validatorName: "autonomy-test-verifier",
      validatorVersion: "1.0.0",
      validatorMessage: "Test evidence failed validation",
      validatedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const inbox = await svc.getAutonomyInbox(ids.companyId);
    const incidentItem = inbox.find((item) => item.kind === "incident");
    const evidenceItem = inbox.find((item) => item.kind === "evidence_validation");
    const laneItem = inbox.find((item) => item.kind === "lane_block");

    expect(incidentItem).toMatchObject({
      id: incidentId,
      kind: "incident",
      severity: "error",
      status: "open",
      title: "Evidence validation failed",
      summary: "Required test evidence was rejected Remediation: Attach a passing test run",
      laneKey: "default",
      issueId: ids.issueId,
      agentId: ids.agentId,
    });
    expect(incidentItem?.incident).toMatchObject({
      id: incidentId,
      type: "EVIDENCE_VALIDATION_FAILED",
      stopsLane: true,
    });
    expect(evidenceItem).toMatchObject({
      id: evidenceId,
      kind: "evidence_validation",
      severity: "error",
      status: "rejected",
      title: "Evidence rejected: Vitest evidence",
      summary: "Test evidence failed validation",
      laneKey: "default",
      issueId: ids.issueId,
      agentId: ids.agentId,
    });
    expect(evidenceItem?.evidenceEntry).toMatchObject({
      id: evidenceId,
      type: "test_run",
      verdict: "fail",
    });
    expect(laneItem).toMatchObject({
      kind: "lane_block",
      severity: "critical",
      status: "stopped",
      title: "Lane Default is stopped",
      summary: "operator evidence gate stop",
      laneKey: "default",
    });
    expect(incidentItem?.createdAt).toEqual(expect.any(String));
    expect(evidenceItem?.updatedAt).toEqual(expect.any(String));
    expect(laneItem?.updatedAt).toEqual(expect.any(String));
  });
});
