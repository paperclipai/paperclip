import { randomBytes } from "node:crypto";
import type { PrpEvent } from "../../protocol/replay-contract.js";
import { redactObservabilityDiagnostic } from "../agent-observability.js";

type Attributes = Record<string, string | number | boolean>;
interface Span { id: string; name: string; start: number; end: number; failed: boolean; attributes: Attributes }
interface Turn {
  runId: string; turnId: string; traceId: string; root: Span;
  tools: Map<string, Span>; usage: Map<string, Span>; truncated: boolean;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const id = () => randomBytes(8).toString("hex");
const maxRows = 64;
const maxTextBytes = 8192;
const attributes = (values: Attributes) => Object.entries(values).map(([key, value]) => ({ key, value:
  typeof value === "string" ? { stringValue: value } : typeof value === "boolean" ? { boolValue: value } : { doubleValue: value } }));
function pairs(value: string | undefined): Record<string, string> {
  return Object.fromEntries((value ?? "").split(",").filter(Boolean).map(entry => {
    const index = entry.indexOf("=");
    if (index < 1) throw new Error("invalid_configuration");
    return [entry.slice(0, index), decodeURIComponent(entry.slice(index + 1))];
  }));
}

/** A controller opt-in, not OpenCode's raw OTLP. Projected PRP events never include reasoning or raw provider payloads. */
export function createOpenCodeCompanyObservability(input: {
  environment: NodeJS.ProcessEnv | undefined; model: string; sensitiveValues: readonly string[];
  fetch?: typeof globalThis.fetch; onDiagnostic?: (message: string) => void;
}) {
  const env = input.environment;
  if (env?.PAPERCLIP_OBSERVABILITY_OPENCODE !== "1") return undefined;
  const diagnostic = (reason: string) => input.onDiagnostic?.(`Company observability export unavailable (${reason}).`);
  let endpoint: string, headers: Record<string, string>, resource: Attributes;
  try {
    const url = new URL(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? "");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error();
    endpoint = url.href;
    headers = pairs(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS);
    const supplied = pairs(env.OTEL_RESOURCE_ATTRIBUTES);
    resource = { "service.name": "paperclip-opencode", ...Object.fromEntries(
      ["paperclip.company.id", "paperclip.agent.id", "paperclip.observability.revision"]
        .filter(key => supplied[key]).map(key => [key, supplied[key]])) };
  } catch { diagnostic("configuration_invalid"); return undefined; }
  const capture = (key: string) => env[key] === "1";
  const clean = (value: unknown, limit = maxTextBytes): string => {
    if (typeof value !== "string") return "";
    let text = redactObservabilityDiagnostic(value, env);
    for (const secret of input.sensitiveValues.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, "[REDACTED]");
    const bytes = Buffer.from(text);
    if (bytes.length > limit && current) current.truncated = true;
    let end = Math.min(bytes.length, limit);
    while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    return bytes.subarray(0, end).toString("utf8");
  };
  const pending = new Set<Promise<void>>();
  let current: Turn | undefined;
  let closed = false;
  const makeSpan = (name: string, time: number, values: Attributes): Span => ({ id: id(), name, start: time, end: time, failed: false, attributes: values });
  const finish = (failed: boolean, time: number) => {
    const turn = current;
    current = undefined;
    if (!turn) return;
    turn.root.end = Math.max(turn.root.start, time);
    turn.root.failed = failed;
    turn.root.attributes["paperclip.observability.truncated"] = turn.truncated;
    const spans = [turn.root, ...turn.tools.values(), ...turn.usage.values()].map(span => ({
      traceId: turn.traceId, spanId: span.id, ...(span !== turn.root ? { parentSpanId: turn.root.id } : {}),
      name: span.name, kind: 0, startTimeUnixNano: String(BigInt(Math.trunc(span.start)) * 1_000_000n),
      endTimeUnixNano: String(BigInt(Math.trunc(Math.max(span.start, span.end))) * 1_000_000n),
      status: { code: span.failed ? 2 : 1 }, attributes: attributes({ ...resource, ...span.attributes,
        "paperclip.run.id": turn.runId, "paperclip.turn.id": turn.turnId }),
    }));
    // One bounded request per terminal turn, no idle worker, retries or durable secret-bearing queue.
    if (pending.size >= 4) { diagnostic("export_busy"); return; }
    const body = JSON.stringify({ resourceSpans: [{ resource: { attributes: attributes(resource) },
      scopeSpans: [{ scope: { name: "paperclip.opencode", version: "1" }, spans }] }] });
    if (Buffer.byteLength(body) > 1_048_576) { diagnostic("export_too_large"); return; }
    const job = (async () => {
      try {
        const response = await (input.fetch ?? globalThis.fetch)(endpoint, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(3000),
          headers: { ...headers, "content-type": "application/json", accept: "application/json" }, body,
        });
        const reader = response.body?.getReader();
        try {
          if (!response.ok) throw new Error("receiver_rejected");
          const chunks: Uint8Array[] = []; let size = 0;
          while (reader) {
            const next = await reader.read(); if (next.done) break;
            size += next.value.length; if (size > 65536) throw new Error("invalid_response");
            chunks.push(next.value);
          }
          if (size) {
            const decoded: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("invalid_response");
            const partial = record(decoded).partialSuccess;
            if (partial !== undefined && (!partial || typeof partial !== "object" || Array.isArray(partial))) throw new Error("invalid_response");
            const rejected = record(partial).rejectedSpans ?? 0;
            if (!/^\d+$/.test(String(rejected)) || Number(rejected) !== 0) throw new Error("partial_rejection");
          }
        } finally { await reader?.cancel().catch(() => {}); }
      } catch { diagnostic("export_failed"); }
    })();
    pending.add(job);
    void job.finally(() => pending.delete(job));
  };
  return {
    observe(event: PrpEvent) {
      if (closed) return;
      const time = Date.parse(event.emittedAt);
      if (!Number.isFinite(time)) return;
      if (event.eventType === "turn.submitted" && event.turnId) {
        if (current) finish(true, time);
        current = { runId: event.runId, turnId: event.turnId, traceId: randomBytes(16).toString("hex"),
          root: makeSpan("paperclip.opencode.turn", time, { "gen_ai.operation.name": "invoke_agent", "gen_ai.request.model": input.model }),
          tools: new Map(), usage: new Map(), truncated: false };
        if (capture("OTEL_LOG_USER_PROMPTS")) current.root.attributes["braintrust.input"] = clean(record(event.payload).text);
      }
      const turn = current;
      if (!turn || event.runId !== turn.runId || event.turnId !== turn.turnId) return;
      const payload = record(event.payload);
      if (event.eventType === "item.completed" && payload.kind === "agentMessage" && capture("OTEL_LOG_ASSISTANT_RESPONSES")) {
        turn.root.attributes["braintrust.output"] = clean(payload.text);
      }
      if (event.eventType.startsWith("tool.execution.") && event.itemId && capture("OTEL_LOG_TOOL_DETAILS")) {
        let span = turn.tools.get(event.itemId);
        if (!span && turn.tools.size < maxRows) {
          const name = clean(payload.name, 128);
          span = makeSpan(`tool ${name || "execution"}`, time, {
            "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": name });
          turn.tools.set(event.itemId, span);
        }
        if (span) {
          span.end = time; span.failed = payload.status === "failed";
          if (capture("OTEL_LOG_TOOL_CONTENT")) {
            span.attributes["braintrust.output"] = clean(payload.output);
            if (payload.outputTruncated === true) turn.truncated = true;
          }
        } else turn.truncated = true;
      }
      if (event.eventType === "item.completed" && payload.kind === "usage" && typeof payload.usageMessageId === "string") {
        const key = payload.usageMessageId;
        if (turn.usage.has(key) || turn.usage.size < maxRows) {
          const usage = record(payload.usage), cache = record(usage.cache);
          const values: Attributes = { "gen_ai.operation.name": "chat", "gen_ai.request.model": input.model };
          for (const [name, value] of Object.entries({ "gen_ai.usage.input_tokens": usage.input, "gen_ai.usage.output_tokens": usage.output,
            "gen_ai.usage.cache_read.input_tokens": cache.read, "gen_ai.usage.cache_creation.input_tokens": cache.write,
            "paperclip.cost.usd": usage.costUsd })) if (finite(value)) values[name] = value;
          const previous = turn.usage.get(key);
          turn.usage.set(key, { ...makeSpan("opencode.model.usage", previous?.start ?? time, values), id: previous?.id ?? id(), end: time });
        } else turn.truncated = true;
      }
      if (["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"].includes(event.eventType)) finish(event.eventType !== "turn.completed", time);
    },
    async close() {
      if (closed) return;
      closed = true;
      finish(true, Date.now());
      await Promise.all(pending);
    },
  };
}
