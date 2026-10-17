# Agent runtime synchronization

Plugins can opt into committed agent runtime changes with
`resourceLifecycle: ["agent_runtime"]` and `events.subscribe`.
Implement `onResourceLifecycle` and handle `update` and `delete`.
Existing agent and project subscriptions do not receive this new resource type.
Manual inbox reads retain both legacy streams regardless of automatic subscriptions.
They include runtime events only when the manifest opts into `agent_runtime`.

An event contains company identity, agent identity in `resourceId`, a numeric
sequence serialized as `id`, and its action. It contains no file contents,
configuration, or credentials. Treat `id` as an opaque decimal revision, not a
JavaScript floating-point value. Delivery is at least once and ordered per agent.
Return `acknowledged` only after external effects finish. Return `retry` after an
unfinished operation, or `deferred` when configuration is missing. Startup,
plugin startup, and configuration changes recover unacknowledged work.

The host records configuration changes at the database mutation boundary. This
covers API saves, rollback, plugin writes, and background writers. No-op updates
and heartbeat accounting do not create runtime work. Instruction edits, file
deletions, restores, and run writeback use the file audit boundary. Pending hires
produce no update until approval. Returning to the ready lifecycle phase requests
synchronization after preparation or resume. Existing agents receive a one-time
baseline when the migration runs. Agent deletion leaves a durable delete event.

PostgreSQL notifications wake the existing durable dispatcher only after commit,
including writes through independent clients. Notifications carry no identifiers
or contents. The journal remains authoritative. The listener scans on connection
and reconnection so a dropped notification does not lose committed work. There
is no recurring empty-inbox poll. Existing retry deadlines still retry failed work.
A process opens one listener connection only after a ready plugin opts into
`agent_runtime`. The database connection must support session-level `LISTEN`;
transaction-mode poolers are not supported for this opt-in feature. Startup waits
for listener registration. It releases the listener after the last runtime
subscriber is disabled or removed. Legacy subscriptions keep process-local work signals.

A plugin that also has `agents.lifecycle.manage` can call
`ctx.agents.getRuntime(agentId, companyId)` from a company-scoped invocation.
Only the enabled, ready plugin selected in that agent's required lifecycle set
can read these inputs. The result supplies the latest runtime revision, the
normalized agent configuration, instruction root and entry filename, and that
plugin's own instance secrets. Instruction paths use the same managed-folder
recovery as the instruction reader. A missing or cross-company agent returns null.
The instruction root identifies host files that the trusted worker can package
through its existing filesystem access. This API grants no arbitrary path reads.
Never expose instance secrets through UI data, logs, plugin state, or agent files.

Re-read current state before external effects. A queued event can be older than
the returned revision. Fence stale revisions at the destination and use its
conditional writes. Current configuration is desired state, not a frozen run
snapshot or permission to change an active provider session. Execution admission
and provider activation keep their existing checks. The private transport consumer
is a separate integration.

Filesystem changes outside Paperclip's managed write APIs do not emit these
hooks. Filesystem publication and the database journal are not one filesystem
transaction. A failed managed write must be repaired through the same API before
claiming synchronization. Upstream repository detection remains owned by the
source integration.

Successful file saves record the current desired state. Identical retries and
already-applied deletions repair a missing journal event if a prior save published
bytes before its database transaction failed. Audit rows carry their runtime
revision, so repeated identical saves against that revision create no audit rows
or events. Later runtime changes invalidate that deduplication. The file API still
returns `changed: false` for identical content and keeps conditional-write checks.
Consumers can skip rewriting content whose hash already matches.

## Skills

Migration 0348 invalidates referencing agents when installed skill content,
companion files, versions, source bindings, or identities change. Rename checks
both old and new keys. String selections, structured selections, and supported
legacy aliases are recognized. Unrelated agents and other companies receive no
content invalidation. Private-source bindings, membership, and privacy changes
invalidate only agents assigned skills from the affected sources. Project workspace
authorization-policy changes use the same boundary. Company policy
changes conservatively invalidate the company.
Source retry/lease bookkeeping and skill popularity counters do not emit changes.
Multi-skill source publication defers its skill invalidation until transaction
commit, after it acquires all skill rows. This avoids an agent-lock/skill-lock
cycle with concurrent version saves. Individual file edits retain immediate
journaling and their existing filesystem rollback behavior.

