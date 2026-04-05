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
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres execution lock sweep tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("sweepOrphanedExecutionLocks", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-lock-sweep-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(input: {
    runStatus: string;
    lockedAt?: Date;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "paused",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input.runStatus,
      contextSnapshot: { issueId },
      startedAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test issue with execution lock",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      executionLockedAt: input.lockedAt ?? new Date(),
      executionAgentNameKey: "testagent",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, runId, issueId };
  }

  it("clears lock when associated run is in terminal status 'succeeded'", async () => {
    const { issueId } = await seedFixture({ runStatus: "succeeded" });
    const heartbeat = heartbeatService(db as any);

    const result = await heartbeat.sweepOrphanedExecutionLocks();

    expect(result.cleaned).toBe(1);
    expect(result.issueIds).toContain(issueId);

    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(row!.executionRunId).toBeNull();
    expect(row!.executionLockedAt).toBeNull();
    expect(row!.executionAgentNameKey).toBeNull();
  });

  it("clears lock when associated run is in terminal status 'failed'", async () => {
    const { issueId } = await seedFixture({ runStatus: "failed" });
    const heartbeat = heartbeatService(db as any);

    const result = await heartbeat.sweepOrphanedExecutionLocks();

    expect(result.cleaned).toBe(1);
    expect(result.issueIds).toContain(issueId);
  });

  it("clears lock when associated run is in terminal status 'cancelled'", async () => {
    const { issueId } = await seedFixture({ runStatus: "cancelled" });
    const heartbeat = heartbeatService(db as any);

    const result = await heartbeat.sweepOrphanedExecutionLocks();

    expect(result.cleaned).toBe(1);
    expect(result.issueIds).toContain(issueId);
  });

  it("clears lock when associated run is in terminal status 'timed_out'", async () => {
    const { issueId } = await seedFixture({ runStatus: "timed_out" });
    const heartbeat = heartbeatService(db as any);

    const result = await heartbeat.sweepOrphanedExecutionLocks();

    expect(result.cleaned).toBe(1);
    expect(result.issueIds).toContain(issueId);
  });

  it("clears lock when executionLockedAt is older than the stale threshold and run is terminal", async () => {
    const staleDate = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
    const { issueId } = await seedFixture({ runStatus: "failed", lockedAt: staleDate });
    const heartbeat = heartbeatService(db as any);

    const result = await heartbeat.sweepOrphanedExecutionLocks({ staleThresholdMs: 60 * 60 * 1000 });

    expect(result.cleaned).toBe(1);
    expect(result.issueIds).toContain(issueId);
  });

  it("does NOT clear lock when associated run is still active (running)", async () => {
    const { issueId } = await seedFixture({ runStatus: "running" });
    const heartbeat = heartbeatService(db as any);

    const result = await heartbeat.sweepOrphanedExecutionLocks();

    expect(result.cleaned).toBe(0);
    expect(result.issueIds).not.toContain(issueId);

    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(row!.executionRunId).not.toBeNull();
  });

  it("does NOT clear lock when associated run is queued (not yet started)", async () => {
    const { issueId } = await seedFixture({ runStatus: "queued" });
    const heartbeat = heartbeatService(db as any);

    const result = await heartbeat.sweepOrphanedExecutionLocks();

    expect(result.cleaned).toBe(0);
    expect(result.issueIds).not.toContain(issueId);
  });

  it("does NOT clear a recent lock when run is still active, even with a long-ago lockedAt", async () => {
    // Run is still running — the lock is valid regardless of timestamp
    const staleDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const { issueId } = await seedFixture({ runStatus: "running", lockedAt: staleDate });
    const heartbeat = heartbeatService(db as any);

    const result = await heartbeat.sweepOrphanedExecutionLocks({ staleThresholdMs: 60 * 60 * 1000 });

    expect(result.cleaned).toBe(0);
    expect(result.issueIds).not.toContain(issueId);
  });

  it("returns cleaned=0 when there are no orphaned locks", async () => {
    const heartbeat = heartbeatService(db as any);
    const result = await heartbeat.sweepOrphanedExecutionLocks();
    expect(result.cleaned).toBe(0);
    expect(result.issueIds).toHaveLength(0);
  });
});
