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
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import {
  ASSIGNEE_NOT_INVOKABLE_UNBLOCK_ACTION,
  ASSIGNEE_NOT_INVOKABLE_UNBLOCK_CAUSE,
  buildAssigneeNotInvokableUnblockDescriptor,
  isAssigneeNotInvokableUnblockDescriptor,
  recoveryService,
} from "../services/recovery/service.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping assignee-not-invokable self-heal tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describe("assignee-not-invokable descriptor helpers (TSMC-19829)", () => {
  it("builds a stable board descriptor with the machine-readable cause", () => {
    const descriptor = buildAssigneeNotInvokableUnblockDescriptor();
    expect(descriptor).toEqual({
      owner: "board",
      action: ASSIGNEE_NOT_INVOKABLE_UNBLOCK_ACTION,
    });
    expect(descriptor.action).toContain(`cause:${ASSIGNEE_NOT_INVOKABLE_UNBLOCK_CAUSE}`);
    expect(isAssigneeNotInvokableUnblockDescriptor(descriptor)).toBe(true);
  });

  it("accepts legacy action text that still embeds the cause token", () => {
    expect(
      isAssigneeNotInvokableUnblockDescriptor({
        owner: "board",
        action: "Please restore the lane (cause:assignee_not_invokable).",
      }),
    ).toBe(true);
  });

  it("rejects unrelated descriptors", () => {
    expect(isAssigneeNotInvokableUnblockDescriptor(null)).toBe(false);
    expect(
      isAssigneeNotInvokableUnblockDescriptor({
        owner: "board",
        action: "Wait for the external vendor.",
      }),
    ).toBe(false);
    expect(isAssigneeNotInvokableUnblockDescriptor({ owner: "board" })).toBe(false);
  });
});

