import { describe, expect, it } from "vitest";
import { withAgentStartLock, withGlobalAdmissionLock } from "./agent-start-lock.js";
import { evaluateRunAdmission, resolveGlobalRunCeiling } from "./run-admission.js";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe("withGlobalAdmissionLock", () => {
  it("serializes overlapping sections so they never interleave", async () => {
    const events: string[] = [];
    const section = (id: string) =>
      withGlobalAdmissionLock(async () => {
        events.push(`enter-${id}`);
        await tick(5);
        events.push(`exit-${id}`);
      });

    await Promise.all([section("a"), section("b"), section("c")]);

    // Every enter must be immediately followed by its own exit.
    for (let i = 0; i < events.length; i += 2) {
      const id = events[i].slice("enter-".length);
      expect(events[i]).toBe(`enter-${id}`);
      expect(events[i + 1]).toBe(`exit-${id}`);
    }
  });

  it("releases the lock when the guarded section throws", async () => {
    await expect(
      withGlobalAdmissionLock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // A rejected predecessor must not wedge the queue behind it.
    await expect(withGlobalAdmissionLock(async () => "recovered")).resolves.toBe("recovered");
  });

  it("does not deadlock when nested inside a per-agent start lock", async () => {
    // This is the production nesting order: agent lock outside, global inside.
    const result = await withAgentStartLock("agent-1", () =>
      withGlobalAdmissionLock(async () => "ok"),
    );
    expect(result).toBe("ok");
  });

  it("returns the guarded section's value", async () => {
    await expect(withGlobalAdmissionLock(async () => 42)).resolves.toBe(42);
  });
});

describe("AC1 under concurrency: the ceiling holds when agents dispatch simultaneously", () => {
  /**
   * Reproduces the cross-agent TOCTOU hole the global lock exists to close.
   *
   * withAgentStartLock only serializes a single agent, so each agent's dispatch
   * runs unserialized against the others. If the count-then-claim sequence is not
   * globally atomic, several agents each read the same free slot and each start a
   * run — which is how 27 runs ended up on a 12-core host.
   */
  const dispatchAllAgents = async (agentCount: number, useGlobalLock: boolean) => {
    const ceiling = resolveGlobalRunCeiling(12);
    let running = 0;
    let peak = 0;

    const dispatch = async (agentId: string) => {
      const claim = async () => {
        const admission = evaluateRunAdmission({
          agentCap: 5,
          runningForAgent: 0,
          runningGlobal: running,
          load: { cpuCount: 12, loadAverage1m: 2 },
        });
        if (admission.availableSlots <= 0) return;
        // Yield between the read and the write — the interleaving window that a
        // real DB round-trip opens up.
        await tick();
        running += 1;
        peak = Math.max(peak, running);
      };
      await withAgentStartLock(agentId, () => (useGlobalLock ? withGlobalAdmissionLock(claim) : claim()));
    };

    await Promise.all(
      Array.from({ length: agentCount }, (_, i) => dispatch(`agent-${i}`)),
    );
    return { peak, ceiling };
  };

  it("holds the ceiling with the global lock", async () => {
    const { peak, ceiling } = await dispatchAllAgents(10, true);
    expect(peak).toBeLessThanOrEqual(ceiling);
  });

  it("demonstrates the ceiling is breached without it (guards the fix)", async () => {
    // If this ever stops overshooting, the global lock has become redundant and
    // this whole mechanism should be revisited rather than silently kept.
    const { peak, ceiling } = await dispatchAllAgents(10, false);
    expect(peak).toBeGreaterThan(ceiling);
  });
});
