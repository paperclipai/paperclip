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

## Task detail loading

`GET /api/issues/:id` returns `Server-Timing` with `paperclip_issue` for the
whole handler and `issue_<phase>` for its reads. The total includes the final
execution-blocker read after recovery revalidation. Concurrent phases overlap;
do not sum them to obtain request duration.

With the existing operator-configured OTLP endpoint, the same reads produce
`issue.read.<phase>` child spans through the `paperclip.issue-read` tracer.
There are no custom attributes, identifiers, content, or exception messages.
The closed phase names in `server/src/services/issue-read-timing.ts` are:
`lookup`, `authorization`, `project_goal`, `ancestors`, `mentions`, `documents`,
`relations`, `blockers`, `review`, `references`, `handoff`, `retry`, `recovery`,
`cases`, `inbox`, `channel`, `workspace`, `work_products`, `execution_blocker`,
`relation_recovery`, `revalidate_recovery`, and `mentioned_projects`.
Without an OTLP endpoint, spans remain no-ops. This adds no first-party
Telemetry events or run-log events.

The browser's `issue-detail:navigate→content-paint` User Timing measure ends
after the redesigned conversation is revealed and painted, rather than when
the comments request completes while the conversation is still hidden. Durable
messages can paint before run history and plan enrichment. Runtime-only threads
wait for initial output; late history retains the existing scroll-anchor behavior.
Use Chrome's request waterfall and this mark together to distinguish API wait,
request dependencies, and rendering time. A hard-load trace also includes auth,
company selection, and JavaScript startup before the task navigation mark.

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

This document also holds three local instrumentation contracts: native runner
traces, sandbox startup traces, and sandbox duplex transport instrumentation.
Those sections follow below.

## Native Runner Trace Spans

Paperclip Runner task runs emit a single foldable OpenTelemetry trace. This is
the native-run trace schema version `2`. `task.run` is the only full-run root;
every other native span carries a real OpenTelemetry parent context rather than
only a descriptive `parentName` field.

The canonical lifecycle is:

```text
task.run
├── heartbeat.queue
├── task.prepare
│   ├── environment.startup
│   │   ├── environment.acquire
│   │   └── environment.workspace.realize
│   ├── skills.prepare
│   ├── heartbeat.prepare_before_environment
│   ├── heartbeat.prepare_after_environment
│   └── native.coordinator.claim
├── native.session.execute
│   ├── runner.session.startup
│   │   ├── runner.transport.connect
│   │   │   └── runner.artifact.prepare
│   │   ├── runner.transport.activation
│   │   ├── runner.transport.ready
│   │   ├── runner.runtime.stage
│   │   │   └── stage.sync
│   │   │       ├── stage.asset.home
│   │   │       │   └── session.checkpoint.restore
│   │   │       ├── stage.asset.runtime_context
│   │   │       └── stage.asset.ca_bundle
│   │   ├── runner.session.bootstrap | runner.session.resume
│   │   └── runner.turn.submit
│   └── agent.turn
│       ├── provider.turn.queue
│       ├── provider.time_to_first_agent_event
│       ├── tool.request.input_stream
│       └── tool.execute
└── task.settle
    ├── native.result.finalize
    └── session.checkpoint.persist
```

The tree shows stable semantic groups, not an exhaustive leaf list. Existing
artifact discovery and verification, process launch, PRP/websocket, ingress,
sandbox lease, harness-state, provider, duplex, and `sandbox.exec` spans remain
under the closest group. This keeps detailed diagnosis available while letting
a trace UI collapse the run into preparation, runner startup, agent work, and
settlement. A repeated operation creates another span with the same semantic
name; attempts are not encoded into span names.

`runner.session.startup` ends at the first durable `turn.submitted` event. A
fresh provider session records `runner.session.bootstrap`; an exact recovered
session records `runner.session.resume`. `agent.turn` begins at
`turn.submitted` and ends at the provider terminal event. `task.settle` begins
at that terminal event and remains open through finalization and checkpoint
persistence, so settlement work does not appear to outlive its parent.

`provider.time_to_first_agent_event` ends at the first meaningful provider
activity: a nonempty assistant/reasoning delta, a tool announcement with an
execution identity, or an existing assistant/reasoning/tool item start or
completion. Usage updates and empty deltas do not count. This is a first
activity metric, not time to a finished answer.

`tool.request.input_stream` measures the observed request-input window: from
an ACP tool announcement to its last input update before the provider reports
the tool complete. It can include provider buffering and transport. It is not
a claim about the exact end of model generation or the start of API execution.
The span is omitted when no subsequent input update is observed.

