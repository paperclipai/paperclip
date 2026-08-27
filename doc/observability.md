# Observability

This document is the Observability contract. It covers the OpenTelemetry
trace path, the opt-in Sentry error-monitoring path, and two local
instrumentation contracts; see the
[Telemetry Data Contract](../packages/shared/src/telemetry/README.md) for the
separate first-party event system.

Paperclip ships with **opt-in** OpenTelemetry auto-instrumentation for the
server process. When activated it produces **traces only** — no metrics and no
logs are exported by this integration.

`@opentelemetry/api` is a normal dependency of `@paperclipai/server`. Every
install includes it. It stays a no-op interface until an SDK registers a
provider, so it exports no telemetry by itself.

The SDK, the auto-instrumentation bundle, and the resources and
semantic-conventions helpers are *optional peer dependencies*: they are not in
the default lockfile, and the server loads them dynamically only when an
operator turns the feature on. The three exporters below are mutually
alternative peer dependencies — install exactly **one**, matching
`OTEL_EXPORTER_OTLP_PROTOCOL`.

When `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, none of the `@opentelemetry/*` SDK
packages are imported and there is zero runtime overhead.

`server/package.json` declares each optional package at the exact version the
server tests against; install that exact version. Our Dependabot cannot bump
these versions: its npm parser reads only `dependencies`, `devDependencies`,
and `optionalDependencies`, never `peerDependencies`. A peer version here is a
compatibility claim, not an installed version, so raising it is a human
decision. `@opentelemetry/api` is the one OpenTelemetry package Paperclip
maintains as a dependency; once you install the packages below, they become
normal dependencies of **your own** project, and your own Dependabot updates
them.

## Enabling tracing

### 1. Install the OTel peer dependencies

Install the SDK, the auto-instrumentations bundle, the resources/semconv
helpers, and **one** exporter matching your chosen OTLP protocol, at the exact
versions below.

Common to every protocol:

```bash
pnpm add \
  @opentelemetry/sdk-node@0.221.0 \
  @opentelemetry/auto-instrumentations-node@0.79.0 \
  @opentelemetry/resources@2.10.0 \
  @opentelemetry/semantic-conventions@1.43.0
```

Then add the exporter for the protocol you intend to use:

| `OTEL_EXPORTER_OTLP_PROTOCOL` | Exporter package                           | Version   |
| ------------------------------ | ------------------------------------------- | --------- |
| `grpc` (default if unset)      | `@opentelemetry/exporter-trace-otlp-grpc`   | `0.221.0` |
| `http/protobuf`                | `@opentelemetry/exporter-trace-otlp-proto`  | `0.221.0` |
| `http/json`                    | `@opentelemetry/exporter-trace-otlp-http`   | `0.221.0` |

For example, for the default gRPC path:

```bash
pnpm add @opentelemetry/exporter-trace-otlp-grpc@0.221.0
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

Before it imports any OTel package, the server checks the four common
packages and the selected exporter against the exact versions
`server/package.json` declares. If `OTEL_EXPORTER_OTLP_ENDPOINT` is set and a
package is missing or installed at a different version, the server logs one
diagnostic line on boot and continues without tracing — your server stays up.

## Scope

The OpenTelemetry export carries **traces only**. Metrics and log exporters
are out of scope and intentionally not configured here. Auto-instrumentations
for `fs`, `dns`, and `net` are disabled by default because they are too chatty
for this workload; everything else from
`@opentelemetry/auto-instrumentations-node` is on (HTTP, Express, PG, etc.).

This document also holds two local instrumentation contracts: the sandbox
startup trace spans, and the sandbox duplex transport instrumentation. Both
sections follow below.

## Sentry Error Monitoring

Paperclip ships with **opt-in** Sentry error monitoring for the server
process and the browser app. The operator activates it with one
environment variable, `SENTRY_DSN`. The server and the browser both read
this same value, so both report to **one** Sentry project. The feature
uses built-in Sentry options only. It adds no `beforeSend` hook and no
custom filter code.

When `SENTRY_DSN` is unset, the feature is fully inactive. The server
imports no Sentry package. The browser fetches no Sentry chunk.

### Enabling Sentry

#### 1. Install the Sentry peer dependency

Install `@sentry/node` in the server, the same way you install the
OpenTelemetry packages above. `@sentry/node` is an *optional peer
dependency*: it is not in the default lockfile, and the server loads it
dynamically only when `SENTRY_DSN` is set.

```bash
pnpm add @sentry/node
```

The browser package, `@sentry/browser`, needs no install step. It is
already a development dependency of the `ui` package, so the browser code
ships inside every build. A signed-out browser, or a browser with no DSN,
never fetches the Sentry chunk — see "DSN delivery to the browser" below.

#### 2. Set the environment

```bash
export SENTRY_DSN="https://<public-key>@<host>/<project-id>"
```

No other variable is needed.

### One Sentry project

The server and the browser report to **one** Sentry project, because both
read the same `SENTRY_DSN` value. The server reads it from the process
environment. The browser reads it from the authenticated
`GET /api/auth/get-session` response.

### DSN delivery to the browser

The browser never reads the DSN from a `<meta>` tag or from any other part
of `index.html`. The served `index.html` holds no DSN — it is a static
file, built once and served unchanged to every request.

Instead, the browser receives the DSN inside the authenticated
`GET /api/auth/get-session` response body, next to the signed-in session
and the user profile. A signed-out browser calls this route with no board
actor, so the route answers 401 and sends no DSN. A signed-out browser
therefore loads no Sentry chunk and sends no event. These pages run
signed out:

- `/auth`
- `/cli-auth/:id`
- `/board-claim/:token`
- `/invite/:token`

**A gap the operator must know:** a browser error that happens before the
session response arrives is not captured. The gate opens only after the
session query resolves.

### Privacy settings

The feature uses built-in Sentry options only.

- `sendDefaultPii` is `false`, on both runtimes.
- `tracesSampleRate` is `0`, on both runtimes. Paperclip sends no
  performance trace and no profile.
- There is no `beforeSend` hook and no custom filter, on either runtime.

### Server request data

**A server event carries no request data at all.** It holds no URL, no
method, no header, no cookie, no query string, and no body. This is a
verified result, not the Sentry SDK's documented default. A live test
against the real `@sentry/node@10.71.0` package proves it: it captures an
event from inside a real HTTP request handler and confirms the event
holds no request field (see `server/src/__tests__/sentry.test.ts`, "a
server event captured inside a real HTTP request handler carries no
request field").

The reason is `skipOpenTelemetrySetup: true`. This feature sets that
option so it never fights Paperclip's separate, independently opt-in
OpenTelemetry feature for control of the global tracer. The same option
turns off Sentry's per-request context tracking. Sentry's built-in
`RequestData` integration needs that tracking to find a URL, a method, a
header set, a cookie set, or a query string to attach. `RequestData`
stays in the integration list — the initializer does not remove it — but
it attaches nothing under this configuration.

This holds even when the operator turns on the separate OpenTelemetry
feature too (`OTEL_EXPORTER_OTLP_ENDPOINT` set). A live test with a real
OpenTelemetry SDK, a real HTTP instrumentation package, and a real
async-context manager registered still shows no request field on the
captured event.

A server event carries only the exception, its stack trace, and the
context the other kept default integrations add: the host name, the
runtime version, and the dependency list. See "Default capture set"
below.

### Browser data

The browser sends no page URL, no referrer, no user agent, and no
breadcrumb.

### Fail-open behavior

A failed Sentry import or a failed init never stops the server and never
breaks the browser app. Both runtimes fall through to a single diagnostic
log line and keep running with no error monitoring.

### Default capture set

The lists below name every event and every context field this feature
sends, so an operator can read what the feature does before turning it on.
Each Sentry integration name below is verified against the default
integration list of `@sentry/node@10.71.0` and `@sentry/browser@10.71.0`.

**Server events this feature adds**

- An Express `HttpError` with `status >= 500`.
- Any unknown throw that is not a `ZodError`. It always answers 500.
- A server startup failure.

**Server events the default integrations add**

- `OnUncaughtException` — each uncaught exception on the main thread, at
  level `fatal`. The process still exits.
- `OnUnhandledRejection` — each unhandled promise rejection. The mode is
  `strict`, so the process exits after the capture.
- `ChildProcess` — one event for each worker-thread `error`.
- `LinkedErrors` — the `error.cause` chain of each captured error.

**Server context the kept integrations attach**

- `RequestData` — attaches nothing under this feature's configuration. See
  "Server request data" above for the verified reason.
- `ChildProcess` — a non-zero child-process exit becomes a breadcrumb.
- `Modules` and `Context` — the dependency list, the host name, the
  operating system, and the runtime version.
- `ProcessSession` — one release-health session for each process.
- `LocalVariablesAsync` — off. It needs `includeLocalVariables: true`,
  which this feature omits.
- `NodeSystemError` — a Node system error (for example, `ENOENT`) gets a
  `node_system_error` context field with its error code. The `path` and
  `dest` fields are removed by default.

**Server sources this feature removes**

- `Console` — raw `console.*` arguments.
- `ContextLines` — 7 local source lines around each stack frame.
- The outbound breadcrumb of `Http` — outbound request URLs and query
  strings.

**Browser events this feature adds**

- A crash in the application error boundary and a crash in the route
  error boundary.

**Browser events and context the kept integrations add**

- `GlobalHandlers` — `window.onerror` and `window.onunhandledrejection`.
- `BrowserApiErrors` — a throw inside `setTimeout`, `setInterval`,
  `requestAnimationFrame`, and an event listener.
- `CultureContext` — the locale and the timezone.
- `Dedupe`, `LinkedErrors`, and `BrowserSession`.

**Browser sources this feature removes**

- `HttpContext` — the page URL, the referrer, and the user agent.
- `Breadcrumbs` — console output, a click and a keypress target, a
  `fetch` and an `XHR` request URL, and history navigation.

**Not captured on either runtime**

- A Zod validation error, which answers 400.
- Each `HttpError` below status 500, such as 401, 403, 404, 409, and 422.
- A performance trace and a profile, because `tracesSampleRate` is 0.

### Operator responsibilities

Two controls belong to the operator. This feature ships neither one.

1. **Set a rate limit and a quota alert.** Set a per-client-key ingestion
   rate limit and a quota alert in the Sentry project. The feature sends
   no built-in rate limit of its own.
2. **Give a self-hosted sink a reachable host name.** If `SENTRY_DSN`
   points at a self-hosted Sentry instance, give it an externally
   reachable ingest host name, not an internal-only host name. The
   browser sends its events from the operator's network, not from the
   server's network, so an internal-only host name fails silently for
   the browser even when it works for the server.

## Sandbox Startup Trace Spans

Paperclip opens OpenTelemetry spans on the sandbox start path. These spans are
an Observability surface. They are not Paperclip Telemetry events. The
generated telemetry contract does not cover them, so this section is their
canonical contract.

The spans are opt-in. Paperclip exports them only when an OTLP endpoint is
configured. With no endpoint the whole span path is a no-op. Paperclip opens the
spans only for a run that targets a remote sandbox. A local run and an SSH run
stay out of these spans.

Every span attribute uses the closed `paperclip.sandbox.startup.` prefix and
rides a fixed allowlist. A command line, an argument, an environment value, a
file path, program output, or a raw identifier never rides a span. It rides
neither as an attribute nor as an event. The producer bounds each free-form
value:

- A command basename maps to a small known set. Any other value maps to `other`.
- A region maps to a small known set. Any other value maps to `unknown`.
- An image id, a sandbox id, and a lease id ride only as a non-reversible short
  hash.

Each numeric attribute is finite. Paperclip omits an attribute when its value is
absent, never a misleading `0`.

### Spans

| Span | Scope | Parent |
| --- | --- | --- |
| `sandbox.startup` | The one root span for a sandbox bring-up. | none (root) |
| `workspace.resolve` | Workspace resolution step. | `sandbox.startup` |
| `codex-home.seed` | Managed-home seed step. | `sandbox.startup` |
| `skills.reconcile` | Skills reconcile step. | `sandbox.startup` |
| `stage.sync` | Workspace stage-sync step. | `sandbox.startup` |
| `snapshot.git` | Host-side git workspace enumeration inside `stage.sync` (`git status --ignored`, the HEAD diffs, `ls-files`). | `stage.sync` |
| `snapshot.baseline` | Host-side baseline workspace content-hash walk inside `stage.sync`, kept for restore. | `stage.sync` |
| `stage.workspace` | One inbound workspace stage task inside `stage.sync`. It packs and uploads the workspace. | `stage.sync` |
| `stage.asset.<key>` | One inbound asset stage task inside `stage.sync`. It packs and uploads one managed-home asset. The `<key>` segment is the asset key. | `stage.sync` |
| `stage.project.<id>` | One inbound referenced-project stage task inside `stage.sync`. It uploads one referenced project. The `<id>` segment is the project id. | `stage.sync` |
| `pack` | Host-side workspace tarball build inside the `stage.workspace` task. | `stage.workspace` |
| `bridge.paperclip` | Paperclip bridge start step. | `sandbox.startup` |
| `bridge.process-session` | Process-session bridge start step. | `sandbox.startup` |
| `acp.handshake` | ACP session handshake step. | `sandbox.startup` |
| `sandbox.syncBack` | The settlement sync-back that restores the managed home at teardown. | the active run span |
| `restore.workspace` | One outbound workspace restore task at teardown. It reads the sandbox workspace back and merges it into the host workspace. | `sandbox.syncBack` |
| `restore.asset.<key>` | One outbound asset restore task at teardown. It reads one asset back to its host store. The `<key>` segment is the asset key. | `sandbox.syncBack` |
| `sandbox.agentSession.sendInput` | One outbound ACP message to the agent — the socket handler's one `writeTextFile` exec. | the active run span |
| `sandbox.agentSession.pollOutput` | One 100 ms poll tick — `list`, then `read`+`remove` per file found (`1 + 2n` execs). | the active run span |
| `sandbox.callbackBridge.relayRequest` | One Paperclip-API callback request — read the request, write the response, remove it. | the active run span |
| `sandbox.agentProcess` | The persistent streamed agent process the process-session bridge launches; open until the process settles or the bridge tears down, whichever comes first. | the active run span |
| `sandbox.exec` | One host-to-sandbox execution. | the active step or wrapper span |

A step span name is the step name. The `sandbox.exec` span parents to the step
span that runs the execution, so each execution nests under its step. Within
`stage.sync`, the host-side sub-steps `snapshot.git` and `snapshot.baseline` open
as child spans of the step, so the host work at the head of the step is
attributed rather than showing as a gap. Each inbound sync operation also opens
its own task span under `stage.sync`: `stage.workspace`, one `stage.asset.<key>`
per asset, and one `stage.project.<id>` per referenced project. The `pack` span
nests under `stage.workspace`, because the host builds the tarball inside that
task. Two concurrent tasks produce overlapping spans.

The settlement `sandbox.syncBack` span runs at teardown and parents to the run
span. It wraps the managed-home restore. Each outbound restore operation opens
its own task span under `sandbox.syncBack`: `restore.workspace` and one
`restore.asset.<key>` per asset. Two concurrent restore tasks produce overlapping
spans. A run-time
`sandbox.exec` span parents instead to the run-time wrapper span that runs it
(`sandbox.agentSession.sendInput`, `sandbox.agentSession.pollOutput`,
`sandbox.callbackBridge.relayRequest`, or `sandbox.agentProcess`). Each run-time
wrapper span parents to the live run span (`agent.turn` during the turn,
`task.run` otherwise). With no active trace context the exec span opens
unparented.

`sandbox.agentProcess` wraps the persistent streamed agent process. The
process-session bridge launches it during `bridge.process-session`, so it opens
under `task.run` — no turn has started yet. It therefore overlaps the sibling
`agent.turn` rather than nesting under it or dangling off the short-lived bring-up
step. The span ends when the process settles or when the bridge tears down,
whichever comes first. The bridge tears down before the run root span ends, so
the span never outlives `task.run` even when the process lingers past teardown
(the sandbox `execute` has no cancel, so a lingering process cannot be forced to
resolve).

The root span sets the error status when the bring-up fails. Each step span sets
the error status when its step fails. The `sandbox.exec` span sets the error
status when the exit code is non-zero or the execution throws.

### Outcome values

The `paperclip.sandbox.startup.outcome` attribute uses a closed value set:

- `ok` — the step or the execution settled with a success result.
- `skipped` — a warm cache skipped the step; the step ran no work.
- `failed` — the step or the execution threw, or the exit code was non-zero.

### Root span attributes

The `sandbox.startup` root span uses this closed attribute allowlist.

| Attribute | Type | Optional | Meaning |
| --- | --- | --- | --- |
| `paperclip.sandbox.startup.root.wall_ms` | number | no | The root-span wall time of the whole bring-up. |
| `paperclip.sandbox.startup.root.work_ms` | number | no | The sum of the step wall times. |
| `paperclip.sandbox.startup.root.diff_ms` | number | no | `work_ms − wall_ms`; the overlap the parallel steps saved. |
| `paperclip.sandbox.startup.provider` | string | yes | The normalized provider family. |
| `paperclip.sandbox.startup.cold_start` | boolean | yes | Whether the bring-up is a cold start. |
| `paperclip.sandbox.startup.region` | string | yes | The clamped region label. |
| `paperclip.sandbox.startup.image_id` | string | yes | The hashed image id. |
| `paperclip.sandbox.startup.sandbox_id` | string | yes | The hashed sandbox id. |
| `paperclip.sandbox.startup.lease_id` | string | yes | The hashed lease id. |

### Step span attributes

Each bring-up step span uses this closed attribute allowlist. The step name
rides the span name, so no `step` attribute repeats it.

| Attribute | Type | Optional | Meaning |
| --- | --- | --- | --- |
| `paperclip.sandbox.startup.step.wall_ms` | number | no | The wall time of the step. |
| `paperclip.sandbox.startup.outcome` | string | no | The step outcome (`ok`, `skipped`, or `failed`). |
| `paperclip.sandbox.startup.provider` | string | yes | The normalized provider family. |
| `paperclip.sandbox.startup.batch` | string | yes | A shared tag that marks two parallel steps as one batch. |
| `paperclip.sandbox.startup.handshake.create_runtime.wall_ms` | number | yes | The create-runtime sub-time of the `acp.handshake` step. |
| `paperclip.sandbox.startup.handshake.ensure_session.wall_ms` | number | yes | The ensure-session sub-time of the `acp.handshake` step. |

The round-trip count and the provider durations no longer ride a step span. The
per-execution `sandbox.exec` child spans carry that detail.

### `sandbox.exec` span attributes

The `sandbox.exec` span uses this closed attribute allowlist. Paperclip omits a
numeric attribute when the provider does not report the value.

| Attribute | Type | Optional | Meaning |
| --- | --- | --- | --- |
| `paperclip.sandbox.startup.provider` | string | no | The normalized provider family. |
| `paperclip.sandbox.startup.exec.command` | string | no | The clamped `argv[0]` command label. |
| `paperclip.sandbox.startup.exec.exit_code` | number | yes | The numeric process exit code. |
| `paperclip.sandbox.startup.exec.wall_ms` | number | no | The host-measured wall time of the execution. |
| `paperclip.sandbox.startup.exec.wait_before_ms` | number | yes | The provider handle-fetch wait before the execution ran. |
| `paperclip.sandbox.startup.exec.sandbox_ms` | number | yes | The in-sandbox run time of the execution. |
| `paperclip.sandbox.startup.exec.network_ms` | number | yes | The transport time the host adds; `wall_ms − wait_before_ms − sandbox_ms`. |
| `paperclip.sandbox.startup.exec.critical_path` | boolean | no | Whether the execution sits on the startup critical path. |
| `paperclip.sandbox.startup.exec.cache_hit` | boolean | yes | Whether the provider served the sandbox handle from its warm cache. |
| `paperclip.sandbox.startup.outcome` | string | no | The execution outcome (`ok` or `failed`). |

The plugin decides the cache hit at the sandbox-handle lookup. The span no
longer infers a cache hit from `wait_before_ms == 0`. Paperclip omits the
`cache_hit` attribute when the provider does not report the value.

To add a span attribute, extend the `SANDBOX_STARTUP_SPAN_ATTRS` allowlist in
the code first. Keep the attribute low-cardinality and free of user content.

### Provider spans

A sandbox provider plugin also opens spans for its own sync steps. These spans
use the `sandbox.daytona.` name prefix. They share the
`paperclip.sandbox.startup.` attribute prefix and obey the same opt-in and
no-user-content rules as the startup spans above.

The plugin worker runs in a separate process from the host. So the host treats
every field of a worker-sent span as untrusted input. The host re-clamps the
span name and every attribute at one boundary, the `span.record` host handler,
before it records the span.

| Span | Scope | Parent |
| --- | --- | --- |
| `sandbox.daytona.pack` | The host-local pack step that builds the upload tarball. It makes no sandbox round trip. | the active startup step span |
| `sandbox.daytona.transfer` | The transfer step: an upload to the sandbox (inbound) or a download from the sandbox (outbound). The `paperclip.sandbox.startup.transfer.direction` attribute records the direction. | the active sync task span (`stage.*` inbound, `restore.*` under `sandbox.syncBack` outbound) |
| `sandbox.daytona.ensureDirectory` | The `mkdir -p` step that ensures a directory exists before a write. | the active startup step span |
| `sandbox.daytona.checkSymlinkEscape` | The re-check step that a path resolves inside the workspace root before use. | the active startup step span |
| `sandbox.daytona.promote` | The atomic move of a staged temp onto its target via a pinned dir handle. | the active startup step span |
| `sandbox.daytona.extractTarball` | The one round trip that re-checks the path, runs `tar -xf`, and removes the scratch tarball. | the active startup step span |
| `sandbox.daytona.postUploadCommand` | One caller-supplied post-upload command. | the active startup step span |
| `sandbox.daytona.session.open` | The create of the one persistent session for a lease, on the first in-run command. | the active run span |
| `sandbox.daytona.session.close` | The delete of that persistent session on lease release. | the active run span |
| `sandbox.daytona.other` | Any span name outside the known set. | the active startup step span |

The host clamps the span name to the closed set of leaf names above (`pack`,
`transfer`, `ensureDirectory`, `checkSymlinkEscape`, `promote`, `extractTarball`,
`postUploadCommand`, `session.open`, and `session.close`). The host maps a known
name to `sandbox.daytona.<name>`. The host maps any other value to
`sandbox.daytona.other`, so a span name never carries free-form data. Only the
daytona provider emits these spans today, so the segment is the literal
`daytona`.

The `sandbox.daytona.*` spans use this closed attribute allowlist. The host
drops every other key, so a command, an argument, a path, an id, a standard
output, or a standard error never rides a provider span. The host records only
the attributes that the producer sends for one span.

| Attribute | Type | Optional | Meaning |
| --- | --- | --- | --- |
| `paperclip.sandbox.startup.provider` | string | no | The normalized provider family. |
| `paperclip.sandbox.startup.outcome` | string | yes | The step outcome (`ok`, `skipped`, or `failed`). |
| `paperclip.sandbox.startup.pack.wall_ms` | number | yes | The host-local wall time of the pack step. It rides the `sandbox.daytona.pack` span. |
| `paperclip.sandbox.startup.transfer.wall_ms` | number | yes | The wall time of the transfer step. It rides the `sandbox.daytona.transfer` span. |
| `paperclip.sandbox.startup.transfer.guard.count` | number | yes | The number of serial guard round trips before one transfer. It rides the `sandbox.daytona.transfer` span. |
| `paperclip.sandbox.startup.transfer.direction` | string | yes | The transfer direction (`inbound` or `outbound`). It rides the `sandbox.daytona.transfer` span. |

The `span.record` host handler enforces the allowlist. It re-maps `provider`
through the provider-family normalizer. It keeps `outcome` only when the value
is `ok`, `skipped`, or `failed`. It keeps `transfer.direction` only when the
value is `inbound` or `outbound`. It keeps a numeric attribute only when the
value is a finite number. It drops a status message and keeps only the numeric
status code. The handler never throws, because observability must not change the
sync control flow.

The `span.record` host method needs the `environment.drivers.register`
capability. So only a plugin that registers an environment driver may emit a
provider span. The capability gate rejects a provider span from any other
plugin.

The host parents each provider span to the active sync task span. An inbound
transfer runs inside a `stage.*` task span, so its provider spans parent there.
An outbound transfer runs inside a `restore.*` task span under `sandbox.syncBack`
at teardown, so its provider spans parent there. The host mints a W3C
`traceparent` from the active task span and passes it to the plugin worker on the
per-call invocation channel. The teardown restore runs inside the run-parented
`sandbox.syncBack` span, so the host mints a `traceparent` for an outbound
provider span the same way it does for an inbound one. The worker tags its span with the
`traceparent` and treats the value as opaque. The worker never derives the
parent from it. The host recovers the `traceparent` from its own invocation
record, so a worker can never forge a parent. The host validates the
`traceparent` and rejects a missing or malformed value. With no active host
trace context the worker sends no span, so the whole provider-span path is a
no-op.

## Sandbox Duplex Transport Instrumentation

This section documents one duplex transport with three sinks: an
OpenTelemetry span, a counter in the `tool_runtime_metric_counters` table, and
one run-log event.

Paperclip opens a fixed observability surface for the sandbox duplex transport.
This instrumentation is separate from Paperclip Telemetry events and from the
sandbox startup trace spans above. The generated telemetry contract does not
cover it, so this section is its canonical contract. The code owner is
`packages/adapter-utils/src/duplex-observability.ts`. That module holds each name and
each enum value as a literal constant, so the surface never drifts.

The surface is opt-in. The host injects a recorder that binds the span to the
OTel tracer, the counter to the guarded counter store in
`server/src/services/tool-runtime-metrics.ts`, and the event to the run-events
bridge. The default recorder is a no-op, so the whole surface stays inert until
the host binds a real recorder. Every recorder call sits inside an error swallow,
so a telemetry failure never breaks the request path.

The surface carries no user content. No route, no query, no request body, no
token, and no raw identifier rides a span, a counter, or an event. Each record
carries only the closed dimension keys below and, for the request span, a
latency. The `provider` dimension carries only the allowlisted public value
`daytona`. Any other plugin key maps to `other` before the record reaches a sink,
so a raw plugin key never reaches a span attribute, a counter label, or an event
field.

### Spans

| Span | Scope | Latency |
| --- | --- | --- |
| `sandbox.duplex.channel_open` | One duplex channel-open attempt. The `outcome` dimension is `ok` when the channel opened and readiness passed, or `error` when the open or readiness failed. | none |
| `sandbox.duplex.request` | One duplex request the broker forwarded to the host. | The request latency in milliseconds. |

### Event

| Event | Scope |
| --- | --- |
| `sandbox.duplex.transport` | The host emits it at each transport boundary: a ready duplex channel, a fallback to the file bridge, and a terminal channel loss. Its dimensions record the boundary. |

### Counters

| Counter | Scope |
| --- | --- |
| `sandbox_duplex_channel_open_total` | One successful duplex channel open. |
| `sandbox_duplex_fallback_total` | One fallback to the file bridge. The `fallback_reason` dimension records the cause. |
| `sandbox_duplex_loss_total` | One terminal duplex channel loss. The `loss_class` dimension records the phase. |
| `sandbox_duplex_session_leak_total` | One leaked provider session at teardown. |

### Aggregate byte ledger metrics

The host aggregate byte ledger owns one process-scoped gauge and two
process-scoped counters. The ledger bounds the retained bytes across every live
duplex route in one process. It sets the gauge on each reserve and each release.
It increments a counter on a rejected reservation and on an accounting defect.
These records carry no dimension label. The guarded counter store keys each
counter on `(companyId, metric)`, and the gauge reports one process value, so no
dynamic dimension rides them. The code owner is
`packages/adapter-utils/src/duplex-aggregate-byte-ledger.ts`, and the metric
names are literal constants in `duplex-observability.ts`.

| Metric | Type | Scope |
| --- | --- | --- |
| `sandbox_duplex_aggregate_bytes_in_use` | gauge | The aggregate retained bytes across every live duplex route. The ledger sets it on each reserve and each release. |
| `sandbox_duplex_aggregate_byte_reservation_rejections_total` | counter | One rejected aggregate byte reservation. The ledger increments it when a reservation would pass the aggregate ceiling. |
| `sandbox_duplex_aggregate_byte_accounting_underflow_total` | counter | One aggregate byte accounting defect. The ledger increments it on a double release or on a transfer of a token it does not hold. |

### Dimension keys

Counters carry no dimension labels. The guarded counter store keys each counter
on `(companyId, metric)` with no label column, so the `fallback_reason` and
`loss_class` values fold into the counter metric name instead. The full closed
dimension set below rides only the spans and the `sandbox.duplex.transport`
event, which use only these closed keys. A test asserts the exact set, so a new
key never reaches a sink by accident.

| Key | Type | Optional | Value set |
| --- | --- | --- | --- |
| `provider` | string | no | `daytona`, or `other` for any other plugin key. |
| `transport` | string | no | `duplex`, `http2`, or `file`. `duplex` names the retired bespoke frame protocol; `http2` names the Node HTTP/2 session over the sandbox channel; a fallback record uses `file`. |
| `outcome` | string | yes | `ok` or `error`. |
| `fallback_reason` | string | yes | `gate_off`, `capability_absent`, `route_busy`, `entrypoint_sync_failed`, `broker_construction_failed`, `channel_open_failed`, `ready_invalid`, `ready_nonce_mismatch`, `ready_timeout`, `contaminated`, `aggregate_bytes_exceeded`, or `preface_missing`. It rides only a fallback record. `route_busy` marks the process-scoped route ceiling full. `entrypoint_sync_failed` and `broker_construction_failed` mark the named build step. `channel_open_failed` marks a failed channel open. `aggregate_bytes_exceeded` marks a readiness handshake, or an `http2` post-preface pre-bind buffer, where the host fell back because the process aggregate byte ceiling had no room. `preface_missing` marks a missing or an invalid HTTP/2 client connection preface inside the bounded readiness buffer: the host found no valid preface after the accepted READY line, aborted the `http2` open, and moved the run to the file bridge (`queue_v1`) one time. |
| `loss_class` | string | yes | `pre_dispatch` or `post_dispatch`, relative to the first request dispatch. It rides only a loss record. |
| `loss_reason` | string | yes | `stdin_eof`, `provider_exit`, `heartbeat_timeout`, `rpc_failure`, `write_error`, `transport_closed`, or `other`. The host maps every loss cause to one of these values, so no raw provider text reaches a sink. `write_error` marks a rejected host-to-sandbox write. `transport_closed` marks a reason-less provider transport close with no exit data. It rides only a loss record. |

To add a name or an enum value, extend the literal constant in
`duplex-observability.ts` first, then update the test that asserts the closed set.
Keep every dimension low-cardinality and free of user content.
