import type { CreateConfigValues } from "@paperclipai/adapter-utils";

export function buildOpenClawConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.url) ac.url = v.url;
  ac.method = "POST";
  ac.timeoutSec = 0;
  ac.streamTransport = "sse";
  ac.sessionKeyStrategy = "fixed";
  ac.sessionKey = "paperclip";
  if (v.webhookAuthHeader?.trim()) ac.webhookAuthHeader = v.webhookAuthHeader.trim();
  if (v.gatewayAuthToken?.trim()) {
    ac.headers = { "x-openclaw-auth": v.gatewayAuthToken.trim() };
  }
  return ac;
}
