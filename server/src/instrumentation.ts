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
// Timing guarantee: the bootstrap is async (dynamic imports), so it cannot
// patch modules "before they are evaluated" — by the time the first await
// yields, index.ts's static imports (http, express, pg) are already loaded.
// What this module guarantees instead is `instrumentationReady`: the SDK has
// started (or failed and logged) before that promise resolves. index.ts
// awaits it at the top of `startServer()`, so tracing is active before any
// DB connection is opened or the HTTP server is constructed — the patching
// that matters happens at call time, not import time. Spans are flushed on
// exit via `shutdownInstrumentation()`, which index.ts awaits in its signal
// handler before `process.exit`.

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

let sdkShutdown: (() => Promise<void>) | null = null;
let shutdownPromise: Promise<void> | null = null;

/**
 * Resolves once the OTel SDK has started (or once bootstrap has failed and
 * logged, or immediately when the feature is off). Await before constructing
 * the HTTP server so trace coverage doesn't depend on incidental timing.
 */
export const instrumentationReady: Promise<void> = endpoint
  ? bootstrapOtel(endpoint)
  : Promise.resolve();

/**
 * Flush buffered spans and stop the SDK. Idempotent — concurrent callers
 * share one shutdown. No-op when tracing is off or bootstrap failed.
 */
export function shutdownInstrumentation(): Promise<void> {
  shutdownPromise ??= (async () => {
    await instrumentationReady;
    if (!sdkShutdown) return;
    try {
      // Awaiting matters: the SDK flushes buffered spans to the collector
      // during shutdown; exiting before it settles silently drops them.
      await sdkShutdown();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[paperclip] OpenTelemetry shutdown failed", err);
    }
  })();
  return shutdownPromise;
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

    sdkShutdown = () => sdk.shutdown();
    // index.ts awaits shutdownInstrumentation() in its own signal handler
    // before process.exit, which is what actually guarantees the flush.
    // These handlers are a backstop for entrypoints that import this module
    // without coordinating; shutdownInstrumentation() is idempotent, so the
    // two paths share a single flush.
    process.once("SIGTERM", () => void shutdownInstrumentation());
    process.once("SIGINT", () => void shutdownInstrumentation());
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
