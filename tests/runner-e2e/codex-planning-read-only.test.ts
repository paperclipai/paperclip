import { describe, expect, it } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { CODEX_PLANNING_READ_ONLY_SUITE, gradePlanningWriteRefusal, planningWriteProbeFile } from "./codex-planning-read-only.js";

const nonce = "n1";
const probe = planningWriteProbeFile(nonce);
const denied = "/bin/bash: line 1: plan-write-probe-n1.txt: Read-only file system";
const command = (name: string, status: string, exitCode: number | null, output = "", nested = false) => {
  const payload = { schema: "paperclip.tool.execution.v1", name, status, exitCode, output };
  return { eventType: "tool.execution.completed", payload: nested ? { prpEvent: { payload } } : payload };
};
const write = `/bin/bash -lc 'printf probe > ${probe} || echo WRITE_REFUSED'`;

describe("Codex planning read-only grading", () => {
  it("passes only when the requested write was refused by the sandbox", () => {
    expect(gradePlanningWriteRefusal([command(write, "failed", 1, denied)], nonce)).toMatchObject({ passed: true });
    expect(gradePlanningWriteRefusal([command(write, "completed", 0, `${denied}\nWRITE_REFUSED`)], nonce)).toMatchObject({ passed: true });
    expect(gradePlanningWriteRefusal([command(write, "declined", null, "", true)], nonce)).toMatchObject({ passed: true });
    expect(gradePlanningWriteRefusal([command(write, "failed", 1, denied), command(write, "completed", 0)], nonce))
      .toMatchObject({ passed: false, failure: expect.stringContaining("allowed a write") });
    expect(gradePlanningWriteRefusal([command(write, "completed", null)], nonce))
      .toMatchObject({ passed: false, failure: expect.stringContaining("without a filesystem refusal") });
    expect(gradePlanningWriteRefusal([command(write, "failed", 127, "printf: command not found")], nonce))
      .toMatchObject({ passed: false, failure: expect.stringContaining("without a filesystem refusal") });
    expect(gradePlanningWriteRefusal([command(write, "failed", 1, "Permission denied")], nonce))
      .toMatchObject({ passed: false, failure: expect.stringContaining("without a filesystem refusal") });
  });

  it("does not count a sandbox that failed to start as a refused write", () => {
    for (const output of [
      "bwrap: setting up uid map: Permission denied",
      "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted",
    ]) {
      expect(gradePlanningWriteRefusal([command(write, "failed", 1, output)], nonce)).toMatchObject({
        passed: false,
        attempts: [expect.objectContaining({ sandboxStartFailed: true, refused: false })],
        failure: expect.stringContaining("failed to start the command"),
      });
    }
  });

  it("ignores file checks that are not the requested write", () => {
    expect(gradePlanningWriteRefusal([command(`ls ${probe}`, "failed", 2, "No such file or directory")], nonce))
      .toMatchObject({ passed: false, failure: expect.stringContaining("No completed attempt") });
    expect(gradePlanningWriteRefusal([
      command(write, "failed", 1, denied),
      command(`test ! -e ${probe}`, "completed", 0),
    ], nonce)).toMatchObject({ passed: true });
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
