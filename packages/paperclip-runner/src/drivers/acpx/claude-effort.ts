import { createAcpxConfigAdmission } from "./config-admission.js";

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";
export function resolveClaudeEffort(agent: string, value: unknown): ClaudeEffort | undefined {
  if (value === undefined || value === "") return undefined;
  if (agent !== "claude") throw new Error("Claude effort is only supported by Claude");
  if (value !== "low" && value !== "medium" && value !== "high" && value !== "xhigh" && value !== "max") throw new Error("Claude effort must be low, medium, high, xhigh, or max");
  return value;
}
export function createClaudeEffortAdmission(expected: ClaudeEffort) {
  return createAcpxConfigAdmission(expected, { label: "Claude effort", configId: "effort",
    supportedValues: ["default", "low", "medium", "high", "xhigh", "max"] });
}
export function admittedClaudeEffort(agent: string, requested: unknown, descriptor: Record<string, unknown>, identity: Record<string, unknown>): ClaudeEffort | undefined {
  const expected = resolveClaudeEffort(agent, requested);
  const effective = resolveClaudeEffort(agent, identity.claudeEffort);
  if (effective !== expected || descriptor.claudeEffort !== expected) throw new Error("Claude effort differs from the admitted configuration");
  return effective;
}
