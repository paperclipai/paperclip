import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUOTA_RECOVERY_CAP_PER_AGENT,
  DEFAULT_QUOTA_RECOVERY_DECORRELATION_WINDOW_MS,
  DEFAULT_QUOTA_RECOVERY_DEFERRAL_STEP_MS,
  QUOTA_RECOVERY_RETRY_REASON,
  RELEASE_REASON_INFLIGHT_UNAVAILABLE,
  RELEASE_REASON_OUT_OF_SCOPE,
  RELEASE_REASON_OVER_CAP,
  RELEASE_REASON_RELEASED,
  decorrelateRetryAt,
  planDueQuotaRecoveryReleases,
  type DueQuotaRetry,
} from "./quota-recovery-release.js";

const NOW = new Date("2026-09-28T08:49:18.000Z");
const SEED = 20260928;

function due(overrides: Partial<DueQuotaRetry> & { runId: string }): DueQuotaRetry {
  return {
    agentId: "agent-1",
    scheduledRetryAt: new Date("2026-09-28T08:48:00.000Z"),
    scheduledRetryReason: QUOTA_RECOVERY_RETRY_REASON,
    ...overrides,
  };
}

/** The measured shape: one 429 wave parks one quota retry per affected issue,
 * and every one of them carries the same due time. */
function correlatedCohort(agentIds: string[], perAgent: number): DueQuotaRetry[] {
  const rows: DueQuotaRetry[] = [];
  for (const agentId of agentIds) {
    for (let i = 0; i < perAgent; i += 1) {
      rows.push(due({ runId: `run-${agentId}-${i}`, agentId }));
    }
  }
  return rows;
}

function noInflight(): ReadonlyMap<string, number> {
  return new Map();
}

