import { randomUUID } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvals,
  issueApprovals,
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  issueThreadInteractions,
  issueWatchdogs,
} from "@paperclipai/db";
import { taskWatchdogService } from "../services/task-watchdogs.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("obsolete task watchdog settlement", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("watchdog-settlement-");
    db = createDb(temp.connectionString);
  }, 90000);
  afterAll(async () => {
    await db?.$client.end();
    await temp?.cleanup();
  });
  const one = async (id: string) =>
    (await db.select().from(issues).where(eq(issues.id, id)))[0];
  async function fixture() {
    const [company] = await db
      .insert(companies)
      .values({
        name: "Watchdog settlement",
        issuePrefix: "WS" + randomUUID().slice(0, 8),
        defaultResponsibleUserId: "board",
      })
      .returning();
    const [worker, watcher] = await db
      .insert(agents)
      .values(
        ["Worker", "Watcher"].map((name) => ({
          companyId: company.id,
          name,
          status: "idle" as const,
          adapterType: "process",
          runtimeConfig: { heartbeat: { wakeOnDemand: true } },
        })),
      )
      .returning();
    const [source] = await db
      .insert(issues)
      .values({
        companyId: company.id,
        title: "Stopped work",
        status: "blocked",
        assigneeAgentId: worker.id,
        createdAt: new Date(Date.now() - 3600000),
      })
      .returning();
    const [watchdog] = await db
      .insert(issueWatchdogs)
      .values({
        companyId: company.id,
        issueId: source.id,
        watchdogAgentId: watcher.id,
        instructions: "Inspect stopped work",
      })
      .returning();
    const wakes: string[] = [];
    const service = taskWatchdogService(db, {
      enqueueWakeup: async (_agentId, options) => {
        wakes.push(options?.idempotencyKey ?? "");
        return { id: randomUUID() };
      },
    });
    await service.reconcileTaskWatchdogs({ companyId: company.id });
    const [current] = await db
      .select()
      .from(issueWatchdogs)
      .where(eq(issueWatchdogs.id, watchdog.id));
    const reviewId = current.watchdogIssueId!;
    expect(reviewId).toBeTruthy();
    await db
      .update(issues)
      .set({ status: "blocked" })
      .where(eq(issues.id, reviewId));
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: worker.id,
        issueId: source.id,
        status: "running",
        runtimeMode: "legacy",
        startedAt: new Date(),
        processPid: process.pid,
        sessionIdBefore: randomUUID(),
        contextSnapshot: { issueId: source.id },
      })
      .returning();
    await db
      .update(issues)
      .set({ executionRunId: run.id })
      .where(eq(issues.id, source.id));
    return {
      company,
      worker,
      watcher,
      source,
      watchdog,
      reviewId,
      run,
      service,
      wakes,
    };
  }
  it("settles an obsolete blocked control once after verified provider progress and rearms a later stop", async () => {
    const f = await fixture();
    await Promise.all([
      f.service.reconcileTaskWatchdogs({ companyId: f.company.id }),
      f.service.reconcileTaskWatchdogs({ companyId: f.company.id }),
    ]);
    expect(await one(f.reviewId)).toMatchObject({ status: "done" });
    const receipts = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, f.company.id),
          eq(activityLog.action, "issue.task_watchdog_auto_settled"),
        ),
      );
    expect(receipts).toHaveLength(1);
    expect(receipts[0].details).toMatchObject({ businessAcceptance: false });
    const [settled] = await db
      .select()
      .from(issueWatchdogs)
      .where(eq(issueWatchdogs.id, f.watchdog.id));
    expect(settled.lastReviewedFingerprint).toBeNull();
    await db
      .update(heartbeatRuns)
      .set({ status: "failed", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, f.run.id));
    await db
      .update(issues)
      .set({ executionRunId: null })
      .where(eq(issues.id, f.source.id));
    await f.service.reconcileTaskWatchdogs({ companyId: f.company.id });
    expect(await one(f.reviewId)).toMatchObject({ status: "todo" });
    expect(f.wakes).toHaveLength(2);
    expect(f.wakes[1]).not.toBe(f.wakes[0]);
    await f.service.reconcileTaskWatchdogs({ companyId: f.company.id });
    expect(f.wakes).toHaveLength(2);
  });
  it("keeps a terminal business subtree settled without accepting business work", async () => {
    const f = await fixture();
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, f.run.id));
    await db
      .update(issues)
      .set({ status: "done", executionRunId: null })
      .where(eq(issues.id, f.source.id));
    await f.service.reconcileTaskWatchdogs({ companyId: f.company.id });
    await f.service.reconcileTaskWatchdogs({ companyId: f.company.id });
    expect(await one(f.reviewId)).toMatchObject({ status: "done" });
    expect(f.wakes).toHaveLength(1);
    expect((await one(f.reviewId)).completedAt).toBeInstanceOf(Date);
    await db
      .update(issueWatchdogs)
      .set({ status: "disabled" })
      .where(ne(issueWatchdogs.id, f.watchdog.id));
    const owner = () => ({ revision: "stable", reconciled: true });
    expect(
      (await f.service.readIdleSchedule(db, Date.now(), owner)).blocked,
    ).toBe(false);
    await db
      .insert(issueThreadInteractions)
      .values({
        companyId: f.company.id,
        issueId: f.reviewId,
        kind: "question",
        status: "pending",
        title: "New human wait",
        payload: {},
      });
    expect(
      (await f.service.readIdleSchedule(db, Date.now(), owner)).blocked,
    ).toBe(true);
  });
  it("leaves a wide subtree for its existing review instead of locking unbounded work", async () => {
    const f = await fixture();
    await db.insert(issues).values(
      Array.from({ length: 100 }, (_, index) => ({
        companyId: f.company.id,
        parentId: f.source.id,
        title: "Completed child " + index,
        status: "done" as const,
        createdAt: new Date(Date.now() - 3600000),
      })),
    );
    await f.service.reconcileTaskWatchdogs({ companyId: f.company.id });
    expect((await one(f.reviewId)).status).toBe("blocked");
  });
  it("accepts a started native provider as progress", async () => {
    const f = await fixture();
    await db
      .update(heartbeatRuns)
      .set({
        runtimeMode: "native",
        nativeSessionId: randomUUID(),
        executionStage: "executing",
        processPid: null,
      })
      .where(eq(heartbeatRuns.id, f.run.id));
    await f.service.reconcileTaskWatchdogs({ companyId: f.company.id });
    expect((await one(f.reviewId)).status).toBe("done");
  });
  it("keeps a human-completed review as a reviewed disposition", async () => {
    const f = await fixture();
    await db
      .update(issues)
      .set({ status: "done" })
      .where(eq(issues.id, f.reviewId));
    await f.service.reconcileTaskWatchdogs({ companyId: f.company.id });
    const [watchdog] = await db
      .select()
      .from(issueWatchdogs)
      .where(eq(issueWatchdogs.id, f.watchdog.id));
    expect(watchdog.lastReviewedFingerprint).toBeTruthy();
    expect(
      await db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, f.company.id),
            eq(activityLog.action, "issue.task_watchdog_auto_settled"),
          ),
        ),
    ).toHaveLength(0);
  });
  it.each([
    "approval",
    "stop_requested",
    "business_question",
    "watchdog_question",
    "paused",
    "queued_only",
    "watchdog_running",
    "user_stop",
  ])("preserves %s", async (mode) => {
    const f = await fixture();
    if (mode === "approval") {
      const [approval] = await db
        .insert(approvals)
        .values({ companyId: f.company.id, type: "budget", payload: {} })
        .returning();
      await db.insert(issueApprovals).values({
        companyId: f.company.id,
        issueId: f.reviewId,
        approvalId: approval.id,
      });
    }
    if (mode === "stop_requested")
      await db
        .update(heartbeatRuns)
        .set({
          resultJson: { cancellation: { source: "operator", expected: true } },
        })
        .where(eq(heartbeatRuns.id, f.run.id));
    if (mode.endsWith("question"))
      await db.insert(issueThreadInteractions).values({
        companyId: f.company.id,
        issueId: mode === "business_question" ? f.source.id : f.reviewId,
        kind: "question",
        status: "pending",
        title: "Need a decision",
        payload: {},
      });
    if (mode === "paused")
      await db
        .update(agents)
        .set({ status: "paused" })
        .where(eq(agents.id, f.worker.id));
    if (mode === "queued_only")
      await db
        .update(heartbeatRuns)
        .set({ status: "queued", startedAt: null })
        .where(eq(heartbeatRuns.id, f.run.id));
    if (mode === "watchdog_running")
      await db.insert(heartbeatRuns).values({
        companyId: f.company.id,
        agentId: f.watcher.id,
        issueId: f.reviewId,
        status: "running",
        contextSnapshot: { issueId: f.reviewId },
      });
    if (mode === "user_stop")
      await db
        .update(heartbeatRuns)
        .set({
          status: "cancelled",
          finishedAt: new Date(),
          resultJson: { cancellation: { source: "operator" } },
        })
        .where(eq(heartbeatRuns.id, f.run.id));
    await f.service.reconcileTaskWatchdogs({ companyId: f.company.id });
    expect((await one(f.reviewId)).status).toBe("blocked");
  });
});
