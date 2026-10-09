export type OpenCodeReasoningMode = "default" | "disabled";

/** Opt-in only. Omitting the setting preserves the provider's own defaults. */
export function parseOpenCodeReasoningMode(value: string | undefined): OpenCodeReasoningMode {
  const configured = value?.trim();
  if (!configured || configured === "default") return "default";
  if (configured === "disabled") return "disabled";
  throw new Error("PAPERCLIP_OPENCODE_REASONING must be default or disabled");
}
