import { randomUUID } from "node:crypto";
import { activityLog, agents, agentWakeupRequests, companies, createDb, issues } from "@paperclipai/db";
import type { LiveEvent } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { publishActivity, type ActivityPublication } from "./activity-log.js";
import { writeDeferredExecutionWait } from "./deferred-execution-wait.js";
import { subscribeCompanyLiveEvents } from "./live-events.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("deferred execution wait live refresh", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("deferred-execution-wait-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  /** A person's Retry, saved as a deferred request that admission has not started. */
  async function deferredRetry() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Wait fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Morgan", adapterType: "process", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Website task", status: "blocked", assigneeAgentId: agentId });
    const [request] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "on_demand",
      reason: "task_retry", status: "deferred_issue_execution", payload: { issueId } }).returning();
    return { companyId, agentId, issueId, requestId: request!.id };
  }

  function listen(companyId: string) {
    const events: LiveEvent[] = [];
    const stop = subscribeCompanyLiveEvents(companyId, event => events.push(event));
    const waiting = () => events.filter(event => event.type === "activity.logged" && event.payload.action === "issue.execution_waiting");
    return { waiting, stop };
  }

  const budget = { reason: "budget.blocked", message: "Retry is waiting for the budget to allow new work." };

  it("refreshes an open task page once when admission records why a Retry waits", async () => {
    const f = await deferredRetry(), live = listen(f.companyId);
    try {
      expect(await writeDeferredExecutionWait(db, { companyId: f.companyId, requestId: f.requestId }, budget)).toBe(true);
      expect(live.waiting()).toHaveLength(1);
      expect(live.waiting()[0]!.payload).toMatchObject({ entityType: "issue", entityId: f.issueId, issueId: f.issueId,
        actorType: "system", agentId: f.agentId, details: { requestId: f.requestId, reason: "budget.blocked" } });
      // The same reason again changes nothing a reader can see: no repeated refresh.
      await writeDeferredExecutionWait(db, { companyId: f.companyId, requestId: f.requestId }, budget);
      expect(live.waiting()).toHaveLength(1);
      // A different gate does refresh the page.
      await writeDeferredExecutionWait(db, { companyId: f.companyId, requestId: f.requestId },
        { reason: "issue_tree_hold_active", message: "This task is paused." }, { replace: true });
      expect(live.waiting()).toHaveLength(2);
      const rows = await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId),
        eq(activityLog.action, "issue.execution_waiting")));
      expect(rows.map(row => (row.details as { reason: string }).reason)).toEqual(["budget.blocked", "issue_tree_hold_active"]);
    } finally { live.stop(); }
  });

  it("publishes only after the caller's transaction commits when it passes its publication list", async () => {
    const f = await deferredRetry(), live = listen(f.companyId), publications: ActivityPublication[] = [];
    try {
      await db.transaction(async tx => {
        await writeDeferredExecutionWait(tx as unknown as typeof db, { companyId: f.companyId, requestId: f.requestId }, budget, { publications });
        expect(live.waiting()).toHaveLength(0);
      });
      expect(publications).toHaveLength(1);
      for (const publication of publications) publishActivity(publication);
      expect(live.waiting()).toHaveLength(1);
    } finally { live.stop(); }
  });

  it("records nothing for a request that is no longer deferred", async () => {
    const f = await deferredRetry(), live = listen(f.companyId);
    try {
      await db.update(agentWakeupRequests).set({ status: "completed" }).where(eq(agentWakeupRequests.id, f.requestId));
      expect(await writeDeferredExecutionWait(db, { companyId: f.companyId, requestId: f.requestId }, budget)).toBe(false);
      expect(live.waiting()).toHaveLength(0);
    } finally { live.stop(); }
  });
});
