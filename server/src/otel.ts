import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { PostgresInstrumentation } from "otel-instrumentation-postgres";

const OTEL_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4317";

const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME ?? "paperclip-server",
  traceExporter: new OTLPTraceExporter({ url: OTEL_ENDPOINT }),
  instrumentations: [new PostgresInstrumentation()],
});

sdk.start();

process.on("SIGTERM", () => {
  void sdk.shutdown();
});
