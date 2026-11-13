import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { executionProjectionsForRuns } from "./execution-projection.js";
import { agentQueuedRunLine, clearAgentQueueLineCache, worktreeExecutionCutoff } from "./heartbeat/queued-run-line.js";
import { issueService } from "./issues.js";

const support = await getEmbeddedPostgresTestSupport();
const now = new Date("2026-11-13T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

(support.supported ? describe : describe.skip)("execution projection: waiting behind the agent's limit", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("agent-queue-projection-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(() => clearAgentQueueLineCache());

  async function fixture(options: { maxConcurrentRuns: number; running: number }) {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Queue test", issuePrefix: `Q${companyId.slice(0, 8)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Codie", adapterType: "claude_local",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: options.maxConcurrentRuns } } });
    for (let index = 0; index < options.running; index += 1) {
      await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running",
        startedAt: minutesAgo(90), createdAt: minutesAgo(90) });
    }
    async function queue(input: { priority: "critical" | "high" | "medium" | "low"; createdMinutesAgo: number; wakeReason?: string }) {
      const issueId = randomUUID(), runId = randomUUID();
      await db.insert(issues).values({ id: issueId, companyId, title: `Task ${input.priority}`, assigneeAgentId: agentId,
        status: "in_progress", priority: input.priority });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "queued", issueId,
        createdAt: minutesAgo(input.createdMinutesAgo),
        contextSnapshot: { issueId, ...(input.wakeReason ? { wakeReason: input.wakeReason } : {}) } });
      return runId;
    }
    return { companyId, agentId, queue };
  }

  it("names the agent, its limit and each run's place in the order dispatch starts them", async () => {
    const f = await fixture({ maxConcurrentRuns: 2, running: 2 });
    // Created oldest first, but dispatch starts a person's retry first, then by priority.
    const lowOld = await f.queue({ priority: "low", createdMinutesAgo: 30 });
    const medium = await f.queue({ priority: "medium", createdMinutesAgo: 20 });
    const critical = await f.queue({ priority: "critical", createdMinutesAgo: 10 });
    const personRetry = await f.queue({ priority: "low", createdMinutesAgo: 5, wakeReason: "task_retry" });

    const projections = await executionProjectionsForRuns(db, f.companyId, [lowOld, medium, critical, personRetry], now);
    const queueOf = (runId: string) => projections.get(runId)?.agentQueue;
    expect(projections.get(critical)).toMatchObject({
      phase: "queued",
      label: "Waiting for Codie",
      cause: "agent_at_capacity",
      agentQueue: { agentId: f.agentId, agentName: "Codie", maxConcurrentRuns: 2, runningCount: 2, position: 2, queuedCount: 4 },
    });
    expect([personRetry, critical, medium, lowOld].map(runId => queueOf(runId)?.position)).toEqual([1, 2, 3, 4]);

    // The position is the dispatch line itself, not a client-side sort.
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(await agentQueuedRunLine(db, issueService(db), agent!, now)).toEqual([personRetry, critical, medium, lowOld]);
  });

  it("does not claim a run waits on the limit while the agent has a free slot", async () => {
    const f = await fixture({ maxConcurrentRuns: 3, running: 2 });
    const runId = await f.queue({ priority: "high", createdMinutesAgo: 5 });
    const projection = (await executionProjectionsForRuns(db, f.companyId, [runId], now)).get(runId);
    expect(projection).toMatchObject({ phase: "queued", label: "Queued", cause: null });
    expect(projection?.agentQueue).toBeUndefined();

    // Once the limit is full the same run explains the wait.
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } } }).where(eq(agents.id, f.agentId));
    expect((await executionProjectionsForRuns(db, f.companyId, [runId], now)).get(runId)).toMatchObject({
      label: "Waiting for Codie",
      agentQueue: { maxConcurrentRuns: 2, runningCount: 2, position: 1, queuedCount: 1 },
    });
  });

  it("names the routine's open execution that holds a queued routine task, before the agent's limit", async () => {
    const f = await fixture({ maxConcurrentRuns: 20, running: 0 });
    const routineId = randomUUID();
    const holderIssueId = randomUUID(), holderRunId = randomUUID();
    const waitingIssueId = randomUUID(), waitingRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: holderRunId, companyId: f.companyId, agentId: f.agentId, status: "running",
      startedAt: minutesAgo(18), createdAt: minutesAgo(30), issueId: holderIssueId, contextSnapshot: { issueId: holderIssueId } });
    await db.insert(issues).values([
      { id: holderIssueId, companyId: f.companyId, identifier: "Q-3093", title: "Nightly test gardening", status: "in_progress",
        assigneeAgentId: f.agentId, originKind: "routine_execution", originId: routineId, executionRunId: holderRunId },
      { id: waitingIssueId, companyId: f.companyId, identifier: "Q-3636", title: "Nightly test gardening", status: "in_progress",
        assigneeAgentId: f.agentId, originKind: "routine_execution", originId: routineId },
    ]);
    await db.insert(heartbeatRuns).values({ id: waitingRunId, companyId: f.companyId, agentId: f.agentId, status: "queued",
      createdAt: minutesAgo(8), issueId: waitingIssueId, contextSnapshot: { issueId: waitingIssueId } });

    expect((await executionProjectionsForRuns(db, f.companyId, [waitingRunId], now)).get(waitingRunId)).toMatchObject({
      phase: "queued",
      label: "Waiting for Q-3093 to finish",
      cause: "routine_execution_in_progress",
    });
    // The holder's own run is not waiting on itself.
    expect((await executionProjectionsForRuns(db, f.companyId, [holderRunId], now)).get(holderRunId)?.cause).not.toBe("routine_execution_in_progress");

    // A private holder is not named to readers of the waiting task.
    await db.update(issues).set({ visibility: "private" }).where(eq(issues.id, holderIssueId));
    const privateHold = (await executionProjectionsForRuns(db, f.companyId, [waitingRunId], now)).get(waitingRunId);
    expect(privateHold).toMatchObject({ label: "Waiting for another task in this routine to finish", cause: "routine_execution_in_progress" });
    expect(JSON.stringify(privateHold)).not.toContain("Q-3093");
    await db.update(issues).set({ visibility: "open" }).where(eq(issues.id, holderIssueId));

    // Once the holder closes, the routine slot is free and the run is plainly queued.
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, holderIssueId));
    expect((await executionProjectionsForRuns(db, f.companyId, [waitingRunId], now)).get(waitingRunId)).toMatchObject({
      label: "Queued", cause: null,
    });
  });

  it("leaves out queued runs that a preview worktree's cutoff keeps from starting", async () => {
    const f = await fixture({ maxConcurrentRuns: 1, running: 1 });
    const copiedOld = await f.queue({ priority: "critical", createdMinutesAgo: 120 });
    const fresh = await f.queue({ priority: "low", createdMinutesAgo: 5 });
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(await agentQueuedRunLine(db, issueService(db), agent!, now, { cutoff: null })).toEqual([copiedOld, fresh]);
    expect(await agentQueuedRunLine(db, issueService(db), agent!, now, { cutoff: minutesAgo(60) })).toEqual([fresh]);
    // Outside a worktree there is no cutoff and no settings read.
    expect(await worktreeExecutionCutoff(db, {})).toBeNull();
  });

  it("keeps a deep queue's place in line to a few reads, not one per run", async () => {
    const f = await fixture({ maxConcurrentRuns: 20, running: 20 });
    const runIds: string[] = [];
    for (let index = 0; index < 300; index += 1) {
      runIds.push(await f.queue({ priority: (["critical", "high", "medium", "low"] as const)[index % 4], createdMinutesAgo: 300 - index,
        ...(index % 9 === 0 ? { wakeReason: "issue_continuation_needed" } : {}) }));
    }
    const started = performance.now();
    const projections = await executionProjectionsForRuns(db, f.companyId, runIds, now);
    const elapsedMs = performance.now() - started;
    const positions = runIds.map(runId => projections.get(runId)?.agentQueue?.position).sort((a, b) => a! - b!);
    expect(positions).toEqual(runIds.map((_, index) => index + 1));
    expect(projections.get(runIds[0]!)?.agentQueue?.queuedCount).toBe(300);
    // Generous bound for slow CI; the ordering itself is O(n log n).
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it("leaves running runs and other companies' runs out of the line", async () => {
    const f = await fixture({ maxConcurrentRuns: 1, running: 1 });
    const mine = await f.queue({ priority: "medium", createdMinutesAgo: 5 });
    const other = await fixture({ maxConcurrentRuns: 1, running: 1 });
    await other.queue({ priority: "critical", createdMinutesAgo: 50 });
    const projection = (await executionProjectionsForRuns(db, f.companyId, [mine], now)).get(mine);
    expect(projection?.agentQueue).toMatchObject({ position: 1, queuedCount: 1, runningCount: 1 });
  });
});
