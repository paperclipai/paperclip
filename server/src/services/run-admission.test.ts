import { describe, expect, it } from "vitest";
import {
  AGENT_RUN_CORE_BUDGET_RATIO,
  GLOBAL_RUN_CEILING_MAX,
  GLOBAL_RUN_CEILING_MIN,
  HOST_LOAD_REFUSAL_RATIO,
  MEASURED_LOAD_PER_AGENT_RUN,
  clampAgentCapToGlobalCeiling,
  evaluateRunAdmission,
  isHostOverloaded,
  readHostLoadSnapshot,
  resolveGlobalRunCeiling,
  type HostLoadSnapshot,
} from "./run-admission.js";

/** The measured reference host from the RBR-974 report. */
const REFERENCE_CORES = 12;
const IDLE: HostLoadSnapshot = { cpuCount: REFERENCE_CORES, loadAverage1m: 2 };
/** The measured saturation state: load 45.98 on 12 cores. */
const SATURATED: HostLoadSnapshot = { cpuCount: REFERENCE_CORES, loadAverage1m: 45.98 };

describe("resolveGlobalRunCeiling (AC5: chosen ceiling and reasoning)", () => {
  it("derives 5 on the 12-core reference host from measured per-run load", () => {
    // floor(12 * 0.75 / 1.55) = floor(5.80) = 5
    expect(resolveGlobalRunCeiling(REFERENCE_CORES)).toBe(5);
  });

  it("is derived from core count, not hard-coded", () => {
    const expected = (cores: number) =>
      Math.max(
        GLOBAL_RUN_CEILING_MIN,
        Math.min(
          GLOBAL_RUN_CEILING_MAX,
          Math.floor((cores * AGENT_RUN_CORE_BUDGET_RATIO) / MEASURED_LOAD_PER_AGENT_RUN),
        ),
      );
    for (const cores of [1, 2, 4, 8, 12, 16, 32, 64, 128]) {
      expect(resolveGlobalRunCeiling(cores)).toBe(expected(cores));
    }
  });

  it("scales up with cores but stays clamped to a sane band", () => {
    expect(resolveGlobalRunCeiling(4)).toBeLessThan(resolveGlobalRunCeiling(12));
    expect(resolveGlobalRunCeiling(1)).toBe(GLOBAL_RUN_CEILING_MIN);
    expect(resolveGlobalRunCeiling(1024)).toBe(GLOBAL_RUN_CEILING_MAX);
  });

  it("never returns 0 — a ceiling of 0 would wedge the instance", () => {
    for (const cores of [1, 2, 3]) {
      expect(resolveGlobalRunCeiling(cores)).toBeGreaterThanOrEqual(1);
    }
  });

  it("reads a usable snapshot from the real host", () => {
    const snapshot = readHostLoadSnapshot();
    expect(snapshot.cpuCount).toBeGreaterThanOrEqual(1);
    expect(snapshot.loadAverage1m).toBeGreaterThanOrEqual(0);
    expect(resolveGlobalRunCeiling(snapshot.cpuCount)).toBeGreaterThanOrEqual(GLOBAL_RUN_CEILING_MIN);
  });
});

