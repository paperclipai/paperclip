# Telemetry Data Contract

This document explains how contributors should use Paperclip's public telemetry
contract. It does not duplicate the full list of individual events or
dimensions. It documents extra semantic and privacy rules where the generated
shape is not sufficient.

The canonical source for first-party event names, dimensions, optionality,
allowed primitive value types, and enum descriptions is
`packages/shared/src/telemetry/generated/paperclip-telemetry.ts`.

Shared enum constants live in `packages/shared/src/constants.ts`. Use those
constants when code needs a reusable domain, but treat the generated telemetry
types as the final authority for emitted first-party telemetry shapes.

## Public Sources

Use these files when reviewing or changing telemetry code:

| Contract item | Public source |
| --- | --- |
| First-party event names | `PaperclipEventName` in `generated/paperclip-telemetry.ts` |
| Per-event dimensions and optionality | `EventDimensionsMap` in `generated/paperclip-telemetry.ts` |
| Enum descriptions for telemetry dimensions | `PAPERCLIP_ENUM_DESCRIPTIONS` in `generated/paperclip-telemetry.ts` |
| Schema version and event envelope helpers | `SCHEMA_VERSION`, `makeEvent()`, and `makeBatch()` in `generated/paperclip-telemetry.ts` |
| Runtime-safe event names and dimensions | `TelemetryEventName` and `TelemetryEventDimensions` in `types.ts` |
| Allowed primitive dimension values | `TelemetryDimensionValue` in `types.ts` |
| Shared reusable enum domains | Named exports in `constants.ts` |
| First-party typed emit helpers | `events.ts` |
| Generic client behavior | `client.ts` |
| Retention windows and event class assignments | `RETENTION_DAYS` and `EVENT_RETENTION_CLASS` in `retention.ts` |

Do not copy generated event lists or dimension tables into this README. They
will drift as the generated contract changes.

## Emission Boundary

Paperclip telemetry uses named events with explicit dimension fields. Treat
open-ended string dimensions as public contract values, not as a place for user
content or private operational data. Do not send PII, secrets, credentials,
private paths, prompts, model output, or other sensitive values through
telemetry dimensions.

Telemetry emitters send raw dimension values. They must not pre-normalize
enum-like values into a reporting form just to match today's known domain.

The receiving layer owns canonicalization. Keeping canonicalization in one place
means emitters can stay simple and accurate: emit what the product observed, use
the generated contract for required and optional fields, and let the receiving
layer decide how legacy spellings, aliases, unknown names, and future values map
to a stable reporting shape.

Do not add client-side lowercasing, alias mapping, or fallback mapping unless
the generated telemetry contract specifically requires that emitted value.

If a dimension is privacy-protected before emission, emit only the protected
value and its matching public marker as defined by the typed helper or generated
contract. Do not emit private source material in telemetry dimensions.

## Interaction Resolver Events

`interaction.created` records the interaction kind and whether the create
request used a deprecated resolver-policy alias. It does not record the prompt,
title, options, questions, target identifier, creator identifier, or resolver
identifier.

`interaction.resolved` records the low-cardinality interaction outcome defined
in the generated contract. Its `legacy_inherited_restriction` dimension is
`true` only when stored migration provenance preserves a legacy resolver-policy
restriction. It is `false` for canonical new writes. This dimension describes
policy provenance. It does not contain user content or an identifier.

Use `trackInteractionCreated()` and `trackInteractionResolved()` from
`events.ts` to emit these events. The generated contract remains the authority
for their exact dimensions and optionality.

## Sandbox Startup Trace Spans

Paperclip opens OpenTelemetry spans on the sandbox start path. These spans are a
separate telemetry surface from the first-party events above. The generated
telemetry contract does not cover them, so this section is their canonical
contract.

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
| `pack` | Host-side workspace tarball build inside `stage.sync`. | `stage.sync` |
| `bridge.paperclip` | Paperclip bridge start step. | `sandbox.startup` |
| `bridge.process-session` | Process-session bridge start step. | `sandbox.startup` |
| `acp.handshake` | ACP session handshake step. | `sandbox.startup` |
| `sandbox.agentSession.sendInput` | One outbound ACP message to the agent — the socket handler's one `writeTextFile` exec. | the active run span |
| `sandbox.agentSession.pollOutput` | One 100 ms poll tick — `list`, then `read`+`remove` per file found (`1 + 2n` execs). | the active run span |
| `sandbox.callbackBridge.relayRequest` | One Paperclip-API callback request — read the request, write the response, remove it. | the active run span |
| `sandbox.agentProcess` | The persistent streamed agent process the process-session bridge launches; open until the process settles or the bridge tears down, whichever comes first. | the active run span |
| `sandbox.exec` | One host-to-sandbox execution. | the active step or wrapper span |

