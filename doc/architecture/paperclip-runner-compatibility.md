# Paperclip Runner compatibility and rollout

- Status: Proposed
- Date: 2026-08-24
- Parent decision: [Paperclip Runner architecture](paperclip-runner.md)

## Purpose

This document defines compatibility rules for introducing the experimental
Paperclip Runner. These rules are acceptance criteria for each implementation
change. They are not a migration plan for existing adapters.

## Compatibility invariants

1. Existing adapter selection is authoritative. A direct adapter stays direct.
2. A non-runner run must not start runnerd or open PRP.
3. A non-runner run must not create native result, finalization, status-decision,
   or runner-transport records.
4. A non-runner run must not invoke native status arbitration.
5. Direct adapters keep their current transcript, interaction, cancellation,
   result, and finalization behavior.
6. Runner-only UI controls depend on persisted runtime facts and are absent from
   direct runs.
7. The rollout flag controls fresh runner selection and fresh runner starts.
8. A flag change does not rewrite an agent profile or a persisted run choice.
9. Persisted native data remains readable after the flag is disabled.
10. Recovery may finish an already persisted native run while fresh native
    starts remain blocked.

## Runtime selection

The server resolves and persists the runtime once, before provider launch.

| Persisted runtime | Adapter | Flag | Result |
| --- | --- | --- | --- |
| none | Any direct adapter | off or on | Use the existing direct path. |
| none | `paperclip_runner` with Codex | off | Reject the fresh start with a stable rollout-disabled error. |
| none | `paperclip_runner` with Codex | on | Use PRP v1 and runnerd. |
| none | `paperclip_runner` with another provider | on | Reject the unsupported provider before runnerd starts. |
| direct | Any | changed later | Keep the persisted direct path. |
| native | Any | changed later | Keep the persisted native path for read, cancel, recovery, and finalization. |

The server must not fall back from a selected `paperclip_runner` start to
`codex_local`. A configuration or rollout error must be visible. Silent fallback
would hide the runtime that executed the task.

## Direct adapter boundary

This rule applies to every built-in and plugin direct adapter. It includes:

- `codex_local`;
- `claude_local`;
- `opencode_local`;
- other local CLI or session adapters;
- process and HTTP adapters;
- gateway adapters; and
- external adapter plugins.

Adding Paperclip Runner must not add runner imports or runner branches inside a
direct adapter implementation. The heartbeat coordinator may select the
explicit runner adapter at one narrow seam. All other adapters continue through
their existing code.

For a flag-off `codex_local` heartbeat, compatibility proof must show:

- one direct invocation;
- the same normalized result and finalization bytes as the approved baseline;
- zero runner processes;
- zero PRP connections; and
- zero native rows.

## Configuration behavior

When the rollout flag is off:

- creation UI does not offer `paperclip_runner`;
- edit UI does not offer switching to `paperclip_runner`;
- server creation and import reject a new `paperclip_runner` selection;
- the server rejects a fresh start for an existing runner-configured agent;
- read and export preserve an existing runner configuration;
- unrelated edits to an existing runner-configured agent do not erase its
  configuration; and
- switching that agent to a direct adapter remains allowed.

When the rollout flag is on:

- creation, import, and edit accept `paperclip_runner` only with provider
  `codex` and valid Codex configuration;
- switching from a direct adapter affects only future unresolved runs; and
- switching away from the runner affects only future unresolved runs.

Server validation is the authority in both states. Import files and API clients
cannot bypass the flag or provider allowlist.

## Persisted native runs

The following data remains readable independent of the current flag:

- the persisted runtime selection and reason;
- run, runner, session, turn, and provider identity;
- ordered runner and provider events;
- accepted result and evidence assessment;
- finalization coordinator and status decision;
- usage, cost, cancellation, and terminal details; and
- durable interactions and final task-thread reply.

If the flag is disabled during an in-flight native run, the server may reconnect,
cancel, reconcile, and finalize that same run. It must not use that recovery as
authority to start a new native run.

Recovery must remain idempotent. Repeating it cannot add a second final reply,
interaction, wake, status decision, or application effect.

## Task-page compatibility

The task page uses one provider-neutral thread projection. Runtime facts may add
runner event groups, semantic receipts, usage, and structured questions. They
must not replace classic direct-adapter content.

Direct-adapter coverage must include:

- an active run;
- a settled run;
- an empty transcript;
- a pending interaction;
- a resolved interaction; and
- the classic interface state.

The existing composer remains usable for direct adapters. A direct run does not
show reconnect, runner cancel, semantic receipt, or other runner-only controls.
Final replies continue to use the existing issue-comment behavior.

## Structured input compatibility

New structured questions use `paperclip.question_set.v1` and the matching
response contract. Provider-specific question objects remain inside their
drivers.

Legacy unstructured interaction records remain readable and resolvable. A
structured form fails closed when its required schema, question mode, question
ID, option ID, or response value is invalid. The implementation must not silently
convert malformed structured input to a legacy text prompt.

## Protocol version compatibility

PRP wire versions, fixture versions, event schema versions, and typed schema
discriminators are independently versioned.

- Peers negotiate the highest common PRP version.
- No common required version fails closed before command or provider execution.
- An unknown required fixture or event schema version fails closed.
- An unknown required typed discriminator fails closed.
- Additive optional properties remain compatible only when an old v1 consumer
  can ignore them without changing behavior.
- Unknown object properties must survive validation when the owning schema
  permits additive fields.

Breaking meaning requires a new required version. A provider error is not a
protocol negotiation result.

## Semantic action compatibility

Catalog generation and production authorization are separate steps.

- A catalog entry does not authorize production use.
- An operation without a production binding is undiscoverable.
- An operation denied to the run is undiscoverable unless the protocol
  explicitly defines a safe denied receipt for that discovery mode.
- A duplicate call with the same idempotency key and canonical input returns the
  original safe receipt.
- Reusing the key with different input returns a conflict and performs no second
  effect.
- Receipts redact credentials, private provider payloads, and hidden identity.

## Required compatibility matrix

Each runner-related pull request updates only rows that it can execute. The
complete first-wave matrix must cover:

| Area | Required cases |
| --- | --- |
| Runtime selection | Every built-in direct adapter, explicit runner selection, unsupported provider, flag on, and flag off. |
| Direct regression | Flag-off `codex_local` invocation count, byte-stable result/finalization, and zero native rows. |
| Configuration | Enabled and disabled create, import, edit, read, export, and adapter switch. |
| Recovery | Persisted native run after flag disable, reconnect, duplicate event, duplicate command, cancellation, and server restart. |
| Protocol security | Cross-company binding, ticket replay, ticket expiry, malformed frame, unsupported version, and revoked lease. |
| Semantic actions | Discovery denial, unbound action, duplicate call, conflicting retry, redaction, and governed action. |
| Task page | Active, settled, empty transcript, interaction, and classic direct-adapter states. |
| Structured input | Valid response, malformed response, stale response, duplicate response, provider loss, and cancellation. |

## Pull request acceptance

Every implementation pull request must:

- build and work against its declared base;
- keep its changed-file count below 100;
- update manifests and exports only for implemented surfaces;
- run the smallest relevant tests before the repository handoff gate;
- run typecheck, tests, and build for handoff;
- run protocol parity, Cargo, clean-consumer, migration, token, and browser gates
  when those areas change;
- contain no unexplained failed, cancelled, or path-skipped verification; and
- resolve actionable review and security findings before it is ready.

Generated files land with their source and a drift check. `pnpm-lock.yaml` is
owned by CI and is not part of these pull requests.
