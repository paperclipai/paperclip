import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  RECOVERY_UNBLOCK_COOLDOWN_MS,
  evaluateStrandedEscalationGuard,
} from "./stranded-escalation-guard.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("stranded escalation guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stranded-guard-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.update(issues).set({ executionRunId: null });
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue(overrides: { status?: string; originKind?: string } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Guard Test Company",
      issuePrefix: `G${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Guard agent",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `GRD-${issueId.slice(0, 8)}`,
      title: "Stranded escalation guard fixture",
      description: "Fixture issue for the stranded escalation guard.",
      status: overrides.status ?? "in_progress",
      priority: "medium",
      workMode: "standard",
      originKind: overrides.originKind ?? "manual",
      assigneeAgentId: agentId,
    });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    return { companyId, agentId, issueId, issue: issue! };
  }

  it("blocks when nothing in the current state contradicts the escalation", async () => {
    const { issue } = await seedIssue();
    const decision = await evaluateStrandedEscalationGuard(db, { issue });
    expect(decision.decision).toBe("block");
    expect(decision.reason).toBe("no_conflicting_state");
  });

  it("leaves routine-execution issues to their own disposition", async () => {
    const { issue } = await seedIssue({ originKind: "routine_execution" });
    const decision = await evaluateStrandedEscalationGuard(db, { issue });
    expect(decision.decision).toBe("block");
    expect(decision.reason).toBe("routine_execution_issue");
  });

  it("skips when the issue reached a terminal status after the sweep scanned it", async () => {
    const { issue, issueId } = await seedIssue();
    // The sweep captured `in_progress`. The issue finished before the write.
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
    const decision = await evaluateStrandedEscalationGuard(db, { issue });
    expect(decision.decision).toBe("skip");
    expect(decision.reason).toBe("issue_terminal");
  });

  it("skips when the issue row is gone", async () => {
    const { issue, issueId } = await seedIssue();
    await db.delete(issues).where(eq(issues.id, issueId));
    const decision = await evaluateStrandedEscalationGuard(db, { issue });
    expect(decision.decision).toBe("skip");
    expect(decision.reason).toBe("issue_missing");
  });

  it.each(["queued", "running", "scheduled_retry"])(
    "skips when a %s run for the issue is live",
    async (status) => {
      const { issue, issueId, companyId, agentId } = await seedIssue();
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        status,
        contextSnapshot: { issueId },
      });
      const decision = await evaluateStrandedEscalationGuard(db, { issue });
      expect(decision.decision).toBe("skip");
      expect(decision.reason).toBe("live_run_present");
    },
  );

  it("still blocks when the only run for the issue already finished", async () => {
    const { issue, issueId, companyId, agentId } = await seedIssue();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "failed",
      contextSnapshot: { issueId },
    });
    const decision = await evaluateStrandedEscalationGuard(db, { issue });
    expect(decision.decision).toBe("block");
  });

  it("does not treat another issue's live run as this issue's run", async () => {
    const { issue, companyId, agentId } = await seedIssue();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId: randomUUID() },
    });
    const decision = await evaluateStrandedEscalationGuard(db, { issue });
    expect(decision.decision).toBe("block");
  });

  it.each(["agent", "user"])(
    "skips inside the cool-down after a %s moved the issue out of blocked",
    async (actorType) => {
      const { issue, issueId, companyId } = await seedIssue();
      await db.insert(activityLog).values({
        companyId,
        actorType,
        actorId: "actor-1",
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        details: { status: "in_progress" },
      });
      const decision = await evaluateStrandedEscalationGuard(db, { issue });
      expect(decision).toMatchObject({
        decision: "skip",
        reason: "explicit_unblock_cooldown",
        unblockedByActorType: actorType,
      });
    },
  );

  it("skips inside the cool-down after an explicit recovery-action resolution", async () => {
    const { issue, issueId, companyId } = await seedIssue();
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "actor-1",
      action: "issue.recovery_action_resolved",
      entityType: "issue",
      entityId: issueId,
      details: {},
    });
    const decision = await evaluateStrandedEscalationGuard(db, { issue });
    expect(decision.decision).toBe("skip");
    expect(decision.reason).toBe("explicit_unblock_cooldown");
  });

  it("blocks again once the unblock is older than the cool-down", async () => {
    const { issue, issueId, companyId } = await seedIssue();
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "actor-1",
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: { status: "in_progress" },
      createdAt: new Date(Date.now() - RECOVERY_UNBLOCK_COOLDOWN_MS - 60_000),
    });
    const decision = await evaluateStrandedEscalationGuard(db, { issue });
    expect(decision.decision).toBe("block");
  });

  it("ignores a system status write, so recovery is not its own cool-down", async () => {
    const { issue, issueId, companyId } = await seedIssue();
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: { status: "todo" },
    });
    const decision = await evaluateStrandedEscalationGuard(db, { issue });
    expect(decision.decision).toBe("block");
  });

  it("ignores an agent write that did not move the issue out of blocked", async () => {
    const { issue, issueId, companyId } = await seedIssue();
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: "agent-1",
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: { status: "blocked" },
    });
    const decision = await evaluateStrandedEscalationGuard(db, { issue });
    expect(decision.decision).toBe("block");
  });
});
