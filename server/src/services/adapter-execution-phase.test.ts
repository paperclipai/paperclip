import { expect, it } from "vitest";
import { createAdapterExecutionPhaseTracker, MAX_EXECUTION_PHASE_ELAPSED_MS } from "./adapter-execution-phase.js";

it("returns the latest pending scope and resumes the outer scope's original age", () => {
  let now = 10;
  const phases = createAdapterExecutionPhaseTracker(() => now);
  const outer = phases.enter("sync_back")!;
  now = 30;
  const inner = phases.enter("instruction_collection")!;
  now = 80;
  expect(phases.snapshot()).toEqual({ phase: "instruction_collection", phaseElapsedMs: 50 });
  inner();
  expect(phases.snapshot()).toEqual({ phase: "sync_back", phaseElapsedMs: 70 });
  outer();
  expect(phases.snapshot()).toBeNull();
});

it("late and repeated releases never clear a newer scope or revive a completed scope", () => {
  const phases = createAdapterExecutionPhaseTracker(() => 20);
  const first = phases.enter("end_session")!;
  const second = phases.enter("close_session")!;
  first();
  first();
  expect(phases.snapshot()?.phase).toBe("close_session");
  second();
  expect(phases.snapshot()).toBeNull();
});

it("isolates trackers and refuses late updates after the executor finishes", () => {
  const first = createAdapterExecutionPhaseTracker();
  const second = createAdapterExecutionPhaseTracker();
  first.enter("workspace_restore");
  second.enter("instruction_cleanup");
  first.finish();
  first.enter("lease_release");
  expect(first.snapshot()).toBeNull();
  expect(second.snapshot()?.phase).toBe("instruction_cleanup");
});

it("bounds retained scopes and fails closed on overflow or arbitrary labels", () => {
  const phases = createAdapterExecutionPhaseTracker();
  phases.enter("private fixture payload" as "sync_back");
  expect(phases.snapshot()).toBeNull();
  for (let i = 0; i < 100; i++) phases.enter("sync_back");
  expect(phases.snapshot()).toBeNull();
  phases.finish();
  expect(phases.snapshot()).toBeNull();
});

it("uses a finite nonnegative capped elapsed time", () => {
  let now = 10;
  const phases = createAdapterExecutionPhaseTracker(() => now);
  phases.enter("close_session");
  now = Infinity;
  expect(phases.snapshot()).toBeNull();
  now = 9;
  expect(phases.snapshot()).toBeNull();
  now = MAX_EXECUTION_PHASE_ELAPSED_MS * 2;
  expect(phases.snapshot()).toEqual({ phase: "close_session", phaseElapsedMs: MAX_EXECUTION_PHASE_ELAPSED_MS });
});
