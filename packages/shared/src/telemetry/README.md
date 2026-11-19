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

| Contract item                                 | Public source                                                                            |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| First-party event names                       | `PaperclipEventName` in `generated/paperclip-telemetry.ts`                               |
| Per-event dimensions and optionality          | `EventDimensionsMap` in `generated/paperclip-telemetry.ts`                               |
| Enum descriptions for telemetry dimensions    | `PAPERCLIP_ENUM_DESCRIPTIONS` in `generated/paperclip-telemetry.ts`                      |
| Schema version and event envelope helpers     | `SCHEMA_VERSION`, `makeEvent()`, and `makeBatch()` in `generated/paperclip-telemetry.ts` |
| Runtime-safe event names and dimensions       | `TelemetryEventName` and `TelemetryEventDimensions` in `types.ts`                        |
| Allowed primitive dimension values            | `TelemetryDimensionValue` in `types.ts`                                                  |
| Shared reusable enum domains                  | Named exports in `constants.ts`                                                          |
| First-party typed emit helpers                | `events.ts`                                                                              |
| Generic client behavior                       | `client.ts`                                                                              |
| Retention windows and event class assignments | `RETENTION_DAYS` and `EVENT_RETENTION_CLASS` in `retention.ts`                           |

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

The `adapter_type` dimension on `agent.task_run` and `agent.task_completed` is
not an alias map. For a Paperclip runner agent, the server sends the harness
that `agentHarnessType()` resolves from the agent configuration. The receiving
layer does not get that configuration, so it cannot derive the harness from
`paperclip_runner`. The emitter sends the resolved value raw. It does not fall
back to `other`.

If a dimension is privacy-protected before emission, emit only the protected
value and its matching public marker as defined by the typed helper or generated
contract. Do not emit private source material in telemetry dimensions.

Credential-bearing chat setup failures replace provider-controlled error names,
messages, and stacks with a fresh generic error before the HTTP error handler
reports the crash. The existing `error.handler_crash` event still uses its
generated `error_code: string` contract; this path emits only `Error`, never a
provider-supplied error name that may contain a credential. This is a privacy
boundary, not enum canonicalization. Test the value reaching the telemetry
helper as well as the separate crash-reporting and local logging sinks.

## Server Startup Privacy

The startup helper emits the raw Node.js operating system family once when an
enabled server telemetry client initializes. It omits OS versions, CPU
architecture, hostnames, and other machine details. The usual telemetry opt-out
and CI suppression apply before client initialization. If state storage fails
at startup, the server disables telemetry for that process and continues to run.
The warning contains no storage path or underlying error. Container and WSL servers
report their runtime platform; this does not identify the underlying physical
host's OS. Count distinct installation identifiers by platform to compare
installations, since restart event counts also reflect restart frequency.

Contract syncs may also register existing proposals. Remove each adopted
proposal marker and update its helper and transport tests in the same change.
The connector helpers preserve raw enum values and send only catalog connector
keys and the approved lifecycle and invocation dimensions. Connection names,
credentials, tool arguments, and tool results stay out of those events.

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

Emit `interaction.resolved` only after the complete decision transaction commits.
Conversational answers include the card outcome, source-message reference, and
activity audit in that transaction. A rollback or matching retry must not emit
a resolution event. This changes emission timing only: message text, comment IDs,
and user IDs remain in the instance database and are not added to telemetry.

Use `trackInteractionCreated()` and `trackInteractionResolved()` from
`events.ts` to emit these events. The generated contract remains the authority
for their exact dimensions and optionality.

## Agent Task Run Events

`agent.task_run` records one terminal state for one agent run: `succeeded`,
`interrupted`, `failed`, `cancelled`, or `timed_out`. Emit it once per run, at
the run's terminal transition. Do not emit it for a run that is still active.

The event's `task_id` dimension is optional and privacy-protected. Never emit
the raw task id. Pass the raw id to `trackAgentTaskRun()` in `events.ts`. The
helper calls `hashPrivateRef()` on `client.ts`, which derives the emitted
value with a salted hash of the per-installation secret.

Use `trackAgentTaskRun()` to emit this event. The generated contract remains
the authority for its exact dimensions and optionality.

