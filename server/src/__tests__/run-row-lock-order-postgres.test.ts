import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { agentService } from "../services/agents.js";
import { companyService } from "../services/companies.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres run-row lock order tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Lock-order proof for the only foreign key between `issues` and
 * `heartbeat_runs`.
 *
 * `issues.checkout_run_id` and `issues.execution_run_id` both reference
 * `heartbeat_runs.id` `ON DELETE SET NULL`. So `delete from heartbeat_runs`
 * is never a single-table statement: Postgres must take a row lock on every
 * referencing `issues` row in order to null the column out. That makes the
 * delete path a `heartbeat_runs` -> `issues` locker.
 *
 * The run-lifecycle path takes the opposite order. `issuesSvc.checkout` calls
 * `clearExecutionRunIfTerminal` / `clearCheckoutRunIfTerminal`, which lock the
 * issue row `for update` first and only then lock the run row it points at
 * (`services/issues.ts`, the two `for update` pairs). Two orders, one cycle,
 * and the loser is whichever transaction Postgres picks.
 *
 * Both tests below pin the delete paths to the run-lifecycle order by holding
 * the issue row and proving the deletion waits for it instead of deadlocking
 * against it. The interleaving is deterministic: the deleting transaction is
 * only released once it is observably parked on a lock.
 */
describeEmbeddedPostgres("run row lock order (delete paths vs checkout)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-lock-order-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    // Clear the run references before dropping the run rows, so teardown takes
    // the same issues -> heartbeat_runs order the assertions are about.
    const cleanups = [
      () => db.update(issues).set({ checkoutRunId: null, executionRunId: null }),
      () => db.delete(heartbeatRuns),
      () => db.delete(issues),
      () => db.delete(agents),
      () => db.delete(companies),
    ];
    for (const cleanup of cleanups) await cleanup().catch(() => undefined);
  });

  afterAll(async () => {
    // End the postgres.js pool before stopping the embedded server, so a
    // batched write the driver scheduled cannot fire onto a dropped socket.
    await db.$client.end();
    await tempDb?.cleanup();
  });

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  /**
   * Resolves once some backend other than ours is parked waiting for a lock.
   * This is what makes the interleaving deterministic rather than timing-based:
   * the holding transaction only asks for its second lock after the deleting
   * transaction has demonstrably reached a lock wait.
   */
  async function waitUntilABackendWaitsOnLock() {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const waiting = await db
        .execute(
          sql`select count(*)::int as count from pg_stat_activity
              where wait_event_type = 'Lock'
                and datname = current_database()
                and pid <> pg_backend_pid()`,
        )
        .then((rows) => Number((rows as unknown as Array<{ count: number }>)[0]?.count ?? 0));
      if (waiting > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("no backend ever parked on a lock wait");
  }

  /**
   * `assignIssueToAgent: false` is the case that actually exercises the agent
   * delete path. `agentService.remove` already nulls `assignee_agent_id` /
   * `created_by_agent_id` before it deletes the runs, which incidentally locks
   * the issue rows assigned to that agent in the right order. An issue that
   * merely *references* one of the agent's runs is not covered by that update,
   * so it is the one the FK action reaches first.
   */
  async function seedRunHoldingIssue({ assignIssueToAgent = true } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Lock Order Company",
      issuePrefix: "LCK",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Lock Order Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "LCK-1",
      title: "Lock order issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: assignIssueToAgent ? agentId : null,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    // The FK edge that forces the delete path to touch `issues` at all.
    await db
      .update(issues)
      .set({ checkoutRunId: runId, executionRunId: runId })
      .where(sql`${issues.id} = ${issueId}`);

    return { companyId, agentId, issueId, runId };
  }

  /**
   * Holds the issue row, releases the deleter, then takes the run row — the
   * exact order `clearExecutionRunIfTerminal` takes. Resolves to the error the
   * run-lifecycle transaction saw, or null when it completed cleanly.
   */
  async function raceDeleteAgainstCheckoutOrder(
    issueId: string,
    runId: string,
    deleteUnderTest: () => Promise<unknown>,
  ): Promise<Error | null> {
    const issueHeld = deferred();
    const deleterParked = deferred();
    let lifecycleError: Error | null = null;

    const lifecycleTx = db
      .transaction(async (tx) => {
        await tx.execute(
          sql`select ${issues.id} from ${issues} where ${issues.id} = ${issueId} for update`,
        );
        issueHeld.resolve();
        await deleterParked.promise;
        await tx.execute(
          sql`select ${heartbeatRuns.id} from ${heartbeatRuns} where ${heartbeatRuns.id} = ${runId} for update`,
        );
      })
      .catch((error: Error) => {
        lifecycleError = error;
      });

    await issueHeld.promise;
    const deletion = deleteUnderTest();
    const deletionSettled = deletion.then(
      () => null,
      (error: Error) => error,
    );
    await waitUntilABackendWaitsOnLock();
    deleterParked.resolve();

    await lifecycleTx;
    const deletionError = await deletionSettled;
    // The deletion itself must also survive: a deadlock aborts one of the two,
    // and either victim is a failure of the ordering this test pins.
    if (deletionError) throw deletionError;
    return lifecycleError;
  }

  it("company removal waits for a held issue row instead of deadlocking against it", async () => {
    const { companyId, issueId, runId } = await seedRunHoldingIssue();

    const lifecycleError = await raceDeleteAgainstCheckoutOrder(issueId, runId, () =>
      companyService(db).remove(companyId),
    );

    expect(lifecycleError).toBeNull();
    const remaining = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.id} = ${runId}`);
    expect(remaining).toHaveLength(0);
  }, 30_000);

  it("agent removal waits for a held issue row instead of deadlocking against it", async () => {
    const { agentId, issueId, runId } = await seedRunHoldingIssue({
      assignIssueToAgent: false,
    });

    const lifecycleError = await raceDeleteAgainstCheckoutOrder(issueId, runId, () =>
      agentService(db).remove(agentId),
    );

    expect(lifecycleError).toBeNull();
    const remaining = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.id} = ${runId}`);
    expect(remaining).toHaveLength(0);
  }, 30_000);
});
