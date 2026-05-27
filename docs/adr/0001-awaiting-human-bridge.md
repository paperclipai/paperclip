# Awaiting Human Bridge For External Human Input

This ADR replaces the earlier ClickUp-specific awaiting-human path in `heartbeat.ts` with a split between bridge state, bridge runner, and transport adapter. The bridge is the durable coordination object for one issue interaction reaching one external human channel. The runner is the execution seam that decides when to act. The adapter is the provider seam that knows how to talk to ClickUp or any future provider.

The bridge is not a generic chat system. The external thread is transport only, while Bizbox remains authoritative through the issue interaction and the imported issue comments created from inbound human replies. The bridge stores the minimum information needed to coordinate the workflow: which company and interaction it belongs to, which provider is selected, which external thread and message represent it, what state it is in, and when it should be revisited.

## Decision

Bizbox will support awaiting-human handoffs through an interaction-scoped bridge with company-scoped configuration and provider-specific transport adapters.

The bridge is configuration plus durable state, not provider behavior. It records:

- company
- issue interaction
- selected provider
- external thread and message IDs
- lifecycle state
- polling timestamps
- closure outcome

The runner is responsible for deciding when to execute bridge work. In practice, that means:

- detect when an issue enters `awaiting_human`
- open or reuse the bridge for that interaction
- run the selected adapter when delivery or polling is due
- apply generic bridge policy for replies, approvals, rejections, expiration, and closure

The adapter is responsible for provider-specific behavior only:

- send the outbound human-facing message
- poll the provider for replies or reactions
- normalize inbound provider events
- perform best-effort provider cleanup or status reactions

ClickUp-specific reply parsing, reaction semantics, and message acknowledgement belong in the ClickUp adapter, not in the generic bridge.

## Scope

For the first cut, the bridge applies only to issue interactions, not agent-thread asks. Identity is interaction-scoped: one active bridge exists per interaction, provider thread reuse is allowed only while that same bridge remains open, and a retry after timeout or failure creates a new bridge cycle instead of mutating the old one back into service. Channel selection is company-wide for now.

The bridge lifecycle is:

- `pending_delivery`
- `waiting_for_human`
- `closed`
- `failed`

Close outcomes include:

- `approved`
- `rejected`
- `expired`
- `superseded`
- `cancelled`

## Configuration

Company configuration for this bridge lives behind its own Awaiting Human settings seam instead of on generic company fields. Bizbox stores one `company_awaiting_human_settings` record per company, with generic bridge fields (`enabled`, `provider`) plus provider-specific config kept in provider JSON. For ClickUp, that provider JSON stores deterministic routing (`workspaceId`, `channelId`) and the secret reference for the personal token. The UI and runtime both consume this dedicated settings module and route rather than mutating generic company settings directly.

## Workflow Ownership

The runner and bridge core own generic workflow behavior:

- bridge lifecycle transitions
- dedupe
- polling orchestration
- plain reply import as issue comments
- waking the agent after imported replies
- approval and rejection resolution
- timeout handling
- failure handling

Plain replies are non-terminal and keep the bridge open. Approval and rejection signals are terminal: they resolve the interaction, wake the agent, and close the bridge. Timeouts close the bridge, emit activity plus an issue-visible system note, and leave the issue workflow state unchanged. Terminal provider failures mark the bridge failed, emit activity, and add an issue-visible system note.

## Polling First

We are starting polling-first, not because webhook support is impossible, but because polling is sufficient for the current workflow and keeps the first extraction smaller. The adapter seam is intentionally compatible with later webhook ingestion, but webhook support is deferred rather than required in this decision.

## Deployment: Three-PR Chain

The implementation is delivered as three chained PRs instead of one monolith:

1. **PR 1 - Configuration**: `company_awaiting_human_settings` schema, CRUD service, route, and UI page. No runtime, no transport. Merges independently.
2. **PR 2 - Bridge Core + Runner Cleanup**: bridge state/policy service, adapter registry, support modules (handoff builder, notification outbox, review file resolver), and runner/heartbeat cleanup that restores heartbeat to its pre-ClickUp role while removing the ClickUp notification additions from it. Depends on PR 1.
3. **PR 3 - ClickUp Transport Adapter**: ClickUp-specific transport (`send`, `poll`, `normalize`) and adapter wrapper that registers via the bridge adapter registry. ClickUp-specific reactions live here. No core changes. Depends on PR 2.

The registry stores factories - `registerAwaitingHumanBridgeAdapter(type, (db) => adapter)` - so PR 3 plugs in ClickUp without touching PR 2 files. This decomposition keeps each PR's review surface under Greptile coherence thresholds: one narrative per PR, no reviewer context-switching between settings validation, bridge lifecycle, and transport I/O.

PR 2 includes a large rewrite of `awaiting-human-notifications.ts` (shrinking from about 1,300 lines to about 390 lines). This is intentional: the master version hardcodes ClickUp chat delivery, channel resolution, and retry loops inline. The new version keeps only the generic outbox queue and scheduling; actual send now flows through the bridge runner to the adapter layer. The line reduction signals correct extraction, not deletion of functionality.

## Consequences

This decision gives us:

- a narrow bridge interface that carries durable coordination state instead of provider behavior
- a runner seam where bridge execution can change without rewriting provider adapters
- provider-specific behavior concentrated in one adapter module
- tests that can isolate bridge policy from ClickUp transport

It also means the old ClickUp logic in `heartbeat.ts` must not be reintroduced in generic bridge code. If a change needs ClickUp-specific transport behavior, it belongs in the ClickUp adapter or its transport wrapper.
