# Observability

Paperclip ships with **opt-in** OpenTelemetry auto-instrumentation for the
server process. When activated it produces **traces only** — no metrics and no
logs are exported by this integration. The OTel packages are *optional peer
dependencies*: they are not in the default lockfile and are loaded dynamically
only when an operator turns the feature on.

When `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, none of the `@opentelemetry/*`
packages are imported and there is zero runtime overhead.

## Enabling tracing

### 1. Install the OTel peer dependencies

Install the SDK, the auto-instrumentations bundle, the resources/semconv
helpers, and **one** exporter matching your chosen OTLP protocol.

Common to every protocol:

```bash
pnpm add \
  @opentelemetry/sdk-node \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/resources \
  @opentelemetry/semantic-conventions
```

Then add the exporter for the protocol you intend to use:

| `OTEL_EXPORTER_OTLP_PROTOCOL` | Exporter package                              |
| ----------------------------- | --------------------------------------------- |
| `grpc` (default if unset)     | `@opentelemetry/exporter-trace-otlp-grpc`     |
| `http/protobuf`               | `@opentelemetry/exporter-trace-otlp-proto`    |
| `http/json`                   | `@opentelemetry/exporter-trace-otlp-http`     |

For example, for the default gRPC path:

```bash
pnpm add @opentelemetry/exporter-trace-otlp-grpc
```

### 2. Set the environment

Minimal setup:

```bash
# Required — turns the feature on. Point at your collector.
# For grpc this is the gRPC target (typically port 4317). For the HTTP
# protocols give the collector's BASE URL (typically port 4318) — the
# exporter appends /v1/traces itself.
export OTEL_EXPORTER_OTLP_ENDPOINT="http://otel-collector:4317"

# Optional — protocol. Defaults to grpc when unset.
# Valid values: grpc | http/protobuf | http/json
export OTEL_EXPORTER_OTLP_PROTOCOL="grpc"

# Optional — service identity attached to every span.
export OTEL_SERVICE_NAME="paperclip"
export OTEL_SERVICE_VERSION="2026.5.0"
```

### `service.version` resolution order

The `service.version` span attribute reports the commit the running server was
built from. The server resolves it in this order and uses the first source that
returns a value:

1. **The build stamp.** The server `build` script writes the commit SHA into
   `dist/build-info.json`. The stamp wins so the reported version tracks the
   true built commit and cannot go stale across rebuilds. The build script
   reads the commit from `git rev-parse --short HEAD` first. A Docker image
   build excludes `.git`, so the build script reads the `PAPERCLIP_BUILD_COMMIT`
   environment variable instead. Pass the built commit in that variable so the
   image stamp records the true commit.
2. **A runtime `git rev-parse --short HEAD`.** This covers `tsx src/index.ts`
   dev mode, where the server runs from the source checkout and writes no
   stamp. A failure here is not fatal.
3. **The `OTEL_SERVICE_VERSION` environment variable.** This is the fallback
   for a build with no stamp and no reachable git — for example a tarball
   build. `OTEL_SERVICE_VERSION` is a Paperclip-specific variable, not an
   OpenTelemetry SDK variable, so Paperclip controls this precedence.
4. **`"unknown"`** when no source returns a value.

The server logs the resolved `service.version` once at startup, so an operator
can confirm the value.

If `OTEL_EXPORTER_OTLP_PROTOCOL` is set to an unrecognized value, Paperclip
logs a single warning and falls back to gRPC.

If `OTEL_EXPORTER_OTLP_ENDPOINT` is set but the OTel packages are not
installed, the server logs a single diagnostic line on boot and continues
without tracing — your server stays up.

## Scope

This integration emits **traces only**. Metrics and log exporters are out of
scope and intentionally not configured here. Auto-instrumentations for
`fs`, `dns`, and `net` are disabled by default because they are too chatty
for this workload; everything else from
`@opentelemetry/auto-instrumentations-node` is on (HTTP, Express, PG, etc.).