For native control-plane tools, `tool.execute` measures authorization and
execution inside the server authority, including time spent in HTTP requests.
Provider tool IDs and MCP request IDs are separate namespaces; the trace does
not guess a pairing by tool name or arrival order. Both spans belong to the
current run's `agent.turn`, including when a warm provider session is reused.
Their `operation` attribute is a known semantic tool name or `other`. Only a
boolean input-update marker crosses the provider-event boundary; no arguments,
argument hashes, or raw call IDs are exported by these spans. Concurrent tools
have separate durations; overlapping spans must not be summed as wall time.

The active native scope is also published through the existing asynchronous
runtime-parent seam. Provider execution, plugin, websocket/duplex, daemon, and
sandbox spans therefore inherit the correct branch even when their callbacks
run in another service layer. With no active native scope, those existing seams
retain their documented fallback behavior.

The root carries only a hashed run id, runtime label, schema version, wall time,
and outcome. Native child attributes use the bounded
`paperclip.native.span.` prefix and a closed key allowlist; values are limited
to finite numbers, booleans, or short strings. Commands, arguments, environment
values, paths, output, credentials, and raw identifiers are discarded by the
trace helper. `task.run.measured` remains in the local run log for compatibility
but is not exported as a second full-width OTel span.
Persisted `run.performance.span` events retain the v1 run-log schema and include
`traceSchemaVersion: 2` so local tooling can distinguish the hierarchy.

Like every span in this document, native-run spans are opt-in. When
`OTEL_EXPORTER_OTLP_ENDPOINT` is unset, the tracer remains a no-op; the local
run-log copy is unaffected.

## Sentry Error Monitoring

Paperclip ships with **opt-in** Sentry error monitoring for the server
process and the browser app. The operator activates it with two
environment variables: `SENTRY_DSN_FRONTEND` for the browser and
`SENTRY_DSN_BACKEND` for the server. Each variable is optional. A
specific variable always wins for its own component; a legacy variable,
`SENTRY_DSN`, supplies a component that has no specific value set. An
empty string counts as absent for all three variables. The feature uses
built-in Sentry options only. It adds no `beforeSend` hook and no custom
filter code.

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

### Run failure context

Terminal run failures also carry the run and task IDs, adapter, error code,
run status, and redacted error message. Their fingerprint is the error code
and adapter. These fields are passed directly to that event's capture call.
They do not change the ambient Sentry scope, whose isolation is unavailable
without an OpenTelemetry context manager. Later, unrelated exceptions must
not inherit a previous run's identity or fingerprint.

The `run_failure` context also includes the recorded process `exitCode` and
`signal`, so a generic adapter error can still distinguish a nonzero exit from
a signal termination. Exit codes must fit the database's signed 32-bit integer;
missing or malformed values become `null`. Signals must match the reporting
host's Node signal constants; missing values become `null` and unrecognized
values become `unknown`. A signal such as `SIGKILL` does not establish who sent
it or prove an out-of-memory kill. These fields do not change error grouping
or run outcomes, and do not include process output or adapter result payloads.

For a native Codex turn that ends with a structured HTTP 400 model/ChatGPT
compatibility rejection, the run records `native_provider_model_rejected`
and a fixed message that asks the user to select a supported model or connection.
This requires a committed runner terminal for the selected model and the exact
failed turn. Agent text, tool output, unrelated turns, and unknown provider
errors do not create this classification. The provider diagnostic contains only
`provider=codex`, `category=model_auth_incompatible`, `status=400`, and
`authMode=chatgpt`. It excludes the model name and provider response. This does
not change credentials, select a fallback model, replay a turn, or alter the
accepted semantic result or cleanup. The existing configuration-blocker recovery
path requires a configuration change instead of automatically retrying the same
model and connection. Native finalization also derives this evidence from the
committed event and the run's pinned provider configuration before it can queue
a failed-result retry. This survives a controller restart before the adapter
diagnostic is saved. Invalid bindings, missing evidence, or a mismatched event
hash do not grant this classification. A current worker's task is blocked for a
configuration change. A pending review instead keeps its original decision and
status version, releases execution, and creates no automatic recovery action.
After repairing the configuration, explicitly retry the reviewer to resolve the
same pending review. The Board's exact failed-run Retry accepts this classified
native failure only while its saved review is still current and pending; caller
payloads cannot select a different review. Dispatch checks that assignment again.
Superseded or completed reviews retain their authority.

