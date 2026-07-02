# Telemetry Data Contract

This document is the public contract for first-party Paperclip telemetry events.
It covers the event names and dimensions emitted by `packages/shared/src/telemetry/`
and the shared enum sources in `packages/shared/src/constants.ts`.

It does not describe where events are delivered or how any receiving system is
implemented. Contributors should treat that path as outside this repository's
public contract.

## Normalization Boundary

Telemetry emitters send raw dimension values. They must not pre-normalize values
into the canonical reporting form.

The receiving layer owns canonicalization because there should be one place that
maps legacy spellings, aliases, unknown adapter names, and future values into a
stable reporting shape. This keeps SDKs and third-party contributors simple:
emit what the product observed, use the documented sentinel only when a required
field has no value at all, and let the receiving layer decide the canonical form.

Examples:

- `adapter_type`: if the runtime reports a concrete adapter string that is not
  yet in `AGENT_ADAPTER_TYPES`, emit that raw string. Do not rewrite it to
  `other`. Use `other` only when the adapter is genuinely unknown and the event
  requires an `adapter_type` dimension.
- Interaction labels: if older code, plugin-adjacent code, or a caller reports a
  same-meaning label that does not match the current enum spelling, emit the raw
  label. Do not map it in the client before calling `track()`.

The one exception is privacy protection at the emit boundary: if a dimension is
documented as hashed before emission, emit the hashed value and the matching
boolean marker rather than the private source value.

## Event Catalog

The source of truth for registered first-party event names is
`TelemetryEventName`, which is backed by `PaperclipEventName` in
`generated/paperclip-telemetry.ts`. Plugin events use `trackDynamic()` and are
not part of this first-party catalog.

Dimension value types are `string`, `number`, and `boolean`. Optional dimensions
must be omitted when absent; do not emit `null`, `undefined`, objects, or arrays.

| Event | Dimensions |
| --- | --- |
| `agent.created` | Required `agent_id`: `string`.<br>Required `agent_role`: `string`, domain `AGENT_ROLES` plus telemetry-only values from `EventDimensionsMap`. |
| `agent.first_heartbeat` | Required `agent_id`: `string`.<br>Required `agent_role`: `string`, domain `AGENT_ROLES` plus telemetry-only values from `EventDimensionsMap`. |
| `agent.task_completed` | Required `adapter_type`: `string`, domain `AGENT_ADAPTER_TYPES` plus telemetry-only values from `EventDimensionsMap`.<br>Required `agent_id`: `string`.<br>Required `agent_role`: `string`, domain `AGENT_ROLES` plus telemetry-only values from `EventDimensionsMap`.<br>Optional `model`: `string`. |
| `company.imported` | Required `source_type`: `string`, domain declared inline in `EventDimensionsMap`.<br>Optional `source_ref`: `string`; hashed before emission when the source is private.<br>Optional `source_ref_hashed`: `boolean`; `true` when `source_ref` is hashed. |
| `error.handler_crash` | Required `error_code`: `string`. |
| `goal.created` | Required `goal_level`: `string`, domain `GOAL_LEVELS` plus telemetry-only values from `EventDimensionsMap`. |
| `install.completed` | Required `adapter_type`: `string`, domain `AGENT_ADAPTER_TYPES` plus telemetry-only values from `EventDimensionsMap`. |
| `install.started` | No dimensions. |
| `interaction.resolved` | Required `interaction_kind`: `string`, domain `ISSUE_THREAD_INTERACTION_KINDS` plus telemetry-only values from `EventDimensionsMap`.<br>Required `status`: `string`, terminal values from `ISSUE_THREAD_INTERACTION_STATUSES` plus telemetry-only values from `EventDimensionsMap`.<br>Required `resolved_by_kind`: `string`, domain declared inline in `EventDimensionsMap`.<br>Optional `resolution_reason`: `string`, domain declared inline in `EventDimensionsMap`.<br>Optional `created_by_kind`: `string`, domain declared inline in `EventDimensionsMap`.<br>Optional `creator_agent_role`: `string`, domain `AGENT_ROLES` plus telemetry-only values from `EventDimensionsMap`.<br>Optional `continuation_policy`: `string`, domain `ISSUE_THREAD_INTERACTION_CONTINUATION_POLICIES` plus telemetry-only values from `EventDimensionsMap`.<br>Optional `target_type`: `string`, domain declared inline in `EventDimensionsMap`.<br>Optional `option_count`: `number`.<br>Optional `selected_option_count`: `number`.<br>Optional `question_count`: `number`.<br>Optional `answered_question_count`: `number`.<br>Optional `created_task_count`: `number`.<br>Optional `skipped_task_count`: `number`.<br>Optional `has_reason`: `boolean`.<br>Optional `resolution_latency_seconds`: `number`.<br>Optional `interaction_id`: `string`.<br>Optional `created_by_agent_id`: `string`.<br>Optional `source_run_id`: `string`. |
| `project.created` | No dimensions. |
| `routine.created` | No dimensions. |
| `routine.run` | Required `source`: `string`, domain `ROUTINE_RUN_SOURCES` plus telemetry-only values from `EventDimensionsMap`.<br>Required `status`: `string`, domain `ROUTINE_RUN_STATUSES` plus telemetry-only values from `EventDimensionsMap`. |
| `skill.imported` | Required `source_type`: `string`, domain declared inline in `EventDimensionsMap`.<br>Optional `skill_ref`: `string`. |

