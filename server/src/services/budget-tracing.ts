import { trace, type Span } from "@opentelemetry/api";

/** Operator-gated OpenTelemetry only; these spans contain no prompt, receipt,
 * credential, or provider error text. Diagnostics never change accounting. */
export async function withBudgetSpan<T>(name: string, work: () => Promise<T>, attributes?: Record<string, number | boolean>) {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) return work();
  let operation: Promise<T> | undefined;
  const run = (span?: Span) => operation ??= Promise.resolve().then(work).finally(() => {
    try { span?.end(); } catch { /* Diagnostics cannot change accounting. */ }
  });
  try {
    const traced = trace.getTracer("paperclip.budgets").startActiveSpan(name, { attributes }, span => run(span));
    // Some external SDK implementations can fail before or after the callback.
    // Own the accounting promise so either failure still executes work once.
    void Promise.resolve(traced).catch(() => undefined);
  } catch { /* Preserve the accounting operation if span creation fails. */ }
  return operation ?? run();
}
