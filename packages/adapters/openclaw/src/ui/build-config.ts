import type { CreateConfigValues } from "@paperclipai/adapter-utils";

export function buildOpenClawConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.url) ac.url = v.url;
  ac.method = "POST";
  ac.timeoutSec = 0;
  ac.streamTransport = "sse";
  ac.sessionKeyStrategy = "fixed";
  ac.sessionKey = "paperclip";
  return ac;
}