Assignment edits already use the configuration boundary. The runtime reader
returns selected skill entries with host source paths and immutable version IDs.
It uses the execution resolver, current agent access, the instance pin flag, and
legacy operational-skill rules. It performs no upstream refresh. The resolver can
rebuild an expired version cache from saved bytes. Slow materialization happens
outside the agent row lock. The reader rechecks ownership and revision afterward;
it retries concurrent changes three times and then returns a conflict.

Pinned assignments receive conservative content invalidations too. Their resolved
version and bytes stay pinned when pin support is enabled. Consumers can compare
versions or destination hashes and avoid rewriting unchanged trees. Task-only
skill mentions and a running task's saved version selection remain task-owned.

## Standing connection assignments

`getRuntime` also returns `connectionAssignments`: effective `publicMcp` and
`chatConnectors` feature switches, installed connections with `id`, `name`,
`transport`, `enabled`, and `status`, and active profile IDs. It includes both
company assignments and assignments for the requested agent. It excludes other
agents' assignments and has no credential values, grant details, or tool schemas.
The owning-plugin checks for the runtime reader apply to this field too.

Migration 0354 records committed changes to every stored field used by this
snapshot. Agent-targeted installation and profile binding edits invalidate only
their old and new target agents. Company-targeted assignments invalidate company
agent runtimes. Project, routine, issue, and gateway bindings are outside this
snapshot and do not invalidate it. Connection metadata, profile activation or
removal, and connector feature switches still use conservative company-wide
invalidation. Empty writes and changes to health bookkeeping do not. Multiple
assignment statements in one transaction coalesce to one update per agent.
Journal writes and their triggering changes commit or roll back together.
Company-wide invalidation remains synchronous: it locks eligible company agents
in order and journals one update per agent. Its work grows with company size;
there is no fanout ceiling or cross-transaction mutation quota.

The reader orders and deduplicates assignments. It rejects more than 512
connections or 128 active profiles with status 422 instead of returning a partial
snapshot. It rechecks the revision after reading assignments and skills, with the
same three-attempt conflict behavior described above.

Each delivery-service startup records one company baseline when an enabled
runtime subscriber becomes active. This covers feature overlays supplied at
process startup. It does not add a recurring scan. Plugins must compare desired
state and destination hashes before rewriting external files.

Standing assignments express desired state; they do not prove task-specific
authorization. Existing agent and skill invalidations still apply independently.

## Tool definitions and configuration

Migration 0355 extends runtime invalidation to application and connection
configuration, catalog contents, profile entries, policies, and MCP gateways.
These changes use the same content-free journal, atomic commit behavior, and
transaction coalescing. Bulk discovery invalidates once per company per committed
chunk instead of once per tool. Unchanged rediscovery, health bookkeeping, and
trust-rule usage counters do not request preparation. Binding and installation
notifications retain the scoped recipients described above. Definition changes
use synchronous company-wide fanout with the same documented company-size cost.

Profile entry mutations lock referenced applications, connections, and catalog
rows before the parent profile. They then change the entries and parent in one
transaction, using the reserved connection for validation and profile reads.
Profile replacement uses the same order. Setup finalization and
catalog publication can run concurrently without acquiring these locks in the
opposite order. Policy reorder locks all affected policies in ID order before
changing priorities. Connection removal locks the managed profile before deleting
its entries in the same transaction.

The bounded assignment snapshot remains the API described above. An invalidation
can advance its revision without changing its assignment fields. Consumers must
use their existing authorized readers for tool definitions and configuration.
Credential-only changes, grants, secrets, and endpoint configuration still need
the access hooks supplied by a later migration before consumers can rely on
their immediate synchronization.