Cloud portfolio proxy failures have an event-local `cloud_portfolio` context.
It contains only the phase (`fetch`, `http_response`, `response_body`, or
`response_write`), upstream HTTP status when available, elapsed milliseconds,
and an allowlisted network error code. Unknown values become `unknown` or
`null`; elapsed time outside 0–60,000 ms becomes `null`. Codes come from at
most four error/cause objects' own data properties, never error messages.
`DEADLINE_EXCEEDED` means the request's own ten-second signal was aborted.
The route's warning uses the same safe fields. Neither record includes URLs,
headers, cookies, bodies, user/stack IDs, or the original exception. Sentry
receives a plain error with the existing generic message and default grouping.
The context does not change the HTTP response, authentication, cookies, cache,
deadline, or single-fetch behavior, and does not carry into unrelated events.

An unconfirmed adapter Stop timeout has an event-local `adapter_stop` context:
the run UUID, built-in adapter type, native/legacy runtime mode, configured
wait duration, and whether abort was requested. Invalid identities become
`null`, and unknown adapter/runtime values become `unknown`. The report does
not include stop reasons, prompts, process output, provider responses, or
credentials. It preserves default error grouping and does not acknowledge
termination, remove the live execution control, or change the timeout. The
context is sent only through the existing opt-in Sentry gate and never leaks
into unrelated captures.

The context also samples the pending execution `phase` and `phaseElapsedMs`
when the Stop timer expires. An in-memory tracker belongs to the exact live
execution control; a replaced or missing owner reports `unknown` with a null
elapsed time. Labels come from a closed list and elapsed time uses a monotonic
clock, capped at one day. Nested scopes remain visible while their awaits are
pending, including ACP session close, transport stop, instruction collection,
workspace restore, and host instruction or lease cleanup. `phase_reporting`
means a step is waiting to write timing or teardown error diagnostics. `adapter_execution` and
`host_execution` are coarse labels for work outside those narrower scopes.
The tracker clears when its executor finishes. A phase is diagnostic context,
not evidence that a provider stopped or that files were recovered. No new
run-log or Telemetry event is emitted by this tracker.

The shared reporter also attaches bounded diagnostic contexts for both legacy
and native runs:

- `run_execution`: runtime mode, execution stage/native phase, driver and version,
  duration, ACP activity, failure phase, stop reason, error family,
  and timeout settings when available.
- `adapter_failure`: selected adapter error fields such as phase, category,
  protocol code, retryability, cause message, stack preview, HTTP status, and request ID.
- `provider_failure`: the saved provider failure category, title, and details.
- `run_exception_0` through `run_exception_3`: exception names, codes, HTTP
  statuses, and request IDs for a caught exception and up to three causes.

ACP turns record `acpLastEventAgeMs`, `acpObservedEventCount`,
`acpPendingToolCount`, and `acpToolInventoryComplete` at finalization, before
usage reads, error logging, and cleanup. The age measures time since the last
runtime event and is omitted if no event was observed or the clock is invalid.
Timeout and cleanup log messages do not reset this age. The pending count uses
known tool statuses; an incomplete inventory cannot establish that no work is
pending. Recent events do not prove useful progress. These fields contain only
numbers and a boolean, never tool names, IDs, arguments, or event content, and
do not change the execution timeout, cancellation, or recovery policy.

ACP results retain the adapter's resolved wall-clock timeout as
`adapterExecutionTimeout` in the instance run result. Finalization uses it for
`effectiveTimeoutSec`, `timeoutSource`, and `timeoutConfigured`. Sources are
`configured`, `sandbox_default`, or `unlimited`; `timeoutConfigured` identifies an
explicit override, including a negative value that disables the timer. An untouched
sandbox value of zero reports the four-hour default, while a local zero reports
unlimited. Older adapters without a valid resolution retain the config-based
metadata fallback. This does not change timers, Stop acknowledgement, or recovery.

When settlement records a workspace restore failure, `run_execution` also
includes `workspaceRestoreFailure` with one of the shared, path-free codes:
`restore_permission_denied`, `restore_lock_timeout`, `restore_unsafe_archive`,
or `restore_failed`. Unknown values are omitted. Workspace paths and arbitrary
pre-restore result data are not included. A later successful run does not, by
itself, establish that an earlier failed restore recovered the workspace files.

