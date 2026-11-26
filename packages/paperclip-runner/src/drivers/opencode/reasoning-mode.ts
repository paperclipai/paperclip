export type OpenCodeReasoningMode = "default" | "disabled";

/** Opt-in only. Omitting the setting preserves the provider's own defaults. */
export function parseOpenCodeReasoningMode(value: unknown): OpenCodeReasoningMode {
  if (value === undefined || value === "default") return "default";
  if (value === "disabled") return "disabled";
  throw new Error("turn.reasoningMode must be default or disabled");
}
