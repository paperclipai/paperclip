import { parse, stringify } from "smol-toml";
import { chmodSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** Controller-owned, secret-bearing options; excluded from all durable descriptors. */
export interface ProviderObservabilityLaunch {
  kind: "codex" | "claude";
  compatibilityKey: string;
  otelConfig?: Record<string, unknown>;
  environment: Readonly<Record<string, string>>;
}
export const AGENT_OBSERVABILITY_ENV_KEYS = [
  "CLAUDE_CODE_ENABLE_TELEMETRY", "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA", "ENABLE_ENHANCED_TELEMETRY_BETA",
  "OTEL_LOGS_EXPORTER", "OTEL_TRACES_EXPORTER", "OTEL_METRICS_EXPORTER", "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_PROTOCOL", "OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_TIMEOUT",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL", "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS", "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_TIMEOUT", "OTEL_EXPORTER_OTLP_TRACES_TIMEOUT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "OTEL_EXPORTER_OTLP_METRICS_HEADERS", "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
  "OTEL_LOG_USER_PROMPTS", "OTEL_LOG_ASSISTANT_RESPONSES", "OTEL_LOG_TOOL_DETAILS", "OTEL_LOG_TOOL_CONTENT", "OTEL_LOG_RAW_API_BODIES",
  "PAPERCLIP_OBSERVABILITY_CODEX_CONFIG",
] as const;

export function providerObservabilityEnvironment(source: NodeJS.ProcessEnv | undefined, agent: string): NodeJS.ProcessEnv {
  if (!source || !["codex", "claude"].includes(agent)) return {};
  const result: NodeJS.ProcessEnv = {};
  const names: readonly string[] = agent === "claude" ? AGENT_OBSERVABILITY_ENV_KEYS.filter(key => key !== "PAPERCLIP_OBSERVABILITY_CODEX_CONFIG")
    : ["OTEL_EXPORTER_OTLP_LOGS_TIMEOUT", "OTEL_EXPORTER_OTLP_TRACES_TIMEOUT", "OTEL_EXPORTER_OTLP_LOGS_HEADERS", "OTEL_EXPORTER_OTLP_TRACES_HEADERS", "PAPERCLIP_OBSERVABILITY_CODEX_CONFIG"];
  for (const key of names) if (source[key] !== undefined) {
    // Codex carries two percent-encoded header maps. A valid 16-KiB company
    // header set can exceed 64 KiB after encoding and duplication.
    const maxBytes = key === "PAPERCLIP_OBSERVABILITY_CODEX_CONFIG" ? 128 * 1024 : 65536;
    if (source[key]!.includes("\0") || Buffer.byteLength(source[key]!) > maxBytes) throw new Error("Invalid observability launch environment");
    result[key] = source[key];
  }
  return result;
}

export function applyProviderObservabilityEnvironment(environment: NodeJS.ProcessEnv, launch: ProviderObservabilityLaunch | undefined, acpx = false): NodeJS.ProcessEnv {
  if (!launch) return environment;
  const result = { ...environment };
  for (const key of AGENT_OBSERVABILITY_ENV_KEYS) delete result[key];
  Object.assign(result, launch.environment);
  if (acpx && launch.kind === "codex" && launch.otelConfig) result.PAPERCLIP_OBSERVABILITY_CODEX_CONFIG = JSON.stringify(launch.otelConfig);
  return result;
}

export function codexObservabilityToml(config: Record<string, unknown> | undefined): string {
  return config ? stringify({ otel: config }) : "";
}

/** Only called with a controller-owned provider home, never a discovered user home. */
export function writeManagedCodexObservability(home: string, config: Record<string, unknown>): void {
  const path = join(home, "config.toml");
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error("Invalid managed Codex config");
  const current = stat ? parse(readFileSync(path, "utf8")) : {};
  const temporary = join(home, `.config-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, stringify({ ...current, otel: config }), { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally { rmSync(temporary, { force: true }); }
}

/** Exact values, including encoded header bundles, must be removed before diagnostics persist. */
export function redactObservabilityDiagnostic(message: string, environment: NodeJS.ProcessEnv | undefined, config?: Record<string, unknown>): string {
  const values = new Set<string>();
  for (const key of ["OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_LOGS_HEADERS", "OTEL_EXPORTER_OTLP_TRACES_HEADERS"]) {
    const value = environment?.[key];
    if (!value) continue;
    values.add(value);
    for (const item of value.split(",")) {
      const encoded = item.slice(item.indexOf("=") + 1);
      values.add(encoded);
      try { values.add(decodeURIComponent(encoded)); } catch { values.add(encoded); }
    }
  }
  const codex = config ?? (() => { try { return JSON.parse(environment?.PAPERCLIP_OBSERVABILITY_CODEX_CONFIG ?? "null"); } catch { return null; } })();
  for (const exporter of [codex?.exporter, codex?.trace_exporter]) {
    const headers = (exporter as { "otlp-http"?: { headers?: Record<string, string> } } | undefined)?.["otlp-http"]?.headers;
    for (const value of Object.values(headers ?? {})) {
      values.add(value);
      try { values.add(decodeURIComponent(value)); } catch { /* Older launch contracts may contain literal percent values. */ }
    }
  }
  for (const value of [...values]) if (/^Bearer /i.test(value)) values.add(value.slice(7));
  for (const value of [...values]) values.add(JSON.stringify(value).slice(1, -1));
  for (const value of [...values].filter(Boolean).sort((a, b) => b.length - a.length)) message = message.replaceAll(value, "[REDACTED]");
  return message;
}
