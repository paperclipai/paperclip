# Telemetry Data Contract

This document explains how contributors should use Paperclip's public telemetry
contract. It intentionally does not list individual events or dimensions.

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

## Sandbox Startup Trace Spans

Paperclip opens OpenTelemetry spans on the sandbox start path. These spans are a
separate telemetry surface from the first-party events above. The generated
telemetry contract does not cover them, so this section is their canonical
contract.

The spans are opt-in. Paperclip exports them only when an OTLP endpoint is
configured. With no endpoint the whole span path is a no-op. Paperclip opens the
spans only for a run that targets a remote sandbox. A local run and an SSH run
stay out of these spans.

Span attributes use a closed allowlist. A command, an argument, an environment
value, a file path, an identifier, or program output never rides a span. It rides
neither as an attribute nor as an event. Each numeric attribute is finite.
Paperclip omits an attribute when its value is absent.

### Spans

| Span | Scope | Parent |
| --- | --- | --- |
| `sandbox.startup` | The one root span for a sandbox bring-up. | none (root) |
| `workspace.resolve` | Workspace resolution step. | `sandbox.startup` |
| `codex-home.seed` | Managed-home seed step. | `sandbox.startup` |
| `skills.reconcile` | Skills reconcile step. | `sandbox.startup` |
| `stage.sync` | Workspace stage-sync step. | `sandbox.startup` |
| `bridge.paperclip` | Paperclip bridge start step. | `sandbox.startup` |
| `bridge.process-session` | Process-session bridge start step. | `sandbox.startup` |
| `acp.handshake` | ACP session handshake step. | `sandbox.startup` |
| `provider.execute` | One host-to-sandbox provider exec call. | none |

The root span sets the error status when the bring-up fails. Each step span sets
the error status when its step fails.

### Startup span attributes

The bring-up step spans use this closed attribute allowlist.

| Attribute | Type | Optional | Meaning |
| --- | --- | --- | --- |
| `step` | string | no | The bring-up step name. |
| `provider` | string | yes | The normalized provider family. |
| `roundTrips` | number | yes | Host-to-sandbox round trips for the step. |
| `providerExecMs` | number | yes | Provider-reported exec time for the step, in milliseconds. |
| `providerGetMs` | number | yes | Provider-reported fetch time for the step, in milliseconds. |

### Provider exec span attributes

The `provider.execute` span uses this closed attribute allowlist. Paperclip omits
a duration attribute when the provider does not report the value.

| Attribute | Type | Optional | Meaning |
| --- | --- | --- | --- |
| `provider` | string | no | The normalized provider family. |
| `exit` | string | no | `ok` when the exit code is 0, else `error`. |
| `provider.exec.duration_ms` | number | yes | Provider-reported exec wall time, in milliseconds. |
| `provider.get.duration_ms` | number | yes | Provider-reported fetch wall time, in milliseconds. |

To add a startup span attribute or a provider span attribute, extend the
allowlist in the code first. Keep the attribute low-cardinality and free of user
content.

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
