import type { CreateConfigValues } from "@paperclipai/adapter-utils";

export function buildOpenClawGatewayConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.url) ac.url = v.url;

  const token = typeof v.openclawGatewayToken === "string" ? v.openclawGatewayToken.trim() : "";
  if (token) {
    ac.headers = { "x-openclaw-token": token };
  }

  ac.timeoutSec = 120;
  ac.waitTimeoutMs = 120000;
  ac.sessionKeyStrategy = "issue";
  ac.role = "operator";
  ac.scopes = ["operator.admin"];

  const harnessMode = v.harnessMode ?? "balanced";
  ac.harness = {
    mode: harnessMode,
    profile:
      harnessMode === "fast"
        ? { maxTurnsPerRun: 24, retries: 1 }
        : harnessMode === "safe"
          ? { maxTurnsPerRun: 8, retries: 3 }
          : { maxTurnsPerRun: 16, retries: 2 },
  };

  const plugins = {
    knowledgebase: v.pluginKnowledgebase === true,
    tracing: v.pluginTracing === true,
    queues: v.pluginQueues === true,
  };
  if (Object.values(plugins).some(Boolean)) {
    ac.plugins = plugins;
  }

  return ac;
}
