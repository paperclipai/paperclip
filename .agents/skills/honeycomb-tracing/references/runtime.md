# Runtime tracing setup and missing spans

Read this when configuring an authorized runtime or diagnosing absent spans.
The authoritative implementation is
[instrumentation.ts](../../../../server/src/instrumentation.ts); package versions
and the data contract live in
[Observability](../../../../doc/observability.md#enabling-tracing).

## Enable the existing bootstrap

1. Identify the actual process/image and its owning package. Inspect
   `server/package.json` for the **exact** peer versions of the OTel SDK,
   auto-instrumentations, resources, semantic conventions, and one exporter.
   Install them in the runtime that will resolve them. Avoid copying old version
   pins from sessions or adding every exporter to the application manifest.
2. Configure that process before startup. A direct US Honeycomb HTTP/protobuf
   setup uses these values:

   | Setting | Value |
   | --- | --- |
   | `OTEL_EXPORTER_OTLP_ENDPOINT` | `https://api.honeycomb.io` |
   | `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` |
   | `OTEL_EXPORTER_OTLP_HEADERS` | `x-honeycomb-team=<authorized ingest key>` |
   | `OTEL_SERVICE_NAME` | `paperclip`, or the deliberately selected service identity |

   Inject the header through the existing secret manager/process environment;
   do not paste a key into shell history or a tracked `.env`. Confirm region and
   environment from the operator's configuration. An existing collector may be
   the intended endpoint instead of direct Honeycomb ingestion.
3. For HTTP, supply the **base URL**; the exporter appends `/v1/traces`. Paperclip
   intentionally constructs HTTP exporters without an explicit URL so they read
   the standard environment variables. A signal-specific variable alone does
   not activate Paperclip: the bootstrap gate checks the generic
   `OTEL_EXPORTER_OTLP_ENDPOINT`.
4. For gRPC, use the appropriate TLS endpoint and matching exporter; the protocol
   defaults to gRPC when unset. Unknown protocol strings warn and fall back to
   gRPC. Do not accidentally pair HTTP configuration with that default.
5. Check the runtime's startup diagnostics. A missing or mismatched peer package
   leaves the server healthy **without tracing**. `instrumentationReady` settles
   before DB connections/server construction; shutdown awaits a bounded flush.
   A healthy `/api/health` alone cannot validate export.
6. Generate a small representative operation within the authorized task, allow
   the export batch to arrive, and open its actual Honeycomb spans. Verify
   service, revision, timestamps, parentage, and the expected operation. Record
   a trace link as proof; a bootstrap log line only proves initialization.

Honeycomb's [OTLP configuration](https://docs.honeycomb.io/send-data/opentelemetry/#using-the-honeycomb-opentelemetry-endpoint)
documents regions, headers, and the additional dataset header required for
Classic. Confirm current provider requirements when changing setup.

## Identify the serving version

Paperclip resolves `service.version` from the build stamp
(`dist/build-info.json`), then runtime Git, then `OTEL_SERVICE_VERSION`, then
`unknown`. The build stamp wins over a stale environment variable. Docker builds
without `.git` use `PAPERCLIP_BUILD_COMMIT` to populate the stamp.

Match the trace's version with actual runtime/deployment evidence. Record source
revision and observation time; an opaque desired release or current local HEAD
is not evidence that the running service includes a fix.

## Troubleshoot in this order

| Observation | Check |
| --- | --- |
| No results | Correct team/environment/dataset/service, exact run hash, absolute UTC range, retention, and query permissions |
| Only native/provider spans | Remove root-name restriction; inspect other trace IDs for the same run hash and controller version |
| App healthy, nothing exported | Actual process env, exact optional peers, protocol/exporter match, bootstrap diagnostic, root sampling, and authorized endpoint reachability |
| Trace ends before saved reply | Provider root excludes outer persistence; inspect `task.execution_attempt`, settlement spans, and run-log timestamps |
| Missing unfinished phase | Active spans may not export until they end; abrupt exit can lose them |
| Long manual span, no SQL children | Auto-instrumentation does not guarantee children; inspect real dependency timings rather than equating the whole span with database time |
| Query API denied, authentication works | Check query permission/plan; use the signed-in UI when available, without widening key privileges |
| Export/CSV contains only COUNT | It is an aggregate result. Inspect span details or the authorized raw-events view for event-level analysis |

The server exports traces only through this bootstrap. `fs`, `dns`, and `net`
auto-instrumentations are disabled for volume. Local performance events can
still exist with OTLP off; their presence is not an exporter health check.

When changing the bootstrap or correlation, start with the relevant tests:

```sh
pnpm exec vitest run server/src/__tests__/instrumentation.test.ts
pnpm exec vitest run server/src/services/execution-preparation-timing.test.ts
pnpm exec vitest run server/src/services/native-runtime/native-run-trace-context.test.ts
pnpm exec vitest run ui/src/lib/honeycomb-run-link.test.ts
```

Select affected checks rather than running this entire list for a read-only
diagnosis. These establish local contracts; deployment and Honeycomb ingestion
need their own evidence.
