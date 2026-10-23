import { isDeepStrictEqual } from "node:util";
import { asString, asStringArray, parseObject } from "../utils.js";

const approvedEnvironments = new WeakMap<object, Record<string, unknown>>();

export function assertFixedProcessUnresolvedEnvironment(savedConfig: unknown, effectiveConfig: unknown, extraEnvironments: unknown[]): void {
  const saved = parseObject(savedConfig);
  if (saved.fixedCommand !== true) return;
  if (!isDeepStrictEqual(parseObject(saved.env), parseObject(parseObject(effectiveConfig).env)) ||
      extraEnvironments.some((env) => Object.keys(parseObject(env)).length > 0)) {
    throw new Error("Fixed process environment differs from its administrative configuration");
  }
}

// The closure captures the resolver output before connectors or later runtime
// transforms can change it. A request cannot mint the WeakMap entry.
export function captureFixedProcessEnvironment(savedConfig: unknown, resolvedConfig: unknown): (runtimeConfig: Record<string, unknown>) => void {
  if (parseObject(savedConfig).fixedCommand !== true) return () => {};
  const expected = structuredClone(parseObject(parseObject(resolvedConfig).env));
  return (runtimeConfig) => {
    if (!isDeepStrictEqual(expected, parseObject(runtimeConfig.env))) {
      throw new Error("Fixed process environment changed after secret resolution");
    }
    approvedEnvironments.set(runtimeConfig, structuredClone(expected));
  };
}

export function assertFixedProcessExecution(savedConfig: unknown, effectiveConfig: unknown, context: unknown): void {
  const saved = parseObject(savedConfig);
  if (saved.fixedCommand !== true) return;
  const effective = parseObject(effectiveConfig);
  const expectedEnv = effectiveConfig && typeof effectiveConfig === "object"
    ? approvedEnvironments.get(effectiveConfig) ?? parseObject(saved.env) : parseObject(saved.env);
  if (!isDeepStrictEqual(expectedEnv, parseObject(effective.env)) ||
      Object.values(parseObject(effective.env)).some((value) => typeof value !== "string")) {
    throw new Error("Fixed process environment is not the verified administrative environment");
  }
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