A step span name is the step name. The `sandbox.exec` span parents to the step
span that runs the execution, so each execution nests under its step. Within
`stage.sync`, the host-side sub-steps `snapshot.git`, `snapshot.baseline`, and
`pack` open as child spans of the step, so the host work at the head of the step
is attributed rather than showing as a gap. A run-time
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
| `sandbox.daytona.transfer` | The transfer step that uploads the files to the sandbox. | the active startup step span |
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

The `span.record` host handler enforces the allowlist. It re-maps `provider`
through the provider-family normalizer. It keeps `outcome` only when the value
is `ok`, `skipped`, or `failed`. It keeps a numeric attribute only when the
value is a finite number. It drops a status message and keeps only the numeric
status code. The handler never throws, because observability must not change the
sync control flow.

The `span.record` host method needs the `environment.drivers.register`
capability. So only a plugin that registers an environment driver may emit a
provider span. The capability gate rejects a provider span from any other
plugin.

The host parents each provider span to the active startup step span. The host
mints a W3C `traceparent` from the active step and passes it to the plugin
worker on the per-call invocation channel. The worker tags its span with the
`traceparent` and treats the value as opaque. The worker never derives the
parent from it. The host recovers the `traceparent` from its own invocation
record, so a worker can never forge a parent. The host validates the
`traceparent` and rejects a missing or malformed value. With no active host
trace context the worker sends no span, so the whole provider-span path is a
no-op.

## Sandbox Startup Run-Log Event

Paperclip writes one `run.startup.step` event to the run log for each bring-up
step. This event is a run-log record, not a first-party telemetry event. The
generated telemetry contract does not cover it, so this section is its canonical
contract.

The event payload carries only three fields.

| Field | Type | Meaning |
| --- | --- | --- |
| `step` | string | The bring-up step name, for example `stage.sync`. |
| `durationMs` | number | The wall time of the step. A skipped step reports `0`. |
| `outcome` | string | The step outcome (`ok`, `skipped`, or `failed`). |

The event no longer carries the per-step round-trip count or the provider
duration fields. It dropped `roundTrips`, `providerExecMs`, `providerGetMs`,
`createRuntimeMs`, and `ensureSessionMs`. The startup spans in the section above
carry that detail now. The `sandbox.exec` child spans hold the round-trip and
provider durations. The `acp.handshake` step span holds the create-runtime and
ensure-session sub-times.

To read the detailed timing, use the startup spans. The spans need an OTLP
endpoint. A run with no endpoint keeps only the three run-log fields above.

## Run Phase Timing Run-Log Event

Paperclip writes one `run.phase.timing` event to the run log for each
run-lifecycle phase. This event is a run-log record, not a first-party telemetry
event. The generated telemetry contract does not cover it, so this section is its
canonical contract. The producer is `emitRunPhaseTiming` in
`packages/adapter-utils/src/acpx-engine/startup-timing.ts`.

The event payload carries only three fields.

| Field | Type | Meaning |
| --- | --- | --- |
| `phase` | string | The run-lifecycle phase name from the closed allowlist below. |
| `durationMs` | number | The wall time of the phase. A negative or a non-finite value clamps to `0`. |
| `outcome` | string | The phase outcome (`ok` or `failed`). |

The `phase` field is one member of a closed, low-cardinality allowlist. The
producer drops any event whose phase name is outside this allowlist, so a
free-form label never reaches the run log. The allowlist has twelve phase names.

