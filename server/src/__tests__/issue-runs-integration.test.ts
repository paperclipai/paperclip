/**
 * Phase-4 4a-5 Integration-Smoke for issue_runs lock contract.
 *
 * Exercises real-DB race scenarios that unit-tests cannot cover:
 *   1. Concurrent acquire — N parallel acquires of the same issue, exactly 1 wins.
 *   2. KPI: 0 doppelte aktive 'running' rows (unique partial index enforcement).
 *   3. Crash-recovery — simulate worker that acquires + crashes; watchdog/recovery cleans up.
 *   4. Heartbeat-during-recovery — race between live heartbeat and concurrent recoverStale.
 *   5. Recovery does not touch fresh runs (sanity).
 *
 * Boot-reconciler trigger is not wired into the Paperclip server-start yet; that lives in 4b.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { agents, companies, createDb, issueRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueRunsService } from "../services/issue-runs.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping issue-runs integration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue-runs integration", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-runs-integ-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(): Promise<string> {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "test-co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedIssue(): Promise<string> {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "fixture issue",
      status: "todo",
      priority: "medium",
      createdByUserId: "user-1",
    });
    return issueId;
  }

  it("KPI: 5 concurrent acquires on same issue produce exactly 1 winner and 0 doublons", async () => {
    await seedCompany();
    const issueId = await seedIssue();
    const svc = issueRunsService(db);

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        svc.acquire({
          companyId,
          issueId,
          executor: "hermes",
          lockedBy: `worker-${i}`,
        }),
      ),
    );

    const winners = results.filter((r) => r.acquired);
    expect(winners.length).toBe(1);

    const activeRows = await db
      .select()
      .from(issueRuns)
      .where(and(eq(issueRuns.issueId, issueId), eq(issueRuns.status, "running")));
    expect(activeRows.length).toBe(1);

    const totalForIssue = await db.select().from(issueRuns).where(eq(issueRuns.issueId, issueId));
    expect(totalForIssue.length).toBe(1);
  });

  it("crash-simulation: acquire, no heartbeat, recoverStale picks up after TTL+grace", async () => {
    await seedCompany();
    const issueId = await seedIssue();
    const svc = issueRunsService(db);

    const acquired = await svc.acquire({
      companyId,
      issueId,
      executor: "hermes",
      lockedBy: "worker-crashed",
      ttlSeconds: 1,
    });
    expect(acquired.acquired).toBe(true);
    if (!acquired.acquired) throw new Error("acquire failed");

    await db
      .update(issueRuns)
      .set({
        leaseExpiresAt: sql`now() - interval '30 seconds'`,
        heartbeatAt: sql`now() - interval '300 seconds'`,
      })
      .where(eq(issueRuns.runId, acquired.run.runId));

    const recovery = await svc.recoverStale({ trigger: "watchdog" });
    expect(recovery.recovered.length).toBe(1);
    expect(recovery.recovered[0]?.runId).toBe(acquired.run.runId);

    const newAcquire = await svc.acquire({
      companyId,
      issueId,
      executor: "hermes",
      lockedBy: "worker-new",
    });
    expect(newAcquire.acquired).toBe(true);

    const rows = await db.select().from(issueRuns).where(eq(issueRuns.issueId, issueId));
    expect(rows.length).toBe(2);
    const statuses = rows.map((r) => r.status).sort();
    expect(statuses).toEqual(["failed_lease_expired", "running"]);
  });

  it("grace-window: lease expired + fresh heartbeat = recovery skips but worker still cannot extend expired lease", async () => {
    await seedCompany();
    const issueId = await seedIssue();
    const svc = issueRunsService(db);

    const acquired = await svc.acquire({
      companyId,
      issueId,
      executor: "hermes",
      lockedBy: "worker-flaky",
      ttlSeconds: 600,
    });
    if (!acquired.acquired) throw new Error("acquire failed");

    await db
      .update(issueRuns)
      .set({
        leaseExpiresAt: sql`now() - interval '30 seconds'`,
        heartbeatAt: sql`now()`,
      })
      .where(eq(issueRuns.runId, acquired.run.runId));

    const recovery = await svc.recoverStale({ trigger: "watchdog" });
    expect(recovery.candidates.length).toBe(0);
    expect(recovery.recovered.length).toBe(0);

    const heartbeat = await svc.heartbeat({
      runId: acquired.run.runId,
      lockedBy: "worker-flaky",
      extendBySeconds: 600,
    });
    expect(heartbeat.ok).toBe(false);
    if (heartbeat.ok) throw new Error("expected lock_lost");
    expect(heartbeat.reason).toBe("lock_lost");
  });

  it("recovery does not touch fresh runs", async () => {
    await seedCompany();
    const issueId = await seedIssue();
    const svc = issueRunsService(db);

    const acquired = await svc.acquire({
      companyId,
      issueId,
      executor: "hermes",
      lockedBy: "worker-1",
      ttlSeconds: 900,
    });
    expect(acquired.acquired).toBe(true);

    const recovery = await svc.recoverStale({ trigger: "watchdog" });
    expect(recovery.candidates.length).toBe(0);
    expect(recovery.recovered.length).toBe(0);
  });

  it("KPI: end-to-end lifecycle leaves no duplicate running rows", async () => {
    await seedCompany();
    const issueId = await seedIssue();
    const svc = issueRunsService(db);

    const acq1 = await svc.acquire({
      companyId,
      issueId,
      executor: "hermes",
      lockedBy: "worker-1",
    });
    if (!acq1.acquired) throw new Error("acquire failed");

    await svc.heartbeat({ runId: acq1.run.runId, lockedBy: "worker-1", extendBySeconds: 60 });
    const released = await svc.release({
      runId: acq1.run.runId,
      lockedBy: "worker-1",
      status: "completed",
      exitCode: 0,
    });
    expect(released.ok).toBe(true);

    const acq2 = await svc.acquire({
      companyId,
      issueId,
      executor: "hermes",
      lockedBy: "worker-2",
    });
    expect(acq2.acquired).toBe(true);

    const running = await db
      .select()
      .from(issueRuns)
      .where(and(eq(issueRuns.issueId, issueId), eq(issueRuns.status, "running")));
    expect(running.length).toBe(1);
  });

  async function seedAgent(executor: "hermes" | "mc-dispatch", name = "agent-1") {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "running",
      executor,
      adapterType: "codex_local",
    });
    return agentId;
  }

  async function seedIssueWithAssignee(agentId: string): Promise<string> {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "assigned issue",
      status: "todo",
      priority: "medium",
      createdByUserId: "user-1",
      assigneeAgentId: agentId,
    });
    return issueId;
  }

  it("Phase-4 4b-4: hermes runner cannot acquire mc-dispatch agent's issue", async () => {
    await seedCompany();
    const mcAgent = await seedAgent("mc-dispatch", "drain-bot");
    const issueId = await seedIssueWithAssignee(mcAgent);
    const svc = issueRunsService(db);

    const result = await svc.acquire({
      companyId,
      issueId,
      executor: "hermes",
      lockedBy: "hermes-worker",
    });

    expect(result.acquired).toBe(false);
    if (result.acquired) throw new Error("unreachable");
    expect(result.reason).toBe("executor_mismatch");
    if (result.reason === "executor_mismatch") {
      expect(result.assignedExecutor).toBe("mc-dispatch");
      expect(result.requestedExecutor).toBe("hermes");
    }

    const rows = await db.select().from(issueRuns).where(eq(issueRuns.issueId, issueId));
    expect(rows.length).toBe(0);
  });

  it("Phase-4 4b-4: mc-dispatch fallback cannot acquire hermes agent's issue", async () => {
    await seedCompany();
    const hermesAgent = await seedAgent("hermes", "hermes-bot");
    const issueId = await seedIssueWithAssignee(hermesAgent);
    const svc = issueRunsService(db);

    const result = await svc.acquire({
      companyId,
      issueId,
      executor: "mc-dispatch",
      lockedBy: "mc-fallback",
    });

    expect(result.acquired).toBe(false);
    if (result.acquired) throw new Error("unreachable");
    expect(result.reason).toBe("executor_mismatch");
  });

  it("Phase-4 4b-4: executor matches assignee allows acquire", async () => {
    await seedCompany();
    const hermesAgent = await seedAgent("hermes", "hermes-bot");
    const issueId = await seedIssueWithAssignee(hermesAgent);
    const svc = issueRunsService(db);

    const result = await svc.acquire({
      companyId,
      issueId,
      executor: "hermes",
      lockedBy: "hermes-worker",
    });

    expect(result.acquired).toBe(true);
  });

  it("Phase-4 4b-4: issue without assignee allows either executor (free pool)", async () => {
    await seedCompany();
    const issueId = await seedIssue();
    const svc = issueRunsService(db);

    const result = await svc.acquire({
      companyId,
      issueId,
      executor: "hermes",
      lockedBy: "any-worker",
    });

    expect(result.acquired).toBe(true);
  });
});