describe("AC1: concurrent runs instance-wide cannot exceed the global ceiling", () => {
  it("refuses to admit anything once the ceiling is reached", () => {
    const ceiling = resolveGlobalRunCeiling(REFERENCE_CORES);
    const decision = evaluateRunAdmission({
      agentCap: 5,
      runningForAgent: 0,
      runningGlobal: ceiling,
      load: IDLE,
    });
    expect(decision.availableSlots).toBe(0);
    expect(decision.deferralReason).toBe("global_ceiling");
  });

  it("admits only the remaining headroom, not the full per-agent cap", () => {
    const ceiling = resolveGlobalRunCeiling(REFERENCE_CORES);
    // 4 of 5 slots taken instance-wide; this agent's own cap would allow 5.
    const decision = evaluateRunAdmission({
      agentCap: 5,
      runningForAgent: 0,
      runningGlobal: ceiling - 1,
      load: IDLE,
    });
    expect(decision.availableSlots).toBe(1);
    expect(decision.deferralReason).toBeNull();
  });

  it("never admits past the ceiling for any request size (excess is queued, not started)", () => {
    const ceiling = resolveGlobalRunCeiling(REFERENCE_CORES);
    for (let runningGlobal = 0; runningGlobal <= ceiling + 5; runningGlobal += 1) {
      const decision = evaluateRunAdmission({
        agentCap: 99, // an operator asking for far more than the host can take
        runningForAgent: 0,
        runningGlobal,
        load: IDLE,
      });
      // The invariant is "admission never pushes us above the ceiling". Note that
      // runningGlobal can legitimately start ABOVE the ceiling — runs already
      // in flight when the cap is lowered, or when this build is deployed onto a
      // host mid-flight. In that state the gate must admit exactly nothing rather
      // than compound the overshoot; it must never kill or drop what is running.
      if (runningGlobal >= ceiling) {
        expect(decision.availableSlots).toBe(0);
        expect(decision.deferralReason).toBe("global_ceiling");
      } else {
        expect(runningGlobal + decision.availableSlots).toBeLessThanOrEqual(ceiling);
        expect(decision.availableSlots).toBeGreaterThan(0);
      }
    }
  });

  it("drains an existing overshoot rather than compounding it", () => {
    // The measured state was 27 runs on a host whose ceiling is 5. Admission must
    // return 0 at every step until the overshoot has drained below the ceiling.
    const ceiling = resolveGlobalRunCeiling(REFERENCE_CORES);
    for (let runningGlobal = 27; runningGlobal > ceiling; runningGlobal -= 1) {
      const decision = evaluateRunAdmission({
        agentCap: 5,
        runningForAgent: 0,
        runningGlobal,
        load: IDLE,
      });
      expect(decision.availableSlots).toBe(0);
    }
    // Once it drains to ceiling-1, dispatch resumes.
    const resumed = evaluateRunAdmission({
      agentCap: 5,
      runningForAgent: 0,
      runningGlobal: ceiling - 1,
      load: IDLE,
    });
    expect(resumed.availableSlots).toBe(1);
  });

  it("holds the ceiling when 10 agents each demand their full cap simultaneously", () => {
    // This is the measured failure: 27 runs started because per-agent caps summed.
    const ceiling = resolveGlobalRunCeiling(REFERENCE_CORES);
    let runningGlobal = 0;
    let started = 0;
    const deferred: string[] = [];

    for (let agent = 0; agent < 10; agent += 1) {
      const decision = evaluateRunAdmission({
        agentCap: 5, // the CEO's configured per-agent cap
        runningForAgent: 0,
        runningGlobal,
        load: IDLE,
      });
      if (decision.availableSlots === 0) {
        deferred.push(`agent-${agent}:${decision.deferralReason}`);
        continue;
      }
      // Each agent starts as many as it is admitted for.
      runningGlobal += decision.availableSlots;
      started += decision.availableSlots;
    }

    expect(started).toBe(ceiling);
    expect(runningGlobal).toBe(ceiling);
    // Naive summing would have produced 10 * 5 = 50.
    expect(started).toBeLessThan(10 * 5);
    // The excess agents were deferred, not dropped and not started.
    expect(deferred.length).toBeGreaterThan(0);
    expect(deferred.every((entry) => entry.endsWith("global_ceiling"))).toBe(true);
  });
});

