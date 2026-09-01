import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  issueComments,
  issues,
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
    `Skipping embedded Postgres stall-cutoff reassignment tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// BRO-2410 allowlisted assignee (Founding Engineer queue). Fixed id so the
// reconciler's allowlist binds to the seeded issue.
const FE_AGENT_ID = "b3b6dde7-d283-47b7-8556-9eafe7ca9b52";
const NOW = new Date("2026-08-25T20:00:00.000Z");

describeEmbeddedPostgres("recovery stall-cutoff auto-reassignment (BRO-2410)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("stall-cutoff-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.execute("TRUNCATE TABLE \"companies\" CASCADE");
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedOrg() {
    const companyId = randomUUID();
    const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const lightEngineerId = randomUUID();
    const busyEngineerId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Stall Cutoff Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: FE_AGENT_ID, companyId, name: "Founding Engineer", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: lightEngineerId, companyId, name: "Light Engineer", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: busyEngineerId, companyId, name: "Busy Engineer", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      // A different-role teammate must never be picked up as a target.
      { id: randomUUID(), companyId, name: "Designer", role: "designer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);

    // Differing open loads so the least-loaded sibling wins the pickup.
    await db.insert(issues).values([
      { id: randomUUID(), companyId, title: "busy1", status: "in_progress", priority: "medium", assigneeAgentId: busyEngineerId },
      { id: randomUUID(), companyId, title: "busy2", status: "todo", priority: "low", assigneeAgentId: busyEngineerId },
      { id: randomUUID(), companyId, title: "light1", status: "todo", priority: "low", assigneeAgentId: lightEngineerId },
    ]);

    return { companyId, lightEngineerId, busyEngineerId };
  }

  async function seedStallIssue(companyId: string, overrides: Record<string, unknown> = {}) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stalled FE issue",
      status: "todo",
      priority: "high",
      assigneeAgentId: FE_AGENT_ID,
      ...overrides,
    });
    return issueId;
  }

  it("reassigns a priority-stale FE issue to the least-loaded same-role engineer, posts a comment, and wakes it", async () => {
    const { companyId, lightEngineerId, busyEngineerId } = await seedOrg();
    const issueId = await seedStallIssue(companyId, { updatedAt: new Date(NOW.getTime() - 40 * 60 * 1000) });

    const wakeup = vi.fn().mockResolvedValue({ id: randomUUID() });
    const recovery = recoveryService(db as any, { enqueueWakeup: wakeup });

    const result = await recovery.reconcileStallCutoffReassignments(NOW);

    expect(result.reassigned).toBe(1);
    expect(result.issueIds).toContain(issueId);

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    // Least-loaded same-role sibling wins; FE and the busy sibling lose out.
    expect(issue.assigneeAgentId).toBe(lightEngineerId);
    expect(issue.assigneeAgentId).not.toBe(busyEngineerId);
    expect(issue.assigneeAgentId).not.toBe(FE_AGENT_ID);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.some((c) => c.body.includes("Auto-reassigned"))).toBe(true);

    expect(wakeup).toHaveBeenCalledTimes(1);
    const [targetAgentId, opts] = wakeup.mock.calls[0];
    expect(targetAgentId).toBe(lightEngineerId);
    expect(opts.reason).toBe("issue_assigned");
  });

  it("leaves an issue untouched while it is still inside its priority cutoff", async () => {
    const { companyId } = await seedOrg();
    const issueId = await seedStallIssue(companyId, { updatedAt: new Date(NOW.getTime() - 10 * 60 * 1000) });

    const wakeup = vi.fn().mockResolvedValue({ id: randomUUID() });
    const recovery = recoveryService(db as any, { enqueueWakeup: wakeup });

    const result = await recovery.reconcileStallCutoffReassignments(NOW);

    expect(result.reassigned).toBe(0);
    expect(result.skippedStaleWithinCutoff).toBeGreaterThan(0);

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.assigneeAgentId).toBe(FE_AGENT_ID);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("does NOT reassign an issue that has a live scheduled monitor", async () => {
    const { companyId } = await seedOrg();
    const issueId = await seedStallIssue(companyId, {
      updatedAt: new Date(NOW.getTime() - 40 * 60 * 1000),
      monitorNextCheckAt: new Date(NOW.getTime() + 5 * 60 * 1000),
    });

    const wakeup = vi.fn().mockResolvedValue({ id: randomUUID() });
    const recovery = recoveryService(db as any, { enqueueWakeup: wakeup });

    const result = await recovery.reconcileStallCutoffReassignments(NOW);

    expect(result.reassigned).toBe(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.assigneeAgentId).toBe(FE_AGENT_ID);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("leaves an issue alone when a live execution path is deferred for it", async () => {
    const { companyId } = await seedOrg();
    const issueId = await seedStallIssue(companyId, { updatedAt: new Date(NOW.getTime() - 40 * 60 * 1000) });

    // A deferred_issue_execution wake counts as a live execution path.
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId: FE_AGENT_ID,
      source: "system",
      status: "deferred_issue_execution",
      payload: { issueId },
    });

    const wakeup = vi.fn().mockResolvedValue({ id: randomUUID() });
    const recovery = recoveryService(db as any, { enqueueWakeup: wakeup });

    const result = await recovery.reconcileStallCutoffReassignments(NOW);

    expect(result.reassigned).toBe(0);
    expect(result.skippedActivePath).toBeGreaterThan(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.assigneeAgentId).toBe(FE_AGENT_ID);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("skips the issue when no invokable same-role sibling is available", async () => {
    const companyId = randomUUID();
    const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Lone Engineer Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: FE_AGENT_ID, companyId, name: "Founding Engineer", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: randomUUID(), companyId, name: "Designer", role: "designer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    const issueId = await seedStallIssue(companyId, { updatedAt: new Date(NOW.getTime() - 40 * 60 * 1000) });

    const wakeup = vi.fn().mockResolvedValue({ id: randomUUID() });
    const recovery = recoveryService(db as any, { enqueueWakeup: wakeup });

    const result = await recovery.reconcileStallCutoffReassignments(NOW);

    expect(result.reassigned).toBe(0);
    expect(result.skippedNoTarget).toBeGreaterThan(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.assigneeAgentId).toBe(FE_AGENT_ID);
    expect(wakeup).not.toHaveBeenCalled();
  });
});