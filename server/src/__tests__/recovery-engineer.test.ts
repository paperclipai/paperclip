import { randomUUID } from "node:crypto";
import express, { type Request as ExpressRequest } from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueCreateIdempotencyKeys,
  issueComments,
  issueExecutionDecisions,
  issueRelations,
  issues,
  issueThreadInteractions,
  projects,
  recoveryEngineerConfigs,
  recoveryEngineerIncidents,
  recoveryEngineerIncidentSources,
  recoveryEngineerProcedures,
  recoveryEngineerProcedureReuses,
  recoveryEngineerVerifications,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { buildRecoveryRunEvidence } from "../services/recovery-engineer-evidence.js";
import { recoveryEngineerService } from "../services/recovery-engineer.js";

type RecoveryEngineerWakeup = Parameters<typeof recoveryEngineerService>[1]["enqueueWakeup"];

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres recovery-engineer tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("recovery-engineer evidence", () => {
  it("does not collapse materially different concrete failures into one fingerprint", () => {
    const shared = {
      id: randomUUID(),
      status: "failed",
      errorCode: "adapter_failed",
      error: "Process exited with code 1",
      exitCode: 1,
      driverKind: "process",
      driverVersion: "1",
    };
    const unavailable = buildRecoveryRunEvidence(
      { ...shared, stderrExcerpt: "write /dev/stdout: resource temporarily unavailable" },
      "codex_local",
      "source-a",
    );
    const diskFull = buildRecoveryRunEvidence(
      { ...shared, id: randomUUID(), stderrExcerpt: "write output.log: no space left on device" },
      "codex_local",
      "source-a",
    );

    expect(unavailable.fingerprint).not.toBe(diskFull.fingerprint);
    const repeated = buildRecoveryRunEvidence({
      ...shared,
      id: randomUUID(),
      stderrExcerpt: "write /dev/stdout: resource temporarily unavailable",
      stdoutExcerpt: "Completely different task output",
      resultJson: { usage: { outputTokens: 999 }, durationMs: 123456 },
    }, "codex_local", "source-b");
    expect(repeated.fingerprint).toBe(unavailable.fingerprint);
    const unknownA = buildRecoveryRunEvidence(shared, "codex_local", "source-a");
    const unknownB = buildRecoveryRunEvidence(shared, "codex_local", "source-b");
    expect(unknownA.fingerprint).not.toBe(unknownB.fingerprint);
    expect(unavailable.summary).toContain("resource temporarily unavailable");
    expect(unavailable.evidence).toMatchObject({
      genericFailureScopedToSource: false,
      failureSignatureVersion: "recovery-engineer-v1",
    });
  });
});