When available, the saved `workspaceRestoreDiagnostic` adds the bounded fields
`workspaceRestorePhase`, `workspaceRestoreStep`, `workspaceRestoreErrorCode`,
`workspaceRestoreHttpStatus`, and `workspaceRestoreExitCode` to `run_execution`.
The phase is `workspace` or `asset`. The failing step is one of `git_export`,
`git_import`, `workspace_transfer`, `workspace_extract`, `directory_merge`,
`git_integration`, `index_reset`, `git_ref_cleanup`, or `asset_restore`.
Nested steps retain the most specific failing operation. Error codes come from
the restore diagnostic allowlist, with unrecognized codes reported as `unknown`;
HTTP statuses are integers from 400 through 599 and process exit codes are
integers from 1 through 255. These fields accompany a known restore failure code
only. They omit error messages, raw command lines, paths, process output, and arbitrary
cause data. Git error wrappers preserve only these safe codes and numbers for
diagnostics, without adding the original error as a cause.
Native sandbox `environmentSyncOut` failures carry the same allowlisted codes
and bounded HTTP/exit statuses across the plugin worker RPC boundary. The host
revalidates that optional envelope and retains it only for restore diagnostics.
The envelope excludes provider messages, response bodies, names, paths, and
credentials. The existing RPC error message and code remain unchanged, as do
restore classification, retries, and source retention. Older workers without the
envelope still report `unknown` when no structured cause is available.
For `git_integration`, optional `workspaceRestoreGitCommand` identifies the fixed
command family: `rev_parse`, `symbolic_ref`, `merge_base`, `merge_tree`,
`commit_tree`, `update_ref`, or `log`. `workspaceRestoreGitFailureKind` is
`merge_conflict`, `invalid_object`, `ref_conflict`, `permission_denied`, or
`unknown`. A merge conflict requires an uninterrupted `merge-tree --write-tree`
exit of 1 with a completed tree ID in stdout; exit 1 alone is ambiguous.
Object and ref classifications require recognized Git diagnostics;
permission denial requires an OS `EACCES` or `EPERM` code. Unrecognized or
localized messages remain `unknown`. Up to 16 KiB of stderr is inspected only
in memory; no arguments, stderr, paths, repository URLs, filenames, or ref names
enter these fields. Handled probes and successful retries emit no diagnostic.
This does not change
restore behavior, retries, timeouts, or recovery policy.

A caught directory-merge lock timeout also records `restoreLockOwnerState`
(`alive`, `dead`, `unknown`, `missing`, or `invalid`), `restoreLockKnownLocalHolder`,
and, when available, `restoreLockOwnerSameProcess`, `restoreLockOwnerPredatesProcess`,
`restoreLockOwnerAgeMs`, and `restoreLockWaitMs` in `run_execution`. Ages are capped
at seven days. These fields omit paths, PIDs, owner records, and absolute timestamps.
The local-holder flag covers this module's active acquisitions only. Process-age
comparison uses the wall clock and a one-second margin; it is a clue to PID reuse,
not proof of ownership or permission to remove a lock. Diagnostic reads can race
with release. The extra diagnostic owner read has a 100 ms budget; a stalled or
unreadable read leaves the owner state `unknown`, while malformed JSON is `invalid`.
These fields do not change lock acquisition, reclamation, or retries.
Agent-directory callers also supply `restoreLockOperation`: `agent_directory_release`,
`agent_directory_collect`, `agent_directory_checkpoint`, or `agent_directory_handoff`.
This identifies the operation waiting for the lock, including cleanup after a
completed adapter turn when the recorded execution stage has not advanced.

The execution and setup catch paths pass the original exception to the reporter.
It snapshots and rebuilds only these selected fields and the original message and
stack. Sentry receives the sanitized cause chain rather than a stack created at
the reporting call. Saved adapter results use an available adapter stack preview;
without one, the report has no synthetic reporting stack.

Credential patterns, the current user's home path, registered run-secret values,
and known host/runtime environment credentials are removed before truncation.
Declared environment secret bindings are included even when their key has no
credential-like name. Runtime values are used only for redaction and are never
copied into an event. Stack fields are limited to 8,192 characters,
exception messages to 2,048, provider titles to 4,096, and provider details to
12,288. Other diagnostic strings are limited to 200 characters (adapter cause
messages: 2,048). Truncation is marked in the text and in
`run_execution.truncatedFields`; cyclic and deeper cause chains are marked too.
Request/response objects, headers, environment/configuration, prompts, stdout,
stderr, and arbitrary adapter result fields are not copied. The existing DSN
opt-in gate and error-code/adapter fingerprint remain unchanged. These reports
cannot recover diagnostic data that a provider or adapter discarded upstream.

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
sends, so an operator can read what the feature does before turning it on.
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

