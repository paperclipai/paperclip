# Paperclip Observability Plugin

OpenTelemetry-based observability for Paperclip — metrics, traces, and structured logs for agents, runs, issues, and costs.

## Prerequisites

- Paperclip server with plugin support enabled
- An OpenTelemetry Collector (or any OTLP-compatible backend) reachable from the server
- Server-side trace context propagation patches (shipped in the companion server PR)

## Enabling the Plugin

1. Install plugin dependencies:

```bash
pnpm install --filter @paperclipai/plugin-paperclip-observability
```

2. Build the plugin:

```bash
pnpm --filter @paperclipai/plugin-paperclip-observability build
```

3. Register the plugin in your Paperclip instance configuration. The plugin is auto-discovered from `plugins/paperclip-observability/dist/manifest.js`.

4. Configure via instance settings (all fields optional):

| Setting | Default | Description |
|---------|---------|-------------|
| `otlpEndpoint` | `http://localhost:4318` | OTLP HTTP endpoint for the collector |
| `serviceName` | `paperclip` | `service.name` resource attribute |
| `serviceVersion` | `0.1.0` | `service.version` resource attribute |
| `exportIntervalMs` | `60000` | Metric flush interval in milliseconds |
| `enableTracing` | `true` | Distributed traces for runs and issue lifecycle |
| `enableMetrics` | `true` | Counters and histograms for agents, tokens, costs |
| `enableLogs` | `true` | Structured log export via OTel Logs API |
| `resourceAttributes` | `{}` | Extra key-value pairs on the OTel resource |

## What It Captures

### Traces

- **Heartbeat run spans** — full lifecycle of each agent heartbeat execution
- **Cost event spans** — GenAI semantic convention spans for LLM token usage
- **Issue lifecycle spans** — creation, status transitions, comments, delegation
- **Cross-agent trace linking** — W3C trace context propagation across multi-agent workflows
- **Tool activity child spans** — individual tool calls nested under run spans
- **Database query spans** — lightweight instrumentation for critical-path queries
- **Ticket change spans** — issue mutations linked as children of the originating run

### Metrics

- Token and cost counters (GenAI semantic conventions)
- Agent health scores (scheduled gauge collection)
- Issue/task flow counters (created, completed, blocked)
- Budget and governance gauges
- Operation duration histograms
- Session streaming event counters

### Logs

- Structured log records exported via the OTel Logs API
- Activity log events routed through the telemetry framework

## Architecture

```
┌─────────────────────────────────────────────┐
│  Paperclip Server                           │
│  ┌───────────────────────────────────────┐  │
│  │  Event Bus (domain events)            │  │
│  └────────────────┬──────────────────────┘  │
│                   │                         │
│  ┌────────────────▼──────────────────────┐  │
│  │  Observability Plugin (worker.ts)     │  │
│  │  ┌─────────────────────────────────┐  │  │
│  │  │  Telemetry Router               │  │  │
│  │  │  ├── trace-handlers.ts          │  │  │
│  │  │  ├── metrics-handlers.ts        │  │  │
│  │  │  ├── log-handlers.ts            │  │  │
│  │  │  ├── session-handlers.ts        │  │  │
│  │  │  ├── activity-handlers.ts       │  │  │
│  │  │  └── db-query-handlers.ts       │  │  │
│  │  └─────────────────────────────────┘  │  │
│  │  ┌─────────────────────────────────┐  │  │
│  │  │  OTel SDK v2 (otel-setup.ts)    │  │  │
│  │  │  ├── TracerProvider             │  │  │
│  │  │  ├── MeterProvider              │  │  │
│  │  │  └── LoggerProvider             │  │  │
│  │  └────────────────┬────────────────┘  │  │
│  └───────────────────┼──────────────────┘  │
└──────────────────────┼──────────────────────┘
                       │ OTLP/HTTP
              ┌────────▼────────┐
              │  OTel Collector │
              └────────┬────────┘
                       │
              ┌────────▼────────┐
              │  Backend        │
              │  (Dynatrace,    │
              │   Jaeger, etc.) │
              └─────────────────┘
```

## Server Dependencies

This plugin relies on server-side changes for full functionality:

- **Trace context propagation** — the server injects W3C `traceparent`/`tracestate` into plugin event payloads so spans can be correlated across agent boundaries
- **Database instrumentation hooks** — server-side `db-instrumentation.ts` emits query events that the plugin captures as spans
- **Event payload enrichment** — several server routes and services include `runId`, `issueId`, and agent identifiers in event payloads

These server changes are tracked in the companion server PR under the same parent task.

## Testing

```bash
pnpm --filter @paperclipai/plugin-paperclip-observability typecheck
```

Unit tests cover health scoring, metrics handlers, activity handlers, session handlers, and the worker lifecycle.
