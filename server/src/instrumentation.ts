// Optional OpenTelemetry auto-instrumentation for HTTP / Express / PG / …
//
// Activated only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. When unset, no
// OTel packages are loaded at all.
//
// The imports are dynamic and the packages are treated as optional runtime
// dependencies — self-hosters who want tracing install them explicitly.
// That keeps OTel off the default dependency graph and avoids forcing a
// lockfile bump for an opt-in feature.
//
// The exporter protocol is selected via the standard `OTEL_EXPORTER_OTLP_PROTOCOL`
// env var (per the OTLP spec):
//   - `grpc` (or unset)  → @opentelemetry/exporter-trace-otlp-grpc   [default]
//   - `http/protobuf`    → @opentelemetry/exporter-trace-otlp-proto
//   - `http/json`        → @opentelemetry/exporter-trace-otlp-http
// Any other value logs a warning and falls back to grpc.
//
// Must be imported *before* any other module that should be instrumented
// (express, http, pg, etc.); `server/src/index.ts` imports it as the very
// first statement for that reason.

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (endpoint) {
  void bootstrapOtel(endpoint);
}

type ExporterProtocol = "grpc" | "http/protobuf" | "http/json";

function resolveProtocol(): {
  protocol: ExporterProtocol;
  packageName: string;
} {
  const raw = process.env.OTEL_EXPORTER_OTLP_PROTOCOL?.trim().toLowerCase();
  switch (raw) {
    case undefined:
    case "":
    case "grpc":
      return {
        protocol: "grpc",
        packageName: "@opentelemetry/exporter-trace-otlp-grpc",
      };
    case "http/protobuf":
      return {
        protocol: "http/protobuf",
        packageName: "@opentelemetry/exporter-trace-otlp-proto",
      };
    case "http/json":
      return {
        protocol: "http/json",
        packageName: "@opentelemetry/exporter-trace-otlp-http",
      };
    default:
      // eslint-disable-next-line no-console
      console.warn(
        `[paperclip] Unknown OTEL_EXPORTER_OTLP_PROTOCOL=${raw}; falling back to grpc. ` +
          `Valid values: grpc, http/protobuf, http/json.`,
      );
      return {
        protocol: "grpc",
        packageName: "@opentelemetry/exporter-trace-otlp-grpc",
      };
  }
}

async function importExporter(protocol: ExporterProtocol): Promise<{
  OTLPTraceExporter: new (config: { url: string }) => unknown;
}> {
  switch (protocol) {
    case "grpc":
      // @ts-ignore optional peer dep
      return await import("@opentelemetry/exporter-trace-otlp-grpc");
    case "http/protobuf":
      // @ts-ignore optional peer dep
      return await import("@opentelemetry/exporter-trace-otlp-proto");
    case "http/json":
      // @ts-ignore optional peer dep
      return await import("@opentelemetry/exporter-trace-otlp-http");
  }
}

async function bootstrapOtel(endpoint: string): Promise<void> {
  const { protocol, packageName: exporterPackage } = resolveProtocol();

  try {
    // Dynamic imports so type-resolution doesn't require the packages to
    // be installed unless the operator actually opts in.
    const [sdkNode, autoInstr, traceExporter, resources, semconv] =
      await Promise.all([
        // @ts-ignore optional peer dep
        import("@opentelemetry/sdk-node"),
        // @ts-ignore optional peer dep
        import("@opentelemetry/auto-instrumentations-node"),
        importExporter(protocol),
        // @ts-ignore optional peer dep
        import("@opentelemetry/resources"),
        // @ts-ignore optional peer dep
        import("@opentelemetry/semantic-conventions"),
      ]);

    const { NodeSDK } = sdkNode;
    const { getNodeAutoInstrumentations } = autoInstr;
    const { OTLPTraceExporter } = traceExporter;
    const { resourceFromAttributes } = resources;
    const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = semconv;

    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "paperclip",
        [ATTR_SERVICE_VERSION]: process.env.OTEL_SERVICE_VERSION || "unknown",
      }),
      traceExporter: new OTLPTraceExporter({ url: endpoint }),
      instrumentations: [
        getNodeAutoInstrumentations({
          // Too chatty for this workload.
          "@opentelemetry/instrumentation-fs": { enabled: false },
          "@opentelemetry/instrumentation-dns": { enabled: false },
          "@opentelemetry/instrumentation-net": { enabled: false },
        }),
      ],
    });

    try {
      sdk.start();
    } catch (err) {
      // A bad gRPC endpoint, missing native bindings, or a collector that
      // rejects the SDK's handshake should not take down the server.
      // eslint-disable-next-line no-console
      console.error(
        "[paperclip] OpenTelemetry SDK failed to start; continuing without tracing",
        err,
      );
      return;
    }

    const shutdown = () => {
      sdk.shutdown().catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[paperclip] OpenTelemetry shutdown failed", err);
      });
    };
    // Use `once` so a repeated signal doesn't call shutdown twice (which
    // would log a spurious second error).
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  } catch (err) {
    // OTel packages not installed, or dynamic import failed. Fall through
    // with a single diagnostic so the opt-in path is self-documenting.
    // eslint-disable-next-line no-console
    console.warn(
      "[paperclip] OTEL_EXPORTER_OTLP_ENDPOINT is set but the @opentelemetry/* " +
        `packages are not installed. Install @opentelemetry/sdk-node, ` +
        `@opentelemetry/auto-instrumentations-node, ${exporterPackage}, ` +
        `@opentelemetry/resources, and @opentelemetry/semantic-conventions to enable tracing.`,
      err,
    );
  }
}
