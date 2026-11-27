import { randomBytes, randomUUID } from "node:crypto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ProtobufLogsSerializer, ProtobufTraceSerializer } from "@opentelemetry/otlp-transformer";
import type { AgentObservabilityTestReceipt, OtlpSignalTestResult } from "@paperclipai/shared";
import { guardedRemoteHttpFetch } from "./remote-http-fetch.js";
import type { ResolvedAgentObservability } from "./agent-observability.js";

const failureMessages: Record<string, string> = {
  credentials_unavailable: "The saved credentials are unavailable. Replace them and try again.",
  configuration_invalid: "The saved configuration is invalid. Save it again.",
  timeout: "The receiver did not respond within ten seconds.",
  network_error: "The receiver could not be reached from this server.",
  receiver_rejected: "The receiver rejected the test records. Check credentials and destination routing.",
  partial_rejection: "The receiver reported rejected test records.",
  invalid_response: "The receiver returned an invalid OTLP response.",
};
const failed = (code: string, durationMs = 0, httpStatus: number | null = null): OtlpSignalTestResult => ({
  status: "failed", httpStatus, rejectedRecords: 0, errorCode: code,
  message: failureMessages[code] ?? failureMessages.network_error, durationMs,
});

async function boundedBody(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > 65536) throw new Error("OTLP response too large");
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export async function testAgentObservability(input: {
  companyId: string; revision: string; resolved: ResolvedAgentObservability;
  allowPrivateNetwork: boolean; timeoutMs?: number;
}): Promise<AgentObservabilityTestReceipt> {
  const startedAt = new Date().toISOString();
  const marker = `paperclip-observability-test-${randomUUID()}`;
  const traceId = randomBytes(16).toString("hex"), spanId = randomBytes(8).toString("hex");
  const spanContext = { traceId, spanId, traceFlags: 1 };
  const now = Date.now();
  const time: [number, number] = [Math.floor(now / 1000), (now % 1000) * 1_000_000];
  const attributes = { "paperclip.company.id": input.companyId, "paperclip.observability.revision": input.revision, "paperclip.observability.test_marker": marker };
  const resource = resourceFromAttributes({ "service.name": "paperclip-observability-test", ...attributes });
  const instrumentationScope = { name: "paperclip.agent-observability", version: "1" };
  const log: Parameters<typeof ProtobufLogsSerializer.serializeRequest>[0][number] = {
    resource, instrumentationScope, hrTime: time, hrTimeObserved: time,
    severityNumber: 9, severityText: "INFO", body: marker, attributes, droppedAttributesCount: 0, spanContext,
  };
  const span: Parameters<typeof ProtobufTraceSerializer.serializeRequest>[0][number] = {
    name: "paperclip.observability.connection_test", kind: 0, spanContext: () => spanContext,
    startTime: time, endTime: time, duration: [0, 0], status: { code: 1 }, attributes,
    links: [], events: [], ended: true, resource, instrumentationScope,
    droppedAttributesCount: 0, droppedEventsCount: 0, droppedLinksCount: 0,
  };
  const abort = new AbortController();
  const timeoutMs = input.timeoutMs ?? 10000;
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const send = async (signal: "logs" | "traces"): Promise<OtlpSignalTestResult> => {
      const started = performance.now();
      const duration = () => Math.round(performance.now() - started);
      if (input.resolved.state !== "enabled") return failed(input.resolved.reason ?? "configuration_invalid");
      const serializer = signal === "logs" ? ProtobufLogsSerializer : ProtobufTraceSerializer;
      const payload = signal === "logs" ? ProtobufLogsSerializer.serializeRequest([log]) : ProtobufTraceSerializer.serializeRequest([span]);
      if (!payload) return failed("configuration_invalid");
      let status: number | null = null;
      try {
        const response = await guardedRemoteHttpFetch(signal === "logs" ? input.resolved.logsEndpoint : input.resolved.tracesEndpoint, {
          method: "POST", headers: { ...input.resolved.headers, "content-type": "application/x-protobuf", accept: "application/x-protobuf, application/json" },
          body: Buffer.from(payload), signal: abort.signal,
        }, { allowPrivateNetwork: input.allowPrivateNetwork, dnsTimeoutMs: timeoutMs, connectTimeoutMs: timeoutMs,
          responseTimeoutMs: timeoutMs, error: () => new Error("Observability endpoint is unavailable") });
        status = response.status;
        const bytes = await boundedBody(response);
        if (!response.ok) return failed("receiver_rejected", duration(), status);
        const contentType = response.headers.get("content-type")?.split(";")[0].trim();
        if (contentType && !["application/x-protobuf", "application/json"].includes(contentType)) return failed("invalid_response", duration(), status);
        let rejected = 0;
        try {
          if (bytes.length) {
            let result: unknown;
            if (contentType === "application/json") result = JSON.parse(new TextDecoder().decode(bytes));
            else if (contentType === "application/x-protobuf") result = serializer.deserializeResponse(bytes);
            else return failed("invalid_response", duration(), status);
            if (!result || typeof result !== "object" || Array.isArray(result)) return failed("invalid_response", duration(), status);
            const partial = (result as { partialSuccess?: { rejectedLogRecords?: unknown; rejectedSpans?: unknown } }).partialSuccess;
            if (partial !== undefined && (!partial || typeof partial !== "object" || Array.isArray(partial))) return failed("invalid_response", duration(), status);
            const count = partial?.[signal === "logs" ? "rejectedLogRecords" : "rejectedSpans"];
            if (count !== undefined && (typeof count !== "number" && typeof count !== "string" || typeof count === "string" && !/^\d+$/.test(count))) return failed("invalid_response", duration(), status);
            rejected = count === undefined ? 0 : Number(count);
            if (!Number.isSafeInteger(rejected) || rejected < 0) return failed("invalid_response", duration(), status);
          }
        } catch { return failed("invalid_response", duration(), status); }
        return { status: rejected ? "rejected" : "accepted", httpStatus: status, rejectedRecords: rejected,
          errorCode: rejected ? "partial_rejection" : null, message: rejected ? failureMessages.partial_rejection : null, durationMs: duration() };
      } catch { return failed(abort.signal.aborted ? "timeout" : "network_error", duration(), status); }
    };
    const [logs, traces] = await Promise.all([send("logs"), send("traces")]);
    const accepted = [logs, traces].filter(result => result.status === "accepted").length;
    return { revision: input.revision, marker, source: "control_plane", startedAt, finishedAt: new Date().toISOString(),
      status: accepted === 2 ? "accepted" : accepted || [logs, traces].some(result => result.status === "rejected") ? "partial" : "failed", signals: { logs, traces } };
  } finally { clearTimeout(timer); }
}