Failed, timed-out, and interrupted runs also carry `failure_cause`. The server
picks this code from the run's stored error code and its provider failure
category, in `server/src/services/agent-task-run-telemetry.ts`. The code is a
fixed enum. It never contains error text, provider messages, or SQL. An error
code that the mapping does not know is sent as `unknown`. The provider failure
category decides the code only for the generic `adapter_failed` and
`provider_failed` codes, or when there is no error code. The mapping reuses the
run failure code sets in `server/src/services/continuation-cause.ts`, and a
test fails when a code in those sets has no telemetry code.

The `adapter_type` dimension on `agent.task_run` and `agent.task_completed`
reports the harness the agent runs, as `agentHarnessType()` resolves it. A
Paperclip runner agent therefore reports its underlying harness (for example
`claude_local` or `codex_local`), not `paperclip_runner`. Some runner harnesses
are not in the generated `adapter_type` enum yet: `acpx:copilot`,
`antigravity_runtime`, `aws_agentcore`, `claude_managed`, `grok_bot`, `muse`,
and `openai_dot`. The receiving layer reports them as `other` until the
contract lists them. A test in
`server/src/__tests__/agent-task-run-telemetry.test.ts` fails when a runner
harness that is not in this list is missing from the contract.

## Product Lifecycle Events

`model.connected`, `task.created`, `task.completed`, `task.blocked`,
`plan.created`, `plan.approved`, and `artifact.created` describe the main
product path. Their dimensions are enums, booleans, and counts only. They never
contain a task title, a document body, a plan step, a connection or account
name, an email, a URL, a repository name, or an endpoint address.

The server emits these events through
`server/src/services/product-telemetry.ts`. Each emit site runs inside the
transaction that writes the change, and the helper sends the event only after
that transaction commits (`afterTransactionCommit` in `@paperclipai/db`). A
rolled-back write sends nothing. This includes a write in a savepoint that
rolls back while the outer transaction commits. The
helper also wraps the track call in `withTelemetryCompany()`, so Cloud direct
delivery gets the company for background writes.

These rules keep one event per real change:

- `task.created` is sent for a newly inserted task only. Chat conversations,
  company imports, and create requests that return an existing task do not send
  it. `created_by_kind` is `routine` for a routine-run task and `onboarding` for
  the first task from the onboarding wizard. Otherwise it is the acting kind.
- `task.completed` and `task.blocked` are sent when a task's status changes
  from another value to `done` or `blocked`. Writing the same status again
  sends nothing. `issueService.update` covers most writers. The two direct
  writers that block a task (the dispatch check for unrunnable workspace
  settings and execution recovery) call the same helper as a system write.
  A new direct status writer must call it too.
- `blocked_reason` is derived at the transition. A blocking task that is not
  done gives `waiting_on_task`. A cancelled blocker counts, because it stays
  unresolved until someone changes the relation. Otherwise, the unblock owner gives `waiting_for_person` or
  `waiting_for_agent`. A system write with neither gives `needs_recovery`. A
  person or agent write with neither gives `unspecified`.
- `plan.created` is sent for the first revision of a task's `plan` document
  only.
- `plan.approved` is sent when a person or agent accepts a confirmation request
  whose target is the task's `plan` document.
- `model.connected` is sent for a new AI provider connection. A reconnect of an
  existing connection does not send it.
- `artifact.created` is sent for a new task work product. A work product
  provider outside `paperclip`, `github`, `vercel`, and `s3` is sent as
  `custom`, so a private service name never leaves the installation.

The actor kind is `agent` when an agent acts, `user` when a person acts, and
`system` when neither does.

On Cloud direct delivery, each of these events also names the responsible
person with `withTelemetryActor()` and `resolveTelemetryPerson()`: the task
creator, else the task's responsible user, else the run owner (the acting
person, the plan author, or the user who owns the model connection). A live
request still wins. The self-hosted collector envelope does not change.

## Cloud Direct Delivery

Self-hosted installs are unchanged. They post every batch to the collector,
private references stay hashed by `hashPrivateRef()`, and the collector and
its loader apply their anonymization. A self-hosted server never loads
`posthog-node`.

A Paperclip Cloud stack can send telemetry straight to PostHog instead. The
server turns this on only when the instance is Cloud-managed and
`PAPERCLIP_POSTHOG_PROJECT_TOKEN`, `PAPERCLIP_CLOUD_STACK_ID`, and
`PAPERCLIP_POSTHOG_ENVIRONMENT` are set.
`PAPERCLIP_POSTHOG_DIRECT=0` sends through the collector again. The server owns
this transport (`server/src/services/posthog-direct/`). This package only
exposes the `TelemetryTransport` seam on `TelemetryClient`:

