import { createAcpxConfigAdmission } from "./config-admission.js";

export type PiThinkingLevel = "off" | "low" | "high" | "max";

export function resolvePiThinkingLevel(agent: string, mode: unknown): PiThinkingLevel | undefined {
  if (agent !== "pi") {
    if (mode !== undefined) throw new Error("Pi thinking level is only supported by Pi");
    return undefined;
  }
  if (mode === undefined) throw new Error("Pi thinking level must be explicit");
  if (mode !== "off" && mode !== "low" && mode !== "high" && mode !== "max") throw new Error("Invalid Pi thinking level");
  return mode;
}

export function createPiThinkingAdmission(expected: PiThinkingLevel, options: { restoring?: boolean } = {}) {
  return createAcpxConfigAdmission(expected, { ...options, label: "Pi thinking mode", configId: "thought_level",
    supportedValues: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], sessionMode: true });
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Cross-check independently returned durable identity and public descriptor. */
export function admittedPiThinkingLevel(agent: string, requested: unknown, descriptor: unknown, identity: unknown): PiThinkingLevel | undefined {
  const expected = resolvePiThinkingLevel(agent, requested);
  const reported = object(identity).piThinkingLevel;
  const projected = object(descriptor).piThinkingLevel;
  if (agent !== "pi") {
    if (reported !== undefined || projected !== undefined) throw new Error("Non-Pi identity contains a Pi thinking level");
    return undefined;
  }
  const effective = resolvePiThinkingLevel("pi", reported);
  if (effective !== expected || projected !== effective) throw new Error("Pi effective thinking level differs from the admitted configuration");
  return effective;
}
