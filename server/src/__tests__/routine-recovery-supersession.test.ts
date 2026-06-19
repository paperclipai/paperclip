import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issues,
  routineRuns,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine recovery supersession tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("routine recovery supersession", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-recovery-supersession-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(issueRelations);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(routineRuns);
    await db.delete(routines);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(prefixSeed = "RA") {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const sourceIssueId = randomUUID();
    const prefix = `${prefixSeed}${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: `${prefixSeed} Recovery Co`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "BobGo balance check",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    return { companyId, managerId, coderId, sourceIssueId, prefix, sourceIssue: sourceIssue! };
  }

  it("suppresses recovery for routine executions superseded by a newer completed run", async () => {
    const { companyId, coderId, sourceIssueId, prefix, sourceIssue } = await seedCompany();
    const routineId = randomUUID();
    const oldRunId = randomUUID();
    const newerRunId = randomUUID();
    const newerIssueId = randomUUID();
    const dispatchFingerprint = "routine:fingerprint:bobgo";

    await db.insert(routines).values({
      id: routineId,
      companyId,
      title: "BobGo balance check",
      description: "Check the courier wallet balance.",
      assigneeAgentId: coderId,
      priority: "medium",
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
    });
    await db
      .update(issues)
      .set({
        title: "BobGo balance check",
        status: "in_progress",
        originKind: "routine_execution",
        originId: routineId,
        originRunId: oldRunId,
        originFingerprint: dispatchFingerprint,
      })
      .where(eq(issues.id, sourceIssueId));
    await db.insert(issues).values({
      id: newerIssueId,
      companyId,
      title: "BobGo balance check",
      status: "done",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 2,
      identifier: `${prefix}-2`,
      originKind: "routine_execution",
      originId: routineId,
      originRunId: newerRunId,
      originFingerprint: dispatchFingerprint,
    });
    await db.insert(routineRuns).values([
      {
        id: oldRunId,
        companyId,
        routineId,
        source: "schedule",
        status: "failed",
        triggeredAt: new Date("2026-06-10T03:00:00.000Z"),
        dispatchFingerprint,
        linkedIssueId: sourceIssueId,
        failureReason: "Execution issue moved to blocked",
        completedAt: new Date("2026-06-10T03:05:00.000Z"),
      },
      {
        id: newerRunId,
        companyId,
        routineId,
        source: "schedule",
        status: "completed",
        triggeredAt: new Date("2026-06-11T03:00:00.000Z"),
        dispatchFingerprint,
        linkedIssueId: newerIssueId,
        completedAt: new Date("2026-06-11T03:03:00.000Z"),
      },
    ]);

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    await recovery.escalateStrandedAssignedIssue({
      issue: {
        ...sourceIssue,
        title: "BobGo balance check",
        status: "in_progress",
        originKind: "routine_execution",
        originId: routineId,
        originRunId: oldRunId,
        originFingerprint: dispatchFingerprint,
      },
      previousStatus: "in_progress",
      latestRun: {
        id: randomUUID(),
        agentId: coderId,
        status: "failed",
        error: "adapter failed",
        errorCode: "adapter_failed",
        contextSnapshot: { retryReason: "issue_continuation_needed" },
        livenessState: "needs_followup",
      },
    });

    expect(enqueueWakeup).not.toHaveBeenCalled();
    const issueRows = await db.select().from(issues);
    expect(issueRows).toHaveLength(2);
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue?.status).toBe("cancelled");
    expect(updatedIssue?.cancelledAt).toBeInstanceOf(Date);
    expect(updatedIssue?.completedAt).toBeNull();
    expect(updatedIssue?.checkoutRunId).toBeNull();
    expect(updatedIssue?.executionRunId).toBeNull();
    expect(updatedIssue?.executionAgentNameKey).toBeNull();
    expect(updatedIssue?.executionLockedAt).toBeNull();
    const [updatedRun] = await db.select().from(routineRuns).where(eq(routineRuns.id, oldRunId));
    expect(updatedRun?.status).toBe("superseded");
    expect(updatedRun?.coalescedIntoRunId).toBe(newerRunId);
    expect(updatedRun?.completedAt?.toISOString()).toBe("2026-06-10T03:05:00.000Z");
    expect(updatedRun?.failureReason).toContain(`${prefix}-2`);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("superseded by a newer completed routine run");
    expect(comments[0]?.body).toContain(`${prefix}-2`);
  });

  it("does not suppress routine recovery using a run from another company", async () => {
    const { companyId, managerId, coderId, sourceIssueId, sourceIssue } = await seedCompany();
    const other = await seedCompany("OT");
    const routineId = randomUUID();
    const oldRunId = randomUUID();
    const dispatchFingerprint = "routine:fingerprint:foreign";

    await db.insert(routines).values({
      id: routineId,
      companyId: other.companyId,
      title: "Foreign routine",
      description: "Belongs to another company.",
      assigneeAgentId: other.coderId,
      priority: "medium",
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
    });
    await db.insert(routineRuns).values({
      id: oldRunId,
      companyId: other.companyId,
      routineId,
      source: "schedule",
      status: "failed",
      triggeredAt: new Date("2026-06-10T03:00:00.000Z"),
      dispatchFingerprint,
      completedAt: new Date("2026-06-10T03:05:00.000Z"),
    });
    await db
      .update(issues)
      .set({
        status: "in_progress",
        originKind: "routine_execution",
        originId: routineId,
        originRunId: oldRunId,
        originFingerprint: dispatchFingerprint,
      })
      .where(eq(issues.id, sourceIssueId));

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    await recovery.escalateStrandedAssignedIssue({
      issue: {
        ...sourceIssue,
        status: "in_progress",
        originKind: "routine_execution",
        originId: routineId,
        originRunId: oldRunId,
        originFingerprint: dispatchFingerprint,
      },
      previousStatus: "in_progress",
      latestRun: {
        id: randomUUID(),
        agentId: coderId,
        status: "failed",
        error: "adapter failed",
        errorCode: "adapter_failed",
        contextSnapshot: { retryReason: "issue_continuation_needed" },
        livenessState: "needs_followup",
      },
    });

    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue?.companyId).toBe(companyId);
    expect(updatedIssue?.status).toBe("blocked");
    const issueRows = await db.select().from(issues);
    expect(issueRows).toHaveLength(2);
    const recoveryActions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId));
    expect(recoveryActions).toHaveLength(1);
    expect(recoveryActions[0]).toMatchObject({
      companyId,
      sourceIssueId,
      recoveryIssueId: null,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 1,
    });
    expect(enqueueWakeup).toHaveBeenCalledWith(managerId, expect.any(Object));
  });
});
