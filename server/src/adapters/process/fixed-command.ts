import { asString, asStringArray, parseObject } from "../utils.js";

export function assertFixedProcessExecution(savedConfig: unknown, effectiveConfig: unknown, context: unknown): void {
  const saved = parseObject(savedConfig);
  if (saved.fixedCommand !== true) return;
  const effective = parseObject(effectiveConfig);
  const wake = parseObject(context);
  if (wake.issueId || wake.taskId || wake.projectId) {
    throw new Error("Fixed process services cannot execute from an issue or project context");
  }
  if (!asString(saved.command, "") || !asString(saved.cwd, "") ||
      asString(saved.command, "") !== asString(effective.command, "") ||
      asString(saved.cwd, "") !== asString(effective.cwd, "") ||
      JSON.stringify(asStringArray(saved.args)) !== JSON.stringify(asStringArray(effective.args))) {
    throw new Error("Fixed process execution differs from its administrative command");
  }
}