| Phase | Meaning |
| --- | --- |
| `place_workspace` | Place the run workspace. |
| `start_transport` | Start the agent transport. |
| `create_runtime` | Create the agent runtime. |
| `ensure_session` | Ensure the agent session exists. |
| `configure_session` | Configure the agent session. |
| `prepare_turn` | Prepare the turn. |
| `turn` | Run the turn. |
| `end_session` | End the agent session. |
| `settle_reuse` | Settle the session for reuse. |
| `stop_transport` | Stop the agent transport. |
| `sync_back` | Sync the workspace back. |
| `release_staging_lease` | Release the staging lease. |

The payload never carries a command, an argument, a path, an environment value,
or a raw identifier. The event rides the `ctx.onEvent` run-event bridge and is
observability-only. It needs no OTLP endpoint.

## Dimension Values

Telemetry dimension values must be primitives. Use only the value types allowed
by `TelemetryDimensionValue`:

- `string`
- `number`
- `boolean`

Do not emit `null`, `undefined`, arrays, or objects as dimension values. Optional
dimensions should be omitted when absent.

When a dimension is enum-like, use the shared constant from `constants.ts` when
one exists. If no shared constant exists, use the generated telemetry type as the
domain. In all cases, the generated telemetry type remains the source of truth
for the emitted value.

## Required, Optional, And Sentinel Values

Required and optional dimensions are defined by `EventDimensionsMap`.

Required dimensions must be present for every event of that name. Optional
dimensions should be emitted only when the value is known and useful.

Sentinel values are only for required fields that have no observed raw value at
the emitting layer. Do not use a sentinel to hide a concrete value that is new,
custom, or not yet represented by a shared constant. Emit the concrete raw value
and let the receiving layer canonicalize it.

## Adding Or Changing Telemetry

Client code is responsible for emitting approved telemetry events at the right
place in the product. Stable event names, dimensions, and enum domains must come
from the generated telemetry contract before normal emitters use them.

For product work that needs to propose a new first-party event before schema
registration, use the proposal marker workflow in `doc/TELEMETRY_WORKFLOW.md`.
Those proposed calls stay on `client.track()`, carry an `@ts-expect-error`
marker on the event-name argument, and are swallowed at runtime until the
generated schema registers the event name.

For stable event work:

1. Start from `generated/paperclip-telemetry.ts`. The generated types are what
   reviewers use to verify event names, dimensions, optionality, value types,
   enum descriptions, and schema version.
2. Choose stable event and dimension names. Do not include user content, local
   machine details, secrets, credentials, private paths, or values that are not
   part of the public event contract.
3. Use only `string`, `number`, or `boolean` dimension values.
4. Reuse a shared constant from `constants.ts` for enum-like dimensions when one
   exists. If the generated telemetry domain has values beyond a shared constant,
   keep the emitter aligned with the generated telemetry type.
5. Keep emitters raw. Do not normalize, alias-map, or lowercase enum-like values
   in the client unless the generated contract explicitly calls for that emitted
   value.
6. Add or update a typed helper in `events.ts` when the event is first-party and
   should have a stable helper API.
7. Update tests for helper behavior, including raw pass-through for enum-like
   values when that is the intended boundary.
8. Update this README only when the contributor workflow, source-of-truth
   pointers, or durable invariants change. Do not add an event catalog here.

Before opening a pull request, verify that the emitted code, typed helpers, and
generated telemetry contract agree. If they disagree, fix the contract or code
rather than documenting around the mismatch in this README.

For new first-party events that are not in the generated contract yet, follow
the public proposal and promotion workflow in
[`doc/TELEMETRY_WORKFLOW.md`](../../../../doc/TELEMETRY_WORKFLOW.md).

## Retention

Retention windows are documented in `retention.ts`. Each event is assigned a
retention class; the class determines the window in days. This is a
housekeeping and query-cost concern managed by data-infra, not a schema
concern — updating a retention window does not require a schema version bump.

Current classes:

| Class | Window | Description |
| --- | --- | --- |
| `operational_enum_count` | 90 days | Enum/boolean/count/bucket events. No token material, no PII. |

When a new event carries only enums, booleans, counts, or coarse buckets and
no token material or PII, assign it to `operational_enum_count` in
`EVENT_RETENTION_CLASS`. If no existing class fits, define a new class in
`RETENTION_DAYS` and document it here.
