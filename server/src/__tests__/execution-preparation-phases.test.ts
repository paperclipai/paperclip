import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createRunPreparationTiming, drainRunPreparationPhases } from "../services/execution-preparation-timing.js";

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

  it("keeps runs apart", async () => {
    const [first, second] = [randomUUID(), randomUUID()];
    await createRunPreparationTiming(first)("instructions", () => delay(60));
    expect(drainRunPreparationPhases(second)).toEqual([]);
    expect(drainRunPreparationPhases(first)).toHaveLength(1);
  });
});
