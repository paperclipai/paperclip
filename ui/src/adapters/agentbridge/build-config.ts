import type { CreateConfigValues } from "@paperclipai/adapter-utils";

export function buildAgentBridgeConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.url) ac.url = v.url;
  if (v.model) ac.model = v.model;
  return ac;
}
