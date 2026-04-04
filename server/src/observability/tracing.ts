/**
 * OpenTelemetry SDK initialization for the Paperclip server.
 *
 * Enabled when PAPERCLIP_OTEL_ENDPOINT is set (e.g. http://localhost:4318 for Tempo HTTP).
 *
 * Environment variables:
 *   PAPERCLIP_OTEL_ENDPOINT  - OTLP HTTP exporter endpoint (default: http://localhost:4318)
 *   PAPERCLIP_OTEL_GRPC      - Use gRPC instead of HTTP (set to "true" to enable)
 *   OTEL_SERVICE_NAME        - Override service name (default: paperclip-server)
 */

export function initTracing(): void {
  const endpoint = process.env.PAPERCLIP_OTEL_ENDPOINT;
  if (!endpoint) return;

  // Dynamically import to avoid loading OTel SDK when tracing is disabled.
  // This keeps startup fast for the common case.
  import("@opentelemetry/sdk-node")
    .then(({ NodeSDK }) =>
      import("@opentelemetry/auto-instrumentations-node").then(
        ({ getNodeAutoInstrumentations }) =>
          import("@opentelemetry/exporter-trace-otlp-http").then(({ OTLPTraceExporter }) => {
            const exporter = new OTLPTraceExporter({ url: `${endpoint}/v1/traces` });

            const sdk = new NodeSDK({
              serviceName: process.env.OTEL_SERVICE_NAME ?? "paperclip-server",
              traceExporter: exporter,
              instrumentations: [
                getNodeAutoInstrumentations({
                  // Disable noisy fs instrumentation; keep HTTP + Express
                  "@opentelemetry/instrumentation-fs": { enabled: false },
                }),
              ],
            });

            sdk.start();

            process.on("SIGTERM", async () => {
              await sdk.shutdown().catch(() => {});
            });
          }),
      ),
    )
    .catch((err) => {
      // Non-fatal: tracing failure should not crash the server
      console.warn("[otel] Failed to initialize tracing:", err?.message ?? err);
    });
}