describe("AC2: per-agent caps cannot sum past the global cap", () => {
  it("clamps an oversized per-agent cap down to the ceiling", () => {
    expect(clampAgentCapToGlobalCeiling(50, 5)).toBe(5);
    expect(clampAgentCapToGlobalCeiling(5, 5)).toBe(5);
  });

  it("leaves a smaller per-agent cap intact as a genuine sub-cap", () => {
    expect(clampAgentCapToGlobalCeiling(3, 5)).toBe(3);
    expect(clampAgentCapToGlobalCeiling(1, 5)).toBe(1);
  });

  it("reports the clamped cap as the effective cap in the decision", () => {
    const decision = evaluateRunAdmission({
      agentCap: 20, // AGENT_DEFAULT_MAX_CONCURRENT_RUNS
      runningForAgent: 0,
      runningGlobal: 0,
      load: IDLE,
    });
    expect(decision.globalCeiling).toBe(5);
    expect(decision.effectiveAgentCap).toBe(5);
    expect(decision.availableSlots).toBe(5);
  });

  it("still enforces a per-agent sub-cap below the ceiling", () => {
    const decision = evaluateRunAdmission({
      agentCap: 3, // the adapter-config cap
      runningForAgent: 3,
      runningGlobal: 3,
      load: IDLE,
    });
    expect(decision.availableSlots).toBe(0);
    expect(decision.deferralReason).toBe("agent_cap");
  });

  it("no single agent can occupy more than the ceiling however it is configured", () => {
    for (const agentCap of [1, 3, 5, 20, 50, Number.POSITIVE_INFINITY]) {
      const decision = evaluateRunAdmission({
        agentCap,
        runningForAgent: 0,
        runningGlobal: 0,
        load: IDLE,
      });
      expect(decision.availableSlots).toBeLessThanOrEqual(decision.globalCeiling);
    }
  });
});

describe("AC3: saturation defers the wake instead of starting a doomed run", () => {
  it("refuses to dispatch at the measured saturation point (load 45.98 on 12 cores)", () => {
    const decision = evaluateRunAdmission({
      agentCap: 5,
      runningForAgent: 0,
      runningGlobal: 1, // our runs are live, so we own the load
      load: SATURATED,
    });
    expect(decision.availableSlots).toBe(0);
    expect(decision.deferralReason).toBe("host_load");
    expect(decision.detail).toContain("45.98");
    expect(decision.detail).toContain("12 cores");
  });

  it("refuses even with free slots, because load is not slot-visible", () => {
    // The 69.6% CPU unscoped `rg` and four stray vitest suites are load we did not
    // start; slot accounting cannot see them.
    const decision = evaluateRunAdmission({
      agentCap: 5,
      runningForAgent: 0,
      runningGlobal: 1, // 1 of 5 slots used — slot math says "yes", load says "no"
      load: { cpuCount: 12, loadAverage1m: 40.46 },
    });
    expect(decision.deferralReason).toBe("host_load");
    expect(decision.availableSlots).toBe(0);
  });

  it("load refusal takes precedence over slot availability", () => {
    const decision = evaluateRunAdmission({
      agentCap: 5,
      runningForAgent: 0,
      runningGlobal: 99, // both would defer; load must be the reported cause
      load: SATURATED,
    });
    expect(decision.deferralReason).toBe("host_load");
  });

  it("admits again once load recovers — deferral is backpressure, not a latch", () => {
    // The self-confirming datapoint: same query, same code, load fell 46 -> 22.
    const recovered = evaluateRunAdmission({
      agentCap: 5,
      runningForAgent: 0,
      runningGlobal: 0,
      load: { cpuCount: 12, loadAverage1m: 8 },
    });
    expect(recovered.availableSlots).toBeGreaterThan(0);
    expect(recovered.deferralReason).toBeNull();
  });

  it("draws the refusal threshold at 1.25x core count", () => {
    expect(isHostOverloaded({ cpuCount: 12, loadAverage1m: 14 })).toBe(false);
    expect(isHostOverloaded({ cpuCount: 12, loadAverage1m: 15 })).toBe(false);
    expect(isHostOverloaded({ cpuCount: 12, loadAverage1m: 16 })).toBe(true);
    expect(isHostOverloaded({ cpuCount: 12, loadAverage1m: REFERENCE_CORES * HOST_LOAD_REFUSAL_RATIO })).toBe(false);
  });

  it("tolerates a load average at or just below full utilisation", () => {
    // A busy-but-healthy host must not be starved of dispatch.
    expect(isHostOverloaded({ cpuCount: 12, loadAverage1m: 11.75 })).toBe(false);
  });

  it("handles a missing/garbage load reading without wedging dispatch", () => {
    const decision = evaluateRunAdmission({
      agentCap: 5,
      runningForAgent: 0,
      runningGlobal: 0,
      load: { cpuCount: 12, loadAverage1m: 0 },
    });
    expect(decision.availableSlots).toBeGreaterThan(0);
  });
});

