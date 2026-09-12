import { describe, expect, it } from "vitest";
import { assertFixedProcessExecution } from "../adapters/process/fixed-command.js";
const saved = { fixedCommand: true, command: "/bin/bash", args: ["/service/watchdog.sh"], cwd: "/service" };
describe("fixed process execution", () => {
  it("accepts the administratively stored invocation", () => {
    expect(() => assertFixedProcessExecution(saved, saved, {})).not.toThrow();
  });
  it.each([
    { ...saved, command: "/bin/other" },
    { ...saved, args: ["-c", "arbitrary command"] },
    { ...saved, cwd: "/other" },
  ])("rejects a changed executable tuple before spawning", (effective) => {
    expect(() => assertFixedProcessExecution(saved, effective, {})).toThrow();
  });
  it.each(["issueId", "taskId", "projectId"])("rejects execution through %s", (key) => {
    expect(() => assertFixedProcessExecution(saved, saved, { [key]: "untrusted" })).toThrow();
  });
  it("does not alter ordinary process execution", () => {
    expect(() => assertFixedProcessExecution({}, { command: "custom" }, { issueId: "ordinary" })).not.toThrow();
  });
});
