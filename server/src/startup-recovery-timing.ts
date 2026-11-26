import { ROOT_CONTEXT, SpanStatusCode, trace, type Span } from "@opentelemetry/api";

type StartupRecoveryPhase = "tool_reviews" | "gateway_sessions" | "delivery_workers"
  | "accounting" | "plugin_workers" | "native_recovery" | "hot_restart"
  | "orphan_reaping" | "scheduled_retries" | "queued_runs" | "goal_actions" | "active_goals";

export async function timeStartupRecovery<T>(phase: StartupRecoveryPhase, work: () => Promise<T>): Promise<T> {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) return work();
  let span: Span | undefined;
  try {
    span = trace.getTracer("paperclip.controller-startup").startSpan(
      `controller.startup.${phase}`, undefined, ROOT_CONTEXT,
    );
  } catch {}
  try {
    return await work();
  } catch (error) {
    try { span?.setStatus({ code: SpanStatusCode.ERROR }); } catch {}
    throw error;
  } finally {
    try { span?.end(); } catch {}
  }
}
