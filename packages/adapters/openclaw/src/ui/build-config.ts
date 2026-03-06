import type { CreateConfigValues } from "@paperclipai/adapter-utils";

export function buildOpenClawConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};

  // Gateway URL — default to localhost
  ac.gatewayUrl = (v as any).gatewayUrl || "ws://127.0.0.1:5555";

  // Agent ID — required
  if ((v as any).agentId) {
    ac.agentId = (v as any).agentId;
  }

  // Auth token — optional
  if ((v as any).authToken) {
    ac.authToken = (v as any).authToken;
  }

  // Timeout
  ac.timeoutSec = 120;

  return ac;
}