describeEmbeddedPostgres("native recovery engineer", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-engineer-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(recoveryEngineerVerifications);
    await db.delete(recoveryEngineerProcedureReuses);
    await db.delete(recoveryEngineerProcedures);
    await db.delete(recoveryEngineerIncidentSources);
    await db.delete(recoveryEngineerIncidents);
    await db.delete(recoveryEngineerConfigs);
    await db.delete(issueExecutionDecisions);
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(issueRelations);
    await db.delete(issueCreateIdempotencyKeys);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const recoveryAgentId = randomUUID();
    const repairAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const ownerAgentId = randomUUID();
    const incidentProjectId = randomUUID();
    const nativeRepairProjectId = randomUUID();
    const frameworkRepairProjectId = randomUUID();
    const sourceIssueId = randomUUID();
    const prefix = `RE${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Recovery Engineering Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: recoveryAgentId,
        companyId,
        name: "Astra",
        role: "coordinator",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: repairAgentId,
        companyId,
        name: "Sol Repair",
        role: "implementer",
        status: "idle",
        reportsTo: recoveryAgentId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: reviewerAgentId,
        companyId,
        name: "Sol Review",
        role: "reviewer",
        status: "idle",
        reportsTo: recoveryAgentId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: ownerAgentId,
        companyId,
        name: "Source Owner",
        role: "implementer",
        status: "idle",
        reportsTo: recoveryAgentId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(projects).values([
      { id: incidentProjectId, companyId, name: "Recovery Incidents" },
      { id: nativeRepairProjectId, companyId, name: "Native Repairs" },
      { id: frameworkRepairProjectId, companyId, name: "Framework Repairs" },
    ]);
    await db.insert(recoveryEngineerConfigs).values({
      companyId,
      enabled: true,
      agentId: recoveryAgentId,
      repairAgentId,
      reviewerAgentId,
      projectId: incidentProjectId,
      repairProjectIds: {
        native: nativeRepairProjectId,
        framework: frameworkRepairProjectId,
      },
      maxAttempts: 1,
      sweepIntervalSec: 300,
    });
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Original source task",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: ownerAgentId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    const sourceIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, sourceIssueId))
      .then((rows) => rows[0]!);
    return {
      companyId,
      prefix,
      recoveryAgentId,
      repairAgentId,
      reviewerAgentId,
      ownerAgentId,
      incidentProjectId,
      sourceIssueId,
      sourceIssue,
    };
  }

  async function seedRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    status: string;
    errorCode?: string;
    error?: string;
    stderrExcerpt?: string;
    createdAt?: Date;
    livenessState?: string | null;
    lastUsefulActionAt?: Date | null;
  }) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "automation",
      status: input.status,
      nativeIssueId: input.issueId,
      contextSnapshot: { issueId: input.issueId, taskId: input.issueId },
      createdAt: input.createdAt,
      startedAt: new Date("2026-09-09T10:00:00.000Z"),
      finishedAt: input.status === "failed" ? new Date("2026-09-09T10:01:00.000Z") : null,
      errorCode: input.errorCode,
      error: input.error,
      stderrExcerpt: input.stderrExcerpt,
      livenessState: input.livenessState ?? null,
      lastUsefulActionAt: input.lastUsefulActionAt ?? null,
    });
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, id))
      .then((rows) => rows[0]!);
  }

  function createApp(actor: ExpressRequest["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    // Recovery authorization cases do not exercise artifact storage.
    const storage = {} as unknown as Parameters<typeof issueRoutes>[1];
    app.use("/api", issueRoutes(db, storage));
    app.use(errorHandler);
    return app;
  }

  it("supplies source blocking evidence and current gates without granting source access", async () => {
    const seeded = await seedCompany();
    const recovery = recoveryEngineerService(db, { enqueueWakeup: async () => null });
    const run = await seedRun({
      companyId: seeded.companyId, agentId: seeded.ownerAgentId,
      issueId: seeded.sourceIssueId, status: "failed",
      errorCode: "adapter_failed", stderrExcerpt: "workspace resolution failed",
    });
    await recovery.observeRunTerminal(run);
    await db.insert(issueComments).values({
      companyId: seeded.companyId, issueId: seeded.sourceIssueId,
      body: "Waiting on missing workspace. Authorization: Bearer secret-source-token",
    });
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, seeded.ownerAgentId));
    const context = await recovery.readContext({
      issueId: seeded.sourceIssueId,
      actor: { actorType: "user", agentId: null, userId: "board", runId: null, board: true },
      sourceLimit: 10, procedureLimit: 10,
    });
    expect(context.sources[0]).toMatchObject({
      currentContext: {
        owner: { id: seeded.ownerAgentId, status: "paused", invokable: false },
        gates: { human: true },
        latestRun: { runId: run.id },
        comments: [{ body: expect.stringContaining("Waiting on missing workspace") }],
      },
    });
    expect(JSON.stringify(context)).not.toContain("secret-source-token");
    expect(context.resumeGate.status).toBe("verification_required");
  });

  it("routes a resolver crash to the configured recovery engineer instead of a human configuration gate", async () => {
    const seeded = await seedCompany();
    const sourceRun = await seedRun({
      companyId: seeded.companyId,
      agentId: seeded.ownerAgentId,
      issueId: seeded.sourceIssueId,
      status: "failed",
      errorCode: "execution_resource_resolver_failed",
      error: "execution resource resolver failed: 1 - stderr: cannot read canonical lane lock",
    });
    const recovery = recoveryEngineerService(db, {
      enqueueWakeup: async (agentId, options) => {
        const issueId = options.contextSnapshot?.issueId;
        if (typeof issueId !== "string") throw new Error("Expected recovery wake issueId");
        return seedRun({ companyId: seeded.companyId, agentId, issueId, status: "queued" });
      },
    });

    await expect(recovery.observeRunTerminal(sourceRun)).resolves.toMatchObject({
      observed: true,
      duplicate: false,
    });
    const incident = await db.select().from(recoveryEngineerIncidents)
      .where(eq(recoveryEngineerIncidents.companyId, seeded.companyId))
      .then((rows) => rows[0]!);
    const diagnosisRun = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, incident.diagnosisRunId!))
      .then((rows) => rows[0]!);
    expect(incident.status).toBe("diagnosing");
    expect(diagnosisRun).toMatchObject({
      agentId: seeded.recoveryAgentId,
      nativeIssueId: incident.maintenanceIssueId,
      status: "queued",
    });
    const sourceIssue = await db.select().from(issues)
      .where(eq(issues.id, seeded.sourceIssueId))
      .then((rows) => rows[0]!);
    expect(sourceIssue.assigneeAgentId).toBe(seeded.ownerAgentId);
  });

  it("deduplicates repeated terminal events and escalates its own failed diagnosis once", async () => {
    const seeded = await seedCompany();
    const sourceRun = await seedRun({
      companyId: seeded.companyId,
      agentId: seeded.ownerAgentId,
      issueId: seeded.sourceIssueId,
      status: "failed",
      errorCode: "adapter_failed",
      error: "Process exited with code 1",
      stderrExcerpt: "write /dev/stdout: resource temporarily unavailable",
    });
    const enqueueWakeup: RecoveryEngineerWakeup = vi.fn(async (agentId, options) => {
      const issueId = options.contextSnapshot?.issueId;
      if (typeof issueId !== "string") throw new Error("Expected recovery wake issueId");
      return seedRun({
        companyId: seeded.companyId,
        agentId,
        issueId,
        status: "queued",
      });
    });
    const recovery = recoveryEngineerService(db, { enqueueWakeup });

    const first = await recovery.observeRunTerminal(sourceRun);
    const second = await recovery.observeRunTerminal(sourceRun);

    expect(first).toMatchObject({ observed: true, duplicate: false });
    expect(second).toMatchObject({ observed: true, duplicate: true });
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    const incidentRows = await db.select().from(recoveryEngineerIncidents);
    const sourceRows = await db.select().from(recoveryEngineerIncidentSources);
    expect(incidentRows).toHaveLength(1);
    expect(sourceRows).toHaveLength(1);
    expect(incidentRows[0]).toMatchObject({ diagnosisAttemptCount: 1, status: "diagnosing" });

    const diagnosisRun = await db
      .update(heartbeatRuns)
      .set({
        status: "failed",
        errorCode: "adapter_failed",
        error: "Recovery diagnosis failed",
        finishedAt: new Date("2026-09-09T10:02:00.000Z"),
      })
      .where(eq(heartbeatRuns.id, incidentRows[0]!.diagnosisRunId!))
      .returning()
      .then((rows) => rows[0]!);
    await recovery.observeRunTerminal(diagnosisRun);
    await recovery.observeRunTerminal(diagnosisRun);

    const escalated = await db
      .select()
      .from(recoveryEngineerIncidents)
      .where(eq(recoveryEngineerIncidents.id, incidentRows[0]!.id))
      .then((rows) => rows[0]!);
    expect(escalated.status).toBe("escalated");
    expect(escalated.boardEscalationReason).toBe("recovery_run_failed");
    expect(escalated.boardEscalatedAt).not.toBeNull();
    expect(await db.select().from(recoveryEngineerIncidents)).toHaveLength(1);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("leaves human, dependency, and provider gates to their native owners", async () => {
    const seeded = await seedCompany();
    const noWakeup: RecoveryEngineerWakeup = async () => null;
    const recovery = recoveryEngineerService(db, { enqueueWakeup: noWakeup });
    const humanIssueId = randomUUID();
    const dependencyIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    const providerIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: humanIssueId,
        companyId: seeded.companyId,
        title: "Needs board approval",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: seeded.ownerAgentId,
        unblockDescriptor: { owner: "board", action: "Approve the external change" },
        issueNumber: 2,
        identifier: `${seeded.prefix}-2`,
      },
      {
        id: dependencyIssueId,
        companyId: seeded.companyId,
        title: "Waiting on dependency",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: seeded.ownerAgentId,
        issueNumber: 3,
        identifier: `${seeded.prefix}-3`,
      },
      {
        id: blockerIssueId,
        companyId: seeded.companyId,
        title: "Unfinished blocker",
        status: "todo",
        priority: "medium",
        assigneeAgentId: seeded.ownerAgentId,
        issueNumber: 4,
        identifier: `${seeded.prefix}-4`,
      },
      {
        id: providerIssueId,
        companyId: seeded.companyId,
        title: "Provider quota failure",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: seeded.ownerAgentId,
        issueNumber: 5,
        identifier: `${seeded.prefix}-5`,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId: seeded.companyId,
      issueId: blockerIssueId,
      relatedIssueId: dependencyIssueId,
      type: "blocks",
    });
    const providerRun = await seedRun({
      companyId: seeded.companyId,
      agentId: seeded.ownerAgentId,
      issueId: providerIssueId,
      status: "failed",
      errorCode: "provider_quota",
      error: "Provider usage quota reached",
    });

    await expect(recovery.observeBlockedIssue(humanIssueId)).resolves.toMatchObject({
      observed: false,
      reason: "human_gate",
    });
    await expect(recovery.observeBlockedIssue(dependencyIssueId)).resolves.toMatchObject({
      observed: false,
      reason: "dependency_gate",
    });
    await expect(recovery.observeRunTerminal(providerRun)).resolves.toMatchObject({
      observed: false,
      reason: "provider_gate",
    });
    expect(await db.select().from(recoveryEngineerIncidents)).toHaveLength(0);
  });

  it("rejects agent verification, procedure promotion, and resume outside the configured role", async () => {
    const seeded = await seedCompany();
    const maintenanceIssueId = randomUUID();
    const repairIssueId = randomUUID();
    const incidentId = randomUUID();
    const procedureId = randomUUID();
    await db.insert(issues).values([
      {
        id: maintenanceIssueId,
        companyId: seeded.companyId,
        title: "Recovery incident",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: seeded.recoveryAgentId,
        issueNumber: 2,
        identifier: `${seeded.prefix}-2`,
        originKind: "recovery_engineer_incident",
        originId: incidentId,
      },
      {
        id: repairIssueId,
        companyId: seeded.companyId,
        title: "Scoped native repair",
        status: "in_review",
        priority: "high",
        assigneeAgentId: seeded.reviewerAgentId,
        issueNumber: 3,
        identifier: `${seeded.prefix}-3`,
        originKind: "recovery_engineer_repair",
        originId: incidentId,
      },
    ]);
    await db.insert(recoveryEngineerIncidents).values({
      id: incidentId,
      companyId: seeded.companyId,
      failureFingerprint: "failure-fingerprint",
      status: "verifying",
      classification: "task_defect",
      maintenanceIssueId,
      diagnosisAttemptCount: 1,
      repairTarget: "native",
      repairIssueId,
      repairCommit: "0123456789abcdef0123456789abcdef01234567",
    });
    await db.insert(recoveryEngineerIncidentSources).values({
      companyId: seeded.companyId,
      incidentId,
      sourceIssueId: seeded.sourceIssueId,
      sourceRunId: null,
      generationKey: "blocked:0",
      originalOwnerAgentId: seeded.ownerAgentId,
      originalOwnerUserId: null,
      sourceStatus: seeded.sourceIssue.status,
      sourceStatusVersion: seeded.sourceIssue.statusVersion,
      sourceUpdatedAt: seeded.sourceIssue.updatedAt,
      evidence: {},
    });
    await db.insert(recoveryEngineerProcedures).values({
      id: procedureId,
      companyId: seeded.companyId,
      incidentId,
      status: "proposed",
      title: "Safe recovery procedure",
      preconditions: ["Failure reproduced"],
      steps: ["Apply scoped repair"],
      successCheck: "Reproduction passes",
      stopConditions: ["Unexpected mutation"],
      rollback: "Revert repair commit",
      evidenceRunId: randomUUID(),
      repairCommit: "0123456789abcdef0123456789abcdef01234567",
      failureFingerprint: "failure-fingerprint",
      classification: "task_defect",
    });
    const repairRun = await seedRun({
      companyId: seeded.companyId,
      agentId: seeded.repairAgentId,
      issueId: repairIssueId,
      status: "running",
    });
    const reviewerRun = await seedRun({
      companyId: seeded.companyId,
      agentId: seeded.reviewerAgentId,
      issueId: repairIssueId,
      status: "running",
    });

    const repairActor: ExpressRequest["actor"] = {
      type: "agent",
      source: "agent_jwt",
      companyId: seeded.companyId,
      agentId: seeded.repairAgentId,
      runId: repairRun.id,
    };
    const reviewerActor: ExpressRequest["actor"] = {
      type: "agent",
      source: "agent_jwt",
      companyId: seeded.companyId,
      agentId: seeded.reviewerAgentId,
      runId: reviewerRun.id,
    };
    const promotion = await request(createApp(repairActor))
      .put(`/api/companies/${seeded.companyId}/recovery-engineer/procedures/${procedureId}`)
      .send({ status: "reviewed", reviewNote: "Looks safe" });
    expect(promotion.status).toBe(403);

    const verification = await request(createApp(repairActor))
      .post(`/api/issues/${repairIssueId}/recovery-engineer`)
      .send({
        action: "verify",
        reviewRunId: reviewerRun.id,
        repairCommit: "0123456789abcdef0123456789abcdef01234567",
        reproductionCommand: "pnpm test recovery",
        reproductionResult: "passed",
      });
    expect(verification.status).toBe(403);
    expect(await db.select().from(recoveryEngineerVerifications)).toHaveLength(0);

    const resume = await request(createApp(reviewerActor))
      .post(`/api/issues/${seeded.sourceIssueId}/recovery-engineer`)
      .send({ action: "resume", sourceIssueId: seeded.sourceIssueId });
    expect(resume.status).toBe(403);
  });

  it.each(["stage", "interaction", "wrong_run", "pending_gate"] as const)("binds successful verification to its native %s review authority", async (reviewMode) => {
    const seeded = await seedCompany();
    const maintenanceIssueId = randomUUID();
    const repairIssueId = randomUUID();
    const incidentId = randomUUID();
    const repairCommit = "abcdef0123456789abcdef0123456789abcdef01";
    await db.insert(issues).values([
      {
        id: maintenanceIssueId,
        companyId: seeded.companyId,
        title: "Recovery incident awaiting review",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: seeded.recoveryAgentId,
        issueNumber: 2,
        identifier: `${seeded.prefix}-2`,
        originKind: "recovery_engineer_incident",
        originId: incidentId,
      },
      {
        id: repairIssueId,
        companyId: seeded.companyId,
        title: "Repair under independent review",
        status: "in_review",
        priority: "high",
        assigneeAgentId: seeded.repairAgentId,
        issueNumber: 3,
        identifier: `${seeded.prefix}-3`,
        originKind: "recovery_engineer_repair",
        originId: incidentId,
      },
    ]);
    const repairRun = await seedRun({
      companyId: seeded.companyId,
      agentId: seeded.repairAgentId,
      issueId: repairIssueId,
      status: "succeeded",
    });
    await db.insert(recoveryEngineerIncidents).values({
      id: incidentId,
      companyId: seeded.companyId,
      failureFingerprint: "pending-review-failure",
      status: "verifying",
      classification: "task_defect",
      maintenanceIssueId,
      diagnosisAttemptCount: 1,
      repairTarget: "native",
      repairIssueId,
      repairRunId: repairRun.id,
    });
    const reviewerRun = await seedRun({
      companyId: seeded.companyId,
      agentId: seeded.reviewerAgentId,
      issueId: repairIssueId,
      status: "running",
    });
    const reviewerActor: ExpressRequest["actor"] = {
      type: "agent",
      source: "agent_jwt",
      companyId: seeded.companyId,
      agentId: seeded.reviewerAgentId,
      runId: reviewerRun.id,
    };

    const submitted = await request(createApp(reviewerActor))
      .post(`/api/issues/${repairIssueId}/recovery-engineer`)
      .send({
        action: "verify",
        reviewRunId: reviewerRun.id,
        repairCommit,
        reproductionCommand: "pnpm test recovery",
        reproductionResult: "passed",
      });
    expect(submitted.status).toBe(200);
    expect(submitted.body.status).toBe("pending");
    expect(
      await db
        .select()
        .from(recoveryEngineerIncidents)
        .where(eq(recoveryEngineerIncidents.id, incidentId))
        .then((rows) => rows[0]!.verifiedAt),
    ).toBeNull();

    const interactionId = randomUUID();
    if (reviewMode === "stage") {
      await db.insert(issueExecutionDecisions).values({
        companyId: seeded.companyId, issueId: repairIssueId, stageId: randomUUID(),
        stageType: "review", actorAgentId: seeded.reviewerAgentId, outcome: "approved",
        body: "Independent reproduction passed at the submitted repair commit.",
        createdByRunId: reviewerRun.id,
      });
    } else {
      await db.insert(issueThreadInteractions).values({
        id: interactionId, companyId: seeded.companyId, issueId: repairIssueId,
        kind: "request_confirmation", status: "accepted",
        createdByAgentId: seeded.repairAgentId, sourceRunId: repairRun.id,
        addresseeAgentId: seeded.reviewerAgentId, resolvedByAgentId: seeded.reviewerAgentId,
        resolvedByRunId: reviewMode === "wrong_run" ? repairRun.id : reviewerRun.id,
        payload: { version: 1, prompt: "Review exact repair", allowDeclineReason: true },
        result: { version: 1, outcome: "accepted" },
      });
    }
    if (reviewMode === "pending_gate") {
      await db.insert(issueThreadInteractions).values({
        companyId: seeded.companyId, issueId: repairIssueId,
        kind: "request_confirmation", status: "pending",
        payload: { version: 1, prompt: "Independent operator gate", allowDeclineReason: true },
      });
    }
    const succeededReviewRun = await db
      .update(heartbeatRuns)
      .set({
        status: "succeeded",
        contextSnapshot: {
          issueId: repairIssueId,
          ...(reviewMode === "stage" ? {} : { interactionId }),
        },
        finishedAt: new Date("2026-09-09T11:00:00.000Z"),
      })
      .where(eq(heartbeatRuns.id, reviewerRun.id))
      .returning()
      .then((rows) => rows[0]!);
    const noWakeup: RecoveryEngineerWakeup = async () => null;
    await recoveryEngineerService(db, { enqueueWakeup: noWakeup })
      .observeRunTerminal(succeededReviewRun);

    const verification = await db
      .select()
      .from(recoveryEngineerVerifications)
      .where(eq(recoveryEngineerVerifications.reviewRunId, reviewerRun.id))
      .then((rows) => rows[0]!);
    const incident = await db
      .select()
      .from(recoveryEngineerIncidents)
      .where(eq(recoveryEngineerIncidents.id, incidentId))
      .then((rows) => rows[0]!);
    const repairIssue = await db.select().from(issues)
      .where(eq(issues.id, repairIssueId)).then((rows) => rows[0]!);
    if (reviewMode === "wrong_run") {
      expect(verification.status).toBe("failed");
      expect(verification.failureReason).toBe("review_run_not_approved");
      expect(incident.verifiedAt).toBeNull();
      expect(repairIssue.status).toBe("in_review");
      return;
    }
    expect(verification.status).toBe("verified");
    expect(verification.finalizedAt).not.toBeNull();
    expect(incident).toMatchObject({
      status: "verified",
      repairCommit,
      verifiedVerificationId: verification.id,
      verifiedReviewRunId: reviewerRun.id,
    });
    expect(incident.activatedAt).toBeNull();
    expect(repairIssue.status).toBe(reviewMode === "pending_gate" ? "in_review" : "done");
    expect(repairIssue.assigneeAgentId).toBe(seeded.repairAgentId);
  });

  it("requires board-confirmed activation before an authorized recovery run can resume a source", async () => {
    const seeded = await seedCompany();
    const maintenanceIssueId = randomUUID();
    const repairIssueId = randomUUID();
    const incidentId = randomUUID();
    const verificationId = randomUUID();
    const repairCommit = "0123456789abcdef0123456789abcdef01234567";
    await db.insert(issues).values([
      {
        id: maintenanceIssueId,
        companyId: seeded.companyId,
        title: "Recovery incident",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: seeded.recoveryAgentId,
        issueNumber: 2,
        identifier: `${seeded.prefix}-2`,
        originKind: "recovery_engineer_incident",
        originId: incidentId,
      },
      {
        id: repairIssueId,
        companyId: seeded.companyId,
        title: "Reviewed repair",
        status: "done",
        priority: "high",
        assigneeAgentId: seeded.repairAgentId,
        issueNumber: 3,
        identifier: `${seeded.prefix}-3`,
        originKind: "recovery_engineer_repair",
        originId: incidentId,
      },
    ]);
    const reviewRun = await seedRun({
      companyId: seeded.companyId,
      agentId: seeded.reviewerAgentId,
      issueId: repairIssueId,
      status: "succeeded",
    });
    await db.insert(recoveryEngineerIncidents).values({
      id: incidentId,
      companyId: seeded.companyId,
      failureFingerprint: "verified-failure",
      status: "verified",
      classification: "infrastructure",
      maintenanceIssueId,
      diagnosisAttemptCount: 1,
      repairTarget: "native",
      repairIssueId,
      repairCommit,
      verifiedVerificationId: verificationId,
      verifiedReviewRunId: reviewRun.id,
      verifiedAt: new Date("2026-09-09T11:00:00.000Z"),
    });
    await db.insert(recoveryEngineerVerifications).values({
      id: verificationId,
      companyId: seeded.companyId,
      incidentId,
      repairIssueId,
      reviewRunId: reviewRun.id,
      status: "verified",
      repairCommit,
      reproductionCommand: "pnpm test recovery",
      reproductionResult: "passed",
      finalizedAt: new Date("2026-09-09T11:00:00.000Z"),
    });
    await db.insert(recoveryEngineerIncidentSources).values({
      companyId: seeded.companyId,
      incidentId,
      sourceIssueId: seeded.sourceIssueId,
      generationKey: "blocked:0",
      originalOwnerAgentId: seeded.ownerAgentId,
      originalOwnerUserId: null,
      sourceStatus: seeded.sourceIssue.status,
      sourceStatusVersion: seeded.sourceIssue.statusVersion,
      sourceUpdatedAt: seeded.sourceIssue.updatedAt,
      evidence: {},
    });
    const recoveryRun = await seedRun({
      companyId: seeded.companyId,
      agentId: seeded.recoveryAgentId,
      issueId: maintenanceIssueId,
      status: "running",
    });
    const actor: ExpressRequest["actor"] = {
      type: "agent",
      source: "agent_jwt",
      companyId: seeded.companyId,
      agentId: seeded.recoveryAgentId,
      runId: recoveryRun.id,
    };

    const response = await request(createApp(actor))
      .post(`/api/issues/${seeded.sourceIssueId}/recovery-engineer`)
      .send({ action: "resume", sourceIssueId: seeded.sourceIssueId });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain("has not been activated");

    const wakes: string[] = [];
    const recovery = recoveryEngineerService(db, {
      enqueueWakeup: async (agentId, options) => {
        if (options.reason !== "recovery_engineer_resume") return null;
        wakes.push(agentId);
        return seedRun({
          companyId: seeded.companyId,
          agentId,
          issueId: String(options.payload?.issueId),
          status: "queued",
        });
      },
    });
    await recovery.confirmActivation(seeded.companyId, incidentId, {
      repairCommit, activationEvidence: "Exact verified revision installed in disposable runtime",
    }, "board-user");
    await recovery.recordAction(
      maintenanceIssueId,
      { action: "resume", sourceIssueId: seeded.sourceIssueId },
      {
        board: false, actorType: "agent", agentId: seeded.recoveryAgentId,
        userId: null, runId: recoveryRun.id,
      },
    );
    expect(wakes).toEqual([seeded.ownerAgentId]);
    const after = await db.select().from(issues).where(eq(issues.id, seeded.sourceIssueId)).then((rows) => rows[0]!);
    expect(after.assigneeAgentId).toBe(seeded.ownerAgentId);
    expect(after.status).not.toBe("done");
  });

  describe("recordTrustedMaintenanceWaitForRun", () => {
    // Polls pg_stat_activity until a backend is provably waiting on a row
    // lock. The interleaving below must not depend on wall-clock timing, and
    // the awaited condition (a live database lock wait) exists only on the
    // real server clock, so deterministic fake timers cannot drive it; the
    // bounded poll mirrors the delivery lifecycle boundary suite convention.
    // In this fixture the only backend that can wait on a lock is the wait
    // record's transaction.
    async function waitForIssueLockWaiter() {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const rows = await db.$client<Array<{ wait_event_type: string | null }>>`
          select wait_event_type
          from pg_stat_activity
          where datname = current_database()
            and pid <> pg_backend_pid()
        `;
        if (rows.some((row) => row.wait_event_type === "Lock")) return;
        if (Date.now() > deadline) {
          throw new Error("timed out waiting for the maintenance-issue lock waiter");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    async function seedIncidentWithMaintenanceIssue(input: { incidentStatus: string }) {
      const seeded = await seedCompany();
      const maintenanceIssueId = randomUUID();
      const incidentId = randomUUID();
      await db.insert(issues).values({
        id: maintenanceIssueId,
        companyId: seeded.companyId,
        title: `Recovery incident maintenance`,
        status: "in_progress",
        priority: "high",
        assigneeAgentId: seeded.recoveryAgentId,
        issueNumber: 2,
        identifier: `${seeded.prefix}-2`,
        originKind: "recovery_engineer_incident",
        originId: incidentId,
      });
      await db.insert(recoveryEngineerIncidents).values({
        id: incidentId,
        companyId: seeded.companyId,
        failureFingerprint: "trusted-maintenance-wait",
        status: input.incidentStatus,
        maintenanceIssueId,
        diagnosisAttemptCount: 1,
      });
      const diagnosisRun = await db
        .insert(heartbeatRuns)
        .values({
          id: randomUUID(),
          companyId: seeded.companyId,
          agentId: seeded.recoveryAgentId,
          invocationSource: "automation",
          status: "succeeded",
          nativeIssueId: maintenanceIssueId,
          contextSnapshot: {
            issueId: maintenanceIssueId,
            taskId: maintenanceIssueId,
            incidentId,
            wakeReason: "recovery_engineer_diagnose",
            source: "recovery_engineer.incident_detected",
            recoveryRole: "diagnosis",
          },
          createdAt: new Date("2026-09-09T10:00:00.000Z"),
          startedAt: new Date("2026-09-09T10:00:00.000Z"),
          finishedAt: new Date("2026-09-09T10:05:00.000Z"),
        })
        .returning()
        .then((rows) => rows[0]!);
      return { ...seeded, maintenanceIssueId, incidentId, diagnosisRun };
    }

    async function readMaintenanceIssue(maintenanceIssueId: string) {
      return db.select().from(issues).where(eq(issues.id, maintenanceIssueId)).then((rows) => rows[0]!);
    }

    it("persists a durable owner-preserving board wait for the constrained recovery run", async () => {
      const seeded = await seedIncidentWithMaintenanceIssue({ incidentStatus: "diagnosing" });
      const noWakeup: RecoveryEngineerWakeup = async () => null;
      const recovery = recoveryEngineerService(db, { enqueueWakeup: noWakeup });

      await expect(recovery.recordTrustedMaintenanceWaitForRun(seeded.diagnosisRun)).resolves.toBe(true);

      const maintenance = await readMaintenanceIssue(seeded.maintenanceIssueId);
      expect(maintenance.status).toBe("blocked");
      expect(maintenance.unblockDescriptor).toMatchObject({
        owner: "board",
        action: expect.stringContaining(seeded.incidentId),
      });
      // owner-preserving: the configured recovery participant stays assigned
      expect(maintenance.assigneeAgentId).toBe(seeded.recoveryAgentId);
      expect(maintenance.assigneeUserId).toBeNull();

      const logged = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "recovery_engineer.maintenance_wait_recorded"));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        entityType: "recovery_engineer_incident",
        entityId: seeded.incidentId,
        runId: seeded.diagnosisRun.id,
      });

      // re-observing the same terminal run must not rewrite the wait
      await expect(recovery.recordTrustedMaintenanceWaitForRun(seeded.diagnosisRun)).resolves.toBe(false);
      const reread = await readMaintenanceIssue(seeded.maintenanceIssueId);
      expect(reread.unblockDescriptor).toEqual(maintenance.unblockDescriptor);
    });

    it("ignores wrong-generation evidence from a newer run on the maintenance issue", async () => {
      const seeded = await seedIncidentWithMaintenanceIssue({ incidentStatus: "diagnosing" });
      const newerRun = await seedRun({
        companyId: seeded.companyId,
        agentId: seeded.recoveryAgentId,
        issueId: seeded.maintenanceIssueId,
        status: "succeeded",
      });
      await db.update(heartbeatRuns).set({
        createdAt: new Date("2026-09-09T12:00:00.000Z"),
        contextSnapshot: {
          issueId: seeded.maintenanceIssueId,
          taskId: seeded.maintenanceIssueId,
          incidentId: seeded.incidentId,
          wakeReason: "recovery_engineer_activated",
          recoveryRole: "resume",
        },
      }).where(eq(heartbeatRuns.id, newerRun.id));
      const noWakeup: RecoveryEngineerWakeup = async () => null;
      const recovery = recoveryEngineerService(db, { enqueueWakeup: noWakeup });
      const before = await readMaintenanceIssue(seeded.maintenanceIssueId);

      await expect(recovery.recordTrustedMaintenanceWaitForRun(seeded.diagnosisRun)).resolves.toBe(false);

      const after = await readMaintenanceIssue(seeded.maintenanceIssueId);
      expect(after.status).toBe("in_progress");
      expect(after.unblockDescriptor).toBeNull();
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    });

    it("ignores evidence from an incident whose maintenance is no longer authoritative", async () => {
      const seeded = await seedIncidentWithMaintenanceIssue({ incidentStatus: "resolved" });
      const noWakeup: RecoveryEngineerWakeup = async () => null;
      const recovery = recoveryEngineerService(db, { enqueueWakeup: noWakeup });
      const before = await readMaintenanceIssue(seeded.maintenanceIssueId);

      await expect(recovery.recordTrustedMaintenanceWaitForRun(seeded.diagnosisRun)).resolves.toBe(false);

      const after = await readMaintenanceIssue(seeded.maintenanceIssueId);
      expect(after.status).toBe("in_progress");
      expect(after.unblockDescriptor).toBeNull();
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    });

    it("ignores runs from participants that are not the configured recovery agent", async () => {
      const seeded = await seedIncidentWithMaintenanceIssue({ incidentStatus: "diagnosing" });
      const repairRun = await seedRun({
        companyId: seeded.companyId,
        agentId: seeded.repairAgentId,
        issueId: seeded.maintenanceIssueId,
        status: "succeeded",
      });
      const noWakeup: RecoveryEngineerWakeup = async () => null;
      const recovery = recoveryEngineerService(db, { enqueueWakeup: noWakeup });

      await expect(recovery.recordTrustedMaintenanceWaitForRun(repairRun)).resolves.toBe(false);

      const after = await readMaintenanceIssue(seeded.maintenanceIssueId);
      expect(after.status).toBe("in_progress");
      expect(after.unblockDescriptor).toBeNull();
    });

    it("never touches a normal implementer's issue or its source assignment", async () => {
      const seeded = await seedIncidentWithMaintenanceIssue({ incidentStatus: "diagnosing" });
      const noWakeup: RecoveryEngineerWakeup = async () => null;
      const recovery = recoveryEngineerService(db, { enqueueWakeup: noWakeup });
      const ownerRun = await seedRun({
        companyId: seeded.companyId,
        agentId: seeded.ownerAgentId,
        issueId: seeded.sourceIssueId,
        status: "succeeded",
      });
      const before = await db.select().from(issues).where(eq(issues.id, seeded.sourceIssueId)).then((rows) => rows[0]!);

      await expect(recovery.recordTrustedMaintenanceWaitForRun(ownerRun)).resolves.toBe(false);

      const after = await db.select().from(issues).where(eq(issues.id, seeded.sourceIssueId)).then((rows) => rows[0]!);
      expect(after.status).toBe(before.status);
      expect(after.assigneeAgentId).toBe(seeded.ownerAgentId);
      expect(after.unblockDescriptor).toBe(before.unblockDescriptor);
    });

    it("refuses to record a wait when a queued wake already owns the next action", async () => {
      const seeded = await seedIncidentWithMaintenanceIssue({ incidentStatus: "diagnosing" });
      await db.insert(agentWakeupRequests).values({
        companyId: seeded.companyId,
        agentId: seeded.recoveryAgentId,
        source: "automation",
        status: "queued",
        payload: { issueId: seeded.maintenanceIssueId, taskId: seeded.maintenanceIssueId },
      });
      const noWakeup: RecoveryEngineerWakeup = async () => null;
      const recovery = recoveryEngineerService(db, { enqueueWakeup: noWakeup });
      const before = await readMaintenanceIssue(seeded.maintenanceIssueId);

      await expect(recovery.recordTrustedMaintenanceWaitForRun(seeded.diagnosisRun)).resolves.toBe(false);

      const after = await readMaintenanceIssue(seeded.maintenanceIssueId);
      expect(after.status).toBe("in_progress");
      expect(after.unblockDescriptor).toBeNull();
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      const logged = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "recovery_engineer.maintenance_wait_recorded"));
      expect(logged).toHaveLength(0);
    });

    // Deterministic interleaving: the competing operator transaction holds the
    // maintenance-issue row lock, the wait record blocks on that lock, and only
    // then does the operator commit its takeover plus newer execution. The
    // guard re-validation must observe the committed operator state, so the
    // wait can never be written over it.
    it("does not overwrite a competing operator decision that commits during validation", async () => {
      const seeded = await seedIncidentWithMaintenanceIssue({ incidentStatus: "diagnosing" });
      const noWakeup: RecoveryEngineerWakeup = async () => null;
      const recovery = recoveryEngineerService(db, { enqueueWakeup: noWakeup });

      const operatorDecided = Promise.withResolvers<void>();
      const operatorHoldingLock = Promise.withResolvers<void>();
      const operatorUserId = randomUUID();
      // The operator's newer execution generation is a real queued run on the
      // maintenance issue, so the takeover references a live execution.
      const newerExecutionRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: newerExecutionRunId,
        companyId: seeded.companyId,
        agentId: seeded.ownerAgentId,
        invocationSource: "assignment",
        status: "queued",
        nativeIssueId: seeded.maintenanceIssueId,
        contextSnapshot: { issueId: seeded.maintenanceIssueId, taskId: seeded.maintenanceIssueId },
        createdAt: new Date("2026-09-09T12:00:00.000Z"),
      });
      const operatorTx = db.transaction(async (tx) => {
        await tx
          .select({ id: issues.id })
          .from(issues)
          .where(eq(issues.id, seeded.maintenanceIssueId))
          .for("update");
        operatorHoldingLock.resolve();
        await operatorDecided.promise;
        await tx
          .update(issues)
          .set({
            status: "in_progress",
            assigneeAgentId: null,
            assigneeUserId: operatorUserId,
            executionState: {
              status: "running",
              currentStageId: null,
              currentStageIndex: null,
              currentStageType: null,
              currentParticipant: null,
              returnAssignee: null,
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
            checkoutRunId: newerExecutionRunId,
            executionRunId: newerExecutionRunId,
            executionLockedAt: new Date(),
          })
          .where(eq(issues.id, seeded.maintenanceIssueId));
      });

      // The operator provably holds the issue row lock before the wait record
      // starts, and the wait record is provably blocked on that lock before
      // the operator commits. The re-validation must therefore observe the
      // committed operator state, so the wait can never be written over it.
      await operatorHoldingLock.promise;
      const waitRecorded = recovery.recordTrustedMaintenanceWaitForRun(seeded.diagnosisRun);
      await waitForIssueLockWaiter();
      operatorDecided.resolve();
      await operatorTx;

      await expect(waitRecorded).resolves.toBe(false);

      const after = await readMaintenanceIssue(seeded.maintenanceIssueId);
      expect(after.status).toBe("in_progress");
      expect(after.assigneeUserId).toBe(operatorUserId);
      expect(after.assigneeAgentId).toBeNull();
      expect(after.executionState).toMatchObject({ status: "running" });
      expect(after.checkoutRunId).toBe(newerExecutionRunId);
      expect(after.executionRunId).toBe(newerExecutionRunId);
      expect(after.unblockDescriptor).toBeNull();
      const logged = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "recovery_engineer.maintenance_wait_recorded"));
      expect(logged).toHaveLength(0);
    });
  });

  describe("closed-loop recovery outcomes", () => {
    const RESUME_KEY_PREFIX = "recovery-engineer:resume:";

    type SeededCompany = Awaited<ReturnType<typeof seedCompany>>;

    async function readIssue(issueId: string) {
      return db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    }

    async function readIncident(incidentId: string) {
      return db
        .select()
        .from(recoveryEngineerIncidents)
        .where(eq(recoveryEngineerIncidents.id, incidentId))
        .then((rows) => rows[0]!);
    }

    async function readSource(sourceId: string) {
      return db
        .select()
        .from(recoveryEngineerIncidentSources)
        .where(eq(recoveryEngineerIncidentSources.id, sourceId))
        .then((rows) => rows[0]!);
    }

    async function readProcedure(procedureId: string) {
      return db
        .select()
        .from(recoveryEngineerProcedures)
        .where(eq(recoveryEngineerProcedures.id, procedureId))
        .then((rows) => rows[0]!);
    }

    async function readAgent(agentId: string) {
      return db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);
    }

    async function configRowFor(companyId: string) {
      return db
        .select()
        .from(recoveryEngineerConfigs)
        .where(eq(recoveryEngineerConfigs.companyId, companyId))
        .then((rows) => rows[0]!);
    }

    /**
     * Seeds an incident whose repair is independently verified and activated,
     * i.e. the state in which a source generation may be resumed.
     */
    async function seedIncidentPipeline(
      seeded: SeededCompany,
      options: {
        incidentStatus?: string;
        classification?: "infrastructure" | "task_defect" | "human_gate" | "provider_gate" | "already_recovered" | null;
        repairCommit?: string;
        activated?: boolean;
        maintenanceStatus?: string;
        maintenanceDescriptor?: unknown;
        /** Real failure fingerprint for tests that drive admission from a run. */
        failureFingerprint?: string;
      } = {},
    ) {
      const repairCommit = options.repairCommit ?? "0123456789abcdef0123456789abcdef01234567";
      const maintenanceIssueId = randomUUID();
      const repairIssueId = randomUUID();
      const incidentId = randomUUID();
      const verificationId = randomUUID();
      await db.insert(issues).values([
        {
          id: maintenanceIssueId,
          companyId: seeded.companyId,
          title: "Recovery incident maintenance",
          status: options.maintenanceStatus ?? "in_progress",
          priority: "high",
          assigneeAgentId: seeded.recoveryAgentId,
          issueNumber: 200,
          identifier: `${seeded.prefix}-200`,
          originKind: "recovery_engineer_incident",
          originId: incidentId,
          ...(options.maintenanceDescriptor ? { unblockDescriptor: options.maintenanceDescriptor } : {}),
        },
        {
          id: repairIssueId,
          companyId: seeded.companyId,
          title: "Scoped repair under independent review",
          status: "in_review",
          priority: "high",
          assigneeAgentId: seeded.repairAgentId,
          issueNumber: 201,
          identifier: `${seeded.prefix}-201`,
          originKind: "recovery_engineer_repair",
          originId: incidentId,
        },
      ]);
      const repairRun = await seedRun({
        companyId: seeded.companyId,
        agentId: seeded.repairAgentId,
        issueId: repairIssueId,
        status: "succeeded",
      });
      const reviewRun = await seedRun({
        companyId: seeded.companyId,
        agentId: seeded.reviewerAgentId,
        issueId: repairIssueId,
        status: "succeeded",
      });
      await db.insert(recoveryEngineerIncidents).values({
        id: incidentId,
        companyId: seeded.companyId,
        failureFingerprint: options.failureFingerprint ?? `outcome-fingerprint-${incidentId}`,
        status: options.incidentStatus ?? "verified",
        classification: options.classification === undefined ? "infrastructure" : options.classification,
        maintenanceIssueId,
        diagnosisAttemptCount: 1,
        repairTarget: "native",
        repairIssueId,
        repairRunId: repairRun.id,
        repairCommit,
        verifiedVerificationId: verificationId,
        verifiedReviewRunId: reviewRun.id,
        verifiedAt: new Date("2026-09-09T11:00:00.000Z"),
        ...(options.activated === false
          ? {}
          : {
            activatedRepairCommit: repairCommit,
            activationEvidence: "installed in the disposable runtime",
            activatedByUserId: "board-user",
            activatedAt: new Date("2026-09-09T11:05:00.000Z"),
          }),
      });
      // The verification row carries the incident FK, so it is inserted once
      // the incident exists (the incident only stores its id, not a FK).
      await db.insert(recoveryEngineerVerifications).values({
        id: verificationId,
        companyId: seeded.companyId,
        incidentId,
        repairIssueId,
        reviewRunId: reviewRun.id,
        status: "verified",
        repairCommit,
        reproductionCommand: "pnpm test recovery",
        reproductionResult: "passed",
        finalizedAt: new Date("2026-09-09T11:00:00.000Z"),
      });
      return {
        maintenanceIssueId,
        repairIssueId,
        incidentId,
        verificationId,
        repairCommit,
        repairRun,
        reviewRun,
      };
    }

    /** Seeds one failure generation of a source issue, capturing the issue's
     * current native status generation exactly like admission does. */
    async function seedSource(input: {
      seeded: SeededCompany;
      incidentId: string;
      issueId: string;
      ownerAgentId?: string;
      generationKey: string;
      observedAt?: Date;
      resumedAt?: Date | null;
      resumedRunId?: string | null;
    }) {
      const issue = await readIssue(input.issueId);
      const source = await db
        .insert(recoveryEngineerIncidentSources)
        .values({
          companyId: input.seeded.companyId,
          incidentId: input.incidentId,
          sourceIssueId: input.issueId,
          generationKey: input.generationKey,
          originalOwnerAgentId: input.ownerAgentId ?? input.seeded.ownerAgentId,
          originalOwnerUserId: null,
          sourceStatus: issue.status,
          sourceStatusVersion: issue.statusVersion,
          sourceUpdatedAt: issue.updatedAt,
          evidence: {},
          observedAt: input.observedAt ?? new Date(Date.now() - 60_000),
          resumedAt: input.resumedAt ?? null,
          resumedRunId: input.resumedRunId ?? null,
        })
        .returning()
        .then((rows) => rows[0]!);
      return source;
    }

    async function seedRecoveryActorRun(seeded: SeededCompany, maintenanceIssueId: string) {
      return seedRun({
        companyId: seeded.companyId,
        agentId: seeded.recoveryAgentId,
        issueId: maintenanceIssueId,
        status: "running",
      });
    }

    async function claimResume(sourceId: string, incidentId: string, claimedAt: Date) {
      await db
        .update(recoveryEngineerIncidentSources)
        .set({
          resumeClaimedAt: claimedAt,
          resumeIdempotencyKey: `${RESUME_KEY_PREFIX}${incidentId}:${sourceId}`,
        })
        .where(eq(recoveryEngineerIncidentSources.id, sourceId));
    }

    function createWakeupRecorder(input: {
      companyId: string;
      /** Mirrors heartbeat by persisting the wake row, so the next sweep can
       * adopt the dispatch that already materialized. */
      recordWakeRows?: boolean;
      /** Simulates a suppressed wake: nothing is enqueued and no run exists. */
      suppress?: boolean;
    }) {
      const calls: Array<{
        agentId: string;
        reason: string | null;
        idempotencyKey: string | null;
        issueId: string | null;
      }> = [];
      const enqueueWakeup: RecoveryEngineerWakeup = async (agentId, options) => {
        const issueId = typeof options.contextSnapshot?.issueId === "string"
          ? options.contextSnapshot.issueId
          : null;
        calls.push({
          agentId,
          reason: options.reason ?? null,
          idempotencyKey: options.idempotencyKey ?? null,
          issueId,
        });
        if (input.suppress || !issueId) return null;
        const run = await seedRun({
          companyId: input.companyId,
          agentId,
          issueId,
          status: "queued",
        });
        if (input.recordWakeRows) {
          await db.insert(agentWakeupRequests).values({
            companyId: input.companyId,
            agentId,
            source: "automation",
            triggerDetail: "system",
            reason: options.reason ?? null,
            payload: { issueId, taskId: issueId },
            status: "queued",
            idempotencyKey: options.idempotencyKey ?? null,
            runId: run.id,
          });
        }
        return run;
      };
      return { calls, enqueueWakeup };
    }

    it("queues a continuation without closing the failure and recovers only on original-path evidence", async () => {
      const seeded = await seedCompany();
      const pipeline = await seedIncidentPipeline(seeded);
      const sourceRun = await seedRun({
        companyId: seeded.companyId,
        agentId: seeded.ownerAgentId,
        issueId: seeded.sourceIssueId,
        status: "failed",
        errorCode: "adapter_failed",
        stderrExcerpt: "write /dev/stdout: resource temporarily unavailable",
        createdAt: new Date("2026-09-09T10:00:00.000Z"),
      });
      const source = await seedSource({
        seeded,
        incidentId: pipeline.incidentId,
        issueId: seeded.sourceIssueId,
        generationKey: `run:${sourceRun.id}`,
        observedAt: new Date("2026-09-09T10:05:00.000Z"),
      });
      const actorRun = await seedRecoveryActorRun(seeded, pipeline.maintenanceIssueId);
      const wakeups = createWakeupRecorder({ companyId: seeded.companyId });
      const recovery = recoveryEngineerService(db, { enqueueWakeup: wakeups.enqueueWakeup });

      await recovery.recordAction(
        pipeline.maintenanceIssueId,
        { action: "resume", sourceIssueId: seeded.sourceIssueId },
        { board: false, actorType: "agent", agentId: seeded.recoveryAgentId, userId: null, runId: actorRun.id },
      );

      const dispatched = await readSource(source.id);
      expect(dispatched.recoveredAt).toBeNull();
      expect(dispatched.supersededAt).toBeNull();
      expect(dispatched.resumeClaimedAt).not.toBeNull();
      expect(dispatched.resumedAt).not.toBeNull();
      expect(dispatched.resumedRunId).not.toBeNull();
      expect(dispatched.resumeDispatchedAt).not.toBeNull();
      expect(dispatched.resumeAttemptCount).toBe(1);
      expect(dispatched.resumeIdempotencyKey)
        .toBe(`${RESUME_KEY_PREFIX}${pipeline.incidentId}:${source.id}`);
      expect(wakeups.calls).toHaveLength(1);
      expect(wakeups.calls[0]).toMatchObject({
        agentId: seeded.ownerAgentId,
        reason: "recovery_engineer_resume",
      });
      // Enqueueing is not recovery: the incident stays open and the
      // maintenance issue is not completed.
      await expect(readIncident(pipeline.incidentId)).resolves.toMatchObject({
        status: "resumed",
        outcome: "pending",
      });
      expect((await readIssue(pipeline.maintenanceIssueId)).status).toBe("in_progress");

      const resumedRunId = dispatched.resumedRunId!;
      await db
        .update(heartbeatRuns)
        .set({
          status: "succeeded",
          livenessState: "advanced",
          lastUsefulActionAt: new Date("2026-09-09T11:00:00.000Z"),
          finishedAt: new Date("2026-09-09T11:00:00.000Z"),
        })
        .where(eq(heartbeatRuns.id, resumedRunId));
      await db
        .update(heartbeatRuns)
        .set({ status: "succeeded", finishedAt: new Date("2026-09-09T11:30:00.000Z") })
        .where(eq(heartbeatRuns.id, actorRun.id));
      const resumedRun = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, resumedRunId))
        .then((rows) => rows[0]!);

      await recovery.observeRunTerminal(resumedRun);

      const recovered = await readSource(source.id);
      expect(recovered.recoveredAt).not.toBeNull();
      expect(recovered.recoveredRunId).toBe(resumedRunId);
      expect(recovered.recoveredEvidence).toMatchObject({
        reason: "original_path_run",
        runId: resumedRunId,
        livenessState: "advanced",
      });
      await expect(readIncident(pipeline.incidentId)).resolves.toMatchObject({
        status: "resolved",
        outcome: "recovered",
      });
      expect((await readIssue(pipeline.maintenanceIssueId)).status).toBe("done");
      expect(wakeups.calls).toHaveLength(1);

      // Re-observing the same terminal evidence is a no-op.
      await recovery.observeRunTerminal(resumedRun);
      expect((await readSource(source.id)).recoveredRunId).toBe(resumedRunId);
      expect((await readIncident(pipeline.incidentId)).outcome).toBe("recovered");
    });

    it("replays a claimed dispatch after a restart without losing or duplicating the wake", async () => {
      const seeded = await seedCompany();
      const pipeline = await seedIncidentPipeline(seeded);
      const source = await seedSource({
        seeded,
        incidentId: pipeline.incidentId,
        issueId: seeded.sourceIssueId,
        generationKey: "blocked:8",
      });
      await claimResume(source.id, pipeline.incidentId, new Date("2026-09-09T10:10:00.000Z"));
      const configRow = await configRowFor(seeded.companyId);
      const wakeups = createWakeupRecorder({
        companyId: seeded.companyId,
        recordWakeRows: true,
      });
      const recovery = recoveryEngineerService(db, { enqueueWakeup: wakeups.enqueueWakeup });

      // Restart before dispatch: the persisted claim is replayed with the same
      // idempotency key.
      const first = await recovery.reconcileSourceDispatches(configRow);
      expect(first).toMatchObject({ replayed: 1, exhausted: 0 });
      expect(wakeups.calls).toHaveLength(1);
      expect(wakeups.calls[0]?.idempotencyKey)
        .toBe(`${RESUME_KEY_PREFIX}${pipeline.incidentId}:${source.id}`);
      const afterFirst = await readSource(source.id);
      expect(afterFirst.resumeAttemptCount).toBe(1);
      expect(afterFirst.resumedRunId).not.toBeNull();

      // Restart after dispatch with the dispatch record lost: the wake that
      // already materialized is adopted, never duplicated.
      await db
        .update(recoveryEngineerIncidentSources)
        .set({ resumedAt: null, resumedRunId: null, resumeDispatchedAt: null })
        .where(eq(recoveryEngineerIncidentSources.id, source.id));
      const second = await recovery.reconcileSourceDispatches(configRow);
      expect(second).toMatchObject({ adopted: 1, replayed: 0 });
      expect(wakeups.calls).toHaveLength(1);
      const adopted = await readSource(source.id);
      expect(adopted.resumedRunId).toBe(afterFirst.resumedRunId);
      expect(adopted.resumedAt).not.toBeNull();

      // Re-running the sweep cannot mint a second wake for the same decision.
      const third = await recovery.reconcileSourceDispatches(configRow);
      expect(third).toMatchObject({ replayed: 0, adopted: 0, exhausted: 0 });
      expect(wakeups.calls).toHaveLength(1);
    });

    it("bounds dispatch replay and hands an exhausted continuation to the board", async () => {
      const seeded = await seedCompany();
      const pipeline = await seedIncidentPipeline(seeded);
      const source = await seedSource({
        seeded,
        incidentId: pipeline.incidentId,
        issueId: seeded.sourceIssueId,
        generationKey: "blocked:8",
      });
      await claimResume(source.id, pipeline.incidentId, new Date("2026-09-09T10:10:00.000Z"));
      const configRow = await configRowFor(seeded.companyId);
      const wakeups = createWakeupRecorder({ companyId: seeded.companyId, suppress: true });
      const recovery = recoveryEngineerService(db, { enqueueWakeup: wakeups.enqueueWakeup });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await recovery.reconcileSourceDispatches(configRow);
      }
      expect(wakeups.calls).toHaveLength(3);
      const pending = await readSource(source.id);
      expect(pending.resumeAttemptCount).toBe(3);
      expect(pending.resumedAt).toBeNull();
      expect(pending.recoveredAt).toBeNull();
      expect(pending.supersededAt).toBeNull();

      await recovery.reconcileSourceDispatches(configRow);
      expect(wakeups.calls).toHaveLength(3);
      const exhausted = await readSource(source.id);
      expect(exhausted.supersededReason).toBe("resume_attempts_exhausted");
      expect(exhausted.recoveredAt).toBeNull();
      const incident = await readIncident(pipeline.incidentId);
      expect(incident.outcome).toBe("unresolved");
      expect(incident.status).toBe("gated");
      expect(incident.boardEscalatedAt).not.toBeNull();
      const maintenance = await readIssue(pipeline.maintenanceIssueId);
      expect(maintenance.status).toBe("blocked");
      expect(maintenance.unblockDescriptor).toMatchObject({ owner: "board" });
    });

    it("adopts a durable deferred continuation instead of re-enqueueing it", async () => {
      const seeded = await seedCompany();
      const pipeline = await seedIncidentPipeline(seeded);
      const source = await seedSource({
        seeded,
        incidentId: pipeline.incidentId,
        issueId: seeded.sourceIssueId,
        generationKey: "blocked:8",
        resumedAt: new Date("2026-09-09T10:10:00.000Z"),
      });
      await claimResume(source.id, pipeline.incidentId, new Date("2026-09-09T10:10:00.000Z"));
      const idempotencyKey = `${RESUME_KEY_PREFIX}${pipeline.incidentId}:${source.id}`;
      await db.insert(agentWakeupRequests).values({
        companyId: seeded.companyId,
        agentId: seeded.ownerAgentId,
        source: "automation",
        triggerDetail: "system",
        reason: "recovery_engineer_resume",
        payload: { issueId: seeded.sourceIssueId, taskId: seeded.sourceIssueId },
        status: "deferred_issue_execution",
        idempotencyKey,
      });
      const configRow = await configRowFor(seeded.companyId);
      const wakeups = createWakeupRecorder({ companyId: seeded.companyId });
      const recovery = recoveryEngineerService(db, { enqueueWakeup: wakeups.enqueueWakeup });

      // The deferred wake still owns the next action: it is adopted, never
      // re-enqueued.
      await expect(recovery.reconcileSourceDispatches(configRow)).resolves.toMatchObject({
        adopted: 1,
        replayed: 0,
      });
      expect(wakeups.calls).toHaveLength(0);
      expect((await readSource(source.id)).resumedRunId).toBeNull();

      // Once the deferred wake materializes a run, the same sweep adopts the
      // run instead of starting a second continuation.
      const deferredRun = await seedRun({
        companyId: seeded.companyId,
        agentId: seeded.ownerAgentId,
        issueId: seeded.sourceIssueId,
        status: "queued",
      });
      await db
        .update(agentWakeupRequests)
        .set({ runId: deferredRun.id, status: "claimed", claimedAt: new Date() })
        .where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey));
      await recovery.reconcileSourceDispatches(configRow);

      expect(wakeups.calls).toHaveLength(0);
      expect((await readSource(source.id)).resumedRunId).toBe(deferredRun.id);
    });

    // Polls pg_stat_activity until a backend is provably waiting on a row lock,
    // so the roll-up race below depends on a real database lock instead of
    // wall-clock timing (same convention as the maintenance-wait suite). The
    // awaited condition (a live Postgres lock wait) exists only on the real
    // server clock, so fake timers cannot drive it; the bounded poll is the
    // signal, not a guessed delay.
    async function waitForRowLockWaiter() {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const rows = await db.$client<Array<{ wait_event_type: string | null }>>`
          select wait_event_type
          from pg_stat_activity
          where datname = current_database()
            and pid <> pg_backend_pid()
        `;
        if (rows.some((row) => row.wait_event_type === "Lock")) return;
        if (Date.now() > deadline) {
          throw new Error("timed out waiting for the roll-up row lock waiter");
        }
        const poll = Promise.withResolvers<void>();
        setTimeout(poll.resolve, 10);
        await poll.promise;
      }
    }

    it("recovers the incident when the newest generation overcomes the failure after an earlier one was replaced", async () => {
      const seeded = await seedCompany();
      const failingSignature = {
        status: "failed",
        errorCode: "adapter_failed",
        stderrExcerpt: "write /dev/stdout: resource temporarily unavailable",
      } as const;
      const firstFailure = await seedRun({
        companyId: seeded.companyId,
        agentId: seeded.ownerAgentId,
        issueId: seeded.sourceIssueId,
        createdAt: new Date("2026-09-09T10:00:00.000Z"),
        ...failingSignature,
      });
      const pipeline = await seedIncidentPipeline(seeded, {
        incidentStatus: "resumed",
        failureFingerprint: buildRecoveryRunEvidence(
          firstFailure,
          "codex_local",
          seeded.sourceIssueId,
        ).fingerprint,
      });
      const replaced = await seedSource({
        seeded,
        incidentId: pipeline.incidentId,
        issueId: seeded.sourceIssueId,
        generationKey: `run:${firstFailure.id}`,
        observedAt: new Date("2026-09-09T10:05:00.000Z"),
      });
      const recovery = recoveryEngineerService(db, { enqueueWakeup: async () => null });

      // The failure recurs: the newer generation replaces the older one, which
      // is routine bookkeeping and must not be counted as a permanent failure.
      const recurrence = await seedRun({
        companyId: seeded.companyId,
        agentId: seeded.ownerAgentId,
        issueId: seeded.sourceIssueId,
        createdAt: new Date("2026-09-09T11:00:00.000Z"),
        ...failingSignature,
      });
      await recovery.observeRunTerminal(recurrence);
      expect((await readSource(replaced.id)).supersededReason)
        .toBe("superseded_by_newer_generation");
      const sources = await db.select().from(recoveryEngineerIncidentSources);
      const current = sources.find((row) => row.id !== replaced.id)!;
      expect(current.recoveredAt).toBeNull();

      // The current generation's continuation succeeds and advances the path.
      const continuation = await seedRun({
        companyId: seeded.companyId,
        agentId: seeded.ownerAgentId,
        issueId: seeded.sourceIssueId,
        status: "succeeded",
        createdAt: new Date("2026-09-09T11:30:00.000Z"),
        livenessState: "advanced",
        lastUsefulActionAt: new Date("2026-09-09T11:30:00.000Z"),
      });
      await db
        .update(recoveryEngineerIncidentSources)
        .set({ resumedAt: new Date("2026-09-09T11:20:00.000Z"), resumedRunId: continuation.id })
        .where(eq(recoveryEngineerIncidentSources.id, current.id));
      await recovery.observeRunTerminal(continuation);

      expect((await readSource(current.id)).recoveredRunId).toBe(continuation.id);
      const incident = await readIncident(pipeline.incidentId);
      expect(incident).toMatchObject({
        outcome: "recovered",
        status: "resolved",
        boardEscalationReason: "unchanged_failure_recurred_after_single_attempt",
      });
      // The genuinely overcome failure is reported as recovered and the
      // maintenance issue is completed instead of being parked on the board.
      expect((await readIssue(pipeline.maintenanceIssueId)).status).toBe("done");
    });

    it("does not revert a lifecycle status that commits while the roll-up runs", async () => {
      const seeded = await seedCompany();
      const pipeline = await seedIncidentPipeline(seeded);
      const continuation = await seedRun({
        companyId: seeded.companyId,
        agentId: seeded.ownerAgentId,
        issueId: seeded.sourceIssueId,
        status: "queued",
      });
      const source = await seedSource({
        seeded,
        incidentId: pipeline.incidentId,
        issueId: seeded.sourceIssueId,
        generationKey: "blocked:0",
        resumedAt: new Date("2026-09-09T10:30:00.000Z"),
        resumedRunId: continuation.id,
      });
      const recovery = recoveryEngineerService(db, { enqueueWakeup: async () => null });

      const operatorDecided = Promise.withResolvers<void>();
      const operatorHoldingLock = Promise.withResolvers<void>();
      const operatorTx = db.transaction(async (tx) => {
        await tx
          .select({ id: recoveryEngineerIncidents.id })
          .from(recoveryEngineerIncidents)
          .where(eq(recoveryEngineerIncidents.id, pipeline.incidentId))
          .for("update");
        operatorHoldingLock.resolve();
        await operatorDecided.promise;
        await tx
          .update(recoveryEngineerIncidents)
          .set({
            status: "escalated",
            boardEscalatedAt: new Date("2026-09-09T12:00:00.000Z"),
            boardEscalationReason: "concurrent_board_decision",
          })
          .where(eq(recoveryEngineerIncidents.id, pipeline.incidentId));
      });

      // The operator provably holds the incident row lock before the roll-up
      // writes, and the roll-up is provably blocked on it before the operator
      // commits, so the guard must observe the committed decision.
      await operatorHoldingLock.promise;
      const rolled = recovery.reconcileIncidentOutcome(pipeline.incidentId);
      await waitForRowLockWaiter();
      operatorDecided.resolve();
      await operatorTx;

      const rolledIncident = await rolled;
      expect(rolledIncident?.status).toBe("escalated");
      const after = await readIncident(pipeline.incidentId);
      expect(after.status).toBe("escalated");
      expect(after.boardEscalationReason).toBe("concurrent_board_decision");
      expect(after.outcome).toBe("pending");
      expect((await readSource(source.id)).recoveredAt).toBeNull();
    });

    it("does not close maintenance over a generation admitted after the outcome snapshot", async () => {
      const seeded = await seedCompany();
      const pipeline = await seedIncidentPipeline(seeded);
      const original = await seedSource({
        seeded, incidentId: pipeline.incidentId,
        issueId: seeded.sourceIssueId, generationKey: "original",
      });
      await db.update(recoveryEngineerIncidentSources)
        .set({ recoveredAt: new Date() })
        .where(eq(recoveryEngineerIncidentSources.id, original.id));
      const locked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const holding = db.transaction(async (tx) => {
        await tx.select({ id: issues.id }).from(issues)
          .where(eq(issues.id, pipeline.maintenanceIssueId)).for("update");
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      const recovery = recoveryEngineerService(db, { enqueueWakeup: async () => null });
      const closing = recovery.reconcileIncidentOutcome(pipeline.incidentId);
      try {
        await waitForRowLockWaiter();
        await seedSource({
          seeded, incidentId: pipeline.incidentId,
          issueId: seeded.sourceIssueId, generationKey: "recurrence",
        });
      } finally {
        release.resolve();
        await holding;
        await closing;
      }
      expect((await readIssue(pipeline.maintenanceIssueId)).status).toBe("in_progress");
      await recovery.reconcileIncidentOutcome(pipeline.incidentId);
      expect((await readIncident(pipeline.incidentId)).outcome).toBe("pending");
    });

    it("refuses a replay that would wake a stale owner", async () => {
      const seeded = await seedCompany();
      const pipeline = await seedIncidentPipeline(seeded);
      const source = await seedSource({
        seeded,
        incidentId: pipeline.incidentId,
        issueId: seeded.sourceIssueId,
        generationKey: "blocked:8",
      });
      await claimResume(source.id, pipeline.incidentId, new Date("2026-09-09T10:10:00.000Z"));
      const otherAgentId = randomUUID();
      await db.insert(agents).values({
        id: otherAgentId,
        companyId: seeded.companyId,
        name: "Replacement Owner",
        role: "implementer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db
        .update(issues)
        .set({ assigneeAgentId: otherAgentId })
        .where(eq(issues.id, seeded.sourceIssueId));
      const configRow = await configRowFor(seeded.companyId);
      const wakeups = createWakeupRecorder({ companyId: seeded.companyId });
      const recovery = recoveryEngineerService(db, { enqueueWakeup: wakeups.enqueueWakeup });

      await expect(recovery.reconcileSourceDispatches(configRow)).resolves.toMatchObject({
        replayed: 0,
        adopted: 0,
        exhausted: 0,
      });
      expect(wakeups.calls).toHaveLength(0);
      const superseded = await readSource(source.id);
      expect(superseded.resumedRunId).toBeNull();
      expect(superseded.supersededReason).toBe("source_owner_changed");
      expect(superseded.recoveredAt).toBeNull();
      expect((await readIssue(seeded.sourceIssueId)).assigneeAgentId).toBe(otherAgentId);
      const incident = await readIncident(pipeline.incidentId);
      expect(incident.outcome).toBe("unresolved");
      expect(incident.status).toBe("gated");
    });

    it("closes a generation only when the evidence is tied to its own advancement", async () => {
      const seeded = await seedCompany();
      const pipeline = await seedIncidentPipeline(seeded, { incidentStatus: "resumed" });
      const dispatchedRun = await seedRun({
        companyId: seeded.companyId,
        agentId: seeded.ownerAgentId,
        issueId: seeded.sourceIssueId,
        status: "queued",
        createdAt: new Date("2026-09-09T10:30:00.000Z"),
      });
      const source = await seedSource({
        seeded,
        incidentId: pipeline.incidentId,
        issueId: seeded.sourceIssueId,
        generationKey: "blocked:0",
        observedAt: new Date("2026-09-09T10:05:00.000Z"),
        resumedAt: new Date("2026-09-09T10:30:00.000Z"),
        resumedRunId: dispatchedRun.id,
      });
      const configRow = await configRowFor(seeded.companyId);
      const recovery = recoveryEngineerService(db, { enqueueWakeup: async () => null });

      // A useful but unrelated success on the same issue, with the native
      // status generation unchanged, does not prove this failure was overcome.
      const unrelatedRun = await seedRun({
        companyId: seeded.companyId,
        agentId: seeded.ownerAgentId,
        issueId: seeded.sourceIssueId,
        status: "succeeded",
        createdAt: new Date("2026-09-09T11:00:00.000Z"),
        livenessState: "advanced",
        lastUsefulActionAt: new Date("2026-09-09T11:00:00.000Z"),
      });
      await expect(recovery.reconcileSourceOutcomes(configRow)).resolves.toMatchObject({
        recovered: 0,
      });
      const untouched = await readSource(source.id);
      expect(untouched.recoveredAt).toBeNull();
      expect(untouched.supersededAt).toBeNull();
      expect((await readIncident(pipeline.incidentId)).status).toBe("resumed");

      // The same evidence closes the generation once the native status
      // generation actually moved forward.
      await db
        .update(issues)
        .set({ statusVersion: untouched.sourceStatusVersion + 1 })
        .where(eq(issues.id, seeded.sourceIssueId));
      const issue = await readIssue(seeded.sourceIssueId);
      await expect(recovery.reconcileSourceOutcomes(configRow)).resolves.toMatchObject({
        recovered: 1,
      });
      const recovered = await readSource(source.id);
      expect(recovered.recoveredRunId).toBe(unrelatedRun.id);
      expect(recovered.recoveredEvidence).toMatchObject({ reason: "original_path_run" });
      expect((await readIncident(pipeline.incidentId)).outcome).toBe("recovered");
      expect(issue.statusVersion).toBe(untouched.sourceStatusVersion + 1);
    });

    it("terminalizes a recorded application after its generation recovered", async () => {
      const seeded = await seedCompany();
      const pipeline = await seedIncidentPipeline(seeded);
      const incident = await readIncident(pipeline.incidentId);
      const sourceRun = await seedRun({
        companyId: seeded.companyId,
        agentId: seeded.ownerAgentId,
        issueId: seeded.sourceIssueId,
        status: "failed",
        errorCode: "adapter_failed",
        stderrExcerpt: "write /dev/stdout: resource temporarily unavailable",
      });
      const source = await seedSource({
        seeded,
        incidentId: pipeline.incidentId,
        issueId: seeded.sourceIssueId,
        generationKey: `run:${sourceRun.id}`,
      });
      const procedureId = randomUUID();
      await db.insert(recoveryEngineerProcedures).values({
        id: procedureId,
        companyId: seeded.companyId,
        incidentId: pipeline.incidentId,
        status: "reviewed",
        title: "Reapply the scoped repair",
        preconditions: ["Failure reproduced"],
        steps: ["Apply the scoped repair to the named module"],
        successCheck: "Reproduction passes",
        stopConditions: ["Unexpected mutation"],
        rollback: "Revert the repair commit",
        evidenceRunId: pipeline.repairRun.id,
        repairCommit: pipeline.repairCommit,
        failureFingerprint: incident.failureFingerprint,
        classification: "infrastructure",
        applicability: {
          adapterType: "codex_local",
          failureFingerprint: incident.failureFingerprint,
          classification: "infrastructure",
          evidenceRunId: pipeline.repairRun.id,
          sourceGenerationKey: source.generationKey,
          sourceStatusVersion: source.sourceStatusVersion,
        },
      });
      const recovery = recoveryEngineerService(db, { enqueueWakeup: async () => null });
      const boardActor = {
        board: true,
        actorType: "user",
        agentId: null,
        userId: "board-user",
        runId: null,
      } as const;

      await recovery.recordAction(
        seeded.sourceIssueId,
        { action: "reuse_procedure", procedureId, evidenceKey: "reuse-1", outcome: "applied" },
        boardActor,
      );
      // The generation recovers while the application is still open.
      await db
        .update(recoveryEngineerIncidentSources)
        .set({
          recoveredAt: new Date("2026-09-09T12:00:00.000Z"),
          recoveredRunId: pipeline.repairRun.id,
          recoveredEvidence: { reason: "original_path_run" },
        })
        .where(eq(recoveryEngineerIncidentSources.id, source.id));

      // A terminal outcome only finalizes an application that was recorded.
      await expect(recovery.recordAction(
        seeded.sourceIssueId,
        { action: "reuse_procedure", procedureId, evidenceKey: "never-applied", outcome: "succeeded" },
        boardActor,
      )).rejects.toThrow(/No applied procedure reuse/);

      const succeeded = await recovery.recordAction(
        seeded.sourceIssueId,
        {
          action: "reuse_procedure",
          procedureId,
          evidenceKey: "reuse-1",
          outcome: "succeeded",
          evidence: { reproduction: "passed after recovery" },
        },
        boardActor,
      ) as { recorded: boolean; reuse: { status: string; outcomeAt: Date | null } };
      expect(succeeded.recorded).toBe(true);
      expect(succeeded.reuse.status).toBe("succeeded");
      expect(succeeded.reuse.outcomeAt).not.toBeNull();
      expect((await readProcedure(procedureId)).lastReuseOutcome).toBe("succeeded");
      // Nothing new can be applied while no generation is open.
      await expect(recovery.recordAction(
        seeded.sourceIssueId,
        { action: "reuse_procedure", procedureId, evidenceKey: "reuse-2", outcome: "applied" },
        boardActor,
      )).rejects.toThrow(/no open failure generation/);
    });

    it("keeps a recurring failure after the continuation unresolved without a second incident or diagnosis", async () => {
      const seeded = await seedCompany();
      const failingSignature = {
        status: "failed",
        errorCode: "adapter_failed",
        stderrExcerpt: "write /dev/stdout: resource temporarily unavailable",
      } as const;
      const firstFailure = await seedRun({
        companyId: seeded.companyId,
        agentId: seeded.ownerAgentId,
        issueId: seeded.sourceIssueId,
        createdAt: new Date("2026-09-09T10:00:00.000Z"),
        ...failingSignature,
      });
      const pipeline = await seedIncidentPipeline(seeded, {
        incidentStatus: "resumed",
        failureFingerprint: buildRecoveryRunEvidence(
          firstFailure,
          "codex_local",
          seeded.sourceIssueId,
        ).fingerprint,
      });
      const resumedRun = await seedRun({
        companyId: seeded.companyId,
        agentId: seeded.ownerAgentId,
        issueId: seeded.sourceIssueId,
        createdAt: new Date("2026-09-09T11:00:00.000Z"),
        ...failingSignature,
      });
      const original = await seedSource({
        seeded,
        incidentId: pipeline.incidentId,
        issueId: seeded.sourceIssueId,
        generationKey: `run:${firstFailure.id}`,
        observedAt: new Date("2026-09-09T10:05:00.000Z"),
        resumedAt: new Date("2026-09-09T10:30:00.000Z"),
        resumedRunId: resumedRun.id,
      });
      const wakeups = createWakeupRecorder({ companyId: seeded.companyId });
      const recovery = recoveryEngineerService(db, { enqueueWakeup: wakeups.enqueueWakeup });

      await expect(recovery.observeRunTerminal(resumedRun))
        .resolves.toMatchObject({ observed: true });

      expect(await db.select().from(recoveryEngineerIncidents)).toHaveLength(1);
      const sources = await db.select().from(recoveryEngineerIncidentSources);
      expect(sources).toHaveLength(2);
      const originalAfter = await readSource(original.id);
      expect(originalAfter.recoveredAt).toBeNull();
      expect(originalAfter.supersededReason).toBe("superseded_by_newer_generation");
      const recurrence = sources.find((row) => row.id !== original.id)!;
      expect(recurrence.recoveredAt).toBeNull();
      expect(recurrence.supersededAt).toBeNull();
      const incident = await readIncident(pipeline.incidentId);
      expect(incident.diagnosisAttemptCount).toBe(1);
      expect(incident.outcome).toBe("pending");
      expect(incident.boardEscalationReason).toBe("unchanged_failure_recurred_after_single_attempt");
      expect(wakeups.calls).toHaveLength(0);

      const configRow = await configRowFor(seeded.companyId);
      for (let pass = 0; pass < 3; pass += 1) {
        await recovery.reconcileSourceOutcomes(configRow);
      }
      expect(wakeups.calls).toHaveLength(0);
      expect(await db.select().from(recoveryEngineerIncidents)).toHaveLength(1);
      expect(await db.select().from(recoveryEngineerIncidentSources)).toHaveLength(2);
      const afterSweeps = await readIncident(pipeline.incidentId);
      expect(afterSweeps.outcome).toBe("pending");
      expect(afterSweeps.diagnosisAttemptCount).toBe(1);
    });

    it("closes only the source whose original path was proven and keeps linked sources independent", async () => {
      const seeded = await seedCompany();
      const pipeline = await seedIncidentPipeline(seeded, { incidentStatus: "resumed" });
      const siblingIssueId = randomUUID();
      await db.insert(issues).values({
        id: siblingIssueId,
        companyId: seeded.companyId,
        title: "Second linked source",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: seeded.ownerAgentId,
        issueNumber: 202,
        identifier: `${seeded.prefix}-202`,
      });
      const sourceARun = await seedRun({
        companyId: seeded.companyId,
        agentId: seeded.ownerAgentId,
        issueId: seeded.sourceIssueId,
        status: "succeeded",
        createdAt: new Date("2026-09-09T11:00:00.000Z"),
        livenessState: "advanced",
        lastUsefulActionAt: new Date("2026-09-09T11:00:00.000Z"),
      });
      const sourceBRun = await seedRun({
        companyId: seeded.companyId,
        agentId: seeded.ownerAgentId,
        issueId: siblingIssueId,
        status: "queued",
        createdAt: new Date("2026-09-09T11:00:00.000Z"),
      });
      const sourceA = await seedSource({
        seeded,
        incidentId: pipeline.incidentId,
        issueId: seeded.sourceIssueId,
        generationKey: "blocked:8",
        observedAt: new Date("2026-09-09T10:00:00.000Z"),
        resumedAt: new Date("2026-09-09T10:30:00.000Z"),
        resumedRunId: sourceARun.id,
      });
      const sourceB = await seedSource({
        seeded,
        incidentId: pipeline.incidentId,
        issueId: siblingIssueId,
        generationKey: "blocked:3",
        observedAt: new Date("2026-09-09T10:00:00.000Z"),
        resumedAt: new Date("2026-09-09T10:30:00.000Z"),
        resumedRunId: sourceBRun.id,
      });
      const recovery = recoveryEngineerService(db, { enqueueWakeup: async () => null });

      await recovery.observeRunTerminal(sourceARun);

      const recoveredA = await readSource(sourceA.id);
      expect(recoveredA.recoveredRunId).toBe(sourceARun.id);
      const untouchedB = await readSource(sourceB.id);
      expect(untouchedB.recoveredAt).toBeNull();
      expect(untouchedB.supersededAt).toBeNull();
      const partiallyOpen = await readIncident(pipeline.incidentId);
      expect(partiallyOpen.outcome).toBe("pending");
      expect(partiallyOpen.status).toBe("resumed");
      expect((await readIssue(pipeline.maintenanceIssueId)).status).toBe("in_progress");

      // B's continuation fails: B is superseded, A keeps its evidence, and the
      // incident never claims recovery for a source that did not overcome it.
      const configRow = await configRowFor(seeded.companyId);
      await db
        .update(heartbeatRuns)
        .set({ status: "failed", finishedAt: new Date("2026-09-09T12:00:00.000Z") })
        .where(eq(heartbeatRuns.id, sourceBRun.id));
      await recovery.reconcileSourceOutcomes(configRow);

      const failedB = await readSource(sourceB.id);
      expect(failedB.recoveredAt).toBeNull();
      expect(failedB.supersededReason).toBe("continuation_failed");
      expect((await readSource(sourceA.id)).recoveredRunId).toBe(sourceARun.id);
      const unresolved = await readIncident(pipeline.incidentId);
      expect(unresolved.outcome).toBe("unresolved");
      expect(unresolved.status).toBe("gated");
    });

    it("records a stale generation against a changed gate without recreating diagnosis or repair", async () => {
      const seeded = await seedCompany();
      const boardWait = {
        owner: "board",
        action: "Inspect recovery incident evidence and choose the next maintenance action.",
      };
      const pipeline = await seedIncidentPipeline(seeded, {
        incidentStatus: "resumed",
        maintenanceDescriptor: boardWait,
      });
      const source = await seedSource({
        seeded,
        incidentId: pipeline.incidentId,
        issueId: seeded.sourceIssueId,
        generationKey: "blocked:0",
        observedAt: new Date("2026-09-10T09:00:00.000Z"),
      });
      const configRow = await configRowFor(seeded.companyId);
      const wakeups = createWakeupRecorder({ companyId: seeded.companyId });
      const recovery = recoveryEngineerService(db, { enqueueWakeup: wakeups.enqueueWakeup });

      // A cosmetic update (comment, description edit, mere timestamp move) must
      // not invalidate the captured generation.
      await db
        .update(issues)
        .set({ updatedAt: new Date("2026-09-10T10:00:00.000Z") })
        .where(eq(issues.id, seeded.sourceIssueId));
      await expect(recovery.reconcileSourceOutcomes(configRow)).resolves.toMatchObject({
        superseded: 0,
        pending: 1,
      });
      expect((await readSource(source.id)).supersededAt).toBeNull();

      // The native status generation moved on and the board owns a new gate.
      await db
        .update(issues)
        .set({
          status: "blocked",
          statusVersion: 11,
          updatedAt: new Date("2026-09-10T10:30:00.000Z"),
          unblockDescriptor: {
            owner: "board",
            action: "Complete exact repair verification on the existing incident.",
          },
        })
        .where(eq(issues.id, seeded.sourceIssueId));
      await expect(recovery.reconcileSourceOutcomes(configRow)).resolves.toMatchObject({
        superseded: 1,
      });

      const superseded = await readSource(source.id);
      expect(superseded.recoveredAt).toBeNull();
      expect(superseded.supersededReason).toBe("source_gate_changed");
      // The changed gate is preserved verbatim: no ownership change, no
      // descriptor rewrite, no status movement.
      const issueAfter = await readIssue(seeded.sourceIssueId);
      expect(issueAfter.status).toBe("blocked");
      expect(issueAfter.assigneeAgentId).toBe(seeded.ownerAgentId);
      expect(issueAfter.assigneeUserId).toBeNull();
      expect(issueAfter.unblockDescriptor).toEqual({
        owner: "board",
        action: "Complete exact repair verification on the existing incident.",
      });
      expect(issueAfter.updatedAt.getTime()).toBe(new Date("2026-09-10T10:30:00.000Z").getTime());

      const incident = await readIncident(pipeline.incidentId);
      expect(incident.outcome).toBe("unresolved");
      expect(incident.status).toBe("gated");
      expect(incident.diagnosisAttemptCount).toBe(1);
      expect(incident.repairIssueId).toBe(pipeline.repairIssueId);
      // The existing human wait on the maintenance issue survives untouched.
      expect((await readIssue(pipeline.maintenanceIssueId)).unblockDescriptor).toEqual(boardWait);
      expect(await db.select().from(recoveryEngineerIncidents)).toHaveLength(1);
      expect(wakeups.calls).toHaveLength(0);
      expect(await db.select().from(recoveryEngineerProcedures)).toHaveLength(0);
    });

    it("preserves budget pauses and dependency gates while refusing a resume", async () => {
      const seeded = await seedCompany();
      const pipeline = await seedIncidentPipeline(seeded);
      const source = await seedSource({
        seeded,
        incidentId: pipeline.incidentId,
        issueId: seeded.sourceIssueId,
        generationKey: "blocked:0",
      });
      const actorRun = await seedRecoveryActorRun(seeded, pipeline.maintenanceIssueId);
      const configRow = await configRowFor(seeded.companyId);
      const wakeups = createWakeupRecorder({ companyId: seeded.companyId });
      const recovery = recoveryEngineerService(db, { enqueueWakeup: wakeups.enqueueWakeup });
      const actor = {
        board: false,
        actorType: "agent",
        agentId: seeded.recoveryAgentId,
        userId: null,
        runId: actorRun.id,
      } as const;

      await db
        .update(agents)
        .set({ status: "paused", pauseReason: "budget" })
        .where(eq(agents.id, seeded.ownerAgentId));
      await expect(recovery.recordAction(
        pipeline.maintenanceIssueId,
        { action: "resume", sourceIssueId: seeded.sourceIssueId },
        actor,
      )).rejects.toThrow(/invokable/);
      expect(await readAgent(seeded.ownerAgentId)).toMatchObject({
        status: "paused",
        pauseReason: "budget",
      });
      expect((await readSource(source.id)).resumeClaimedAt).toBeNull();
      expect(wakeups.calls).toHaveLength(0);
      await expect(recovery.reconcileSourceOutcomes(configRow)).resolves.toMatchObject({
        superseded: 0,
        pending: 1,
      });
      const heldOpen = await readSource(source.id);
      expect(heldOpen.supersededAt).toBeNull();
      expect(heldOpen.recoveredAt).toBeNull();

      const blockerIssueId = randomUUID();
      await db.insert(issues).values({
        id: blockerIssueId,
        companyId: seeded.companyId,
        title: "Unfinished blocker",
        status: "todo",
        priority: "medium",
        assigneeAgentId: seeded.ownerAgentId,
        issueNumber: 203,
        identifier: `${seeded.prefix}-203`,
      });
      await db.insert(issueRelations).values({
        companyId: seeded.companyId,
        issueId: blockerIssueId,
        relatedIssueId: seeded.sourceIssueId,
        type: "blocks",
      });
      await db
        .update(agents)
        .set({ status: "idle", pauseReason: null })
        .where(eq(agents.id, seeded.ownerAgentId));
      await expect(recovery.recordAction(
        pipeline.maintenanceIssueId,
        { action: "resume", sourceIssueId: seeded.sourceIssueId },
        actor,
      )).rejects.toThrow(/dependencies/);
      expect(await db.select().from(issueRelations)).toHaveLength(1);
      expect(wakeups.calls).toHaveLength(0);
    });

    it("confirms an already verified repair idempotently without touching gates or attribution", async () => {
      const seeded = await seedCompany();
      const pipeline = await seedIncidentPipeline(seeded);
      const repairIssueBefore = await readIssue(pipeline.repairIssueId);
      const recovery = recoveryEngineerService(db, { enqueueWakeup: async () => null });

      const secondReviewRun = await seedRun({
        companyId: seeded.companyId,
        agentId: seeded.reviewerAgentId,
        issueId: pipeline.repairIssueId,
        status: "running",
      });
      await db.insert(recoveryEngineerVerifications).values({
        companyId: seeded.companyId,
        incidentId: pipeline.incidentId,
        repairIssueId: pipeline.repairIssueId,
        reviewRunId: secondReviewRun.id,
        status: "pending",
        repairCommit: pipeline.repairCommit,
        reproductionCommand: "pnpm test recovery",
        reproductionResult: "passed in a second independent review",
        submittedByAgentId: seeded.reviewerAgentId,
      });
      await db.insert(issueExecutionDecisions).values({
        companyId: seeded.companyId,
        issueId: pipeline.repairIssueId,
        stageId: randomUUID(),
        stageType: "review",
        actorAgentId: seeded.reviewerAgentId,
        outcome: "approved",
        body: "Independent reproduction passed at the submitted repair commit.",
        createdByRunId: secondReviewRun.id,
      });
      await db
        .update(heartbeatRuns)
        .set({ status: "succeeded", finishedAt: new Date("2026-09-09T12:00:00.000Z") })
        .where(eq(heartbeatRuns.id, secondReviewRun.id));
      const succeededReview = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, secondReviewRun.id))
        .then((rows) => rows[0]!);

      await recovery.observeRunTerminal(succeededReview);

      const confirmed = await db
        .select()
        .from(recoveryEngineerVerifications)
        .where(eq(recoveryEngineerVerifications.reviewRunId, secondReviewRun.id))
        .then((rows) => rows[0]!);
      expect(confirmed.status).toBe("verified");
      expect(confirmed.failureReason).toBeNull();
      expect(confirmed.duplicateOfVerificationId).toBe(pipeline.verificationId);
      const incident = await readIncident(pipeline.incidentId);
      expect(incident.verifiedVerificationId).toBe(pipeline.verificationId);
      expect(incident.verifiedReviewRunId).toBe(pipeline.reviewRun.id);
      expect(incident.repairCommit).toBe(pipeline.repairCommit);
      const repairIssueAfter = await readIssue(pipeline.repairIssueId);
      expect(repairIssueAfter.status).toBe(repairIssueBefore.status);
      expect(repairIssueAfter.assigneeAgentId).toBe(repairIssueBefore.assigneeAgentId);
      expect(repairIssueAfter.updatedAt.getTime()).toBe(repairIssueBefore.updatedAt.getTime());

      // A conflicting commit is still rejected instead of being attributed to
      // the verified fence.
      const conflictingRun = await seedRun({
        companyId: seeded.companyId,
        agentId: seeded.reviewerAgentId,
        issueId: pipeline.repairIssueId,
        status: "running",
      });
      const conflictingCommit = "ffffffffffffffffffffffffffffffffffffffff";
      await db.insert(recoveryEngineerVerifications).values({
        companyId: seeded.companyId,
        incidentId: pipeline.incidentId,
        repairIssueId: pipeline.repairIssueId,
        reviewRunId: conflictingRun.id,
        status: "pending",
        repairCommit: conflictingCommit,
        reproductionCommand: "pnpm test recovery",
        reproductionResult: "passed at a different commit",
      });
      await db.insert(issueExecutionDecisions).values({
        companyId: seeded.companyId,
        issueId: pipeline.repairIssueId,
        stageId: randomUUID(),
        stageType: "review",
        actorAgentId: seeded.reviewerAgentId,
        outcome: "approved",
        body: "Independent reproduction passed at a different commit.",
        createdByRunId: conflictingRun.id,
      });
      await db
        .update(heartbeatRuns)
        .set({ status: "succeeded", finishedAt: new Date("2026-09-09T12:10:00.000Z") })
        .where(eq(heartbeatRuns.id, conflictingRun.id));
      const succeededConflicting = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, conflictingRun.id))
        .then((rows) => rows[0]!);

      await recovery.observeRunTerminal(succeededConflicting);

      const rejected = await db
        .select()
        .from(recoveryEngineerVerifications)
        .where(eq(recoveryEngineerVerifications.reviewRunId, conflictingRun.id))
        .then((rows) => rows[0]!);
      expect(rejected.status).toBe("failed");
      expect(rejected.failureReason).toBe("incident_already_verified_by_another_run");
      expect((await readIncident(pipeline.incidentId)).verifiedReviewRunId).toBe(pipeline.reviewRun.id);
    });

    it("records an already-recovered diagnosis with run evidence and resolves stale generations by rule", async () => {
      const seeded = await seedCompany();
      const pipeline = await seedIncidentPipeline(seeded, {
        incidentStatus: "diagnosing",
        classification: null,
        activated: false,
      });
      const sourceRun = await seedRun({
        companyId: seeded.companyId,
        agentId: seeded.ownerAgentId,
        issueId: seeded.sourceIssueId,
        status: "failed",
        errorCode: "adapter_failed",
        stderrExcerpt: "write /dev/stdout: resource temporarily unavailable",
      });
      const source = await seedSource({
        seeded,
        incidentId: pipeline.incidentId,
        issueId: seeded.sourceIssueId,
        generationKey: `run:${sourceRun.id}`,
      });
      const diagnosisRun = await seedRecoveryActorRun(seeded, pipeline.maintenanceIssueId);
      await db
        .update(recoveryEngineerIncidents)
        .set({ diagnosisRunId: diagnosisRun.id })
        .where(eq(recoveryEngineerIncidents.id, pipeline.incidentId));
      const recovery = recoveryEngineerService(db, { enqueueWakeup: async () => null });
      const actor = {
        board: false,
        actorType: "agent",
        agentId: seeded.recoveryAgentId,
        userId: null,
        runId: diagnosisRun.id,
      } as const;

      await recovery.recordAction(
        pipeline.maintenanceIssueId,
        {
          action: "diagnose",
          classification: "already_recovered",
          hypothesis: "The followup generation was already independently verified.",
          evidence: ["followup verification accepted the repair"],
        },
        actor,
      );

      const recovered = await readSource(source.id);
      expect(recovered.recoveredAt).not.toBeNull();
      expect(recovered.recoveredRunId).toBe(diagnosisRun.id);
      expect(recovered.recoveredEvidence).toMatchObject({
        reason: "diagnosis_already_recovered",
        classification: "already_recovered",
      });
      const resolved = await readIncident(pipeline.incidentId);
      expect(resolved.outcome).toBe("recovered");
      expect(resolved.status).toBe("resolved");

      // The participant run that recorded the diagnosis is still live, so the
      // maintenance close is retried by the sweep once it finishes.
      expect((await readIssue(pipeline.maintenanceIssueId)).status).not.toBe("done");
      await db
        .update(heartbeatRuns)
        .set({ status: "succeeded", finishedAt: new Date("2026-09-09T13:00:00.000Z") })
        .where(eq(heartbeatRuns.id, diagnosisRun.id));
      await recovery.reconcileRecoveredIncidentClosures(await configRowFor(seeded.companyId));
      expect((await readIssue(pipeline.maintenanceIssueId)).status).toBe("done");
    });

    it("stores procedure applicability and refuses reuse outside the reviewed context", async () => {
      const seeded = await seedCompany();
      const pipeline = await seedIncidentPipeline(seeded);
      const incident = await readIncident(pipeline.incidentId);
      const sourceRun = await seedRun({
        companyId: seeded.companyId,
        agentId: seeded.ownerAgentId,
        issueId: seeded.sourceIssueId,
        status: "failed",
        errorCode: "adapter_failed",
        stderrExcerpt: "write /dev/stdout: resource temporarily unavailable",
        createdAt: new Date("2026-09-09T10:00:00.000Z"),
      });
      const source = await seedSource({
        seeded,
        incidentId: pipeline.incidentId,
        issueId: seeded.sourceIssueId,
        generationKey: `run:${sourceRun.id}`,
      });
      const procedureId = randomUUID();
      await db.insert(recoveryEngineerProcedures).values({
        id: procedureId,
        companyId: seeded.companyId,
        incidentId: pipeline.incidentId,
        status: "reviewed",
        title: "Reapply the scoped repair",
        preconditions: ["Failure reproduced"],
        steps: ["Apply the scoped repair to the named module"],
        successCheck: "Reproduction passes",
        stopConditions: ["Unexpected mutation"],
        rollback: "Revert the repair commit",
        evidenceRunId: pipeline.repairRun.id,
        repairCommit: pipeline.repairCommit,
        failureFingerprint: incident.failureFingerprint,
        classification: "infrastructure",
        applicability: {
          adapterType: "codex_local",
          failureFingerprint: incident.failureFingerprint,
          classification: "infrastructure",
          evidenceRunId: pipeline.repairRun.id,
          sourceGenerationKey: source.generationKey,
          sourceStatusVersion: source.sourceStatusVersion,
        },
      });
      const recovery = recoveryEngineerService(db, { enqueueWakeup: async () => null });
      const boardActor = {
        board: true,
        actorType: "user",
        agentId: null,
        userId: "board-user",
        runId: null,
      } as const;

      await recovery.recordAction(
        seeded.sourceIssueId,
        { action: "reuse_procedure", procedureId, evidenceKey: "verification:1", outcome: "applied" },
        boardActor,
      );
      const applied = await db.select().from(recoveryEngineerProcedureReuses);
      expect(applied).toHaveLength(1);
      expect(applied[0]).toMatchObject({
        status: "applied",
        sourceIssueId: seeded.sourceIssueId,
        evidenceKey: "verification:1",
      });

      // Replaying the same evidence converges on the same ledger row.
      await recovery.recordAction(
        seeded.sourceIssueId,
        { action: "reuse_procedure", procedureId, evidenceKey: "verification:1", outcome: "applied" },
        boardActor,
      );
      expect(await db.select().from(recoveryEngineerProcedureReuses)).toHaveLength(1);

      // A different deployed repair is a new context: the old review refuses.
      await db
        .update(recoveryEngineerIncidents)
        .set({ activatedRepairCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })
        .where(eq(recoveryEngineerIncidents.id, pipeline.incidentId));
      const refused = await recovery.recordAction(
        seeded.sourceIssueId,
        { action: "reuse_procedure", procedureId, evidenceKey: "verification:2", outcome: "applied" },
        boardActor,
      ) as { recorded: boolean; verdict: { applicable: boolean; reason: string | null } };
      expect(refused).toMatchObject({
        recorded: false,
        verdict: { applicable: false, reason: "repair_commit_mismatch" },
      });
      await db
        .update(recoveryEngineerIncidents)
        .set({ activatedRepairCommit: pipeline.repairCommit })
        .where(eq(recoveryEngineerIncidents.id, pipeline.incidentId));

      // A failed reuse is recorded, cannot be retried with the same evidence,
      // and the second failure invalidates the procedure.
      await recovery.recordAction(
        seeded.sourceIssueId,
        {
          action: "reuse_procedure",
          procedureId,
          evidenceKey: "verification:1",
          outcome: "failed",
          failureReason: "reproduction still fails",
        },
        boardActor,
      );
      expect((await readProcedure(procedureId)).failedReuseCount).toBe(1);
      expect((await readProcedure(procedureId)).invalidatedAt).toBeNull();
      await expect(recovery.recordAction(
        seeded.sourceIssueId,
        { action: "reuse_procedure", procedureId, evidenceKey: "verification:1", outcome: "applied" },
        boardActor,
      )).rejects.toThrow(/terminal outcome/);

      await recovery.recordAction(
        seeded.sourceIssueId,
        { action: "reuse_procedure", procedureId, evidenceKey: "verification:3", outcome: "applied" },
        boardActor,
      );
      await recovery.recordAction(
        seeded.sourceIssueId,
        {
          action: "reuse_procedure",
          procedureId,
          evidenceKey: "verification:3",
          outcome: "failed",
          failureReason: "reproduction still fails after the second attempt",
        },
        boardActor,
      );
      const invalidated = await readProcedure(procedureId);
      expect(invalidated.failedReuseCount).toBe(2);
      expect(invalidated.invalidatedAt).not.toBeNull();
      expect(invalidated.invalidatedReason).toContain("repeated_reuse_failure");

      const afterInvalidation = await recovery.recordAction(
        seeded.sourceIssueId,
        { action: "reuse_procedure", procedureId, evidenceKey: "verification:4", outcome: "applied" },
        boardActor,
      ) as { recorded: boolean; verdict: { applicable: boolean; reason: string | null } };
      expect(afterInvalidation).toMatchObject({
        recorded: false,
        verdict: { applicable: false, reason: "procedure_invalidated" },
      });
      const ledger = await db.select().from(recoveryEngineerProcedureReuses);
      expect(ledger.filter((row) => row.status === "refused").length).toBe(2);
    });
  });
});
