import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { coalesceHeartbeatRun } from "../services/coalesce-heartbeat-run.js";
import { issueService } from "../services/issues.js";
import { mergeCoalescedContextSnapshot } from "../services/heartbeat.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createAdmissionTransactionScope, createWakeAdmissionWriter } from "../modules/wake-queue/adapters/postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres.each(["heartbeat", "wake-queue"] as const)("%s coalesce after checkout", (path) => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-coalesce-checkout-");
    db = createDb(database.connectionString);
  }, 20_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Coalesce", issuePrefix: `C${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Timer", role: "engineer", status: "active" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", invocationSource: "timer", contextSnapshot: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Assigned task", status: "todo", assigneeAgentId: agentId });
    await issueService(db).checkout(issueId, agentId, ["todo"], runId);
    return { companyId, agentId, issueId, runId };
  }

  function coalesce(input: { companyId: string; agentId: string; runId: string }, merge: Parameters<typeof coalesceHeartbeatRun>[2]) {
    return db.transaction(async (tx) => {
      if (path === "heartbeat") return coalesceHeartbeatRun(tx, input, merge);
      return createWakeAdmissionWriter().coalesceIntoActiveExecutionRun(
        createAdmissionTransactionScope(input.companyId, tx as unknown as Db),
        {
          companyId: input.companyId, agentId: input.agentId,
          activeExecutionRunId: input.runId,
          mergeContextSnapshot: merge,
          source: "timer", triggerDetail: null, payload: null,
          requestedByActorType: "system", requestedByActorId: null, idempotencyKey: null,
        },
      );
    });
  }

  it.each([{}, { issueId: null, taskId: "" }, { issueId: "other", taskId: "other" }])(
    "keeps checkout identity after an out-of-order wake: %j", async (incoming) => {
      const input = await seed();
      const run = await coalesce(input,
        (current) => mergeCoalescedContextSnapshot(current.contextSnapshot, incoming));
      expect(run.contextSnapshot).toMatchObject({ issueId: input.issueId, taskId: input.issueId });
      const [issue] = await db.select().from(issues).where(eq(issues.id, input.issueId));
      expect(issue.checkoutRunId).toBe(run.id);
    },
  );

  it("reloads context after a concurrent row-lock holder commits", async () => {
    const input = await seed();
    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { acquired = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`select id from heartbeat_runs where id = ${input.runId} for update`);
      acquired();
      await gate;
      await tx.update(heartbeatRuns).set({ contextSnapshot: {
        issueId: input.issueId, taskId: input.issueId, checkoutMetadata: "committed while wake waited",
      } }).where(eq(heartbeatRuns.id, input.runId));
    });
    await locked;
    let mergedBeforeRelease = false;
    let released = false;
    const wake = coalesce(input, (current) => {
      mergedBeforeRelease = !released;
      return mergeCoalescedContextSnapshot(current.contextSnapshot, { issueId: null, taskId: null, wakeReason: "heartbeat_timer" });
    });
    let observedWait = false;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const waiting = await db.execute(sql`select pid from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`);
        if (waiting.length > 0) { observedWait = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      released = true;
      release();
      await holder;
    }
    const run = await wake;
    expect(observedWait).toBe(true);
    expect(mergedBeforeRelease).toBe(false);
    expect(run.contextSnapshot).toMatchObject({ issueId: input.issueId, taskId: input.issueId, checkoutMetadata: "committed while wake waited", wakeReason: "heartbeat_timer" });
  });
});
