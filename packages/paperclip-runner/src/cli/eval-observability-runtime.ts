import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { CapabilityMockControlPlaneAdapter } from "../mock-core/capability-mock-control-plane-adapter.js";
import {
  applyProviderObservabilityEnvironment,
  writeManagedCodexObservability,
  type ProviderObservabilityLaunch,
} from "../drivers/agent-observability.js";
import type { EvalSessionRequest } from "./eval-session-contract.js";
import type { prepareEvalGatewayRuntime } from "./eval-gateway-runtime.js";

type Gateway = Awaited<ReturnType<typeof prepareEvalGatewayRuntime>>;
const invalid = () => new Error("Invalid controlled eval observability configuration");
function object(value: unknown, names: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== names.length || Object.keys(value).some(key => !names.includes(key))) throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\r\n\0]/.test(value)) throw invalid();
  return value;
}
function decodedMap(value: unknown): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const item of text(value).split(",")) {
    const index = item.indexOf("=");
    if (index < 1) throw invalid();
    const key = item.slice(0, index);
    if (Object.hasOwn(result, key)) throw invalid();
    result[key] = decodeURIComponent(item.slice(index + 1));
  }
  return result;
}
function same(value: unknown, expected: Record<string, unknown>) {
  const actual = object(value, Object.keys(expected));
  if (Object.entries(expected).some(([key, item]) => actual[key] !== item)) throw invalid();
}
function parentHeader(value: unknown, projectId: string, traceId: string, spanId: string): string {
  const headers = decodedMap(value), parent = text(headers["x-bt-parent"]);
  object(headers, ["x-bt-parent"]);
  const bytes = Buffer.from(parent, "base64");
  if (bytes.toString("base64") !== parent || !bytes.subarray(0, 3).equals(Buffer.from([4, 2, 0]))) throw invalid();
  same(JSON.parse(bytes.subarray(3).toString("utf8")), { object_id: projectId, row_id: spanId, span_id: spanId, root_span_id: traceId });
  return parent;
}

