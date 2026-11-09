import { trace, type Span } from "@opentelemetry/api";

// Closed, content-free Observability dimensions. No provider IDs or content.
export function beginSlackReceiptTiming(input: {
  operation: "add" | "remove";
  queuedAt: Date;
  receivedAt: Date | null;
}) {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) return () => {};
  let span: Span | undefined;
  try {
    span = trace.getTracer("paperclip.chat").startSpan("chat.slack.receipt", {
      attributes: {
        "paperclip.chat.receipt.operation": input.operation,
        "paperclip.chat.receipt.queue_ms": Math.max(0, Date.now() - input.queuedAt.getTime()),
      },
    });
  } catch { /* Tracing cannot prevent the reaction. */ }
  return (outcome: "confirmed" | "failed") => {
    try {
      span?.setAttribute("paperclip.chat.receipt.outcome", outcome);
      if (input.receivedAt) span?.setAttribute("paperclip.chat.receipt.delivery_age_ms", Math.max(0, Date.now() - input.receivedAt.getTime()));
    } catch { /* Tracing cannot change provider settlement. */ }
    try { span?.end(); } catch { /* Best-effort span completion. */ }
  };
}
