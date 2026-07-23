import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";

// LOOA-700: recovery must not tight-loop-requeue doomed wakes every ~30s. These
// tests pin the two live storms discovered during LOOA-629 gateway forensics:
//   Storm 1 — a permanent `workspace_validation_failed` continuation failure
//             (persisted execution-workspace link is structurally wrong) must
//             escalate to `blocked` once instead of re-dispatching forever.
//   Storm 2 — the resolved-dependency wake backstop must skip a non-invokable
//             (paused/terminated) assignee instead of 409-storming enqueueWakeup.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres LOOA-700 recovery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("LOOA-700 recovery doomed-wake backoff", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-looa700-recovery-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  async function seedCompany(opts: { assigneeStatus?: string } = {}) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const prefix = `L7${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Recovery Co",
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
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: opts.assigneeStatus ?? "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      },
    ]);
    return { companyId, managerId, coderId, prefix };
  }

  it("Storm 1: escalates a permanent workspace_validation_failed continuation to blocked instead of requeuing", async () => {
    const { companyId, coderId, prefix } = await seedCompany();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Doomed continuation",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    // Latest run: a terminal run that died before adapter launch on workspace validation.
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "automation",
      status: "failed",
      errorCode: "workspace_validation_failed",
      error:
        'Issue expected project workspace "cce8944f" but persisted execution workspace has no project workspace id.',
      startedAt: new Date(Date.now() - 5_000),
      finishedAt: new Date(Date.now() - 4_000),
      createdAt: new Date(Date.now() - 5_000),
      contextSnapshot: { issueId, retryReason: "issue_continuation_needed" },
    });

    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() }));
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    // Escalated once, and crucially NOT re-dispatched as another doomed continuation.
    expect(result.escalated).toBe(1);
    expect(result.continuationRequeued).toBe(0);
    expect(result.issueIds).toContain(issueId);

    const [updated] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(updated?.status).toBe("blocked");

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({ cause: "workspace_validation_failed" });

    // The only wake enqueued is the recovery-owner escalation wake, not a continuation retry.
    expect(enqueueWakeup.mock.calls[0]?.[1]?.payload).toMatchObject({
      recoveryCause: "workspace_validation_failed",
    });
  });

  it("Storm 1: leaves the issue alone once a newer non-terminal run supersedes the workspace failure", async () => {
    const { companyId, coderId, prefix } = await seedCompany();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Recovered continuation",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    // Old terminal workspace failure...
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "automation",
      status: "failed",
      errorCode: "workspace_validation_failed",
      startedAt: new Date(Date.now() - 60_000),
      finishedAt: new Date(Date.now() - 59_000),
      createdAt: new Date(Date.now() - 60_000),
      contextSnapshot: { issueId, retryReason: "issue_continuation_needed" },
    });
    // ...superseded by a newer queued run (e.g. after the workspace link was repaired).
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "automation",
      status: "queued",
      startedAt: null,
      createdAt: new Date(Date.now() - 1_000),
      contextSnapshot: { issueId, retryReason: "issue_continuation_needed" },
    });

    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() }));
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    // A live queued run exists, so recovery must not escalate to blocked.
    expect(result.escalated).toBe(0);
    const [updated] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(updated?.status).toBe("in_progress");
  });

  it("Storm 2: skips the resolved-dependency wake backstop for a paused assignee instead of 409-storming", async () => {
    const { companyId, coderId, prefix } = await seedCompany({ assigneeStatus: "paused" });
    const blockedIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked dependent assigned to a paused agent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: coderId,
        issueNumber: 1,
        identifier: `${prefix}-1`,
      },
      {
        id: blockerIssueId,
        companyId,
        title: "Completed blocker",
        status: "done",
        priority: "medium",
        issueNumber: 2,
        identifier: `${prefix}-2`,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() }));
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileResolvedDependencyWakeBackstop();

    expect(result.notInvokableSkipped).toBe(1);
    expect(result.healed).toBe(0);
    expect(result.enqueueFailed).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();

    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, coderId)));
    expect(wakes).toHaveLength(0);
  });

  it("Storm 2: still heals the resolved-dependency wake when the assignee is invokable", async () => {
    const { companyId, coderId, prefix } = await seedCompany({ assigneeStatus: "idle" });
    const blockedIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked dependent assigned to an invokable agent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: coderId,
        issueNumber: 1,
        identifier: `${prefix}-1`,
      },
      {
        id: blockerIssueId,
        companyId,
        title: "Completed blocker",
        status: "done",
        priority: "medium",
        issueNumber: 2,
        identifier: `${prefix}-2`,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() }));
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileResolvedDependencyWakeBackstop();

    expect(result.notInvokableSkipped).toBe(0);
    expect(result.healed).toBe(1);
    expect(result.issueIds).toContain(blockedIssueId);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  });
});
