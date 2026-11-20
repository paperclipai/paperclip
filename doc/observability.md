# Observability

This document covers how an operator turns on the two opt-in observability
paths, OpenTelemetry traces and Sentry error monitoring, and what Sentry events
may contain. See the
[Telemetry Data Contract](../packages/shared/src/telemetry/README.md) for the
separate first-party event system, and `rules/data-paths.mdc` for how the paths
differ.

It does not list span names or attributes. Those are defined next to the code
that opens each span; search for the span name, or for `getTracer(` and
`startActiveSpan(` under `server/src` and `packages`. Add a new span in code
without adding it here.

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
packages are imported and there is no SDK or exporter overhead. Local request
timings still use the performance clock.

`server/package.json` declares each optional package at the exact version the
server tests against; install that exact version. Our Dependabot cannot bump
these versions: its npm parser reads only `dependencies`, `devDependencies`,
and `optionalDependencies`, never `peerDependencies`. A peer version here is a
compatibility claim, not an installed version, so raising it is a human
decision. `@opentelemetry/api` is the one OpenTelemetry package Paperclip
maintains as a dependency; once you install the packages below, they become
normal dependencies of **your own** project, and your own Dependabot updates
them.

An initialized SDK does not confirm ingestion. Verify a fresh trace from the
deployed revision at the configured destination. A rejected export can leave
the application healthy. For Honeycomb, configure the ingest key in the
`x-honeycomb-team` entry of `OTEL_EXPORTER_OTLP_HEADERS`; see
[Honeycomb authentication](https://docs.honeycomb.io/api/query-annotations/authorization).
Keep credential values out of logs and diagnostic reports.

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
are out of scope. The SDK receives explicit empty metric-reader and log-processor
lists so its default OTLP exporters cannot emit unrequested metrics or logs. Auto-instrumentations
for `fs`, `dns`, and `net` are disabled by default because they are too chatty
for this workload; everything else from
`@opentelemetry/auto-instrumentations-node` is on (HTTP, Express, PG, etc.).

## Other diagnostic switches

- **OpenCode performance diagnostics.** Set
  `PAPERCLIP_OPENCODE_PERFORMANCE_DIAGNOSTICS=1` as an agent or environment
  variable. It defaults off, and setting the OTLP endpoint alone does not turn it
  on. The Runner then records closed OpenCode phase timings through a local,
  authenticated sink. No operator OTLP endpoint or ingestion credential is
  passed to OpenCode.
- **Browser page-load tracing** on hosted instances needs
  `PAPERCLIP_BROWSER_TRACES_ENDPOINT`. See
  [browser performance tracing](browser-performance-tracing.md).
- **Browser product analytics** (PostHog) on Paperclip Cloud needs
  `PAPERCLIP_POSTHOG_PROJECT_TOKEN` and `PAPERCLIP_POSTHOG_BROWSER_ENABLED=1`.
  See [Cloud browser product analytics](cloud-browser-analytics.md).

## Sentry Error Monitoring

Paperclip ships with **opt-in** Sentry error monitoring for the server
process and the browser app. The operator activates it with two
environment variables: `SENTRY_DSN_FRONTEND` for the browser and
`SENTRY_DSN_BACKEND` for the server. Each variable is optional. A
specific variable always wins for its own component; a legacy variable,
`SENTRY_DSN`, supplies a component that has no specific value set. An
empty string counts as absent for all three variables. The server's `beforeSend`
hook adds normal task and run navigation links to events with saved run context.
The run-failure reporter selects reportable outcomes before calling the SDK,
as described below.

The server is inactive when the backend DSN resolves to `null`; then it
imports no Sentry package. The browser is inactive when the front-end DSN
resolves to `null`; then it fetches no Sentry chunk. The two components
resolve their DSN independently, so the operator can activate one
component and leave the other inactive.

### Enabling Sentry

#### 1. Install the Sentry peer dependency

The supported server SDK version is **`@sentry/node@10.71.0`** — the exact
version this feature is audited against (see "Server request data"
below). Install it in the server, the same way you install the
OpenTelemetry packages above. `@sentry/node` is an *optional peer
dependency*: it is not in the default lockfile, and the server loads it
dynamically only when the backend DSN resolves to a value.
`server/package.json` declares this exact version; installing a different
version defeats the audit, so the server checks the installed version
against the declared one at startup and logs one diagnostic instead of
enabling error monitoring on a mismatch (see "Server request data"
below).

```bash
pnpm add @sentry/node@10.71.0
```

**The hosted image variant ships this package pre-installed.** A managed
tenant runs the image built from the Dockerfile's `cloud` target, and that
target installs the declared version of `@sentry/node` at build time. A
managed tenant needs only `SENTRY_DSN_BACKEND` set (or `SENTRY_DSN_FRONTEND`
for the browser); no install step is needed.

A self-hosted operator runs the image built from the `production` target.
That image holds no Sentry package, the same as before this feature
existed. A self-hosted operator who wants server error monitoring still
completes the install step above.

The browser package, `@sentry/browser`, needs no install step. It is
already a development dependency of the `ui` package, pinned to the same
exact version, **`10.71.0`**, so the browser code ships inside every
build at the audited version. A signed-out browser, or a browser with no
DSN, never fetches the Sentry chunk — see "DSN delivery to the browser"
below.

#### 2. Set the environment

```bash
export SENTRY_DSN_FRONTEND="https://<public-key>@<host>/<project-id>"
export SENTRY_DSN_BACKEND="https://<public-key>@<host>/<project-id>"
```

The operator can set either variable alone. The component with no value
set stays inactive.

### Two Sentry projects

The server and the browser report to two separate Sentry projects by
default, one per component. The server reads its DSN,
`SENTRY_DSN_BACKEND`, from the process environment. The browser reads its
DSN, `SENTRY_DSN_FRONTEND`, from the authenticated
`GET /api/auth/get-session` response.

The legacy `SENTRY_DSN` variable still works. When the operator sets only
`SENTRY_DSN`, both components use it, so both report to **one** Sentry
project. In that mode the server prints one warning at start. The warning
names the three variables (`SENTRY_DSN`, `SENTRY_DSN_FRONTEND`,
`SENTRY_DSN_BACKEND`) and prints no DSN value.

To add a DSN for a new component later, add a field to the `SentryDsns`
type, add a variable with the `SENTRY_DSN_` prefix, and resolve it with
the same precedence rule: the specific variable wins, and `SENTRY_DSN`
supplies a component that has no specific value set.

### DSN delivery to the browser

The browser never reads the DSN from a `<meta>` tag or from any other part
of `index.html`. The served `index.html` holds no DSN — it is a static
file, built once and served unchanged to every request.

Instead, the browser receives the front-end DSN inside the authenticated
`GET /api/auth/get-session` response body, in the `sentryDsn` field, next
to the signed-in session and the user profile. The backend DSN stays in
the server process and never reaches the browser. A signed-out browser
calls this route with no board actor, so the route answers 401 and sends
no DSN. A signed-out browser therefore loads no Sentry chunk and sends no
event. These pages run signed out:

- `/auth`
- `/cli-auth/:id`
- `/board-claim/:token`
- `/invite/:token`

**A gap the operator must know:** a browser error that happens before the
session response arrives is not captured. The gate opens only after the
session query resolves.

### Environment attribution

Set `SENTRY_ENVIRONMENT` to the deployment environment, such as `staging`
or `production`. The server SDK reads this value from its process environment.
The authenticated session sends the same value in `sentryEnvironment`, and
`SentryGate` passes it to the browser SDK. This is runtime configuration, so the
same built image can report correctly in different environments. It does not
infer an environment from the page URL or include a tenant identifier.

When the variable is absent or empty, the session sends `null` and the browser
keeps the SDK's default environment. The field is optional in the session
schema so a newer browser can still read a response from an older server.
A session refetch that changes the environment closes and restarts monitoring;
signing out still closes it. The browser release continues to identify the
loaded bundle, even if the server has since deployed another version.

### Privacy settings

Both runtimes use Sentry's privacy options. The server also adds saved-run
navigation links through a bounded `beforeSend` hook.

- `sendDefaultPii` is `false`, on both runtimes.
- `tracesSampleRate` is `0`, on both runtimes. Paperclip sends no
  performance trace and no profile.
- The server hook reads only saved run and company metadata for navigation.
  It copies no request data and preserves the event if the lookup fails.
  The browser adds no `beforeSend` hook. Neither runtime adds a custom filter.

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

### Run failure context

Run failure reporting requires a separate operator choice in addition to the
backend Sentry DSN and the audited SDK. Set `PAPERCLIP_SENTRY_RUN_FAILURES` to:

| Value | Reports |
| --- | --- |
| `off` (default) | No run failure events. Ordinary server exception reporting still uses the backend DSN. |
| `unexpected` | Failed and timed-out runs, plus unexpected started cancellations, with the configuration, quota, and external connection filters described below. |
| `all` | Every failed or timed-out run, including the known configuration, quota, and external connection failures. Unexpected started cancellations also report. |

Missing, blank, or unrecognized values keep run reporting off. Expected operator
stops, shutdown interruptions, successful runs, and queued work do not report
terminal run failures in either enabled mode. A native run that is `failed` while it waits for a same-run
retry (`nativePhase` `retryable_failure`) does not report either. It reports once
if a later write ends the retry as a terminal failure. The mode does not change run status, retries, recovery,
Telemetry, or OpenTelemetry export. It is process-wide, so an operator can enable
it on one staging instance without enabling it on other deployments. Restart the
server after changing deployment environment variables.

**Upgrade:** A backend DSN alone previously enabled run failure reports. Set
`PAPERCLIP_SENTRY_RUN_FAILURES=unexpected` to preserve that reporting policy.
Use `all` to investigate every failed run in a selected deployment.

Terminal run failures carry the company, agent, run and optional task IDs,
adapter, error code, run status, and redacted error message. Company-scoped runs
without a task also report. The `event_kind=run_failure` tag identifies these
events. Their fingerprint contains the error code and adapter, followed by the
setup/execute phase and original failure code when available. IDs, release,
model, and error text do not split groups. These fields are passed directly to
that event's capture call.
They do not change the ambient Sentry scope, whose isolation is unavailable
without an OpenTelemetry context manager. Later, unrelated exceptions must
not inherit a previous run's identity or fingerprint.

When a task read produces the system-owned failed state displayed as
“Couldn’t finish this attempt. Your message is saved.”, either enabled mode also
reports a `task_attempt_failed` error with `event_kind=run_failure` and
`failure_source=task_interruption`. This catches saved-message failures without
a new terminal run transition. The event keeps the actual observed run status,
the adapter and the company, agent, task and run references. It uses fixed error
text and includes no message bodies, prompts or raw run diagnostics. Working,
scheduled-retry, resolved and user-action states do not produce this event.
Repeated reads of the same company/task/run/intent are suppressed after the SDK
receives a successful HTTP delivery response. The process retains the latest
1,000 confirmed reports. An SDK capture ID alone does not confirm delivery:
processing backpressure, network errors and rate limits can discard the event.
Unconfirmed captures wait 60 seconds before a later task read can try again;
this pending cache also holds at most 1,000 entries and starts no background
timer. Because these caches are process-local, a read reports only a state
change from the last hour: the run's finish time, a saved recovery transition,
a native resume's due or failure time, a scheduled retry time, a saved-message
or Retry request, or a Retry preparation's deadline or terminal update. Failed
or cancelled Retry preparations use their saved update time, so a new failure
is still reported after a long wait. Reading a task does not refresh these times.
A server restart, another replica or cache eviction therefore does not resend
every retained failure that a task list shows. A failed state that no task read observes within that hour is not
reported by this path. A valid run error code is added as the `run_error_code`
tag; it does not change the fingerprint.
This task-state event can accompany a separate terminal run-failure report;
the `failure_source` tag distinguishes them.

The versioned `paperclip` context supplies company and agent IDs and relative
API paths for the saved run, events, log, and optional task. A valid HTTP(S)
origin in `PAPERCLIP_PUBLIC_URL` also supplies absolute run, events, and log URLs.
Values with credentials, query parameters, fragments, or a path are omitted.
The event never includes an API key or an access token. These references grant
no access. A bot must authenticate to the correct instance and pass its existing
company, run-output, and private-task access checks.

Server events associated with a saved run also include `task_url` and `run_url`
tags for the normal company-prefixed board pages, plus `task_identifier` when
available. The `paperclip` context contains the same navigation links as
`taskUrl` and `runPageUrl`; the existing `runUrl` remains an API reference.
This enrichment applies to run failures, adapter Stop timeouts, and server errors
with authenticated run context. It resolves the saved company, agent, and task
instead of copying request URLs, queries, or bodies. Taskless runs receive only a
run link. Missing or unsafe `PAPERCLIP_PUBLIC_URL` values omit these links.
The optional indexed metadata lookup has a one-second reporting deadline and a
limit of eight unfinished reads. A failed or slow lookup preserves the original
event without navigation links.
URLs longer than Sentry's 200-character tag limit remain in context only.
Links require the viewer's normal Paperclip access and apply to newly captured
events; existing Sentry events are not rewritten.

The bot should use the exact run ID to read `GET /api/heartbeat-runs/{runId}`,
`GET /api/heartbeat-runs/{runId}/events`, and
`GET /api/heartbeat-runs/{runId}/log`. These retain the saved result, run context,
and available output. Prefer the saved provider configuration over the agent's
current settings. The Sentry execution context includes the saved native
provider kind and model, start/finish timestamps, and original failure code when
available. Tool-name collision errors identify the conflicting tool names and
connection bindings without serializing tool schemas or provider metadata.
Gateway reason codes survive exception projection. All diagnostic text still
passes through the existing secret redaction and size limits.

Use the Sentry group to combine repeated investigations, and the instance and
run ID to identify each occurrence. Automated retries or proposed code fixes
must use normal Paperclip authority and approval checks. Receiving an event
does not authorize a bot to replay a run. This change provides the reporting
contract; it does not install a bot or configure Sentry alerts.

Reporting remains asynchronous and best effort. Shutdown drains pending report
work before the SDK flushes. There is no durable delivery queue or receipt from
Sentry, so a crash or network outage can lose events. `all` selects failures; it
does not promise delivery or export complete transcripts. Detailed output stays
in the instance behind the existing authenticated APIs, with its normal retention.

In `unexpected` mode, some failures that the task already shows to its owner
stay in the run log and the task's blocked state instead of reporting. Examples
include known missing-secret configuration blockers, some provider quota and
rate-limit failures, recognized external connection failures, and a scheduled
Codex capacity retry. Most exclusions have conditions, so read
`server/src/services/run-failure-report.ts` for the full policy. `all` mode
reports these failures.
Other run failures attach bounded diagnostic contexts. Their fields are defined
in `server/src/sentry.ts` and pass through the existing secret redaction and size
limits. They can include selected provider error titles and details, but not raw
request or response objects, prompts, message bodies, or credentials.

### Browser data

The browser sends no page URL, no referrer, no user agent, and no
breadcrumb.

Application and route error-boundary reports also include:

- `react_error_boundary`: `app` or `route`.
- `react.componentStack`: up to 40 React component names. Frame locations,
  URLs, arguments, and unrecognized lines are omitted. Parsing examines at
  most 16 KiB of input. Production builds preserve function names so this
  trace remains useful after minification; this adds some bundle size.

All browser error reports, including global promise rejections, include:

- `browser_build_mode`: `development` or `production`, from the loaded bundle.
- `browser_rejection_kind`: the primitive type of an unhandled rejected value
  (or `null`). The diagnostic does not read object properties or copy the value.
- `browser_state`: document readiness, visibility, and a boolean indicating
  the `translated-ltr` or `translated-rtl` root class used by browser translation.
  The marker is evidence of DOM translation, not proof of the error's cause;
  its absence does not exclude other translators or DOM-changing extensions.

Boundary state is captured at the failure, before asynchronous reporting.
Global reports without that snapshot read document state before sending.
All fields are attached only to that event. They include no component props,
DOM text, HTML,
element identifiers, arbitrary CSS classes, route, or query string. Failed
diagnostic reads do not prevent the original exception from being reported.
The monitoring gate and sign-out behavior still apply. This context does not
suppress errors, change DOM operations, or disable browser translation.

### Fail-open behavior

A failed Sentry import or a failed init never stops the server and never
breaks the browser app. Both runtimes fall through to a single diagnostic
log line and keep running with no error monitoring.

### Default capture set

The lists below name every event and every context field this feature
sends, so an operator can read what the feature does before turning it on. The
diagnostic contexts on run failure events are the exception: they are defined in
`server/src/sentry.ts`, as described under "Run failure context".
Each Sentry integration name below is verified against the default
integration list of `@sentry/node@10.71.0` and `@sentry/browser@10.71.0`.

**Release attribution**

The server sets `release` to the full source commit from its build metadata.
An explicit `SENTRY_RELEASE` overrides that default. If neither is available,
the server leaves the release unset.

The browser also sets `release`, using the full `PAPERCLIP_BUILD_COMMIT`
supplied when its bundle is built, or the checkout commit for source and npm
builds. The server reads its packaged build stamp when no deployment marker
is present. Docker passes the same commit to both
application builds. A cached browser bundle keeps its own release after a
server deployment, so its errors are attributed to the code actually loaded.
Browser builds without a valid full commit leave the release unset. The
browser does not read a release from the current server, page URL, or session.
These fields contain build identifiers; they add no tenant or user identity.

**Server identity**

- `server_name` — every server event carries the host name of the process.
  The `@sentry/node` client already sets this value by default when the
  operator does not pass a `serverName` option; this feature passes the
  value directly, so the server keeps sending it even if a later SDK
  version changes its default. To send a different value in place of the
  host name, set the environment variable `SENTRY_NAME` to that value.

**Server events this feature adds**

- An Express `HttpError` with `status >= 500`.
- Any unknown throw that is not a `ZodError`. It always answers 500.
- A server startup failure.
- A run that ends with the status `failed` or the status `timed_out`. The
  event carries five context fields: `taskId`, `runId`, `errorMessage`,
  `errorCode`, and `agentAdapter`. The server redacts the error message and
  the error code before it sends the event.

A server event whose original error has the code
`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` gets bounded provenance. The tag
`dynamic_import_inspector` holds `open`, `closed`, or `unavailable`. The
`dynamic_import_provenance` context holds the same state, the process id, the
parent process id, the main-thread flag, the uptime in seconds, and the names
of inspector-related Node flags from `execArgv` and `NODE_OPTIONS`. The event
never holds the inspector URL, because that URL contains a session secret. It
also never holds a flag value or any other flag. This error has reached
Sentry with no first-party frame. The state shows whether an inspector
session was open when the server reported the event. It does not prove which
code caused the error: code compiled without a filename fails the same way
while a debugger is attached. A `closed` state rules out an expression that a
still-open session evaluated. Other events do not change.

Native runner identity and harness failures retain their existing error prefixes.
Their terminal messages now include a bounded guard reason, such as
`session_scope_mismatch`, `durable_identity_unreadable`, or
`backup_without_reusable_lease`. Provider-pack read failures distinguish a missing
file, invalid JSON, permission denial, invalid path type, and other I/O errors.
These reasons contain no session identifiers, provider output, or filesystem
paths. They help diagnose recurrence; they do not authorize a retry, quarantine,
replacement, or a weaker identity check. Existing chat recovery recognizes the
same failure category with or without a reason suffix; it still requires the
exact cleanup receipt, checkpoint, and absence of provider work.

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
- A remote app's recognized OAuth sign-in challenge. Connecting an app or
  refreshing its catalog returns 422 with `oauth_challenge` and the existing
  setup/reconnect links. Other upstream failures still return 502 and are
  reported, including an unexplained upstream HTTP 400.
- Expired OAuth credentials without a refresh token, or a rejected refresh token
  that requires reauthorization. Discovery and health checks return 422 with
  `oauth_refresh_missing` or `oauth_reauthorization_required` and the existing
  reconnect instructions. Unexpected refresh failures remain reportable.
- Slack's explicit response that its app has not enabled MCP access. Discovery
  and health checks return 422 with `slack_mcp_access_disabled` and setup
  instructions. This requires Slack's exact MCP endpoint and known error;
  other HTTP 400 responses remain reportable.
- A performance trace and a profile, because `tracesSampleRate` is 0.

### Operator responsibilities

Two controls belong to the operator. This feature ships neither one.

1. **Set a rate limit and a quota alert.** Set a per-client-key ingestion
   rate limit and a quota alert in the Sentry project. The feature sends
   no built-in rate limit of its own.
2. **Give a self-hosted sink a reachable host name.** If
   `SENTRY_DSN_FRONTEND` (or the legacy `SENTRY_DSN`) points at a
   self-hosted Sentry instance, give it an externally reachable ingest
   host name, not an internal-only host name. The browser sends its
   events from the operator's network, not from the server's network, so
   an internal-only host name fails silently for the browser even when it
   works for the server.
