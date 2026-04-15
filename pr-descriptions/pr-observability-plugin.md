# feat(observability): OpenTelemetry observability plugin for Paperclip

**Branch:** `pr/observability-plugin` (42 commits, 25 files changed, +6,133)

## Summary

Adds a full-featured OpenTelemetry observability plugin that captures traces, metrics, and structured logs for the Paperclip agent platform. Covers heartbeat run lifecycle, LLM cost tracking, issue lifecycle, cross-agent trace linking, database instrumentation, agent session streaming, health scoring, and budget governance — all exported via OTLP to any compatible backend.

## Dependency

> **This PR depends on [PR: Server infrastructure for observability plugin](pr-server-changes.md)** (`pr/server-changes` branch).
> The server-side event emission, trace context propagation, and plugin bus changes are prerequisites — merge the server PR first.

## Changes

### Plugin Scaffold & SDK Setup
- **Plugin scaffold** — New `plugins/paperclip-observability` package with manifest, worker lifecycle, and instance configuration schema.
- **OTel SDK v2 initialization** — `TracerProvider`, `MeterProvider`, and `LoggerProvider` wired through `otel-setup.ts` with OTLP/HTTP exporters and configurable flush intervals.

### Distributed Tracing
- **Heartbeat run spans** — Full span lifecycle (`agent.run.started` → `finished`/`failed`) with agent name, run ID, and status attributes.
- **Cost event GenAI spans** — LLM token usage captured as spans following OpenTelemetry GenAI semantic conventions (model, provider, token counts, cost).
- **Issue lifecycle spans** — Creation, status transitions, comments, and delegation tracked as spans with issue identifiers and project context.
- **Cross-agent trace linking** — W3C `traceparent`/`tracestate` propagation across multi-agent workflows so distributed traces span agent boundaries.
- **Tool activity child spans** — Individual tool calls nested under their parent run span for granular execution visibility.
- **Ticket change child spans** — Issue mutations linked as children of the originating heartbeat run via direct `runId` lookup.
- **Database query spans** — Lightweight instrumentation for critical-path queries (table, operation, duration).
- **Span hierarchy fixes** — Parent context fallbacks, event payload field resolution, and run span context preservation for late-arriving cost events.

### Metrics
- **Token and cost counters** — GenAI semantic convention counters for input/output tokens, total cost, and per-model/provider breakdowns.
- **Agent health scoring** — Scheduled gauge collection computing per-agent health scores from success rates, latency, and error patterns.
- **Issue/task flow counters** — `created`, `completed`, `blocked` counters with project and priority dimensions.
- **Budget and governance gauges** — Monthly spend vs. budget, pause state, and governance violation counters.
- **Operation duration histograms** — Latency distributions for key operations with normalized provider names.
- **Session streaming counters** — Chunk, status, done, and error event counters for agent streaming sessions.
- **Cardinality fixes** — Normalized error metric dimensions, removed high-cardinality `project_name` from gauges.

### Structured Logging
- **Log export via OTel Logs API** — Activity log events routed through the telemetry framework and exported as structured OTel log records.
- **Activity handlers** — Dedicated telemetry handlers for `activity.logged` events with full business context enrichment.

### Health & Diagnostics
- **Server and DB health probes** — Periodic health checks for server availability and database connectivity, exposed as metrics.
- **Agent health scoring system** — Composite health score per agent based on recent run outcomes, exported as a gauge for alerting.

### Configuration
- **Instance config schema** — All settings optional with sensible defaults: `otlpEndpoint`, `serviceName`, `enableTracing`, `enableMetrics`, `enableLogs`, `resourceAttributes`, `exportIntervalMs`.
- **`enableLogs` schema fix** — Added missing `enableLogs` to the instance config validation schema.

### Tests
- **Worker lifecycle tests** — Startup, shutdown, event routing, and configuration validation.
- **Metrics handler tests** — Counter increments, histogram recordings, and dimension correctness.
- **Activity handler tests** — Event routing, attribute extraction, and edge cases.
- **Health score tests** — Scoring algorithm, boundary conditions, and agent-level aggregation.
- **Test helpers** — Shared OTel mock providers and assertion utilities.

## Files Changed

| File | Lines | Description |
|------|-------|-------------|
| `plugins/paperclip-observability/README.md` | +122 | Setup, architecture, and configuration guide |
| `plugins/paperclip-observability/package.json` | +37 | Package manifest with OTel SDK v2 dependencies |
| `plugins/paperclip-observability/tsconfig.json` | +8 | TypeScript configuration |
| `plugins/paperclip-observability/src/index.ts` | +2 | Package entry point |
| `plugins/paperclip-observability/src/manifest.ts` | +97 | Plugin manifest with instance config schema |
| `plugins/paperclip-observability/src/worker.ts` | +953 | Core worker: event routing, lifecycle, telemetry dispatch |
| `plugins/paperclip-observability/src/otel-setup.ts` | +152 | OTel SDK v2 provider initialization and OTLP exporters |
| `plugins/paperclip-observability/src/config.ts` | +56 | Configuration types and defaults |
| `plugins/paperclip-observability/src/constants.ts` | +69 | Metric names, span names, and attribute keys |
| `plugins/paperclip-observability/src/health-score.ts` | +81 | Agent health scoring algorithm |
| `plugins/paperclip-observability/src/provider-map.ts` | +23 | LLM provider name normalization |
| `plugins/paperclip-observability/src/telemetry/index.ts` | +5 | Telemetry module barrel export |
| `plugins/paperclip-observability/src/telemetry/router.ts` | +127 | Event-to-handler routing layer |
| `plugins/paperclip-observability/src/telemetry/trace-handlers.ts` | +1,517 | Run spans, cost spans, issue spans, cross-agent linking |
| `plugins/paperclip-observability/src/telemetry/trace-utils.ts` | +27 | Shared trace context utilities |
| `plugins/paperclip-observability/src/telemetry/metrics-handlers.ts` | +356 | Token, cost, health, issue, budget, and duration metrics |
| `plugins/paperclip-observability/src/telemetry/log-handlers.ts` | +325 | Structured log record export |
| `plugins/paperclip-observability/src/telemetry/session-handlers.ts` | +448 | Agent session streaming telemetry |
| `plugins/paperclip-observability/src/telemetry/activity-handlers.ts` | +320 | Activity log event telemetry |
| `plugins/paperclip-observability/src/telemetry/db-query-handlers.ts` | +53 | Database query span instrumentation |
| `plugins/paperclip-observability/tests/worker.spec.ts` | +315 | Worker lifecycle and routing tests |
| `plugins/paperclip-observability/tests/metrics-handlers.spec.ts` | +337 | Metrics handler unit tests |
| `plugins/paperclip-observability/tests/activity-handlers.spec.ts` | +310 | Activity handler unit tests |
| `plugins/paperclip-observability/tests/health-score.spec.ts` | +145 | Health scoring algorithm tests |
| `plugins/paperclip-observability/tests/helpers.ts` | +248 | Shared test utilities and OTel mocks |
