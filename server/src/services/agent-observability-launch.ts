import { DEFAULT_AGENT_OBSERVABILITY_CAPTURE } from "@paperclipai/shared";
import { buildProviderObservabilityLaunch } from "@paperclipai/adapter-utils/agent-observability";
import type { ResolvedAgentObservability } from "./agent-observability.js";

export function agentObservabilityLaunch(snapshot: ResolvedAgentObservability, input: { kind: "codex" | "claude"; companyId: string; agentId: string }) {
  return buildProviderObservabilityLaunch({ ...input, revision: snapshot.revision, compatibilityKey: snapshot.compatibilityKey,
    enabled: snapshot.state === "enabled", capture: snapshot.state === "enabled" ? snapshot.capture : DEFAULT_AGENT_OBSERVABILITY_CAPTURE,
    ...(snapshot.state === "enabled" ? { logsEndpoint: snapshot.logsEndpoint, tracesEndpoint: snapshot.tracesEndpoint, headers: snapshot.headers } : {}) });
}
