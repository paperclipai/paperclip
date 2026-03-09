import type { CreateConfigValues } from "@paperclipai/adapter-utils";

export function buildNanoClawGatewayConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.url) ac.url = v.url;
  else ac.url = "http://127.0.0.1:18790";
  ac.timeoutMs = 30_000;
  return ac;
}
