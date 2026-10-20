import type { AgentObservabilityCapture } from "@paperclipai/shared";

/** Secret-bearing, controller-owned launch material. Never persist or merge into adapter config. */
export type ProviderObservabilityLaunch = {
  kind: "codex" | "claude";
  compatibilityKey: string;
  otelConfig?: Record<string, unknown>;
  environment: Readonly<Record<string, string>>;
};

export const AGENT_OBSERVABILITY_ENV_KEYS = [
  "CLAUDE_CODE_ENABLE_TELEMETRY", "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA", "ENABLE_ENHANCED_TELEMETRY_BETA",
  "OTEL_LOGS_EXPORTER", "OTEL_TRACES_EXPORTER", "OTEL_METRICS_EXPORTER", "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_PROTOCOL", "OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_TIMEOUT",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL", "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS", "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_TIMEOUT", "OTEL_EXPORTER_OTLP_TRACES_TIMEOUT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "OTEL_EXPORTER_OTLP_METRICS_HEADERS", "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
  "PAPERCLIP_OBSERVABILITY_CODEX_CONFIG",
  "OTEL_LOG_USER_PROMPTS", "OTEL_LOG_ASSISTANT_RESPONSES", "OTEL_LOG_TOOL_DETAILS", "OTEL_LOG_TOOL_CONTENT", "OTEL_LOG_RAW_API_BODIES",
] as const;

export function encodeObservabilityHeaders(headers: Readonly<Record<string, string>>): string {
  return Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join(",");
}

export function applyObservabilityEnvironment(env: NodeJS.ProcessEnv, launch: ProviderObservabilityLaunch): void {
  for (const name of AGENT_OBSERVABILITY_ENV_KEYS) delete env[name];
  Object.assign(env, launch.environment);
}

export function observabilitySecretValues(launch: ProviderObservabilityLaunch | undefined): string[] {
  if (!launch) return [];
  const headers = ((launch.otelConfig?.exporter as Record<string, unknown> | undefined)?.["otlp-http"] as { headers?: Record<string, string> } | undefined)?.headers;
  const encoded = launch.environment.OTEL_EXPORTER_OTLP_LOGS_HEADERS;
  const decoded = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
  const values = [...Object.values(headers ?? {}).flatMap(value => [value, decoded(value)]), ...(encoded ? [encoded, ...encoded.split(",").map(item => decoded(item.slice(item.indexOf("=") + 1)))] : [])];
  return [...new Set(values.flatMap(value => [value, value.replace(/^Bearer /i, ""), JSON.stringify(value).slice(1, -1)]).filter(Boolean))];
}

export function buildProviderObservabilityLaunch(input: {
  kind: "codex" | "claude"; companyId: string; agentId: string; revision: string | null;
  compatibilityKey: string; enabled: boolean; capture: AgentObservabilityCapture;
  logsEndpoint?: string; tracesEndpoint?: string; headers?: Readonly<Record<string, string>>;
}): ProviderObservabilityLaunch {
  const { enabled, capture, kind, compatibilityKey } = input;
  const attributes = { "paperclip.company.id": input.companyId, "paperclip.agent.id": input.agentId, "paperclip.observability.revision": input.revision ?? "unconfigured" };
  const environment: Record<string, string> = {
    OTEL_EXPORTER_OTLP_LOGS_TIMEOUT: "3000", OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: "3000",
  };
  if (kind === "codex") {
    // Codex passes these through opentelemetry-otlp 0.31's with_headers, which
    // percent-decodes values. Encode once so literal percent sequences survive.
    const headers = Object.fromEntries(Object.entries(input.headers ?? {}).map(([name, value]) => [name, encodeURIComponent(value)]));
    const exporter = (endpoint: string | undefined) => enabled ? { "otlp-http": { endpoint, protocol: "binary", headers } } : "none";
    return { kind, compatibilityKey, environment, otelConfig: {
      exporter: exporter(input.logsEndpoint), trace_exporter: exporter(input.tracesEndpoint), metrics_exporter: "none",
      log_user_prompt: enabled && capture.userPrompts, log_agent_responses: enabled && capture.assistantResponses,
      log_guardian_assessments: false, tool_result: { max_bytes: enabled && capture.toolContent ? 65536 : 0 },
      span_attributes: enabled ? attributes : {},
    } };
  }
  Object.assign(environment, {
    CLAUDE_CODE_ENABLE_TELEMETRY: enabled ? "1" : "0",
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: enabled ? "1" : "0",
    OTEL_LOGS_EXPORTER: enabled ? "otlp" : "none", OTEL_TRACES_EXPORTER: enabled ? "otlp" : "none", OTEL_METRICS_EXPORTER: "none",
    OTEL_LOG_USER_PROMPTS: enabled && capture.userPrompts ? "1" : "0",
    OTEL_LOG_ASSISTANT_RESPONSES: enabled && capture.assistantResponses ? "1" : "0",
    OTEL_LOG_TOOL_DETAILS: enabled && capture.toolDetails ? "1" : "0",
    OTEL_LOG_TOOL_CONTENT: enabled && capture.toolContent ? "1" : "0", OTEL_LOG_RAW_API_BODIES: "0",
  });
  if (enabled) Object.assign(environment, {
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/protobuf", OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/protobuf",
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: input.logsEndpoint, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: input.tracesEndpoint,
    OTEL_EXPORTER_OTLP_LOGS_HEADERS: encodeObservabilityHeaders(input.headers ?? {}),
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: encodeObservabilityHeaders(input.headers ?? {}),
    OTEL_RESOURCE_ATTRIBUTES: Object.entries(attributes).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join(","),
  });
  return { kind, compatibilityKey, environment };
}