| Span                                  | Scope                                                                                                                                                      | Parent                          |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `sandbox.startup`                     | The one root span for a sandbox bring-up.                                                                                                                  | none (root)                     |
| `workspace.resolve`                   | Workspace resolution step.                                                                                                                                 | `sandbox.startup`               |
| `codex-home.seed`                     | Managed-home seed step.                                                                                                                                    | `sandbox.startup`               |
| `skills.reconcile`                    | Skills reconcile step.                                                                                                                                     | `sandbox.startup`               |
| `stage.sync`                          | Workspace stage-sync step.                                                                                                                                 | `sandbox.startup`               |
| `snapshot.git`                        | Host-side git workspace enumeration inside `stage.sync` (`git status --ignored`, the HEAD diffs, `ls-files`).                                              | `stage.sync`                    |
| `snapshot.baseline`                   | Host-side baseline workspace content-hash walk inside `stage.sync`, kept for restore.                                                                      | `stage.sync`                    |
| `stage.workspace`                     | One inbound workspace stage task inside `stage.sync`. It packs and uploads the workspace.                                                                  | `stage.sync`                    |
| `stage.asset.<key>`                   | One inbound asset stage task inside `stage.sync`. It packs and uploads one managed-home asset. The `<key>` segment is the asset key.                       | `stage.sync`                    |
| `stage.project.<id>`                  | One inbound referenced-project stage task inside `stage.sync`. It uploads one referenced project. The `<id>` segment is the project id.                    | `stage.sync`                    |
| `pack`                                | Host-side workspace tarball build inside the `stage.workspace` task.                                                                                       | `stage.workspace`               |
| `bridge.paperclip`                    | Paperclip bridge start step.                                                                                                                               | `sandbox.startup`               |
| `bridge.process-session`              | Process-session bridge start step.                                                                                                                         | `sandbox.startup`               |
| `acp.handshake`                       | ACP session handshake step.                                                                                                                                | `sandbox.startup`               |
| `sandbox.syncBack`                    | The settlement sync-back that restores the managed home at teardown.                                                                                       | the active run span             |
| `restore.workspace`                   | One outbound workspace restore task at teardown. It reads the sandbox workspace back and merges it into the host workspace.                                | `sandbox.syncBack`              |
| `restore.asset.<key>`                 | One outbound asset restore task at teardown. It reads one asset back to its host store. The `<key>` segment is the asset key.                              | `sandbox.syncBack`              |
| `sandbox.agentSession.sendInput`      | One outbound ACP message to the agent — the socket handler's one `writeTextFile` exec.                                                                     | the active run span             |
| `sandbox.agentSession.pollOutput`     | One 100 ms poll tick — `list`, then `read`+`remove` per file found (`1 + 2n` execs).                                                                       | the active run span             |
| `sandbox.callbackBridge.relayRequest` | One Paperclip-API callback request — read the request, write the response, remove it.                                                                      | the active run span             |
| `sandbox.agentProcess`                | The persistent streamed agent process the process-session bridge launches; open until the process settles or the bridge tears down, whichever comes first. | the active run span             |
| `sandbox.exec`                        | One host-to-sandbox execution.                                                                                                                             | the active step or wrapper span |

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

| Attribute                                | Type    | Optional | Meaning                                                    |
| ---------------------------------------- | ------- | -------- | ---------------------------------------------------------- |
| `paperclip.sandbox.startup.root.wall_ms` | number  | no       | The root-span wall time of the whole bring-up.             |
| `paperclip.sandbox.startup.root.work_ms` | number  | no       | The sum of the step wall times.                            |
| `paperclip.sandbox.startup.root.diff_ms` | number  | no       | `work_ms − wall_ms`; the overlap the parallel steps saved. |
| `paperclip.sandbox.startup.provider`     | string  | yes      | The normalized provider family.                            |
| `paperclip.sandbox.startup.cold_start`   | boolean | yes      | Whether the bring-up is a cold start.                      |
| `paperclip.sandbox.startup.region`       | string  | yes      | The clamped region label.                                  |
| `paperclip.sandbox.startup.image_id`     | string  | yes      | The hashed image id.                                       |
| `paperclip.sandbox.startup.sandbox_id`   | string  | yes      | The hashed sandbox id.                                     |
| `paperclip.sandbox.startup.lease_id`     | string  | yes      | The hashed lease id.                                       |

