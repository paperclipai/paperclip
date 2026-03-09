import type { CreateConfigValues } from "@paperclipai/adapter-utils";

export function buildNanoClawGatewayConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.url) ac.url = v.url;
  else ac.url = "ws://127.0.0.1:18789";
  ac.timeoutSec = 300;
  ac.waitTimeoutMs = 300_000;
  ac.sessionKeyStrategy = "issue";
  ac.role = "operator";
  ac.scopes = ["operator.admin"];
  return ac;
}