describe("forward-progress escape valve: external load must not wedge the instance", () => {
  it("admits exactly one run when load is high but nothing of ours is running", () => {
    // Load we do not own (a human's build, another worktree's suite). If we
    // deferred on load alone, the company would stall permanently: nothing running
    // means nothing will ever finish to bring the load down.
    const decision = evaluateRunAdmission({
      agentCap: 5,
      runningForAgent: 0,
      runningGlobal: 0,
      load: SATURATED,
    });
    expect(decision.availableSlots).toBe(1);
    expect(decision.deferralReason).toBeNull();
    expect(decision.detail).toMatch(/load is external/);
  });

  it("closes the valve as soon as one run is live — it is a trickle, not a bypass", () => {
    const decision = evaluateRunAdmission({
      agentCap: 5,
      runningForAgent: 1,
      runningGlobal: 1,
      load: SATURATED,
    });
    expect(decision.availableSlots).toBe(0);
    expect(decision.deferralReason).toBe("host_load");
  });

  it("cannot be used to exceed the ceiling at any load", () => {
    for (const loadAverage1m of [0, 8, 15, 30, 45.98, 200]) {
      const decision = evaluateRunAdmission({
        agentCap: 99,
        runningForAgent: 0,
        runningGlobal: 0,
        load: { cpuCount: 12, loadAverage1m },
      });
      expect(decision.availableSlots).toBeLessThanOrEqual(decision.globalCeiling);
    }
  });

  it("respects a zero per-agent cap even under the valve", () => {
    const decision = evaluateRunAdmission({
      agentCap: 0,
      runningForAgent: 0,
      runningGlobal: 0,
      load: SATURATED,
    });
    expect(decision.availableSlots).toBe(0);
  });

  it("guarantees the instance can always drain a queue from a cold start", () => {
    // Simulate a permanently-loaded host: each admitted run completes, so
    // runningGlobal returns to 0 and the valve admits the next one. The queue
    // drains slowly but it does drain — no deadlock.
    let queued = 4;
    let iterations = 0;
    while (queued > 0 && iterations < 50) {
      iterations += 1;
      const decision = evaluateRunAdmission({
        agentCap: 5,
        runningForAgent: 0,
        runningGlobal: 0,
        load: SATURATED,
      });
      expect(decision.availableSlots).toBeGreaterThan(0);
      queued -= decision.availableSlots;
    }
    expect(queued).toBeLessThanOrEqual(0);
    expect(iterations).toBeLessThan(50);
  });
});

describe("regression: the measured 27-run failure cannot recur", () => {
  it("caps the exact observed scenario to the ceiling", () => {
    // 27 runs were live on a 12-core box. Replay the admission gate against that
    // state: nothing further may start, and the reason must be legible.
    const decision = evaluateRunAdmission({
      agentCap: 5,
      runningForAgent: 2,
      runningGlobal: 27,
      load: SATURATED,
    });
    expect(decision.availableSlots).toBe(0);
    expect(decision.globalCeiling).toBe(5);
    expect(decision.detail).toMatch(/deferring dispatch/);
  });

  it("every deferral carries a reason and an operator-readable detail", () => {
    const scenarios = [
      { agentCap: 5, runningForAgent: 0, runningGlobal: 5, load: IDLE },
      { agentCap: 3, runningForAgent: 3, runningGlobal: 3, load: IDLE },
      { agentCap: 5, runningForAgent: 1, runningGlobal: 1, load: SATURATED },
    ];
    for (const scenario of scenarios) {
      const decision = evaluateRunAdmission(scenario);
      expect(decision.availableSlots).toBe(0);
      expect(decision.deferralReason).not.toBeNull();
      expect(decision.detail.length).toBeGreaterThan(10);
    }
  });
});
