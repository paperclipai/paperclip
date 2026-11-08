// Preload entry for OpenTelemetry auto-instrumentation.
//
//   node --import @paperclipai/server/otel-register dist/index.js
//   NODE_OPTIONS="--import @paperclipai/server/otel-register" paperclipai run
//
// Auto-instrumentation only patches libraries that load after the SDK starts.
// Loading this entry first starts the SDK (when OTEL_EXPORTER_OTLP_ENDPOINT is
// set) before the app's own imports run, so HTTP, Express and other library
// spans are produced with real parent/child traces. With the endpoint unset this
// is a no-op. It imports nothing but the instrumentation bootstrap, which is
// fail-open, so a missing or broken OTel install never blocks server start.

import { instrumentationReady } from "./instrumentation.js";

await instrumentationReady;
