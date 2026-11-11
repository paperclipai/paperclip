import { describe, expect, it } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { CODEX_PLANNING_READ_ONLY_SUITE, gradePlanningWriteRefusal, planningWriteProbeFile } from "./codex-planning-read-only.js";

const nonce = "n1";
const command = (status: string, exitCode: number | null, nested = false) => {
  const payload = { schema: "paperclip.tool.execution.v1", name: `/bin/bash -lc 'printf probe > ${planningWriteProbeFile(nonce)}'`, status, exitCode };
  return { eventType: "tool.execution.completed", payload: nested ? { prpEvent: { payload } } : payload };
};

describe("Codex planning read-only grading", () => {
  it("passes only when the planning write attempt was refused", () => {
    expect(gradePlanningWriteRefusal([command("failed", 1)], nonce)).toMatchObject({ passed: true });
    expect(gradePlanningWriteRefusal([command("declined", null, true)], nonce)).toMatchObject({ passed: true });
    expect(gradePlanningWriteRefusal([command("failed", 1), command("completed", 0)], nonce))
      .toMatchObject({ passed: false, failure: expect.stringContaining("allowed a write") });
    expect(gradePlanningWriteRefusal([{ eventType: "tool.execution.completed", payload: { name: "ls" } }], nonce))
      .toMatchObject({ passed: false, failure: expect.stringContaining("No completed shell attempt") });
  });

  it("runs only as explicit native Codex planning cells", () => {
    const cells = runnerMatrix.filter(entry => entry.suite.id === CODEX_PLANNING_READ_ONLY_SUITE);
    expect(cells.map(cell => cell.id).sort()).toEqual([
      "codex-planning-read-only.runner-codex.daytona.plan-write-refused",
      "codex-planning-read-only.runner-codex.local.plan-write-refused",
    ]);
    for (const cell of cells) {
      expect(cell.suite.manualOnly).toBe(true);
      expect(cell.task.workMode).toBe("planning");
      expect(cell.task.flow).toBe("plan_approval_completion");
    }
  });
});
