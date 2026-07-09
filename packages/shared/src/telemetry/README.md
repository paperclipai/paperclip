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
place in the product. It is not responsible for deciding which new events should
exist. Do not introduce ad hoc event names, dimensions, or enum domains in client
code; they must exist in the generated telemetry contract before emitters use
them.

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

## Codex Credential Health Events

**`codex.credential_health`** and **`codex.sync_back_outcome`** carry Codex
adapter authentication and sync state. Key invariants that emitters must preserve:

- Token material (refresh tokens, access tokens, secrets) must **never** appear
  in any dimension. Emit only derived values: SHA-256 fingerprints of sensitive
  material, enumerated age buckets (`lt_1h`, `lt_8d`, `gte_8d`, `missing`), and
  boolean flags (`rotations_detected`).
- For `codex.credential_health`, the post-run snapshot must be read from the
  execution environment that held the active `CODEX_HOME` during the run. For
  remote (sandbox/SSH) executions this is the remote home, not the local host
  path. Reading the wrong home after a run that rotated credentials will produce
  a false `rotations_detected: false`.
- Dimensions: `company_id`, `agent_id`, `adapter_type`, `seed_source`,
  `last_refresh_age_bucket`, `rotations_detected` (required); `failure_class`
  (optional — present only when a structured refresh failure was classified).
- For `codex.sync_back_outcome`: `company_id`, `agent_id`, `adapter_type`,
  `sync_back_outcome` (all required).

Allowed values for enum dimensions are defined in `generated/paperclip-telemetry.ts`
and must not be hard-coded or duplicated here.