- With a transport, each flushed batch goes to the transport and never to the
  collector. One batch has exactly one sender.
- A transport with `hashesPrivateRefs: false` makes the typed helpers emit raw
  task ids. Private source refs (for example a private repository name) are
  customer content, not identifiers, so they stay hashed on every path and
  `source_ref_hashed` stays `true` for them.
- The transport can capture per-event context at track time. That context is
  never added to the collector envelope.
- Background work (heartbeat runs, routine runs, connection invocations, and
  interactions) has no request. The server emit site wraps the track call in
  `withTelemetryCompany(companyId, fn)` from
  `server/src/telemetry-company-scope.ts`, with the company of the entity it
  reports on. Only the direct transport reads this scope, and it uses it only
  when no live request supplies a company. The collector envelope and the
  dimensions do not change.
- Agent-driven events (`agent.task_run`, `agent.task_completed`, and
  `agent.first_heartbeat`) also name the person responsible for the work, with
  `withTelemetryActor({ companyId, person }, fn)` and
  `resolveTelemetryPerson()` from the same file. The person is the user who
  created the task, else the task's responsible user (who assigned or
  delegated it), else the user who owns the run (for `agent.first_heartbeat`,
  the user who created the agent). The emit site reads these ids from rows it
  already loads; the transport does no database reads. A signed-in user on a
  live request always wins over this scope. With no person, the event stays on
  `workspace:<stackId>` with `$process_person_profile: false`. Every direct
  event carries `attributed_via`: `request`, `task_creator`, `task_assigner`,
  `run_owner`, or `none`. The collector path never reads this scope, so the
  self-hosted envelope does not change.

Cloud is Paperclip's own service under the Cloud terms, so its events carry
real identifiers: raw agent and task ids, the stack id, and the company and
acting user ids when known. Event names, dimension names, metadata keys, the
deterministic event uuid, and enum fallback normalization stay the same as the
collector path, so existing insights keep working. Request headers from the
browser SDK only link an event to a browser session. They never set identity
or grant access. Do not use this path to send fields that are not in the
generated contract.

On each start, a Cloud server with direct delivery also sends one
`cloud.workspace_started` event and a workspace `$groupidentify`, straight
through the PostHog client. Neither is in the generated contract, and neither
goes through `TelemetryClient` or the collector. The event carries
`install_hash`, the sha256 of the install id, which is the same value the
collector stores as `install_id`. It lets an offline job join a workspace's
pre-switch history. No other event carries `install_hash`.

### Other Data Paths

This document covers Paperclip Telemetry only. The generated Telemetry
contract covers neither the Observability path nor the run-log path. Two other
data paths document their own contract in their own file:

- [Observability](../../../../doc/observability.md) — the operator-enabled
  OpenTelemetry trace path and Sentry error monitoring.
- [Run-Log Events](../../../../doc/run-log-events.md) — events written to the
  local `heartbeat_run_events` table.

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
8. Keep the telemetry transport contract assertions in `client.test.ts`, which
   owns the emitted-envelope, retry, and payload-size boundaries.
9. Update this README only when the contributor workflow, source-of-truth
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

| Class                    | Window  | Description                                                  |
| ------------------------ | ------- | ------------------------------------------------------------ |
| `operational_enum_count` | 90 days | Enum/boolean/count/bucket events. No token material, no PII. |

When a new event carries only enums, booleans, counts, or coarse buckets and
no token material or PII, assign it to `operational_enum_count` in
`EVENT_RETENTION_CLASS`. If no existing class fits, define a new class in
`RETENTION_DAYS` and document it here.

## GitHub-synced skills

The legacy import endpoint retains `skill.imported` with its existing `source_type`.
For source-managed GitHub skills, `skill_ref` is omitted, including public sources:
the saved repository may be private and its key contains user-authored names.
Source discovery, selection, and refresh add no first-party telemetry events.
Repository URLs, paths, commits, connection IDs, names, and file contents stay out
of these telemetry dimensions. Review this suppression in privacy review alongside
changes to the legacy import caller; the event schema and envelope are unchanged.
