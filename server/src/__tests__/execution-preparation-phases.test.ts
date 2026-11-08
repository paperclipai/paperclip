import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createRunPreparationTiming, drainRunPreparationPhases, measureRunPhase, withRunExecutionTiming } from "../services/execution-preparation-timing.js";

describe("run preparation phases for the run log", () => {
  it("records slow named phases per run, marks failures, and forgets them once drained", async () => {
    const runId = randomUUID();
    const time = createRunPreparationTiming(runId);
    await time("workspace_provision", () => delay(70));
    await time("workspace_binding", async () => undefined);
    await expect(time("runner_binary", async () => { await delay(60); throw new Error("upload failed"); })).rejects.toThrow("upload failed");
    await Promise.resolve();
    const phases = drainRunPreparationPhases(runId);
    expect(phases.map(phase => [phase.name, phase.outcome])).toEqual([
      ["heartbeat.prepare.workspace_provision", "ok"],
      ["heartbeat.prepare.runner_binary", "failed"],
    ]);
    expect(phases[0]!.endedAtMs - phases[0]!.startedAtMs).toBeGreaterThanOrEqual(50);
    expect(drainRunPreparationPhases(runId)).toEqual([]);
  });

  it("records nested run phases inside a preparation phase without a tracer", async () => {
    const runId = randomUUID();
    await createRunPreparationTiming(runId)("runtime_selection", async () => {
      await measureRunPhase("runtime_selection.provider_discovery", () => delay(60));
      await measureRunPhase("runtime_selection.skill_assets", async () => undefined);
    });
    expect(drainRunPreparationPhases(runId).map(phase => phase.name)).toEqual([
      "runtime_selection.provider_discovery", "heartbeat.prepare.runtime_selection",
    ]);
  });

  it("never records an execution attempt, so a resumed run's prepare holds only its own preparation", async () => {
    const runId = randomUUID();
    await createRunPreparationTiming(runId)("workspace", () => delay(60));
    expect(drainRunPreparationPhases(runId)).toHaveLength(1);
    await withRunExecutionTiming(runId, async () => {
      await delay(60);
      await measureRunPhase("workspace_sync.transfer", () => delay(60));
    });
    expect(drainRunPreparationPhases(runId)).toEqual([]);
  });

  it("keeps runs apart", async () => {
    const [first, second] = [randomUUID(), randomUUID()];
    await createRunPreparationTiming(first)("instructions", () => delay(60));
    expect(drainRunPreparationPhases(second)).toEqual([]);
    expect(drainRunPreparationPhases(first)).toHaveLength(1);
  });
});