## Value Types And Enum Domains

| Contract item | Public source |
| --- | --- |
| Allowed dimension value types | `TelemetryDimensionValue` in `types.ts`: `string`, `number`, or `boolean`. |
| Event names | `TelemetryEventName` in `types.ts`, backed by `PaperclipEventName` in `generated/paperclip-telemetry.ts`. |
| Per-event dimensions | `EventDimensionsMap` in `generated/paperclip-telemetry.ts`. |
| Adapter type domain | `AGENT_ADAPTER_TYPES` in `constants.ts`, with telemetry-only values from `EventDimensionsMap`. |
| Agent role domain | `AGENT_ROLES` in `constants.ts`, with telemetry-only values from `EventDimensionsMap`. |
| Goal level domain | `GOAL_LEVELS` in `constants.ts`, with telemetry-only values from `EventDimensionsMap`. |
| Interaction kind domain | `ISSUE_THREAD_INTERACTION_KINDS` in `constants.ts`, with telemetry-only values from `EventDimensionsMap`. |
| Interaction continuation policy domain | `ISSUE_THREAD_INTERACTION_CONTINUATION_POLICIES` in `constants.ts`, with telemetry-only values from `EventDimensionsMap`. |
| Routine run source domain | `ROUTINE_RUN_SOURCES` in `constants.ts`, with telemetry-only values from `EventDimensionsMap`. |
| Routine run status domain | `ROUTINE_RUN_STATUSES` in `constants.ts`, with telemetry-only values from `EventDimensionsMap`. |
| Other telemetry-only domains | The inline dimension union in `generated/paperclip-telemetry.ts` until a shared `constants.ts` export exists. |

Do not duplicate enum value lists in new docs or comments when a shared constant
already exists. Reference the constant by name and keep the emitted values aligned
with the generated telemetry types.

## Optionality And Sentinel Fill

Optionality is defined by `EventDimensionsMap`. Required dimensions must be
present on every event of that name. Optional dimensions are emitted only when
the value is known and useful.

Sentinel values are allowed only to fill a required field that has no observed
raw value:

- Use the event domain's documented sentinel, usually `other`, when the value is
  missing or unknowable at the emitting layer.
- Do not use a sentinel to hide a concrete raw value that the current enum does
  not recognize. Emit the raw value and let the receiving layer canonicalize it.
- If a field is optional, prefer omitting it over sending a sentinel unless the
  event contract explicitly says the sentinel carries meaning.

Worked example: `adapter_type` is required on `install.completed` and
`agent.task_completed`. If no adapter type is known, emit `other` so the required
dimension is present. If the adapter type is known but new, custom, or not yet in
`AGENT_ADAPTER_TYPES`, emit the raw adapter string.

For `company.imported`, `source_ref` is optional and must be omitted when there
is no source reference. When a source reference is private, emit the hashed value
as `source_ref` and set `source_ref_hashed` to `true`; otherwise emit the raw
source reference and set `source_ref_hashed` to `false`.

## Adding Or Changing A Telemetry Event

1. Pick a stable event name using the existing dot-separated style, such as
   `area.action`. Do not include user content, file paths, local machine details,
   secrets, or identifiers that are not already part of the public event contract.
2. Declare the event dimensions in the telemetry schema that produces
   `generated/paperclip-telemetry.ts`. Define required vs optional fields
   deliberately.
3. Use only `string`, `number`, or `boolean` dimension values.
4. For enum-like dimensions, reuse the existing shared constant from
   `constants.ts` when one exists. If no constant exists, use a named generated
   telemetry domain and consider whether the domain should become a shared
   constant before adding more call sites.
5. Keep emitters raw. Do not add client-side normalization, alias mapping, or
   lowercasing just to satisfy the current enum. Sentinel-fill only truly
   unknown required values.
6. Add or update the wrapper in `events.ts` and export it from `index.ts` when
   the event is first-party and should have a typed helper.
7. Update or add tests for the wrapper behavior. Include a case that proves raw
   enum-like values pass through unchanged when that is the intended boundary.
8. Update this README in the same change so the event catalog remains current.

Before opening a pull request, verify that the docs and generated telemetry
types agree on event names, dimensions, optionality, value types, and enum-domain
references.
