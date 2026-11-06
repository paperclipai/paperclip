# Automatic agent provider backup

## Intent and scope

An operator can configure an ordered pool of execution accounts for an agent, adding as many backups as needed. When a provider reports that its quota is exhausted, the same agent can continue its task with the next available pool member, including an independently authenticated account of the same provider or a different supported provider. Existing agents without a pool keep their current behavior. The feature does not predict quota exhaustion from a percentage or transfer a provider's private session state.

## Approaches

- Automatic failover on a confirmed provider-quota failure: selected because work can continue without operator intervention.
- Operator-triggered switching: simpler to inspect but leaves work idle until a person acts.

The repository already contains an experimental AI connection router and reusable account pools. Extend and integrate that mechanism where it meets these requirements rather than introducing a competing pool. Its present task pinning, plugin routing, cursor policy and in-memory usage cache do not themselves provide ordered quota failover or durable account cooldowns; preserving existing allocations and authorization is mandatory when adding that behavior.

## Configuration and visibility

Provide an optional ordered pool in agent settings, with an add control and independently selected provider, model, execution settings and credential reference for each member using existing secure configuration mechanisms. Members can be reordered and removed. Validate company ownership and actor permissions. Make providers and potential cost visible when configuring the pool; never copy credentials into logs or handoffs. Display the actual provider and reason for failover in run history and activity records.

Support only provider, runtime, workspace and credential combinations that can be validated and tested end to end. Publish the actual initial support matrix in product documentation and the settings UI; reject unsupported combinations explicitly rather than silently using ambient credentials. At minimum the implementation must qualify the requested same-provider independent-account and Claude-to-Codex paths before claiming they work.

## Execution and recovery

Only a positively classified provider-quota failure activates the next available member. Confirm that the previous execution and owned resources are stopped or released before admitting a successor; uncertain termination must remain held. The successor is a separate, auditable attempt for the same agent and task, subject to current company, authorization, pause, stop, budget, workspace, approval and task-ownership gates. Preserve the effective configuration and credential identity for each attempt; do not reinterpret an in-flight run after configuration changes. Persist transition and ownership atomically so concurrent workers, cancellation and restart cannot create duplicate successors. If no eligible member can run, use existing recovery and report the cause. Never switch for authentication errors, generic failures, or an unverified quota signal.

Bound the transition across the entire logical recovery chain: try each eligible member at most once per chain and never loop. Coordinate it with existing quota wait-recovery so a failover and a quota recovery cannot both schedule competing work. Update the implementation specification to describe the new behavior.

Record the primary quota deadline when supplied and avoid retrying it before that deadline. Once eligible, use the primary for a subsequent new run; do not interrupt a running backup. If no reliable deadline exists, retain existing quota recovery behavior rather than continuously probing. Exact scheduling follows the existing retry and recovery contracts.

Persist quota suppression by effective provider and account identity across agents, tasks, concurrent runs and restarts, within the appropriate company and credential authority. Pool selection skips an account without launching it until the recorded reset time. Concurrent reports must not shorten a known later cooldown. If a confirmed quota failure has no reliable reset deadline, use a bounded cooldown based on existing quota-recovery policy and avoid uncontrolled probing; make the uncertain reset visible. Account identity must not expose credentials. When all members are unavailable, schedule one wake at the earliest eligible deadline through existing recovery, without polling.

## Sessions and context

Provider sessions are bound to their provider, account and runtime identity. Never resume a primary session with the backup identity. A backup starts a fresh provider session with the existing company- and task-scoped bounded handoff and can retrieve further authorized task context. This does not promise the full provider transcript, hidden context or all tool calls. Preserve the primary session for later use when its provider and identity remain compatible. Workspace state and completed side effects must be preserved; handoff must not treat historical text as new authority or repeat completed actions.

Current task-session uniqueness does not distinguish accounts for the same adapter. Extend durable session identity and migration as needed so primary and backup sessions cannot overwrite or resume each other, including for two Claude accounts. Resume a saved backup session only when its identity and task boundaries match; otherwise use a fresh handoff.

## Verification and constraints

Test account and provider changes, quota detection, no-backup behavior, deadlines, bounded failures, session identity and handoff, stop and budget gates, competing workers, restart and uncertain process termination. Verify credential isolation and company scoping. Exercise settings and run visibility, then run the repository's required typecheck, test and build checks and token gates for UI changes. Live provider quota behavior is separately qualified and must not be claimed from simulated tests.