describeEmbeddedPostgres("assignee-not-invokable self-heal (TSMC-19829)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const enqueueWakeup = vi.fn(async () => ({ id: randomUUID(), status: "queued" as const }));

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-assignee-not-invokable-heal-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    enqueueWakeup.mockClear();
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function recovery() {
    return recoveryService(db, { enqueueWakeup: enqueueWakeup as never });
  }

  async function seedCompanyWithAgent(agentStatus: "idle" | "error" | "paused" | "running" | "active" = "error") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date("2026-03-19T00:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: agentStatus,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    return { companyId, agentId, issuePrefix, now };
  }

  async function seedStrandedInProgressWithDeadRun(agentStatus: "error" | "paused" = "error") {
    const { companyId, agentId, issuePrefix, now } = await seedCompanyWithAgent(agentStatus);
    const issueId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "failed",
      runId,
      claimedAt: now,
      finishedAt: new Date("2026-03-19T00:05:00.000Z"),
      error: "run died",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      wakeupRequestId,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      startedAt: now,
      finishedAt: new Date("2026-03-19T00:05:00.000Z"),
      updatedAt: new Date("2026-03-19T00:05:00.000Z"),
      errorCode: "process_lost",
      error: "run died",
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stranded while assignee is down",
      status: "in_progress",
      priority: "critical",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      createdAt: now,
      updatedAt: now,
    });

    return { companyId, agentId, issueId, runId };
  }

  it("auto-blocks stranded work with the assignee_not_invokable descriptor when the assignee is non-invokable", async () => {
    const { agentId, issueId } = await seedStrandedInProgressWithDeadRun("error");
    const svc = recovery();

    const result = await svc.reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");
    expect(issue?.assigneeAgentId).toBe(agentId);
    expect(isAssigneeNotInvokableUnblockDescriptor(issue?.unblockDescriptor)).toBe(true);

    const relations = await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId, issueId));
    expect(relations).toHaveLength(0);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.some((row) => row.body?.includes("assignee-not-invokable descriptor"))).toBe(true);

    const audit = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.assignee_not_invokable_blocked"));
    expect(audit).toHaveLength(1);
  });

  it("returns descriptor-only blocks to todo when the assignee becomes invokable again and reports healed count", async () => {
    const { companyId, agentId, issuePrefix, now } = await seedCompanyWithAgent("error");
    const issueId = randomUUID();
    const descriptor = buildAssigneeNotInvokableUnblockDescriptor();
    const svc = recovery();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Outage-blocked issue",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      unblockDescriptor: descriptor,
      blockedTransitionAt: now,
      createdAt: now,
      updatedAt: now,
    });

    // Still non-invokable — do not heal.
    const whileDown = await svc.healAssigneeNotInvokableBlockedIssues({
      agentId,
      source: "test.while_down",
    });
    expect(whileDown).toMatchObject({ checked: 1, healed: 0, skipped: 1, issueIds: [] });
    let issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");
    expect(isAssigneeNotInvokableUnblockDescriptor(issue?.unblockDescriptor)).toBe(true);

    // Lane recovers.
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agentId));
    const healed = await svc.healAssigneeNotInvokableBlockedIssues({
      agentId,
      source: "test.after_recovery",
    });
    expect(healed).toMatchObject({ checked: 1, healed: 1, skipped: 0, issueIds: [issueId] });

    issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("todo");
    expect(issue?.unblockDescriptor).toBeNull();

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.some((row) => row.body?.includes("restored this issue to `todo`"))).toBe(true);

    const audit = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.assignee_not_invokable_healed"));
    expect(audit).toHaveLength(1);

    expect(enqueueWakeup).toHaveBeenCalled();
    expect(enqueueWakeup.mock.calls.some((call) => {
      const calledAgentId = (call as unknown[])[0];
      const opts = (call as unknown[])[1] as { reason?: string; payload?: Record<string, unknown> } | undefined;
      return calledAgentId === agentId
        && opts?.reason === "issue_assignment_recovery"
        && opts?.payload?.issueId === issueId
        && opts?.payload?.healedFrom === ASSIGNEE_NOT_INVOKABLE_UNBLOCK_CAUSE;
    })).toBe(true);

    // Idempotent second pass.
    const again = await svc.healAssigneeNotInvokableBlockedIssues({
      agentId,
      source: "test.idempotent",
    });
    expect(again).toMatchObject({ checked: 0, healed: 0 });
  });

  it("does not heal issues that still have genuine open blockedBy edges or foreign descriptors", async () => {
    const { companyId, agentId, issuePrefix, now } = await seedCompanyWithAgent("idle");
    const healableId = randomUUID();
    const genuineBlockerId = randomUUID();
    const genuineBlockedId = randomUUID();
    const foreignDescriptorId = randomUUID();
    const descriptor = buildAssigneeNotInvokableUnblockDescriptor();
    const svc = recovery();

    await db.insert(issues).values([
      {
        id: healableId,
        companyId,
        title: "Healable outage block",
        status: "blocked",
        priority: "high",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        unblockDescriptor: descriptor,
        blockedTransitionAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: genuineBlockerId,
        companyId,
        title: "Open blocker",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: genuineBlockedId,
        companyId,
        title: "Genuine dependency block",
        status: "blocked",
        priority: "high",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
        issueNumber: 3,
        identifier: `${issuePrefix}-3`,
        unblockDescriptor: descriptor,
        blockedTransitionAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: foreignDescriptorId,
        companyId,
        title: "External wait block",
        status: "blocked",
        priority: "high",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
        issueNumber: 4,
        identifier: `${issuePrefix}-4`,
        unblockDescriptor: { owner: "board", action: "Wait for the vendor reply." },
        blockedTransitionAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    // blocker.blocks -> genuineBlockedId
    await db.insert(issueRelations).values({
      id: randomUUID(),
      companyId,
      issueId: genuineBlockerId,
      relatedIssueId: genuineBlockedId,
      type: "blocks",
    });

    const result = await svc.healAssigneeNotInvokableBlockedIssues({
      companyId,
      source: "test.selective",
    });

    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([healableId]);
    expect(result.skipped).toBeGreaterThanOrEqual(1);

    const healed = await db.select().from(issues).where(eq(issues.id, healableId)).then((rows) => rows[0] ?? null);
    expect(healed?.status).toBe("todo");
    expect(healed?.unblockDescriptor).toBeNull();

    const genuine = await db
      .select()
      .from(issues)
      .where(eq(issues.id, genuineBlockedId))
      .then((rows) => rows[0] ?? null);
    expect(genuine?.status).toBe("blocked");
    expect(isAssigneeNotInvokableUnblockDescriptor(genuine?.unblockDescriptor)).toBe(true);

    const foreign = await db
      .select()
      .from(issues)
      .where(eq(issues.id, foreignDescriptorId))
      .then((rows) => rows[0] ?? null);
    expect(foreign?.status).toBe("blocked");
    expect(foreign?.unblockDescriptor).toEqual({ owner: "board", action: "Wait for the vendor reply." });
  });

  it("end-to-end: stranded non-invokable block then heal after assignee recovers", async () => {
    const { agentId, issueId } = await seedStrandedInProgressWithDeadRun("paused");
    const svc = recovery();

    const blocked = await svc.reconcileStrandedAssignedIssues();
    expect(blocked.escalated).toBe(1);

    let issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");
    expect(isAssigneeNotInvokableUnblockDescriptor(issue?.unblockDescriptor)).toBe(true);

    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agentId));
    const healed = await svc.healAssigneeNotInvokableBlockedIssues({
      agentId,
      source: "startup.heal_assignee_not_invokable",
    });
    expect(healed.healed).toBe(1);
    expect(healed.issueIds).toEqual([issueId]);

    issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("todo");
    expect(issue?.unblockDescriptor).toBeNull();
  });
});
