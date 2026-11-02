import { trace, SpanStatusCode, type Context, type Span } from "@opentelemetry/api";
import { getActiveStepContext, runWithRuntimeParent } from "@paperclipai/adapter-utils/acpx-engine/startup-timing";

const phases = new Set(["runner.transport.cold_start", "runner.transport.resume", "runner.transport.attach", "runner.transport.prepare",
  "runner.transport.turn_start", "runner.transport.started_event", "runner.transport.command_ack", "runner.transport.registration", "runner.transport.provider_identity"]);
const keys = new Set(["inputBytes", "toolSchemaBytes", "toolCount", "contextReused", "tokenDataAvailable"]);

// Resolve the parent on every call: a retained transport belongs to several successive runs.
export function measureRunnerOperation<T>(phase: string, work: () => Promise<T>, attributes?: Record<string, number | boolean>): Promise<T> {
  const parent = getActiveStepContext()?.parentContext;
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || !parent || !phases.has(phase)) return work();
  let operation: Promise<T> | undefined;
  const once = () => operation ??= Promise.resolve().then(work);
  let span: Span | undefined;
  try {
    const bounded = Object.fromEntries(Object.entries(attributes ?? {}).filter(([key,value])=>keys.has(key) &&
      (typeof value === "boolean" || Number.isSafeInteger(value) && value >= 0 && value <= 1e12)));
    span = trace.getTracer("paperclip.native-runner").startSpan(phase,{attributes:bounded},parent as Context);
    const currentSpan = span;
    const child = trace.setSpan(parent as Context,currentSpan);
    return runWithRuntimeParent(child,once).then(value=>{try {currentSpan.end();}catch{} return value;},error=>{
      try{currentSpan.setStatus({code:SpanStatusCode.ERROR});currentSpan.end();}catch{} throw error;
    });
  } catch { try { span?.end(); } catch {} return once(); }
}

/** Numeric same-process durations, causally anchored at receipt. Remainders are unattributed. */
export function recordRunnerTimingReceipt(raw: unknown): void {
  const parent = getActiveStepContext()?.parentContext;
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || !parent || !raw || typeof raw !== "object") return;
  const row = raw as Record<string, unknown>;
  const values = ["runnerMs", "sidecarMs", "statusMs", "promptMs", "statusOffsetMs", "promptOffsetMs", "roundTripMs"].map(key=>row[key]);
  if (!values.every(value=>typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 300000)) return;
  const [runner,sidecar,status,prompt,statusOffset,promptOffset,roundTrip] = values as number[];
  if (runner > roundTrip || sidecar > runner || statusOffset + status > promptOffset || promptOffset + prompt > sidecar) return;
  const opened: Array<{span:Span; end:number}> = [];
  const end = Date.now(), start=end-runner, sidecarStart=end-sidecar;
  try {
    const tracer = trace.getTracer("paperclip.native-runner");
    const root = tracer.startSpan("runner.remote.turn_start",{startTime:start},parent as Context);
    opened.push({span:root,end});
    const rootContext=trace.setSpan(parent as Context,root);
    const child=tracer.startSpan("runner.sidecar.turn_start",{startTime:sidecarStart},rootContext);
    opened.push({span:child,end});
    const childContext=trace.setSpan(rootContext,child);
    const settings=tracer.startSpan("runner.sidecar.status_read",{startTime:sidecarStart+statusOffset},childContext);opened.push({span:settings,end:sidecarStart+statusOffset+status});
    const acknowledgement=tracer.startSpan("runner.sidecar.prompt_started",{startTime:sidecarStart+promptOffset},childContext);opened.push({span:acknowledgement,end:sidecarStart+promptOffset+prompt});
  } catch {} finally {
    for (const item of opened.reverse()) { try { item.span.end(item.end); } catch {} }
  }
}
