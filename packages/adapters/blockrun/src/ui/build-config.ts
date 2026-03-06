import type { CreateConfigValues } from "@paperclipai/adapter-utils";

export function buildBlockRunConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.model) ac.model = v.model;
  ac.maxTokens = 4096;
  ac.temperature = 0.7;
  ac.routingMode = "balanced";
  return ac;
}