### Step span attributes

Each bring-up step span uses this closed attribute allowlist. The step name
rides the span name, so no `step` attribute repeats it.

| Attribute                                                    | Type   | Optional | Meaning                                                  |
| ------------------------------------------------------------ | ------ | -------- | -------------------------------------------------------- |
| `paperclip.sandbox.startup.step.wall_ms`                     | number | no       | The wall time of the step.                               |
| `paperclip.sandbox.startup.outcome`                          | string | no       | The step outcome (`ok`, `skipped`, or `failed`).         |
| `paperclip.sandbox.startup.provider`                         | string | yes      | The normalized provider family.                          |
| `paperclip.sandbox.startup.batch`                            | string | yes      | A shared tag that marks two parallel steps as one batch. |
| `paperclip.sandbox.startup.handshake.create_runtime.wall_ms` | number | yes      | The create-runtime sub-time of the `acp.handshake` step. |
| `paperclip.sandbox.startup.handshake.ensure_session.wall_ms` | number | yes      | The ensure-session sub-time of the `acp.handshake` step. |

The round-trip count and the provider durations no longer ride a step span. The
per-execution `sandbox.exec` child spans carry that detail.

### `sandbox.exec` span attributes

The `sandbox.exec` span uses this closed attribute allowlist. Paperclip omits a
numeric attribute when the provider does not report the value.

| Attribute                                       | Type    | Optional | Meaning                                                                    |
| ----------------------------------------------- | ------- | -------- | -------------------------------------------------------------------------- |
| `paperclip.sandbox.startup.provider`            | string  | no       | The normalized provider family.                                            |
| `paperclip.sandbox.startup.exec.command`        | string  | no       | The clamped `argv[0]` command label.                                       |
| `paperclip.sandbox.startup.exec.exit_code`      | number  | yes      | The numeric process exit code.                                             |
| `paperclip.sandbox.startup.exec.wall_ms`        | number  | no       | The host-measured wall time of the execution.                              |
| `paperclip.sandbox.startup.exec.wait_before_ms` | number  | yes      | The provider handle-fetch wait before the execution ran.                   |
| `paperclip.sandbox.startup.exec.sandbox_ms`     | number  | yes      | The in-sandbox run time of the execution.                                  |
| `paperclip.sandbox.startup.exec.network_ms`     | number  | yes      | The transport time the host adds; `wall_ms − wait_before_ms − sandbox_ms`. |
| `paperclip.sandbox.startup.exec.critical_path`  | boolean | no       | Whether the execution sits on the startup critical path.                   |
| `paperclip.sandbox.startup.exec.cache_hit`      | boolean | yes      | Whether the provider served the sandbox handle from its warm cache.        |
| `paperclip.sandbox.startup.outcome`             | string  | no       | The execution outcome (`ok` or `failed`).                                  |

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

| Span                                 | Scope                                                                                                                                                                                | Parent                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `sandbox.daytona.pack`               | The host-local pack step that builds the upload tarball. It makes no sandbox round trip.                                                                                             | the active startup step span                                                                 |
| `sandbox.daytona.transfer`           | The transfer step: an upload to the sandbox (inbound) or a download from the sandbox (outbound). The `paperclip.sandbox.startup.transfer.direction` attribute records the direction. | the active sync task span (`stage.*` inbound, `restore.*` under `sandbox.syncBack` outbound) |
| `sandbox.daytona.ensureDirectory`    | The `mkdir -p` step that ensures a directory exists before a write.                                                                                                                  | the active startup step span                                                                 |
| `sandbox.daytona.checkSymlinkEscape` | The re-check step that a path resolves inside the workspace root before use.                                                                                                         | the active startup step span                                                                 |
| `sandbox.daytona.promote`            | The atomic move of a staged temp onto its target via a pinned dir handle.                                                                                                            | the active startup step span                                                                 |
| `sandbox.daytona.extractTarball`     | The one round trip that re-checks the path, runs `tar -xf`, and removes the scratch tarball.                                                                                         | the active startup step span                                                                 |
| `sandbox.daytona.postUploadCommand`  | One caller-supplied post-upload command.                                                                                                                                             | the active startup step span                                                                 |
| `sandbox.daytona.session.open`       | The create of the one persistent session for a lease, on the first in-run command.                                                                                                   | the active run span                                                                          |
| `sandbox.daytona.session.close`      | The delete of that persistent session on lease release.                                                                                                                              | the active run span                                                                          |
| `sandbox.daytona.other`              | Any span name outside the known set.                                                                                                                                                 | the active startup step span                                                                 |

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