// ---------------------------------------------------------------------------
// A1: no more than the cap leaves the queue for one agent in one sweep, and
// every row it did not release is pushed forward rather than dropped.
// ---------------------------------------------------------------------------
describe("A1 per-agent cap on released quota-recovery retries", () => {
  it("releases at most the cap for one agent and defers every other row", () => {
    const rows = correlatedCohort(["agent-1"], 10);
    const plan = planDueQuotaRecoveryReleases({
      due: rows,
      now: NOW,
      inflightByAgent: noInflight(),
      seed: SEED,
    });

    expect(plan.released).toHaveLength(DEFAULT_QUOTA_RECOVERY_CAP_PER_AGENT);
    expect(plan.deferred).toHaveLength(10 - DEFAULT_QUOTA_RECOVERY_CAP_PER_AGENT);
    // Every candidate is accounted for. Nothing is silently dropped.
    expect(plan.released.length + plan.deferred.length).toBe(rows.length);
    for (const decision of plan.deferred) {
      expect(decision.reason).toBe(RELEASE_REASON_OVER_CAP);
      expect(decision.outOfScope).toBe(false);
    }
  });

  it("defers nothing to the past and keeps the cohort's relative order", () => {
    const plan = planDueQuotaRecoveryReleases({
      due: correlatedCohort(["agent-1"], 5),
      now: NOW,
      inflightByAgent: noInflight(),
      seed: SEED,
    });
    const times = plan.deferred.map((d) => d.releaseAt!.getTime());
    for (const time of times) {
      expect(time).toBeGreaterThan(NOW.getTime());
    }
    // Staggered by one deferral step each, so the queue drains in order rather
    // than all nine rows coming due together a minute from now.
    expect(new Set(times).size).toBe(times.length);
    expect(times[0]! - NOW.getTime()).toBe(DEFAULT_QUOTA_RECOVERY_DEFERRAL_STEP_MS);
  });

  it("counts retries already released and not yet finished against the cap", () => {
    const rows = correlatedCohort(["agent-1"], 3);
    const withOneInflight = planDueQuotaRecoveryReleases({
      due: rows,
      now: NOW,
      inflightByAgent: new Map([["agent-1", 1]]),
      seed: SEED,
    });
    expect(withOneInflight.released).toHaveLength(0);
    expect(withOneInflight.deferred).toHaveLength(3);
    expect(withOneInflight.degraded).toBe(false);

    // The cap is per agent, not company-wide: a second agent still gets its slot.
    const twoAgents = planDueQuotaRecoveryReleases({
      due: [...correlatedCohort(["agent-1"], 3), ...correlatedCohort(["agent-2"], 3)],
      now: NOW,
      inflightByAgent: new Map([["agent-1", 1]]),
      seed: SEED,
    });
    expect(twoAgents.released).toHaveLength(1);
    expect(twoAgents.released[0]!.agentId).toBe("agent-2");
  });

  it("rejects a cap below one instead of denying every retry forever", () => {
    expect(() =>
      planDueQuotaRecoveryReleases({
        due: [],
        now: NOW,
        inflightByAgent: noInflight(),
        seed: SEED,
        capPerAgent: 0,
      }),
    ).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// A2: the cohort does not come due together. The correlation is created at
// enqueue, so this is the half that has to break it -- the cap cannot.
// ---------------------------------------------------------------------------
describe("A2 correlated due times are the cause and are broken at enqueue", () => {
  it("the control: a cap cannot separate rows that share a due time", () => {
    // This is the discriminating observation. A release-side cap bounds how
    // many rows leave the queue; it does nothing to rows that all become due
    // at the same instant. Ten rows due together, capped at one per agent, are
    // still ten rows that all became due together.
    const flatBackoff = correlatedCohort(["agent-1"], 3);
    expect(new Set(flatBackoff.map((r) => r.scheduledRetryAt.getTime())).size).toBe(1);

    const plan = planDueQuotaRecoveryReleases({
      due: flatBackoff,
      now: NOW,
      inflightByAgent: noInflight(),
      seed: SEED,
    });
    // The cap bounds how many leave the queue. It does not touch the fact that
    // all three rows became due at one instant, which is what the enqueue-side
    // spread has to change.
    expect(plan.released).toHaveLength(1);
    const dueInstants = plan.deferred.map((d) => flatBackoff.find((r) => r.runId === d.runId)!.scheduledRetryAt);
    expect(new Set(dueInstants.map((t) => t.getTime())).size).toBe(1);
  });

  it("decorrelateRetryAt gives co-enqueued retries distinct, reproducible due times", () => {
    const baseBackoffMs = 60 * 60 * 1000;
    const cohortKeys = [
      "c1:issue-1",
      "c1:issue-2",
      "c1:issue-3",
      "c1:issue-4",
      "c1:issue-5",
      "c1:issue-6",
      "c1:issue-7",
      "c1:issue-8",
    ];
    const first = cohortKeys.map((cohortKey) =>
      decorrelateRetryAt({ now: NOW, baseBackoffMs, seed: SEED, cohortKey }).getTime(),
    );
    const second = cohortKeys.map((cohortKey) =>
      decorrelateRetryAt({ now: NOW, baseBackoffMs, seed: SEED, cohortKey }).getTime(),
    );

    // No two members of a cohort share a due instant.
    expect(new Set(first).size).toBe(first.length);
    // Reproducible: identical inputs produce an identical schedule.
    expect(second).toEqual(first);
    // Spread over the window, and never earlier than the base backoff.
    for (const time of first) {
      expect(time).toBeGreaterThanOrEqual(NOW.getTime() + baseBackoffMs);
      expect(time).toBeLessThan(
        NOW.getTime() + baseBackoffMs + DEFAULT_QUOTA_RECOVERY_DECORRELATION_WINDOW_MS + 1,
      );
    }
  });

  it("keeps the base backoff as a floor, so the spread can only delay a retry", () => {
    const floor = decorrelateRetryAt({
      now: NOW,
      baseBackoffMs: 60 * 60 * 1000,
      windowMs: 0,
      seed: SEED,
      cohortKey: "c1:issue-1",
    });
    expect(floor.getTime()).toBe(NOW.getTime() + 60 * 60 * 1000);
  });

  it("separates different agents of the same incident, not just different issues", () => {
    const baseBackoffMs = 60 * 60 * 1000;
    const times = ["a1", "a2", "a3", "a4"].map(
      (agentId) =>
        decorrelateRetryAt({ now: NOW, baseBackoffMs, seed: SEED, cohortKey: `c1:${agentId}` }).getTime(),
    );
    expect(new Set(times).size).toBe(times.length);
  });

  it("rejects a backoff shorter than the minimum rather than scheduling a retry before it existed", () => {
    expect(() =>
      decorrelateRetryAt({ now: NOW, baseBackoffMs: 500, seed: SEED, cohortKey: "c1:issue-1" }),
    ).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed: an unreadable in-flight input denies, and the denial is a
// result with a reason rather than an error path.
// ---------------------------------------------------------------------------
describe("fail closed when in-flight state is unavailable", () => {
  it("releases nothing when the in-flight count is null", () => {
    const plan = planDueQuotaRecoveryReleases({
      due: correlatedCohort(["agent-1"], 10),
      now: NOW,
      inflightByAgent: null,
      seed: SEED,
    });

    expect(plan.released).toHaveLength(0);
    expect(plan.degraded).toBe(true);
    expect(plan.deferred).toHaveLength(10);
    for (const decision of plan.deferred) {
      expect(decision.reason).toBe(RELEASE_REASON_INFLIGHT_UNAVAILABLE);
      // Nothing is rescheduled onto a fabricated due time; the row keeps its
      // own and a later sweep re-decides it.
      expect(decision.releaseAt).toBeNull();
    }
  });

  it("records the unavailable in-flight count as -1 rather than 0", () => {
    const plan = planDueQuotaRecoveryReleases({
      due: correlatedCohort(["agent-1"], 2),
      now: NOW,
      inflightByAgent: null,
      seed: SEED,
    });
    expect(plan.agents[0]!.inflight).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// A3: released and deferred are both visible, per agent, every sweep. Recorded
// as a shape assertion and explicitly labelled non-discriminating: the
// existence of a report cannot tell a fixed scheduler from a broken one.
// ---------------------------------------------------------------------------
describe("A3 observability", () => {
  it("reports every decision and a per-agent roll-up that reconciles", () => {
    const rows = [...correlatedCohort(["agent-1"], 4), ...correlatedCohort(["agent-2"], 2)];
    rows.push(due({ runId: "run-other-1", agentId: "agent-2", scheduledRetryReason: "process_loss" }));
    const plan = planDueQuotaRecoveryReleases({
      due: rows,
      now: NOW,
      inflightByAgent: new Map([["agent-2", 1]]),
      seed: SEED,
    });

    // One decision per candidate, each with a reason from the closed set.
    expect(plan.decisions).toHaveLength(rows.length);
    const closedSet = new Set([
      RELEASE_REASON_RELEASED,
      RELEASE_REASON_OVER_CAP,
      RELEASE_REASON_OUT_OF_SCOPE,
      RELEASE_REASON_INFLIGHT_UNAVAILABLE,
    ]);
    for (const decision of plan.decisions) {
      expect(closedSet.has(decision.reason)).toBe(true);
    }
    expect(plan.decisions.map((d) => d.reason)).toContain(RELEASE_REASON_RELEASED);
    expect(plan.decisions.map((d) => d.reason)).toContain(RELEASE_REASON_OUT_OF_SCOPE);

    // Per-agent released and deferred, and the roll-up reconciles with the
    // decisions, so a silent drop is visible rather than inferred.
    const totalByAgent = plan.agents.reduce((sum, a) => sum + a.released + a.deferred, 0);
    expect(totalByAgent).toBe(plan.decisions.length);
    expect(plan.agents.find((a) => a.agentId === "agent-1")!.due).toBe(4);
    // agent-2 already has one quota recovery in flight, so its two rows are
    // held and its process-loss row is only reported.
    expect(plan.agents.find((a) => a.agentId === "agent-2")!.inflight).toBe(1);
  });

  it("A3 is satisfied by the existence of the report, so it cannot fail on a broken planner", () => {
    const plan = planDueQuotaRecoveryReleases({
      due: correlatedCohort(["agent-1"], 3),
      now: NOW,
      inflightByAgent: noInflight(),
      seed: SEED,
      // A planner that released all three at once would still produce a
      // report. That is the reason A3 is documented as non-discriminating.
      capPerAgent: 3,
    });
    expect(plan.released).toHaveLength(3);
    expect(plan.decisions).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// A4: the cap must not eat another mechanism.
// ---------------------------------------------------------------------------
describe("A4 other retry mechanisms keep their existing path", () => {
  it("an out-of-scope row never consumes cap and is never given a new due time", () => {
    const rows: DueQuotaRetry[] = [
      due({ runId: "run-quota-1", agentId: "agent-1" }),
      due({ runId: "run-process-loss-1", agentId: "agent-1", scheduledRetryReason: "process_loss" }),
      due({ runId: "run-process-loss-2", agentId: "agent-1", scheduledRetryReason: "process_loss" }),
    ];
    const plan = planDueQuotaRecoveryReleases({
      due: rows,
      now: NOW,
      inflightByAgent: noInflight(),
      seed: SEED,
    });

    // The quota retry still gets the single cap slot...
    expect(plan.released.map((d) => d.runId)).toEqual(["run-quota-1"]);
    // ...and the two process-loss rows are visible but carry no new due time,
    // so the caller's own path releases them exactly as it did before.
    for (const runId of ["run-process-loss-1", "run-process-loss-2"]) {
      const decision = plan.decision(runId)!;
      expect(decision.outOfScope).toBe(true);
      expect(decision.reason).toBe(RELEASE_REASON_OUT_OF_SCOPE);
      expect(decision.releaseAt).toBeNull();
    }
  });

  it("an out-of-scope row is still promoted when the plan is degraded", () => {
    const plan = planDueQuotaRecoveryReleases({
      due: [
        due({ runId: "run-quota-1", agentId: "agent-1" }),
        due({ runId: "run-process-loss-1", agentId: "agent-1", scheduledRetryReason: "process_loss" }),
      ],
      now: NOW,
      inflightByAgent: null,
      seed: SEED,
    });

    expect(plan.degraded).toBe(true);
    // The quota row is denied, the process-loss row is only reported: a reader
    // of this report can tell which is which without guessing.
    expect(plan.decision("run-quota-1")!.outOfScope).toBe(false);
    expect(plan.decision("run-quota-1")!.reason).toBe(RELEASE_REASON_INFLIGHT_UNAVAILABLE);
    expect(plan.decision("run-process-loss-1")!.outOfScope).toBe(true);
  });

  it("a null retry reason is treated as another mechanism's, not as quota recovery", () => {
    const plan = planDueQuotaRecoveryReleases({
      due: [due({ runId: "run-null-reason", scheduledRetryReason: null })],
      now: NOW,
      inflightByAgent: noInflight(),
      seed: SEED,
    });
    expect(plan.released).toHaveLength(0);
    expect(plan.decision("run-null-reason")!.outOfScope).toBe(true);
  });

  it("scopes the cap by agent even when a different agent only has out-of-scope rows", () => {
    const plan = planDueQuotaRecoveryReleases({
      due: [
        due({ runId: "run-q-1", agentId: "agent-1" }),
        due({ runId: "run-pl-1", agentId: "agent-2", scheduledRetryReason: "process_loss" }),
      ],
      now: NOW,
      inflightByAgent: new Map([["agent-2", 0]]),
      seed: SEED,
    });
    expect(plan.released.map((d) => d.runId)).toEqual(["run-q-1"]);
    expect(plan.decision("run-pl-1")!.outOfScope).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reproducibility and non-regression of the planner itself.
// ---------------------------------------------------------------------------
describe("reproducibility", () => {
  it("produces identical plans for identical inputs", () => {
    const rows = correlatedCohort(["agent-1", "agent-2"], 4);
    const args = {
      due: rows,
      now: NOW,
      inflightByAgent: new Map([["agent-1", 0]]),
      seed: SEED,
    };
    const first = planDueQuotaRecoveryReleases(args);
    const second = planDueQuotaRecoveryReleases(args);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("preserves the caller's order rather than re-sorting, so the first row read is the first row decided", () => {
    const rows = [
      due({ runId: "run-late", agentId: "agent-1", scheduledRetryAt: new Date("2026-09-28T09:00:00.000Z") }),
      due({ runId: "run-early", agentId: "agent-1", scheduledRetryAt: new Date("2026-09-28T08:00:00.000Z") }),
    ];
    const plan = planDueQuotaRecoveryReleases({
      due: rows,
      now: NOW,
      inflightByAgent: noInflight(),
      seed: SEED,
    });

    expect(plan.decisions.map((d) => d.runId)).toEqual(["run-late", "run-early"]);
    expect(plan.released[0]!.runId).toBe("run-late");
  });

  it("is a no-op for a single due retry below the cap", () => {
    const plan = planDueQuotaRecoveryReleases({
      due: [due({ runId: "run-1" })],
      now: NOW,
      inflightByAgent: noInflight(),
      seed: SEED,
    });
    expect(plan.released).toHaveLength(1);
    expect(plan.released[0]!.reason).toBe(RELEASE_REASON_RELEASED);
    expect(plan.released[0]!.releaseAt).toEqual(NOW);
    expect(plan.deferred).toHaveLength(0);
  });
});
