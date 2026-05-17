import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issueTreeHolds,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Acknowledged liveness escalation.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: vi.fn(),
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { runningProcesses } from "../adapters/index.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue liveness escalation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat issue graph liveness escalation", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-issue-liveness-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    vi.clearAllMocks();
    runningProcesses.clear();
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
    await instanceSettingsService(db).updateExperimental({
      enableIssueGraphLivenessAutoRecovery: false,
      enableIsolatedWorkspaces: false,
      issueGraphLivenessAutoRecoveryLookbackHours: 24,
    });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function enableAutoRecovery() {
    await instanceSettingsService(db).updateExperimental({
      enableIssueGraphLivenessAutoRecovery: true,
    });
  }

  async function seedBlockedChain(opts: {
    outsideLookback?: boolean;
    blockerStatus?: string;
    blockerAssigneeAgentId?: "coder" | "manager" | null;
  } = {}) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const blockedIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
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
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
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
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
    ]);

    const issueTimestamp = opts.outsideLookback === true
      ? new Date(Date.now() - 25 * 60 * 60 * 1000)
      : new Date(Date.now() - 60 * 60 * 1000);
    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked parent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: coderId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        createdAt: issueTimestamp,
        updatedAt: issueTimestamp,
      },
      {
        id: blockerIssueId,
        companyId,
        title: "Missing unblock owner",
        status: opts.blockerStatus ?? "todo",
        priority: "medium",
        assigneeAgentId: opts.blockerAssigneeAgentId === "coder"
          ? coderId
          : opts.blockerAssigneeAgentId === "manager"
            ? managerId
            : null,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
        createdAt: issueTimestamp,
        updatedAt: issueTimestamp,
      },
    ]);

    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    return { companyId, managerId, coderId, blockedIssueId, blockerIssueId };
  }

  it("keeps liveness findings advisory when auto recovery is disabled", async () => {
    await instanceSettingsService(db).updateExperimental({
      enableIssueGraphLivenessAutoRecovery: false,
    });
    const { companyId } = await seedBlockedChain();
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileIssueGraphLiveness();

    expect(result.findings).toBe(1);
    expect(result.autoRecoveryEnabled).toBe(false);
    expect(result.escalationsCreated).toBe(0);
    expect(result.skippedAutoRecoveryDisabled).toBe(1);

    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(0);
  });

  it("does not create recovery issues outside the configured lookback window", async () => {
    await enableAutoRecovery();
    const { companyId } = await seedBlockedChain({ outsideLookback: true });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileIssueGraphLiveness();

    expect(result.findings).toBe(1);
    expect(result.escalationsCreated).toBe(0);
    expect(result.skippedOutsideLookback).toBe(1);

    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(0);
  });

  it("suppresses liveness escalation when the source issue is under an active pause hold", async () => {
    await enableAutoRecovery();
    const { companyId, blockedIssueId } = await seedBlockedChain();

    await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId: blockedIssueId,
      mode: "pause",
      status: "active",
      reason: "pause liveness recovery subtree",
      releasePolicy: { strategy: "manual" },
    });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.findings).toBe(1);
    expect(result.escalationsCreated).toBe(0);
    expect(result.existingEscalations).toBe(0);
    expect(result.skipped).toBe(1);

    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(0);
  });

  it("treats an active executionRunId on the leaf blocker as a live execution path", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      status: "running",
      contextSnapshot: { issueId: blockedIssueId },
    });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, blockerIssueId));
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileIssueGraphLiveness();

    expect(result.findings).toBe(0);
    expect(result.escalationsCreated).toBe(0);
  });

  it("opens one source-scoped recovery action for an assigned backlog blocker leaf", async () => {
    await enableAutoRecovery();
    const { companyId, coderId, blockedIssueId, blockerIssueId } = await seedBlockedChain({
      blockerStatus: "backlog",
      blockerAssigneeAgentId: "coder",
    });
    const heartbeat = heartbeatService(db);

    const first = await heartbeat.reconcileIssueGraphLiveness();
    const second = await heartbeat.reconcileIssueGraphLiveness();

    expect(first.findings).toBe(1);
    expect(first.escalationsCreated).toBe(1);
    expect(first.sourceRecoveryActionsOpened).toBe(1);
    expect(second.findings).toBe(0);
    expect(second.escalationsCreated).toBe(0);
    expect(second.existingSourceRecoveryActions).toBe(0);

    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(0);
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, blockerIssueId)));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      sourceIssueId: blockerIssueId,
      recoveryIssueId: null,
      kind: "issue_graph_liveness",
      cause: "issue_graph_liveness",
      ownerAgentId: coderId,
      fingerprint: [
        "harness_liveness_leaf",
        companyId,
        "blocked_by_assigned_backlog_issue",
        blockerIssueId,
      ].join(":"),
    });
    expect(actions[0]?.evidence).toMatchObject({
      incidentKey: [
        "harness_liveness",
        companyId,
        blockedIssueId,
        "blocked_by_assigned_backlog_issue",
        blockerIssueId,
      ].join(":"),
      selectedOwnerAgentId: coderId,
    });
  });

  it("opens source-scoped recovery for a stalled in_review leaf without creating a synthetic issue", async () => {
    await enableAutoRecovery();
    const { companyId, coderId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    await db
      .update(issues)
      .set({
        status: "in_review",
        assigneeAgentId: coderId,
        executionState: null,
      })
      .where(eq(issues.id, blockerIssueId));

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.findings).toBe(1);
    expect(result.escalationsCreated).toBe(1);
    expect(result.sourceRecoveryActionsOpened).toBe(1);
    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(0);
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, blockerIssueId)));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      companyId,
      sourceIssueId: blockerIssueId,
      recoveryIssueId: null,
      kind: "issue_graph_liveness",
      cause: "issue_graph_liveness",
      ownerAgentId: coderId,
      fingerprint: [
        "harness_liveness_leaf",
        companyId,
        "in_review_without_action_path",
        blockerIssueId,
      ].join(":"),
    });
    expect(actions[0]?.evidence).toMatchObject({
      incidentKey: [
        "harness_liveness",
        companyId,
        blockedIssueId,
        "in_review_without_action_path",
        blockerIssueId,
      ].join(":"),
      selectedOwnerAgentId: coderId,
    });
  });

  it("opens source-scoped recovery for an invalid review participant", async () => {
    await enableAutoRecovery();
    const { companyId, coderId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    await db
      .update(issues)
      .set({
        status: "in_review",
        assigneeAgentId: coderId,
        executionState: {
          status: "pending",
          currentStageId: "review-1",
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: "00000000-0000-0000-0000-000000000404" },
          returnAssignee: { type: "agent", agentId: coderId },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      })
      .where(eq(issues.id, blockerIssueId));

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.findings).toBe(1);
    expect(result.escalationsCreated).toBe(1);
    expect(result.sourceRecoveryActionsOpened).toBe(1);
    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(0);
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, blockerIssueId)));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      companyId,
      sourceIssueId: blockerIssueId,
      recoveryIssueId: null,
      kind: "issue_graph_liveness",
      cause: "issue_graph_liveness",
      ownerAgentId: coderId,
      fingerprint: [
        "harness_liveness_leaf",
        companyId,
        "invalid_review_participant",
        blockerIssueId,
      ].join(":"),
    });
    expect(actions[0]?.evidence).toMatchObject({
      incidentKey: [
        "harness_liveness",
        companyId,
        blockedIssueId,
        "invalid_review_participant",
        "00000000-0000-0000-0000-000000000404",
      ].join(":"),
      selectedOwnerAgentId: coderId,
    });
  });

  it("opens source-scoped recovery for a cancelled blocker edge", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain({
      blockerStatus: "cancelled",
      blockerAssigneeAgentId: "coder",
    });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.findings).toBe(1);
    expect(result.escalationsCreated).toBe(1);
    expect(result.sourceRecoveryActionsOpened).toBe(1);
    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(0);
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, blockerIssueId)));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      companyId,
      sourceIssueId: blockerIssueId,
      recoveryIssueId: null,
      kind: "issue_graph_liveness",
      cause: "issue_graph_liveness",
      ownerAgentId: managerId,
      fingerprint: [
        "harness_liveness_leaf",
        companyId,
        "blocked_by_cancelled_issue",
        blockerIssueId,
      ].join(":"),
    });
    expect(actions[0]?.evidence).toMatchObject({
      incidentKey: [
        "harness_liveness",
        companyId,
        blockedIssueId,
        "blocked_by_cancelled_issue",
        blockerIssueId,
      ].join(":"),
      selectedOwnerAgentId: managerId,
    });
  });

  it("opens one manager-owned recovery action, preserves blockers, and records owner selection", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const heartbeat = heartbeatService(db);

    const first = await heartbeat.reconcileIssueGraphLiveness();

    expect(first.escalationsCreated).toBe(1);
    expect(first.sourceRecoveryActionsOpened).toBe(1);
    const [sourceAfterFirst] = await db
      .select({ updatedAt: issues.updatedAt })
      .from(issues)
      .where(eq(issues.id, blockedIssueId));
    const eventsAfterFirst = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(eventsAfterFirst.filter((event) => event.action === "issue.blockers.updated")).toHaveLength(0);

    const second = await heartbeat.reconcileIssueGraphLiveness();

    expect(second.escalationsCreated).toBe(0);
    const [sourceAfterSecond] = await db
      .select({ updatedAt: issues.updatedAt })
      .from(issues)
      .where(eq(issues.id, blockedIssueId));
    expect(sourceAfterSecond?.updatedAt.getTime()).toBe(sourceAfterFirst?.updatedAt.getTime());

    const escalations = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "harness_liveness_escalation"),
        ),
      );
    expect(escalations).toHaveLength(0);

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, blockerIssueId)));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: "issue_graph_liveness",
      cause: "issue_graph_liveness",
      status: "active",
      ownerAgentId: managerId,
      fingerprint: [
        "harness_liveness_leaf",
        companyId,
        "blocked_by_unassigned_issue",
        blockerIssueId,
      ].join(":"),
    });

    const blockers = await db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, blockedIssueId));
    expect(blockers.map((row) => row.blockerIssueId).sort()).toEqual(
      [blockerIssueId].sort(),
    );

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, blockedIssueId));
    expect(comments).toHaveLength(0);

    const events = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const createdEvent = events.find((event) => event.action === "issue.recovery_action_opened");
    expect(createdEvent).toBeTruthy();
    expect(createdEvent?.details).toMatchObject({
      recoveryActionId: actions[0]?.id,
      recoveryIssueId: blockerIssueId,
      ownerSelection: {
        selectedAgentId: managerId,
        selectedReason: "root_agent",
        selectedSourceIssueId: blockerIssueId,
      },
    });
    expect(events.filter((event) => event.action === "issue.blockers.updated")).toHaveLength(0);
  });

  it("migrates an existing legacy liveness escalation to source-scoped recovery before removing its blocker", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const legacyRecoveryIssueId = randomUUID();
    const incidentKey = [
      "harness_liveness",
      companyId,
      blockedIssueId,
      "blocked_by_unassigned_issue",
      blockerIssueId,
    ].join(":");
    const leafFingerprint = [
      "harness_liveness_leaf",
      companyId,
      "blocked_by_unassigned_issue",
      blockerIssueId,
    ].join(":");
    await db.insert(issues).values({
      id: legacyRecoveryIssueId,
      companyId,
      title: "Legacy liveness escalation",
      status: "todo",
      priority: "high",
      assigneeAgentId: managerId,
      issueNumber: 3,
      identifier: `LEGACY-${legacyRecoveryIssueId.slice(0, 8)}`,
      originKind: "harness_liveness_escalation",
      originId: incidentKey,
      originFingerprint: leafFingerprint,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: legacyRecoveryIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });
    const heartbeat = heartbeatService(db);

    const first = await heartbeat.reconcileIssueGraphLiveness();
    const second = await heartbeat.reconcileIssueGraphLiveness();

    expect(first.findings).toBe(1);
    expect(first.sourceRecoveryActionsOpened).toBe(1);
    expect(first.obsoleteRecoveriesRetired).toBe(1);
    expect(first.obsoleteRecoveryBlockerRelationsRemoved).toBe(1);
    expect(second.findings).toBe(0);
    expect(second.sourceRecoveryActionsOpened).toBe(0);
    expect(second.existingSourceRecoveryActions).toBe(0);

    const legacyRecoveries = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(legacyRecoveries).toHaveLength(1);
    expect(legacyRecoveries[0]?.id).toBe(legacyRecoveryIssueId);
    expect(legacyRecoveries[0]?.status).toBe("cancelled");

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, blockerIssueId)));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: "issue_graph_liveness",
      cause: "issue_graph_liveness",
      status: "active",
      ownerAgentId: managerId,
      fingerprint: leafFingerprint,
    });

    const blockers = await db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, blockedIssueId));
    expect(blockers.map((row) => row.blockerIssueId).sort()).toEqual([blockerIssueId].sort());
  });

  it("skips budget-blocked direct owners and assigns recovery to the manager fallback", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, coderId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const issueTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await db
      .update(issues)
      .set({
        status: "in_review",
        assigneeAgentId: coderId,
        updatedAt: issueTimestamp,
      })
      .where(eq(issues.id, blockerIssueId));
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: coderId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 1,
      hardStopEnabled: true,
      isActive: true,
    });
    await db.insert(costEvents).values({
      companyId,
      agentId: coderId,
      issueId: blockerIssueId,
      provider: "test",
      biller: "test",
      billingType: "tokens",
      model: "test-model",
      costCents: 1,
      occurredAt: new Date(),
    });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.escalationsCreated).toBe(1);
    expect(result.sourceRecoveryActionsOpened).toBe(1);
    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(0);
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, blockerIssueId)));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      ownerAgentId: managerId,
      fingerprint: [
        "harness_liveness_leaf",
        companyId,
        "in_review_without_action_path",
        blockerIssueId,
      ].join(":"),
    });
    expect(actions[0]?.evidence).toMatchObject({
      incidentKey: [
        "harness_liveness",
        companyId,
        blockedIssueId,
        "in_review_without_action_path",
        blockerIssueId,
      ].join(":"),
      budgetBlockedCandidateAgentIds: [coderId],
    });

    const events = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const createdEvent = events.find((event) => event.action === "issue.recovery_action_opened");
    expect(createdEvent?.details).toMatchObject({
      ownerSelection: {
        selectedAgentId: managerId,
        selectedReason: "assignee_reporting_chain",
        budgetBlockedCandidateAgentIds: [coderId],
      },
    });
  });

  it("opens leaf recovery without creating issue-backed workspace state for manager-owned recovery", async () => {
    await enableAutoRecovery();
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    const companyId = randomUUID();
    const managerId = randomUUID();
    const blockedIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    const dependentProjectId = randomUUID();
    const blockerProjectId = randomUUID();
    const dependentProjectWorkspaceId = randomUUID();
    const blockerProjectWorkspaceId = randomUUID();
    const dependentExecutionWorkspaceId = randomUUID();
    const blockerExecutionWorkspaceId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const issueTimestamp = new Date(Date.now() - 60 * 60 * 1000);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: managerId,
      companyId,
      name: "Root Operator",
      role: "operator",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: false } },
      permissions: {},
    });
    await db.insert(projects).values([
      {
        id: dependentProjectId,
        companyId,
        name: "Dependent workspace project",
        status: "in_progress",
      },
      {
        id: blockerProjectId,
        companyId,
        name: "Blocker workspace project",
        status: "in_progress",
      },
    ]);
    await db.insert(projectWorkspaces).values([
      {
        id: dependentProjectWorkspaceId,
        companyId,
        projectId: dependentProjectId,
        name: "Dependent primary",
      },
      {
        id: blockerProjectWorkspaceId,
        companyId,
        projectId: blockerProjectId,
        name: "Blocker primary",
      },
    ]);
    await db.insert(executionWorkspaces).values([
      {
        id: dependentExecutionWorkspaceId,
        companyId,
        projectId: dependentProjectId,
        projectWorkspaceId: dependentProjectWorkspaceId,
        mode: "operator_branch",
        strategyType: "git_worktree",
        name: "Dependent branch",
        status: "active",
        providerType: "git_worktree",
      },
      {
        id: blockerExecutionWorkspaceId,
        companyId,
        projectId: blockerProjectId,
        projectWorkspaceId: blockerProjectWorkspaceId,
        mode: "operator_branch",
        strategyType: "git_worktree",
        name: "Blocker branch",
        status: "active",
        providerType: "git_worktree",
      },
    ]);
    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        projectId: dependentProjectId,
        projectWorkspaceId: dependentProjectWorkspaceId,
        executionWorkspaceId: dependentExecutionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "operator_branch" },
        title: "Blocked dependent",
        status: "blocked",
        priority: "medium",
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        createdAt: issueTimestamp,
        updatedAt: issueTimestamp,
      },
      {
        id: blockerIssueId,
        companyId,
        projectId: blockerProjectId,
        projectWorkspaceId: blockerProjectWorkspaceId,
        executionWorkspaceId: blockerExecutionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "operator_branch" },
        title: "Unassigned leaf blocker",
        status: "todo",
        priority: "medium",
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
        createdAt: issueTimestamp,
        updatedAt: issueTimestamp,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.escalationsCreated).toBe(1);
    expect(result.sourceRecoveryActionsOpened).toBe(1);
    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(0);
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, blockerIssueId)));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      recoveryIssueId: null,
      ownerAgentId: managerId,
    });
    expect(actions[0]?.evidence).toMatchObject({
      recoveryIssue: {
        id: blockerIssueId,
        status: "todo",
      },
    });
  });

  it("uses issue-backed graph-liveness fallback when the leaf already has a different active recovery action", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: blockerIssueId,
      kind: "manual_recovery",
      status: "active",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "operator_request",
      fingerprint: "manual-recovery:blocks-source-scoped-graph-action",
      evidence: { reason: "manual action already owns the source issue surface" },
      nextAction: "Finish the operator-requested recovery first.",
      wakePolicy: { type: "wake_owner" },
    });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.findings).toBe(1);
    expect(result.escalationsCreated).toBe(1);
    expect(result.sourceRecoveryActionsOpened).toBe(0);
    expect(result.escalationIssueIds).toHaveLength(1);
    const escalationId = result.escalationIssueIds[0]!;
    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      id: escalationId,
      companyId,
      parentId: blockerIssueId,
      assigneeAgentId: managerId,
      originId: [
        "harness_liveness",
        companyId,
        blockedIssueId,
        "blocked_by_unassigned_issue",
        blockerIssueId,
      ].join(":"),
      originFingerprint: [
        "harness_liveness_leaf",
        companyId,
        "blocked_by_unassigned_issue",
        blockerIssueId,
      ].join(":"),
    });
    const graphActions = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, blockerIssueId),
          eq(issueRecoveryActions.kind, "issue_graph_liveness"),
        ),
      );
    expect(graphActions).toHaveLength(0);
    const blockers = await db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, blockedIssueId));
    expect(blockers.map((row) => row.blockerIssueId).sort()).toEqual(
      [blockerIssueId, escalationId].sort(),
    );
    const events = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(events.find((event) => event.action === "issue.harness_liveness_escalation_created")?.details)
      .toMatchObject({
        fallbackReason: "source_has_different_active_recovery_action",
        sourceIssueId: blockedIssueId,
        recoveryIssueId: blockerIssueId,
        escalationIssueId: escalationId,
      });
  });

  it("reuses one open recovery action for multiple dependents with the same leaf blocker", async () => {
    await enableAutoRecovery();
    const { companyId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const secondBlockedIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const issueTimestamp = new Date(Date.now() - 60 * 60 * 1000);
    await db.insert(issues).values({
      id: secondBlockedIssueId,
      companyId,
      title: "Second blocked parent",
      status: "blocked",
      priority: "medium",
      issueNumber: 3,
      identifier: `${issuePrefix}-3`,
      createdAt: issueTimestamp,
      updatedAt: issueTimestamp,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: secondBlockedIssueId,
      type: "blocks",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileIssueGraphLiveness();

    expect(result.findings).toBe(2);
    expect(result.escalationsCreated).toBe(1);
    expect(result.existingEscalations).toBe(1);
    expect(result.sourceRecoveryActionsOpened).toBe(1);
    expect(result.existingSourceRecoveryActions).toBe(1);
    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(0);
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, blockerIssueId)));
    expect(actions).toHaveLength(1);
  });

  it("does not create a fresh recovery object when the same-fingerprint action was already resolved", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const heartbeat = heartbeatService(db);
    const incidentKey = [
      "harness_liveness",
      companyId,
      blockedIssueId,
      "blocked_by_unassigned_issue",
      blockerIssueId,
    ].join(":");
    const resolvedAt = new Date();

    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: blockerIssueId,
      kind: "issue_graph_liveness",
      status: "resolved",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: [
        "harness_liveness_leaf",
        companyId,
        "blocked_by_unassigned_issue",
        blockerIssueId,
      ].join(":"),
      evidence: { incidentKey },
      nextAction: "Already handled",
      outcome: "restored",
      resolvedAt,
    });

    const result = await heartbeat.reconcileIssueGraphLiveness();

    expect(result.escalationsCreated).toBe(0);
    expect(result.existingEscalations).toBe(0);
    expect(result.resolvedUnchangedSourceRecoveryActions).toBe(1);

    const openEscalations = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "harness_liveness_escalation"),
          eq(issues.originId, incidentKey),
        ),
      );
    expect(openEscalations).toHaveLength(0);
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, blockerIssueId)));
    expect(actions).toHaveLength(1);
    expect(actions[0]?.status).toBe("resolved");
  });

  it("creates a fresh recovery object when the same-fingerprint action was cancelled", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const heartbeat = heartbeatService(db);
    const incidentKey = [
      "harness_liveness",
      companyId,
      blockedIssueId,
      "blocked_by_unassigned_issue",
      blockerIssueId,
    ].join(":");
    const resolvedAt = new Date();

    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: blockerIssueId,
      kind: "issue_graph_liveness",
      status: "cancelled",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: [
        "harness_liveness_leaf",
        companyId,
        "blocked_by_unassigned_issue",
        blockerIssueId,
      ].join(":"),
      evidence: { incidentKey },
      nextAction: "Cancelled by operator",
      outcome: "cancelled",
      resolvedAt,
    });

    const result = await heartbeat.reconcileIssueGraphLiveness();

    expect(result.escalationsCreated).toBe(1);
    expect(result.existingEscalations).toBe(0);
    expect(result.sourceRecoveryActionsOpened).toBe(1);
    expect(result.resolvedUnchangedSourceRecoveryActions).toBe(0);

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, blockerIssueId)));
    expect(actions).toHaveLength(2);
    expect(actions.map((action) => action.status).sort()).toEqual(["active", "cancelled"]);
  });
});