| Attribute                                        | Type   | Optional | Meaning                                                                                                   |
| ------------------------------------------------ | ------ | -------- | --------------------------------------------------------------------------------------------------------- |
| `paperclip.sandbox.startup.provider`             | string | no       | The normalized provider family.                                                                           |
| `paperclip.sandbox.startup.outcome`              | string | yes      | The step outcome (`ok`, `skipped`, or `failed`).                                                          |
| `paperclip.sandbox.startup.pack.wall_ms`         | number | yes      | The host-local wall time of the pack step. It rides the `sandbox.daytona.pack` span.                      |
| `paperclip.sandbox.startup.transfer.wall_ms`     | number | yes      | The wall time of the transfer step. It rides the `sandbox.daytona.transfer` span.                         |
| `paperclip.sandbox.startup.transfer.guard.count` | number | yes      | The number of serial guard round trips before one transfer. It rides the `sandbox.daytona.transfer` span. |
| `paperclip.sandbox.startup.transfer.direction`   | string | yes      | The transfer direction (`inbound` or `outbound`). It rides the `sandbox.daytona.transfer` span.           |

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

| Span                          | Scope                                                                                                                                                        | Latency                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| `sandbox.duplex.channel_open` | One duplex channel-open attempt. The `outcome` dimension is `ok` when the channel opened and readiness passed, or `error` when the open or readiness failed. | none                                 |
| `sandbox.duplex.request`      | One duplex request the broker forwarded to the host.                                                                                                         | The request latency in milliseconds. |

### Event

