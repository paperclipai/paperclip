import { performance } from "node:perf_hooks";
import { ROOT_CONTEXT, SpanStatusCode, trace } from "@opentelemetry/api";

export type NativeReconciliationPhase = "legacy_workspace_exports" | "obsolete_policy_reviews"
  | "automatic_completion_reviews" | "candidate_scan" | "candidates";

// A pass at least this slow records its phases. Startup recovery runs the pass
// twice and readiness waits for both; the periodic pass runs on every
// scheduler tick, so fast passes record nothing.
export const NATIVE_RECONCILIATION_SLOW_PASS_MS = 1_000;

type RecordedPhase = { phase: NativeReconciliationPhase; startedAt: number; endedAt: number };

// Records phase boundaries of one native finalization reconciliation pass.
// When the pass is slow and an OTLP endpoint is configured, `finish` emits a
// `controller.native_reconciliation` span with one child span per phase, using
// the recorded start and end times. It records counts and outcome only.
export function createNativeReconciliationPassTiming(options: { now?: () => number } = {}) {
  const now = options.now ?? (() => performance.timeOrigin + performance.now());
  const passStartedAt = now();
  const phases: RecordedPhase[] = [];
  let current: { phase: NativeReconciliationPhase; startedAt: number } | null = null;
  let candidates: number | null = null;

  const closeCurrent = () => {
    if (!current) return;
    phases.push({ ...current, endedAt: now() });
    current = null;
  };

  return {
    phase(phase: NativeReconciliationPhase) {
      closeCurrent();
      current = { phase, startedAt: now() };
    },
    candidates(count: number) {
      candidates = count;
    },
    finish(details: { outcome: "ok" | "failed"; scoped: boolean }) {
      const failedPhase = details.outcome === "failed" ? current?.phase ?? null : null;
      closeCurrent();
      const passEndedAt = now();
      if (passEndedAt - passStartedAt < NATIVE_RECONCILIATION_SLOW_PASS_MS) return;
      if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) return;
      try {
        const tracer = trace.getTracer("paperclip.native-reconciliation");
        const pass = tracer.startSpan("controller.native_reconciliation", {
          startTime: passStartedAt,
          attributes: {
            "paperclip.native_reconciliation.scoped": details.scoped,
            ...(candidates === null ? {} : { "paperclip.native_reconciliation.candidates": candidates }),
          },
        }, ROOT_CONTEXT);
        const passContext = trace.setSpan(ROOT_CONTEXT, pass);
        for (const recorded of phases) {
          const span = tracer.startSpan(
            `controller.native_reconciliation.${recorded.phase}`,
            { startTime: recorded.startedAt },
            passContext,
          );
          if (recorded.phase === failedPhase) span.setStatus({ code: SpanStatusCode.ERROR });
          span.end(recorded.endedAt);
        }
        if (details.outcome === "failed") pass.setStatus({ code: SpanStatusCode.ERROR });
        pass.end(passEndedAt);
      } catch {
        // Tracing must never change reconciliation.
      }
    },
  };
}
