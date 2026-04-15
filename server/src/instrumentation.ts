// Optional OpenTelemetry auto-instrumentation for HTTP / Express / PG / …
//
// Activated only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. When unset, the
// SDK is never started and the OTEL packages are only imported at module
// evaluation — no traces are emitted.
//
// Must be imported *before* any other module that should be instrumented
// (express, http, pg, etc.); `server/src/index.ts` imports it as the very
// first statement for that reason.

import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (endpoint) {
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "paperclip",
      [ATTR_SERVICE_VERSION]: process.env.OTEL_SERVICE_VERSION || "unknown",
    }),
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Skip instrumentations that generate an overwhelming volume of
        // low-value spans for a typical Paperclip workload.
        "@opentelemetry/instrumentation-fs": { enabled: false },
        "@opentelemetry/instrumentation-dns": { enabled: false },
        "@opentelemetry/instrumentation-net": { enabled: false },
      }),
    ],
  });

  sdk.start();

  const shutdown = () => {
    sdk.shutdown().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[paperclip] OpenTelemetry shutdown failed", err);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