| Event                      | Scope                                                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox.duplex.transport` | The host emits it at each transport boundary: a ready duplex channel, a fallback to the file bridge, and a terminal channel loss. Its dimensions record the boundary. |

### Counters

| Counter                             | Scope                                                                               |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| `sandbox_duplex_channel_open_total` | One successful duplex channel open.                                                 |
| `sandbox_duplex_fallback_total`     | One fallback to the file bridge. The `fallback_reason` dimension records the cause. |
| `sandbox_duplex_loss_total`         | One terminal duplex channel loss. The `loss_class` dimension records the phase.     |
| `sandbox_duplex_session_leak_total` | One leaked provider session at teardown.                                            |

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
| `fallback_reason` | string | yes | `gate_off`, `capability_absent`, `route_busy`, `entrypoint_sync_failed`, `broker_construction_failed`, `channel_open_failed`, `ready_invalid`, `ready_nonce_mismatch`, `ready_timeout`, `contaminated`, or `preface_missing`. It rides only a fallback record. `route_busy` marks the process-scoped route ceiling full. `entrypoint_sync_failed` and `broker_construction_failed` mark the named build step. `channel_open_failed` marks a failed channel open. `preface_missing` marks a missing or an invalid HTTP/2 client connection preface inside the bounded readiness buffer: the host found no valid preface after the accepted READY line, aborted the `http2` open, and moved the run to the file bridge (`queue_v1`) one time. |
| `loss_class` | string | yes | `pre_dispatch` or `post_dispatch`, relative to the first request dispatch. It rides only a loss record. |
| `loss_reason` | string | yes | `stdin_eof`, `provider_exit`, `heartbeat_timeout`, `rpc_failure`, `write_error`, `transport_closed`, or `other`. The host maps every loss cause to one of these values, so no raw provider text reaches a sink. `write_error` marks a rejected host-to-sandbox write. `transport_closed` marks a reason-less provider transport close with no exit data. It rides only a loss record. |

To add a name or an enum value, extend the literal constant in
`duplex-observability.ts` first, then update the test that asserts the closed set.

### Known behavior: aggregate retained body bytes

Each HTTP/2 bridge route holds up to 168,820,736 bytes (161 MiB) at its own
peak (see `HTTP2_BRIDGE_MAX_CONCURRENT_STREAMS` in `http2-bridge-server.ts`).
The host process admits up to 128 concurrent routes (see
`DEFAULT_MAX_CONCURRENT_DUPLEX_ROUTES` in `plugin-worker-manager.ts`). Those
two figures alone would let the process retain up to 21,609,054,208 bytes
(about 20.1 GiB) of body data across every route at the same time.

The process does not reach that figure, on two levels.
`HTTP2_BRIDGE_MAX_PROCESS_BODY_BYTES` (`http2-bridge-server.ts`) enforces a
real, live ledger: 1,073,741,824 bytes (1 GiB) across every route, not merely
an accepted paper ceiling. Every HTTP/2 stream creates one `BridgeBodyReservation` owner over
its lifetime, and every source-level full-body buffer that stream retains —
its request-body chunk array, the concatenated request body, the
response-body chunk array, and the concatenated response body — reserves
against that one owner before it allocates. A reservation that would pass the
process total is denied before it copies anything, and the host answers 503
instead of accepting the body. The reservation stays live for the response
body until the HTTP/2 write actually finishes flowing to the peer or the
stream closes, not merely until the write call returns, so a slow or
backpressured peer cannot hold response bytes in memory the ledger no longer
counts.

`HTTP2_BRIDGE_MAX_ROUTE_BODY_BYTES` adds a second, per-route ledger on top of
that process-wide one: each route's own reservations also check a ceiling
scoped to that one route (its own 168,820,736-byte peak from above), so one
busy or malicious route can pass its own ceiling and get denied with a 503,
but it can never spend the whole process-wide total and deny every sibling
route admission. This accounting covers source-level full-body buffers only:
internal Node.js and Undici copies (socket buffers, HTTP/2 frame buffers,
decompression buffers) stay outside it.

The generated gateway process inside the sandbox (`getSandboxCallbackBridgeServerSource`
in `sandbox-callback-bridge.ts`) enforces its own separate ledger, independent
of the two host-side ledgers above: each side bounds only the memory in its
own process. `readBodyBytes` reserves a request body's chunk bytes as they
arrive, then reserves the concatenated buffer's own byte count before
`Buffer.concat` allocates it, against a ceiling of `maxBodyBytes * 8` (4
concurrent bodies, each counted twice for its two live copies). A denied
reservation answers 503 with no forward call. Each request handler releases
its own reservation once the whole request settles: a completed response, a
thrown error, a client abort, or a deadline timeout all reach the same
release call.

Keep every dimension low-cardinality and free of user content.

### Shared skill preparation

`skills.prepare` measures the shared inventory listing and runtime materialization
inside `task.prepare`. It is also contained in the broader
`heartbeat.prepare_before_environment` interval; do not add those two durations.
Preparation failures emit a failed span even when no native session starts.
It carries no skill contents, identifiers, locations, or credentials. It uses the
existing run performance events and operator-configured OpenTelemetry endpoint;
no first-party Telemetry event is added.

Runtime preparation refreshes the company inventory once per listing. Local and
catalog directories remain direct sources, so edits are visible on the next
preparation. Explicit version selections still use their stored snapshots.

Reconstructed skills use `__runtime_cache_v1__/<skill-id>/<fingerprint>/files`
beneath company skill storage, with a sibling manifest of paths, sizes, and SHA-256
content digests. Every warm hit validates the manifest and exact file contents;
it does not fetch upstream, rewrite files, or remove directories. The fingerprint
includes installed source identity, revision, file inventory, and stored Markdown,
and excludes display names, stars, and general update timestamps. Manifests stay
outside the directory delivered to agents.

GitHub and skills.sh imports are cached only when pinned to a full commit SHA.
Remote freshness is explicit: update or reimport selects a new revision, including
supporting-file-only changes. A branch advancing upstream does not change an
installed revision. Legacy mutable refs retain uncached behavior until updated.
URL-only skills use stored Markdown. An unavailable new revision reports missing;
it never silently reuses an older revision. Stored `SKILL.md` remains a fallback,
but missing supporting files prevent publication of a reusable partial cache.

Builds publish read-only files and directories from unique staging directories.
A skill-scoped lock serializes builds and cleanup across processes. Cold builders
recheck that the skill still exists under its original key before reading files
and before atomic publication. Existing valid
revisions stay readable during updates. Invalid entries are quarantined in the
same skill cache root for inspection; rename/removal cleans up that skill's cache.
Read-only listings validate caches without downloading or repairing them. A
publication lock left by an abruptly terminated process is reported for operator
cleanup; remove it only after confirming its recorded PID is no longer running.

Run `pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-skill-preparation.ts` for an isolated embedded
PostgreSQL benchmark with 114 mixed skills and at least 400 remote files. It
reports one cold sample and ten warm samples (one in a new process), refresh and
fetch counts, rebuilds, missing entries, and content checks. Upstream responses are
deterministic fixtures; use real deployed run spans for user-facing latency.
