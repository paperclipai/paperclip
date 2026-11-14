import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { assignedWorkSweep } from "../services/recovery/assigned-work-sweep.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

const describePostgres = recoveryPostgresSupport.supported ? describe : describe.skip;
if (!recoveryPostgresSupport.supported)
  console.warn(`Skipping assigned-work network hold tests: ${recoveryPostgresSupport.reason}`);

const HOUR = 60 * 60_000;
const RECHECK_MS = 30_000;

/** The literal production string, subtype and all: the CLI reports
 * `subtype=success` on an object whose `is_error` is true, and Paperclip
 * concatenates it. Every one of the 104 measured rows carries exactly this. */
const OUTAGE_ERROR =
  "Claude run failed: subtype=success: API Error: Can't reach the API server "
  + "- check your internet or DNS (ENOTFOUND)";

/**
 * The assigned-work sweep must not spawn a replacement into a dead network.
 *
 * This is the second half of the LAC-6885 hold, and without it the first half
 * does not stop the storm, it relocates it. The retry gate holds the bounded
 * retry, which removes the `scheduled_retry` run row. That row was this
 * sweep's `pending_intent`, and the only reason it left these tasks alone.
 * Once it is gone the task becomes a violation after SETTLING_GRACE_MS and the
 * repair path spawns a replacement through `enqueueWakeup` -- which never
 * passes the retry gate and spends no bounded attempt, so it is capped only by
 * CONTINUATION_CAP (6 per task per hour) rather than suppressed.
 *
 * The gate sits on the SHARED repair path, below every violation reason that
 * reaches it, so it is not specific to one lane. The fixture below lands on
 * `retry_offered` (the run is a system failure the projection offers a retry
 * for); `no_pending_path` is the other common arrival and takes the same
 * branch. The reason is asserted rather than assumed, so a fixture that
 * silently changes lanes is visible instead of passing quietly.
 *
 * Measured before writing this: in 7 days of real rows the sweep produced 0 of
 * the 104 unreachable-network runs. That is not evidence the lane is harmless,
 * it is evidence the lane was suppressed by the very run row the hold removes.
 *
 * These cases drive the real `checkIssue` against real rows. Only the DNS
 * syscall is faked, so the classifier, the adapter check and the run read are
 * all exercised for real.
 */
describePostgres("the assigned-work sweep holds its replacement while the provider is unreachable", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startRecoveryPostgres("network-hold-assigned-work-");
    db = createDb(temporary.connectionString);
  }, 240_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  /**
   * One `in_progress` task whose only run failed well past the 90s settling
   * grace, with no successor of any kind. That is exactly the state the hold
   * leaves behind, and `evaluateAssignedWork` reads it as a violation.
   */
  async function seed(opts: { adapterType?: string; error?: string } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Assigned work hold fixture", issuePrefix: `A${companyId.slice(0, 7)}`,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Builder", adapterType: opts.adapterType ?? "claude_local",
      status: "idle", adapterConfig: {},
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Held by a dead network", status: "in_progress",
      assigneeAgentId: agentId, issueNumber: 1, identifier: `A${companyId.slice(0, 7)}-1`,
      createdAt: new Date(Date.now() - 5 * HOUR), updatedAt: new Date(Date.now() - 3 * HOUR),
    });
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId, invocationSource: "on_demand", status: "failed",
      errorCode: "adapter_failed", error: opts.error ?? OUTAGE_ERROR,
      startedAt: new Date(Date.now() - 4 * HOUR), finishedAt: new Date(Date.now() - 3 * HOUR),
      livenessState: "needs_followup", contextSnapshot: { issueId, taskId: issueId },
      createdAt: new Date(Date.now() - 4 * HOUR),
    }).returning();
    return { companyId, agentId, issueId, runId: run.id };
  }

  function wiring(opts: { reachable: boolean }) {
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() }));
    const sweep = assignedWorkSweep(db, {
      enqueueWakeup: enqueueWakeup as never,
      isProviderHostReachable: async () => opts.reachable,
    });
    return { sweep, enqueueWakeup };
  }

  it("holds: no replacement is spawned, and the task is given a recheck deadline", async () => {
    const f = await seed();
    const { sweep, enqueueWakeup } = wiring({ reachable: false });
    const deadlines: number[] = [];
    const before = Date.now();

    const check = await sweep.checkIssue({
      companyId: f.companyId, issueId: f.issueId,
      onDeferredDeadline: (at: number) => { deadlines.push(at); },
    });

    // The violation is still real and still reported. Only the repair is held.
    expect(check?.verdict.kind).toBe("violation");
    // Pinned so a fixture drifting to another lane is loud, not silent.
    expect(check?.verdict.kind === "violation" && check.verdict.reason).toBe("retry_offered");
    expect(check?.outcome).toBe("deferred_provider_unreachable");
    // The whole point: no second adapter spawn into a network that is down.
    expect(enqueueWakeup).not.toHaveBeenCalled();
    // And it comes back on its own. `scoped-deadline-work` drops any entry
    // whose check reports no deadline, so a hold reporting none would stall
    // silently -- the same defect the LAC-8130 fix closed on the retry side.
    expect(deadlines).toHaveLength(1);
    expect(deadlines[0]).toBeGreaterThanOrEqual(before + RECHECK_MS);
  });

  it("control: with the network back, the same task is repaired normally", async () => {
    const f = await seed();
    const { sweep, enqueueWakeup } = wiring({ reachable: true });

    const check = await sweep.checkIssue({ companyId: f.companyId, issueId: f.issueId });

    expect(check?.outcome).not.toBe("deferred_provider_unreachable");
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("control: an unrelated failure is not held, even while the probe says the host is down", async () => {
    const f = await seed({ error: "Claude run failed: subtype=error_max_turns: Reached maximum number of turns (120)" });
    const { sweep, enqueueWakeup } = wiring({ reachable: false });

    const check = await sweep.checkIssue({ companyId: f.companyId, issueId: f.issueId });

    // The probe is never the sole evidence: a PRIOR run must already have
    // proved the host could not reach the provider. Without this, one bad
    // probe would hold every replacement in the fleet.
    expect(check?.outcome).not.toBe("deferred_provider_unreachable");
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("control: an adapter the default probe host does not speak for is not held", async () => {
    const f = await seed({ adapterType: "codex_local" });
    const { sweep, enqueueWakeup } = wiring({ reachable: false });

    const check = await sweep.checkIssue({ companyId: f.companyId, issueId: f.issueId });

    // `api.anthropic.com` says nothing about a run that never contacts it.
    expect(check?.outcome).not.toBe("deferred_provider_unreachable");
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  });
});
