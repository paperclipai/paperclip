import { describe, expect, it } from "vitest";
import { buildAgentRunStartStatusPatch } from "../services/heartbeat.ts";

// CON-218: a `running` agent row carried a non-null `error_reason` describing a
// run that had already ended, so the two status fields contradicted each other.
// The explicit lifecycle transitions (pause/resume/clearError/terminate) and the
// run finalizer all reconcile the pair; the run *start* transition did not, and
// `error` is invokable, so an errored agent was flipped to `running` while
// keeping its previous run's failure text.
describe("agent status/errorReason reconciliation on run start (CON-218)", () => {
  it("clears errorReason so a started run never shows a previous run's cause", () => {
    const patch = buildAgentRunStartStatusPatch();

    expect(patch.status).toBe("running");
    // The invariant: `running` and a non-null errorReason is never written
    // together, so no reader sees a false alarm on a healthy agent.
    expect(patch.errorReason).toBeNull();
  });

  it("always writes both fields, so the pair cannot be left half-updated", () => {
    // Guards the exact shape the `.set()` call consumes: a future edit that
    // drops a key would silently reintroduce the stale-reason defect.
    expect(Object.keys(buildAgentRunStartStatusPatch()).sort()).toEqual([
      "errorReason",
      "status",
      "updatedAt",
    ]);
  });

  it("stamps updatedAt, so the run-start write is observable as a change", () => {
    const before = Date.now();
    const patch = buildAgentRunStartStatusPatch();

    expect(patch.updatedAt).toBeInstanceOf(Date);
    const delta = Math.abs(patch.updatedAt.getTime() - before);
    expect(delta).toBeLessThan(60_000);
  });
});
