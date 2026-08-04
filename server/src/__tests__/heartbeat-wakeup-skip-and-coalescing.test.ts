import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.ts";
import { runningProcesses } from "../adapters/index.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat wakeup skip/coalescing tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat wakeup skip reasons and coalescing", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-wakeup-skip-coalescing-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    runningProcesses.clear();
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(overrides: { runtimeConfig?: Record<string, unknown> } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const ownerUserId = `owner-${randomUUID()}`;
    const issuePrefix = `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId: ownerUserId,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: overrides.runtimeConfig ?? { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    return { companyId, agentId, ownerUserId, issuePrefix };
  }

  it("records the precise skip reason when wakeOnDemand is disabled", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      runtimeConfig: { heartbeat: { wakeOnDemand: false } },
    });
    const heartbeat = heartbeatService(db);

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      requestedByActorType: "system",
    });

    expect(run).toBeNull();

    const skipped = await db
      .select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)));

    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.status).toBe("skipped");
    expect(skipped[0]?.reason).toBe("heartbeat.wakeOnDemand.disabled");
  });

  it("durably records a failed assignment wakeup instead of swallowing it", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const failure = new Error("gateway unreachable");
    const wakeupDep = { wakeup: vi.fn(async () => { throw failure; }) };

    // Production call sites use `void` (fire-and-forget); the test awaits
    // the same promise chain directly for determinism.
    await queueIssueAssignmentWakeup({
      db,
      heartbeat: wakeupDep,
      issue: { id: issueId, assigneeAgentId: agentId, status: "todo" },
      reason: "issue_assigned",
      mutation: "assign",
      contextSource: "test",
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    expect(wakeupDep.wakeup).toHaveBeenCalledTimes(1);

    const failed = await db
      .select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason, error: agentWakeupRequests.error })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)));

    expect(failed).toHaveLength(1);
    expect(failed[0]?.status).toBe("failed");
    expect(failed[0]?.reason).toBe("issue_assignment_wakeup_failed");
    expect(failed[0]?.error).toContain("gateway unreachable");
  });

  it("coalesces a wake for the same agent and issue into the already-running run instead of losing it", async () => {
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const runningRunId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: runningRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    });
    // Mark the run as a live execution so the coalesce-target zombie filter
    // (heartbeat.ts filterZombieCoalesceTarget) treats it as active rather
    // than an orphaned process, matching a real running run.
    runningProcesses.set(runningRunId, {
      child: {} as never,
      graceSec: 0,
      processGroupId: null,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Assigned while running",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: runningRunId,
      executionAgentNameKey: "coder",
      executionLockedAt: new Date(),
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const heartbeat = heartbeatService(db);
    const followupRun = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    // The follow-up wake must not vanish: it merges into the run already
    // holding the execution lock rather than being dropped or erroring.
    expect(followupRun).not.toBeNull();
    expect(followupRun?.id).toBe(runningRunId);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("running");

    const coalesced = await db
      .select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)));
    expect(coalesced).toHaveLength(1);
    expect(coalesced[0]?.status).toBe("coalesced");
    expect(coalesced[0]?.runId).toBe(runningRunId);
  });

  it("serializes concurrent wakes for the same agent/issue without duplicating or losing the run", async () => {
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const runningRunId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: runningRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    });
    // Mark the run as a live execution so the coalesce-target zombie filter
    // (heartbeat.ts filterZombieCoalesceTarget) treats it as active rather
    // than an orphaned process, matching a real running run.
    runningProcesses.set(runningRunId, {
      child: {} as never,
      graceSec: 0,
      processGroupId: null,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Concurrent assignment wakes",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: runningRunId,
      executionAgentNameKey: "coder",
      executionLockedAt: new Date(),
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const heartbeat = heartbeatService(db);
    const wakeOnce = () =>
      heartbeat.wakeup(agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId },
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
        requestedByActorType: "user",
        requestedByActorId: "local-board",
      });

    const results = await Promise.all([wakeOnce(), wakeOnce(), wakeOnce()]);

    for (const result of results) {
      expect(result).not.toBeNull();
      expect(result?.id).toBe(runningRunId);
    }

    // Concurrent follow-ups must serialize onto the single held run — no
    // duplicate runs, and every wake is accounted for durably.
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
    expect(runs).toHaveLength(1);

    const coalesced = await db
      .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)));
    expect(coalesced).toHaveLength(3);
    for (const row of coalesced) {
      expect(row.status).toBe("coalesced");
      expect(row.runId).toBe(runningRunId);
    }
  });
});
