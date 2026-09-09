import { randomUUID } from "node:crypto";
import express, { type Request as ExpressRequest } from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
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
    await db.delete(recoveryEngineerProcedures);
    await db.delete(recoveryEngineerIncidentSources);
    await db.delete(recoveryEngineerIncidents);
    await db.delete(recoveryEngineerConfigs);
    await db.delete(issueExecutionDecisions);
    await db.delete(activityLog);
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
      startedAt: new Date("2026-09-09T10:00:00.000Z"),
      finishedAt: input.status === "failed" ? new Date("2026-09-09T10:01:00.000Z") : null,
      errorCode: input.errorCode,
      error: input.error,
      stderrExcerpt: input.stderrExcerpt,
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
});
