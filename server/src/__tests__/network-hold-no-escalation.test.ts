import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { recoveryService } from "../services/recovery/service.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

const describePostgres = recoveryPostgresSupport.supported ? describe : describe.skip;
if (!recoveryPostgresSupport.supported)
  console.warn(`Skipping network-hold escalation tests: ${recoveryPostgresSupport.reason}`);

const HOUR = 60 * 60_000;
const RECHECK_MS = 30_000;

/**
 * The continuation lane must not park an issue whose retry was HELD.
 *
 * LAC-6885 added a gate that holds a bounded retry while the host cannot reach
 * the provider, so an outage stops costing one adapter spawn per scheduled
 * wake. A hold queues no successor, and this lane reads "no successor" as a
 * reason to escalate the issue to `blocked` -- which is the LAC-6342 harm the
 * gate exists to prevent, arriving one level up. The hold therefore reports a
 * recheck deadline (`outcome.retryAt`, handed to `onDeferredDeadline`), and
 * this lane must treat that as a live path rather than a dead end.
 *
 * These cases drive the real `reconcileStrandedAssignedIssues` against real
 * rows. Only `scheduleRecoveryRetry` is injected, standing in for the gate at
 * exactly its contract: return no successor, set `retryAt` on the outcome it
 * was handed. The gate's own half of that contract (that it returns `retryAt`
 * at all, consuming no attempt) is covered by `retries.network-hold.test.ts`.
 */
describePostgres("a held retry defers the continuation lane instead of parking the issue", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startRecoveryPostgres("network-hold-no-escalation-");
    db = createDb(temporary.connectionString);
  }, 240_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  /**
   * One company, one agent, one `in_progress` issue, and one failed run
   * carrying the measured outage signature. The error string is the literal
   * one from production, subtype and all: the CLI reports `subtype=success`
   * on an object whose `is_error` is true, and Paperclip concatenates it.
   */
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Network hold fixture", issuePrefix: `N${companyId.slice(0, 7)}`,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Builder", adapterType: "claude_local", status: "idle", adapterConfig: {},
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Held by a dead network", status: "in_progress", assigneeAgentId: agentId,
      issueNumber: 1, identifier: `N${companyId.slice(0, 7)}-1`,
      createdAt: new Date(Date.now() - 5 * HOUR), updatedAt: new Date(Date.now() - 3 * HOUR),
    });
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId, invocationSource: "on_demand", status: "failed",
      errorCode: "adapter_failed",
      error: "Claude run failed: subtype=success: API Error: Can't reach the API server "
        + "- check your internet or DNS (ENOTFOUND)",
      startedAt: new Date(Date.now() - 4 * HOUR), finishedAt: new Date(Date.now() - 3 * HOUR),
      livenessState: "needs_followup", contextSnapshot: { issueId, taskId: issueId },
      createdAt: new Date(Date.now() - 4 * HOUR),
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    }).returning();
    return { companyId, agentId, issueId, runId: run.id };
  }

  /**
   * @param held when set, `scheduleRecoveryRetry` behaves as the gate does on a
   *   hold: no successor, `retryAt` written to the caller's outcome.
   * @param exhausted additionally reports a spent budget, which a hold CAN do:
   *   the gate sits ahead of the attempt-count logic, while the caller
   *   re-derives exhaustion independently from the predecessor row.
   */
  function wiring(opts: { held: boolean; exhausted?: boolean }) {
    const deadlines: number[] = [];
    const scheduleRecoveryRetry = vi.fn(
      async (_runId: string, outcome?: { retryAt?: number; retryExhausted?: boolean }) => {
        if (opts.held && outcome) outcome.retryAt = Date.now() + RECHECK_MS;
        if (opts.exhausted && outcome) outcome.retryExhausted = true;
        return null;
      },
    );
    const recovery = recoveryService(db, {
      enqueueWakeup: vi.fn(async () => ({ id: randomUUID() }) as never),
      scheduleRecoveryRetry,
      // Puts the lane on its `preparationRetry` arm, the one the reviewer
      // flagged: it is independent of WHY no successor was queued, so without
      // the guard it escalates a held run on its own.
      ownsPreparationRetry: () => true,
    });
    return { recovery, deadlines, scheduleRecoveryRetry };
  }

  async function sweep(
    recovery: ReturnType<typeof recoveryService>,
    companyId: string,
    issueId: string,
    deadlines: number[],
  ) {
    return recovery.reconcileStrandedAssignedIssues({
      companyId, issueId, skipRelatedRecovery: true,
      onDeferredDeadline: (at: number) => { deadlines.push(at); },
    });
  }

  async function statusOf(issueId: string) {
    const [row] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    return row.status;
  }

  it("holds: the issue stays in_progress and the recheck deadline is reported", async () => {
    const f = await seed();
    const { recovery, deadlines } = wiring({ held: true });
    const before = Date.now();

    const result = await sweep(recovery, f.companyId, f.issueId, deadlines);

    // The whole point: no park. Before the guard this lane wrote `blocked`.
    expect(await statusOf(f.issueId)).toBe("in_progress");
    expect(result.escalated).toBe(0);
    // And the issue is coming back on its own. The suppressed retry run used to
    // be the clock; `scoped-deadline-work` drops any entry whose check reports
    // no deadline, so a hold that reported none would stall silently.
    expect(deadlines).toHaveLength(1);
    expect(deadlines[0]).toBeGreaterThanOrEqual(before + RECHECK_MS);
  });

  it("holds even when the predecessor's budget is also spent, deferring the park rather than losing it", async () => {
    const f = await seed();
    const { recovery, deadlines } = wiring({ held: true, exhausted: true });

    const result = await sweep(recovery, f.companyId, f.issueId, deadlines);

    expect(await statusOf(f.issueId)).toBe("in_progress");
    expect(result.escalated).toBe(0);
    expect(deadlines).toHaveLength(1);
  });

  it("control: the same lane with no hold still parks the issue, so the cases above are not passing vacuously", async () => {
    const f = await seed();
    const { recovery, deadlines } = wiring({ held: false, exhausted: true });

    const result = await sweep(recovery, f.companyId, f.issueId, deadlines);

    expect(result.escalated).toBe(1);
    expect(await statusOf(f.issueId)).toBe("blocked");
    expect(deadlines).toHaveLength(0);
  });
});
