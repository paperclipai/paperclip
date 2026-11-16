import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { truncateTablesWithDeadlockRetry } from "./helpers/truncate-with-deadlock-retry.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses, type AdapterExecutionContext, type AdapterExecutionResult } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_context: AdapterExecutionContext): Promise<AdapterExecutionResult> => ({
    exitCode: 0, signal: null, timedOut: false, errorMessage: null,
    summary: "Reassignment wake test run.", provider: "test", model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })) };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping reassignment deferred-wake tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("the new owner's wake after a task is reassigned away from a queued creator run", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-reassign-deferred-wake-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await truncateTablesWithDeadlockRetry(db, `TRUNCATE TABLE "issues", "heartbeat_run_events", "activity_log",
      "heartbeat_runs", "agent_wakeup_requests", "agent_runtime_state", "agents", "companies" RESTART IDENTITY CASCADE`,
    { attempts: 10, delayMs: () => 100 });
    await db.delete(authUsers).where(eq(authUsers.id, "responsible-user"));
  });

  afterAll(async () => {
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  async function seedReassignedTaskWithDeferredNewOwner() {
    const companyId = randomUUID();
    const ceoId = randomUUID();
    const morganId = randomUUID();
    const issueId = randomUUID();
    const ceoRunId = randomUUID();
    const ceoWakeId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Reassign Co", issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user", requireBoardApprovalForNewAgents: false,
    });
    await db.insert(authUsers).values({
      id: "responsible-user", name: "Fixture user", email: "responsible-user@example.test",
      createdAt: new Date(), updatedAt: new Date(),
    }).onConflictDoNothing();
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member",
    });
    await db.insert(agents).values([ceoId, morganId].map((id, index) => ({
      id, companyId, name: index === 0 ? "CEO" : "Morgan", role: index === 0 ? "ceo" : "engineer",
      status: "idle", adapterType: "codex_local", adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {},
    })));
    await db.insert(issues).values({
      id: issueId, companyId, title: "Make a simple website", status: "todo", priority: "medium",
      assigneeAgentId: morganId,
    });
    await db.insert(agentWakeupRequests).values({
      id: ceoWakeId, companyId, agentId: ceoId, source: "assignment", triggerDetail: "system",
      reason: "issue_assigned", payload: { issueId }, status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: ceoRunId, companyId, agentId: ceoId, invocationSource: "assignment", triggerDetail: "system",
      status: "queued", wakeupRequestId: ceoWakeId, contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    await db.update(agentWakeupRequests).set({ runId: ceoRunId }).where(eq(agentWakeupRequests.id, ceoWakeId));

    await heartbeat.wakeup(morganId, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      requestedByActorType: "system", payload: { issueId },
    });
    const [deferred] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, morganId));
    expect(deferred).toMatchObject({ status: "deferred_issue_execution", runId: null });
    return { companyId, ceoId, morganId, issueId, ceoRunId, deferredWakeId: deferred!.id };
  }

  async function expectOneNewOwnerRun(f: { morganId: string; issueId: string; deferredWakeId: string }) {
    await vi.waitFor(async () => {
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.deferredWakeId));
      expect(wake!.status).not.toBe("deferred_issue_execution");
      expect(wake!.runId).toBeTruthy();
      const runs = await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.agentId, f.morganId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`));
      expect(runs).toHaveLength(1);
      expect(runs[0]!.id).toBe(wake!.runId);
      expect(mockAdapterExecute.mock.calls.filter(([context]) => context?.runId === wake!.runId), JSON.stringify({ status: runs[0]!.status, errorCode: runs[0]!.errorCode, error: runs[0]!.error })).toHaveLength(1);
    }, { timeout: 15_000 });
  }

  it("promotes the new owner's wake when the queue withholds the stale creator run", async () => {
    const f = await seedReassignedTaskWithDeferredNewOwner();

    await heartbeat.resumeQueuedRuns();

    const [stale] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.ceoRunId));
    expect(stale).toMatchObject({ status: "cancelled", errorCode: "issue_assignee_changed" });
    expect(mockAdapterExecute.mock.calls.filter(([context]) => context?.runId === f.ceoRunId)).toHaveLength(0);
    await expectOneNewOwnerRun(f);
  });

  it("recovers a new owner's wake left deferred after the blocking run already finished", async () => {
    const f = await seedReassignedTaskWithDeferredNewOwner();
    await db.update(heartbeatRuns).set({
      status: "cancelled", finishedAt: new Date(), errorCode: "issue_assignee_changed",
      error: "Cancelled because issue assignee changed before the queued run could start; the new owner will be woken instead",
    }).where(eq(heartbeatRuns.id, f.ceoRunId));
    await db.update(issues).set({ executionRunId: null, executionAgentNameKey: null, executionLockedAt: null })
      .where(eq(issues.id, f.issueId));

    await heartbeat.resumeQueuedRuns();

    await expectOneNewOwnerRun(f);
  });
});
