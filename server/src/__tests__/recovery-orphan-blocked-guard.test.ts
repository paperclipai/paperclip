import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  completionContracts,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { issueService } from "../services/issues.ts";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.ts";
import { recoveryService } from "../services/recovery/service.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres orphan-blocked guard tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("recovery never strands an issue in blocked with zero blocker edges", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-orphan-blocked-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    mockTelemetryClient.track.mockClear();
    await db.delete(nativeRunFinalizations);
    await db.delete(nativeRunResults);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueRecoveryActions);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    // heartbeat_runs.wakeup_request_id FKs agent_wakeup_requests — runs first.
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(completionContracts);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * Seeds the exact live shape from AND-13551: an assigned task whose only run
   * died, plus a reporting chain so an escalation owner exists by name.
   */
  async function seed() {
    const companyId = randomUUID();
    const executiveAgentId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: executiveAgentId,
        companyId,
        name: "CEO",
        role: "executive",
        status: "active",
        reportsTo: null,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "active",
        reportsTo: executiveAgentId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    return { companyId, agentId, executiveAgentId };
  }

  async function seedStrandedIssue(input: {
    companyId: string;
    agentId: string;
    title?: string;
    errorCode?: string | null;
    resultJson?: Record<string, unknown> | null;
  }) {
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: input.title ?? "Stranded assigned issue with no dependency",
      status: "in_progress",
      assigneeAgentId: input.agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      status: "failed",
      invocationSource: "manual",
      errorCode: input.errorCode ?? "acpx_turn_failed",
      resultJson: input.resultJson ?? null,
      contextSnapshot: { issueId },
      finishedAt: new Date(),
    });
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]!);
    const latestRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]!);
    return { issue, latestRun, issueId, runId };
  }

  function makeRecovery() {
    const enqueueWakeup = vi.fn().mockResolvedValue(null);
    return { enqueueWakeup, recovery: recoveryService(db, { enqueueWakeup }) };
  }

  async function readIssue(issueId: string) {
    return db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]!);
  }

  async function readBlockerIds(issueId: string) {
    return db
      .select({ id: issueRelations.issueId })
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
        ),
      )
      .then((rows) => rows.map((row) => row.id));
  }

  it("rehomes a stranded issue with no dependency to todo instead of orphan-blocked", async () => {
    const { companyId, agentId } = await seed();
    const { issue, latestRun, issueId } = await seedStrandedIssue({ companyId, agentId });
    const { recovery } = makeRecovery();

    const updated = await recovery.escalateStrandedAssignedIssue({
      issue,
      previousStatus: "in_progress",
      latestRun,
    });

    expect(updated).not.toBeNull();
    const blockerIds = await readBlockerIds(issueId);
    // The defect: blocked + zero blocker edges is unreachable by any wake path.
    expect({ status: updated!.status, blockerIds }).not.toEqual({
      status: "blocked",
      blockerIds: [],
    });
    expect(updated!.status).toBe("todo");
    expect(blockerIds).toEqual([]);
    // The assignee must survive, or the rehomed issue has nobody to pick it up.
    expect(updated!.assigneeAgentId).toBe(agentId);
  });

  it("preserves recovery attempt state across the todo rehome so the ladder can advance", async () => {
    const { companyId, agentId } = await seed();
    const { issue, latestRun, issueId } = await seedStrandedIssue({ companyId, agentId });
    const { recovery } = makeRecovery();
    const actionsSvc = issueRecoveryActionService(db);

    await recovery.escalateStrandedAssignedIssue({
      issue,
      previousStatus: "in_progress",
      latestRun,
    });
    const first = await actionsSvc.getActiveForIssue(companyId, issueId);
    expect(first?.attemptCount).toBe(1);

    // Re-escalate from the rehomed row, exactly as the next sweep would.
    const rehomed = await readIssue(issueId);
    await recovery.escalateStrandedAssignedIssue({
      issue: rehomed,
      previousStatus: "todo",
      latestRun,
    });
    const second = await actionsSvc.getActiveForIssue(companyId, issueId);

    // Pinning attemptCount at 1 would make the bounded ladder below unreachable.
    expect(second?.attemptCount).toBe(2);
    expect(second?.status).toBe("active");
    expect(second?.id).toBe(first?.id);
  });

  it("keeps blocked when a real unresolved blocker edge already exists", async () => {
    const { companyId, agentId } = await seed();
    const { issue, latestRun, issueId } = await seedStrandedIssue({ companyId, agentId });
    const blockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId,
      title: "Real blocker",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: issueId,
      type: "blocks",
    });
    const { recovery } = makeRecovery();

    const updated = await recovery.escalateStrandedAssignedIssue({
      issue,
      previousStatus: "in_progress",
      latestRun,
    });

    expect(updated!.status).toBe("blocked");
    expect(await readBlockerIds(issueId)).toEqual([blockerIssueId]);
  });

  it("materialises an agent-owned recovery blocker once the todo ladder is exhausted", async () => {
    const { companyId, agentId, executiveAgentId } = await seed();
    const { issue, latestRun, issueId } = await seedStrandedIssue({ companyId, agentId });
    const { recovery, enqueueWakeup } = makeRecovery();

    let updated = await recovery.escalateStrandedAssignedIssue({
      issue,
      previousStatus: "in_progress",
      latestRun,
    });
    // Attempts 1..3 stay pickable.
    for (const previousStatus of ["todo", "todo"] as const) {
      expect(updated!.status).toBe("todo");
      updated = await recovery.escalateStrandedAssignedIssue({
        issue: await readIssue(issueId),
        previousStatus,
        latestRun,
      });
    }
    expect(updated!.status).toBe("todo");

    // Attempt 4 exceeds the ladder: it must install a real blocker edge.
    updated = await recovery.escalateStrandedAssignedIssue({
      issue: await readIssue(issueId),
      previousStatus: "todo",
      latestRun,
    });

    expect(updated!.status).toBe("blocked");
    const blockerIds = await readBlockerIds(issueId);
    expect(blockerIds).toHaveLength(1);

    const recoveryIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, blockerIds[0]!))
      .then((rows) => rows[0]!);
    // "Owned by nobody" does not satisfy the invariant — a named agent must hold it.
    expect(recoveryIssue.assigneeAgentId).toBe(executiveAgentId);
    expect(recoveryIssue.status).toBe("todo");
    expect(recoveryIssue.originId).toBe(issueId);
    expect(enqueueWakeup).toHaveBeenCalledWith(
      executiveAgentId,
      expect.objectContaining({ reason: "stranded_recovery_issue" }),
    );

    // A second exhausted sweep must reuse the same recovery issue, not fan out.
    await recovery.escalateStrandedAssignedIssue({
      issue: await readIssue(issueId),
      previousStatus: "blocked" as never,
      latestRun,
    });
    expect(await readBlockerIds(issueId)).toEqual(blockerIds);
  });

  it("leaves the provider-quota wait path on blocked with its scheduled retry", async () => {
    const { companyId, agentId } = await seed();
    const { issue, latestRun, issueId } = await seedStrandedIssue({
      companyId,
      agentId,
      title: "Provider quota wait",
      errorCode: "provider_quota_exceeded",
    });
    const { recovery } = makeRecovery();

    const updated = await recovery.escalateStrandedAssignedIssue({
      issue,
      previousStatus: "in_progress",
      latestRun,
      recoveryCause: "provider_quota",
    });

    // This path is status-independent: it wakes via a scheduled_retry run, so
    // blocked with no blocker edge is correct here and must stay unchanged.
    expect(updated!.status).toBe("blocked");
    expect(await readBlockerIds(issueId)).toEqual([]);
    const scheduledRetry = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.status, "scheduled_retry"),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
        ),
      );
    expect(scheduledRetry).toHaveLength(1);
  });

  it("rejects a blocked write that has neither a blocker edge nor a declared wake path", async () => {
    const { companyId, agentId } = await seed();
    const { issueId } = await seedStrandedIssue({ companyId, agentId });
    const issuesSvc = issueService(db);

    await expect(
      issuesSvc.update(issueId, { status: "blocked", blockedByIssueIds: [] }),
    ).rejects.toMatchObject({ status: 422 });

    // The central guard must not have written a partial transition.
    expect((await readIssue(issueId)).status).toBe("in_progress");
  });

  it("admits a blocked write that declares the wake path it installed", async () => {
    const { companyId, agentId } = await seed();
    const { issueId } = await seedStrandedIssue({ companyId, agentId });
    const issuesSvc = issueService(db);

    const updated = await issuesSvc.update(issueId, {
      status: "blocked",
      blockedByIssueIds: [],
      blockedWakePath: {
        kind: "scheduled_retry_run",
        reason: "test_declared_wake_path",
      },
    });

    expect(updated!.status).toBe("blocked");
  });
});