export async function prepareEvalObservabilityRuntime(
  file: string,
  request: EvalSessionRequest,
  gateway: Gateway,
  environment: NodeJS.ProcessEnv = process.env,
) {
  let raw: Buffer;
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 131_072) throw invalid();
    raw = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(raw, 0, raw.length, 0);
    if (bytesRead !== stat.size) throw invalid();
    raw = raw.subarray(0, bytesRead);
  } finally { await handle.close(); }
  let launch: ProviderObservabilityLaunch;
  let projectId: string, traceId: string, spanId: string;
  try {
    const config = object(JSON.parse(raw.toString("utf8")), ["schema", "campaignId", "executionId", "attemptId", "projectId", "traceId", "spanId", "baseUrl", "launch"]);
    projectId = text(config.projectId); traceId = text(config.traceId); spanId = text(config.spanId);
    if (config.schema !== "paperclip.runner-eval.observability/v1" || config.attemptId !== request.attemptId
        || config.campaignId !== gateway.evidence.campaignId || config.executionId !== gateway.evidence.executionId
        || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(projectId)
        || !/^[a-f0-9]{32}$/.test(traceId) || /^0+$/.test(traceId) || !/^[a-f0-9]{16}$/.test(spanId) || /^0+$/.test(spanId)
        || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/otel$/.test(text(config.baseUrl))
        || Number(new URL(config.baseUrl as string).port) > 65535) throw invalid();
    const kind = request.provider === "codex" ? "codex" : request.provider === "acpx" && request.acpxAgent === "claude" ? "claude" : null;
    if (!kind) throw invalid();
    const source = object(config.launch, ["kind", "compatibilityKey", "environment", ...(kind === "codex" ? ["otelConfig"] : [])]);
    if (source.kind !== kind || !/^[A-Za-z0-9_-]{1,128}$/.test(text(source.compatibilityKey))) throw invalid();
    const state = new CapabilityMockControlPlaneAdapter(request.session.seed).snapshot();
    const attributes = {
      "paperclip.company.id": request.session.companyId ?? state.company.id,
      "paperclip.agent.id": request.session.actorId ?? state.actors[0]!.id,
      "paperclip.observability.revision": source.compatibilityKey,
    };
    const common = ["OTEL_EXPORTER_OTLP_LOGS_TIMEOUT", "OTEL_EXPORTER_OTLP_TRACES_TIMEOUT", "OTEL_EXPORTER_OTLP_LOGS_HEADERS", "OTEL_EXPORTER_OTLP_TRACES_HEADERS"];
    const env = object(source.environment, kind === "codex" ? common : [...common,
      "CLAUDE_CODE_ENABLE_TELEMETRY", "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA", "OTEL_LOGS_EXPORTER", "OTEL_TRACES_EXPORTER", "OTEL_METRICS_EXPORTER",
      "OTEL_LOG_USER_PROMPTS", "OTEL_LOG_ASSISTANT_RESPONSES", "OTEL_LOG_TOOL_DETAILS", "OTEL_LOG_TOOL_CONTENT", "OTEL_LOG_RAW_API_BODIES",
      "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL", "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_RESOURCE_ATTRIBUTES",
    ]);
    for (const value of Object.values(env)) text(value);
    for (const signal of ["LOGS", "TRACES"]) {
      if (!/^[1-9][0-9]{0,3}$/.test(env[`OTEL_EXPORTER_OTLP_${signal}_TIMEOUT`] as string) || Number(env[`OTEL_EXPORTER_OTLP_${signal}_TIMEOUT`]) > 3000) throw invalid();
      parentHeader(env[`OTEL_EXPORTER_OTLP_${signal}_HEADERS`], projectId, traceId, spanId);
    }
    if (kind === "codex") {
      const otel = object(source.otelConfig, ["exporter", "trace_exporter", "metrics_exporter", "log_user_prompt", "log_agent_responses", "log_guardian_assessments", "tool_result", "span_attributes"]);
      for (const [key, signal] of [["exporter", "logs"], ["trace_exporter", "traces"]]) {
        const exporter = object(otel[key!], ["otlp-http"]);
        const http = object(exporter["otlp-http"], ["endpoint", "protocol", "headers"]);
        if (http.endpoint !== `${config.baseUrl}/v1/${signal}` || http.protocol !== "binary") throw invalid();
        object(http.headers, []);
      }
      const tool = object(otel.tool_result, ["max_bytes"]);
      if (otel.metrics_exporter !== "none" || otel.log_guardian_assessments !== false
          || typeof otel.log_user_prompt !== "boolean" || typeof otel.log_agent_responses !== "boolean"
          || ![0, 65536].includes(tool.max_bytes as number)) throw invalid();
      same(otel.span_attributes, attributes);
    } else {
      const fixed: Record<string, string> = { CLAUDE_CODE_ENABLE_TELEMETRY: "1", CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
        OTEL_LOGS_EXPORTER: "otlp", OTEL_TRACES_EXPORTER: "otlp", OTEL_METRICS_EXPORTER: "none", OTEL_LOG_RAW_API_BODIES: "0",
        OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/protobuf", OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/protobuf",
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${config.baseUrl}/v1/logs`, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${config.baseUrl}/v1/traces` };
      if (Object.entries(fixed).some(([key, value]) => env[key] !== value)
          || ["OTEL_LOG_USER_PROMPTS", "OTEL_LOG_ASSISTANT_RESPONSES", "OTEL_LOG_TOOL_DETAILS", "OTEL_LOG_TOOL_CONTENT"].some(key => !["0", "1"].includes(env[key] as string))) throw invalid();
      same(decodedMap(env.OTEL_RESOURCE_ATTRIBUTES), attributes);
    }
    launch = structuredClone(source) as unknown as ProviderObservabilityLaunch;
  } catch { throw invalid(); }
  const token = environment.PAPERCLIP_RUNNER_EVAL_OTLP_TOKEN;
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) throw new Error("Missing or invalid controlled eval OTLP token");
  const launchEnvironment = { ...launch.environment };
  for (const signal of ["LOGS", "TRACES"]) {
    const key = `OTEL_EXPORTER_OTLP_${signal}_HEADERS`;
    launchEnvironment[key] += `,authorization=${encodeURIComponent(`Bearer ${token}`)}`;
  }
  launch = { ...launch, environment: launchEnvironment };
  if (launch.kind === "codex") writeManagedCodexObservability(gateway.transportOptions.environment.CODEX_HOME!, launch.otelConfig!);
  return {
    transportOptions: { ...gateway.transportOptions, observability: launch,
      environment: applyProviderObservabilityEnvironment(gateway.transportOptions.environment, launch) },
    evidence: { mode: "controller_otlp" as const, configured: true, verification: "unverified" as const,
      projectId, traceId, spanId, descriptorSha256: createHash("sha256").update(raw).digest("hex") },
  };
}
