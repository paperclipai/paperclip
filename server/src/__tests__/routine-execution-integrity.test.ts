import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  projects,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { routineService } from "../services/routines.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("routine execution integrity", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-execution-integrity-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(routines);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRoutine(input: {
    routineStatus?: "active" | "paused";
    concurrencyPolicy?: "coalesce_if_active" | "skip_if_active" | "always_enqueue";
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const routineId = randomUUID();
    const issuePrefix = `RT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Routine Integrity Co",
      issuePrefix,
      status: "active",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "QA and Release Engineer",
      role: "qa",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "App",
      status: "in_progress",
    });

    await db.insert(routines).values({
      id: routineId,
      companyId,
      projectId,
      title: "Cart trust audit",
      description: "Eliminate any source of doubt",
      assigneeAgentId: agentId,
      priority: "medium",
      status: input.routineStatus ?? "paused",
      concurrencyPolicy: input.concurrencyPolicy ?? "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      variables: [],
    });

    return { companyId, agentId, projectId, routineId, issuePrefix };
  }

  it("reconciles paused coalescing routine issues, wakeups, and stale execution locks", async () => {
    const { companyId, agentId, projectId, routineId, issuePrefix } = await seedRoutine();
    const canonicalIssueId = randomUUID();
    const duplicateIssueId = randomUUID();
    const staleRunId = randomUUID();
    const wakeupA = randomUUID();
    const wakeupB = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: staleRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      finishedAt: new Date("2026-04-18T10:30:00.000Z"),
      contextSnapshot: { issueId: canonicalIssueId },
    });

    await db.insert(issues).values([
      {
        id: canonicalIssueId,
        companyId,
        projectId,
        title: "Canonical routine issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        originKind: "routine_execution",
        originId: routineId,
        originRunId: randomUUID(),
        routineBoundRunId: randomUUID(),
        routineIssueRole: null,
        executionRunId: staleRunId,
        createdAt: new Date("2026-04-18T10:00:00.000Z"),
        updatedAt: new Date("2026-04-18T10:10:00.000Z"),
      },
      {
        id: duplicateIssueId,
        companyId,
        projectId,
        title: "Duplicate routine issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
        originKind: "routine_execution",
        originId: routineId,
        originRunId: randomUUID(),
        routineBoundRunId: randomUUID(),
        routineIssueRole: null,
        createdAt: new Date("2026-04-18T09:55:00.000Z"),
        updatedAt: new Date("2026-04-18T10:05:00.000Z"),
      },
    ]);

    await db.insert(agentWakeupRequests).values([
      {
        id: wakeupA,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: canonicalIssueId },
        status: "queued",
      },
      {
        id: wakeupB,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: duplicateIssueId },
        status: "queued",
      },
    ]);

    const svc = routineService(db);

    const inspection = await svc.inspectExecutionState({ routineId });

    expect(inspection.routinesInspected).toBe(1);
    expect(inspection.routinesWithChanges).toBe(1);
    expect(inspection.staleExecutionLocks.issueIds).toEqual([canonicalIssueId]);
    expect(inspection.canonicalRoleUpdates.issueIds).toEqual([canonicalIssueId]);
    expect(inspection.duplicateIssues.issueIds).toEqual([duplicateIssueId]);
    expect(new Set(inspection.wakeupsToCancel.wakeupIds)).toEqual(new Set([wakeupA, wakeupB]));
    expect(inspection.routines[0]).toMatchObject({
      routineId,
      executionState: "paused",
      canonicalIssueId,
      liveIssueId: null,
    });

    const summary = await svc.reconcileExecutionState({ routineId });

    expect(summary).toMatchObject({
      routinesInspected: 1,
      routinesReconciled: 1,
      staleExecutionLocksCleared: 1,
      canonicalRolesUpdated: 1,
      parallelRolesUpdated: 0,
      duplicateIssuesSuperseded: 1,
      wakeupsCancelled: 2,
    });

    const canonicalIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, canonicalIssueId))
      .then((rows) => rows[0] ?? null);
    const duplicateIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, duplicateIssueId))
      .then((rows) => rows[0] ?? null);
    const refreshedWakeups = await db.select().from(agentWakeupRequests);

    expect(canonicalIssue?.routineIssueRole).toBe("canonical");
    expect(canonicalIssue?.executionRunId).toBeNull();
    expect(duplicateIssue?.routineIssueRole).toBe("superseded");
    expect(duplicateIssue?.status).toBe("cancelled");
    expect(new Set(refreshedWakeups.map((row) => row.status))).toEqual(new Set(["cancelled"]));
  });

  it("keeps always-enqueue routine issues parallel while normalizing legacy roles", async () => {
    const { companyId, agentId, projectId, routineId, issuePrefix } = await seedRoutine({
      routineStatus: "active",
      concurrencyPolicy: "always_enqueue",
    });
    const issueA = randomUUID();
    const issueB = randomUUID();

    await db.insert(issues).values([
      {
        id: issueA,
        companyId,
        projectId,
        title: "Parallel issue A",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        originKind: "routine_execution",
        originId: routineId,
        originRunId: randomUUID(),
        routineBoundRunId: randomUUID(),
        routineIssueRole: null,
      },
      {
        id: issueB,
        companyId,
        projectId,
        title: "Parallel issue B",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
        originKind: "routine_execution",
        originId: routineId,
        originRunId: randomUUID(),
        routineBoundRunId: randomUUID(),
        routineIssueRole: "canonical",
      },
    ]);

    const svc = routineService(db);
    const inspection = await svc.inspectExecutionState({ routineId });

    expect(inspection.parallelRoleUpdates.count).toBe(2);
    expect(new Set(inspection.parallelRoleUpdates.issueIds)).toEqual(new Set([issueA, issueB]));
    expect(inspection.duplicateIssues.count).toBe(0);
    expect(inspection.wakeupsToCancel.count).toBe(0);

    const summary = await svc.reconcileExecutionState({ routineId });

    expect(summary).toMatchObject({
      routinesInspected: 1,
      routinesReconciled: 1,
      staleExecutionLocksCleared: 0,
      canonicalRolesUpdated: 0,
      parallelRolesUpdated: 2,
      duplicateIssuesSuperseded: 0,
      wakeupsCancelled: 0,
    });

    const rows = await db
      .select({ id: issues.id, role: issues.routineIssueRole, status: issues.status })
      .from(issues)
      .where(eq(issues.originId, routineId));

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.role))).toEqual(new Set(["parallel"]));
    expect(new Set(rows.map((row) => row.status))).toEqual(new Set(["todo"]));
  });

  it("cancels queued routine heartbeat runs for paused routines during reconciliation", async () => {
    const { companyId, agentId, projectId, routineId, issuePrefix } = await seedRoutine();
    const issueId = randomUUID();
    const wakeupId = randomUUID();
    const runId = randomUUID();

    await db.insert(agentWakeupRequests).values({
      id: wakeupId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
      runId,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: wakeupId,
      contextSnapshot: { issueId },
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Paused queued routine issue",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      originKind: "routine_execution",
      originId: routineId,
      originRunId: randomUUID(),
      routineBoundRunId: randomUUID(),
      routineIssueRole: "canonical",
      executionRunId: runId,
    });

    const svc = routineService(db);
    const inspection = await svc.inspectExecutionState({ routineId });

    expect(inspection.routinesInspected).toBe(1);
    expect(inspection.routinesWithChanges).toBe(1);
    expect(inspection.wakeupsToCancel.count).toBe(0);
    expect(inspection.queuedRunsToCancel.runIds).toEqual([runId]);

    const summary = await svc.reconcileExecutionState({ routineId });

    expect(summary).toMatchObject({
      routinesInspected: 1,
      routinesReconciled: 1,
      wakeupsCancelled: 0,
      queuedRunsCancelled: 1,
    });

    const [run, wakeup, issue] = await Promise.all([
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0] ?? null),
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeupId)).then((rows) => rows[0] ?? null),
      db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.error).toContain("paused");
    expect(wakeup?.status).toBe("cancelled");
    expect(wakeup?.error).toContain("paused");
    expect(issue?.executionRunId).toBeNull();
  });
});
