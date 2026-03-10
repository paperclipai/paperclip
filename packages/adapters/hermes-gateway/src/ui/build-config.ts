import type { CreateConfigValues } from "@paperclipai/adapter-utils";

function parseCommaList(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

export function buildHermesGatewayConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.url) ac.url = v.url;
  if (v.model) ac.model = v.model;
  if (v.extraArgs) ac.toolsets = parseCommaList(v.extraArgs);
  ac.timeoutSec = 120;
  ac.waitTimeoutMs = 120000;
  ac.sessionKeyStrategy = "fixed";
  ac.maxTurnsPerRun = v.maxTurnsPerRun || 80;
  return ac;
}
