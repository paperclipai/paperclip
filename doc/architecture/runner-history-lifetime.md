# Runner history over an unbounded lifetime

This is the target contract for history, receipts and recovery of long-running
agents. Implementation and qualification are tracked in the dated
[implementation record](../plans/2026-09-28-unbounded-runner-history.md).
The local indexed Codex path is opt-in; this document does not declare the whole
contract implemented or qualified.

Paperclip uses the stock Codex distribution. A Paperclip-maintained Codex build
is out of scope. Provider-owned replay and checkpoint limitations remain
explicit limits of the stock-provider guarantee until upstream supports the
required interfaces; this design does not hide them behind an unlimited claim.

## What the product promises

A task may accumulate history for days and continue for arbitrarily many turns.
Completed work must never consume a lifetime allowance that eventually prevents
the next operation. The same applies inside one active model turn. Adding
storage does not change the task, provider session, pending call identities, or
the meaning of an old receipt.

“Unlimited” describes cumulative application limits. Available disk, storage
throughput, provider context and service limits, and operator budgets still
apply. An individual frame, current operation and unfinished delivery queue
have finite admission limits. Those credits become available again when work
settles. Exhausting storage preserves the exact task and pauses admission until
capacity returns; it must not be reported as a mismatched or corrupt session.

The mechanism has three parts:

- **Current state** says who owns the task and what is unfinished. Ordinary
  continuation reads this small record and bounded pages of outstanding work.
- **History** contains past output. Writers append it; readers request pages
  or stream downloads. Current execution does not reread old output.
- **Receipts** remember the exact identity and result of completed actions.
  A repeated action looks up one receipt in an index. An AI summary cannot
  replace these records.

With current work held constant, memory and foreground I/O have no linear
dependence on historical bytes or completed action count. Indexed lookup can
grow logarithmically, and storage/cache conditions can affect latency. A full
export or disaster recovery may process historical bytes in the background;
it cannot become a prerequisite for every review turn.

## Authority and storage boundaries

PostgreSQL is the controller's authority. The native runner owns transactional
SQLite stores for runner and provider state. Immutable large bodies use the
configured payload store. Provider-owned files remain provider state, not
Paperclip action receipts. Each store's purpose is explicit; a locator, cached
projection, output transcript or backup directory is never write authority.

Each controller transaction validates company, issue, run, normalized session,
runner and environment ownership. It commits current state, exact new receipts,
outstanding-work changes and the accepted raw-event cursor together. The raw
event is acknowledged only after that commit. Normalized UI delivery is a
separate durable outbox; its cursor advances only with its consumer's commit.

Local SQLite commits and reads run on owned storage executors, using qualified
SQLite, bounded queues and WAL recovery. Partition routing is indexed. A
receipt lookup never searches all prior files. Split and relocation operations
are resumable, capture concurrent writes, and publish a new routing generation
only after verification. The current routing head and any routing hierarchy
must themselves support subdivision; an ever-growing root manifest is not an
acceptable substitute for partitioning.

The candidate routing implementation uses a B+tree of bounded, immutable pages.
Only its bounded top page lives in the root SQLite transaction. That page also
subdivides; point lookup follows one verified path, and each child is bound by
its digest and range. Oversized receipt ranges are found through per-child
maximum sizes, without a growing split queue. Retired-file inventory uses the
same paged structure. These routing changes require their own qualification;
earlier evidence for the flat `receipt_routes` preview does not qualify them.
Obsolete immutable routing pages are collected in bounded write and idle
maintenance steps. Reads do not trigger collection, and idle work yields
between pages when a foreground request arrives.
Each page supplies its immutable lower key and tree level; point lookups in the
current routing and retired-file roots determine whether it remains reachable.
The operation fence covers that check and deletion. An unfinished backup pins
all source pages, and an unfinished write prevents collection until recovery.
Only exact owned temporary names can be removed without a page lookup.
Corrupt pages, unknown roots and symlinks fail closed.

The collector retains at most three directory iterators and reads one page per
step, plus logarithmic current-root lookups. A restart may repeat its scan;
it never reuses a stale deletion decision. A complete sweep still takes time
proportional to stored index files, but is not a continuation prerequisite.
Space reclamation depends on maintenance throughput and backup pin lifetime.
This collects index pages, not historical action receipts or payload objects.

Paperclip business-tool receipts likewise live in indexed, company/run-bound
database rows. Each action commits its receipt with its business mutation;
continuation never appends to an ever-growing run JSON map. Publication and
reuse references use indexed lookups. A server-derived comment flag and partial
index locate the final response without scanning all earlier progress comments.
The one-time receipt/comment migration preserves malformed legacy receipts as
integrity failures and requires a maintenance window for its history-sized
backfill and index creation.

Large outputs are immutable segments with company-scoped identities, sizes and
digests. Publication follows durable upload, so metadata never refers to an
incomplete body. The user-facing API resolves references through normal task
authorization and redaction. It does not expose arbitrary filesystem paths or
unscoped object-store URLs.

## Counters rotate independently of agent work

Every accumulating counter must be classified before enabling the full mode.
Increasing an integer width only postpones a ceiling. The following identities
must remain distinct:

| Identity | Meaning | What changes it |
| --- | --- | --- |
| Task / normalized session | The user's continuing work | Explicit product lifecycle |
| Run / provider turn | One execution or provider turn | Normal run lifecycle |
| Transport epoch | A bounded sequence namespace for one delivery lane | Internal cursor rotation |
| Authority revision | Exact compare-and-swap identity of current state | Durable state mutation |
| Partition generation | The authoritative route for a key range | Storage administration |

A cursor is `{ epochId, ordinal }`. The epoch is an opaque unique identity;
the ordinal is an exact, bounded integer represented without JavaScript
rounding. Epochs are stored as indexed records with predecessor/successor links,
final ordinal and an exact transition receipt. The current head points directly
to the current epoch. Reading after an old cursor starts at that exact epoch,
then follows successors as needed for the requested page. It never reconstructs
the entire chain first. History receipts remain indexed by their original epoch.

Rotation uses a separately negotiated capability. It must not silently change
the interpretation of existing PRP v1/v2 numeric fields. The affected contracts
include command/event envelopes, hello/reconciliation, acknowledgements, warm
transitions, raw-to-normalized delivery cursors, database uniqueness and paging,
native receipts, and public history cursors. A peer lacking the capability stays
on its declared legacy contract; it is not advertised as unlimited.

For each delivery lane, the transition is:

1. Before the ordinal ceiling, the sender stops admitting new lane entries and
   persists a rotation intent with old epoch, final ordinal, successor epoch and
   transition ID. Admission leaves reserved control capacity for this step.
2. Existing admitted entries drain durably through the final ordinal. Work that
   is still executing retains its semantic call ID and input receipt; it does
   not need to finish merely to rotate a transport counter.
3. The receiver verifies its contiguous committed cursor and commits the old
   epoch's close receipt plus the successor head in one transaction. It returns
   the exact transition receipt. This operation is idempotent by transition ID
   and rejects conflicting successors.
4. The sender verifies the receipt, commits its successor head, and admits new
   entries at ordinal one. Their run, turn and provider identities are unchanged.
   Results for older calls still reference their original semantic identity.

A crash at any step reopens the persisted transition. Lost replies repeat the
same transition, never allocate a competing successor. An old frame is resolved
against its old receipt and cannot be reinterpreted as a fresh ordinal in the
new epoch. Neither peer may infer rotation from a low incoming number. Cursor
rotation does not invoke turn completion, interrupt, resume or provider restart.

Current-state revisions use an exact opaque compare-and-swap identity. If the
implementation retains a bounded revision ordinal, rotating its revision epoch
is atomic with the new state and its commit receipt. A stale revision can never
become valid again after wraparound. Revision identity is not an ordering API.
Native provider generations preserve legacy numeric increments until their safe
namespace is exhausted, then switch permanently to opaque identities bound to
the exact launch transition. PostgreSQL session-goal mutations use opaque
equality tokens with exact retry evidence. The retained numeric goal revision
freezes at activation, and a pre-transition numeric expectation cannot match
after token activation. Goal source epochs and cursors remain separate from
this compare-and-swap identity.

Controller recovery ownership already uses a fresh random lease identity,
checked together with the controller identity. Its retained integer generation
is diagnostic and saturates at the database integer limit; it is never a sole
ownership fence. Reaching that value cannot block a new claim or revive a stale
lease.

The command lane now negotiates `transport.command_epochs.v1`. The controller
holds new command admission after 1,048,576 entries, drains accepted commands,
and publishes an exact transition. The native runner commits that receipt and
its successor head together. Semantic calls and an active provider turn remain
live. An optional lower test threshold forces repeated rotations. Each side
keeps only its current head/transition and resolves older receipts by identity;
new ordinals use the `controllerEpoch` namespace. PostgreSQL's sequence index
includes it. Admission can persist a transition during reconnect once the
capability has been authenticated; it does not require a live socket to preserve
that intent. Unnegotiated peers cannot inherit that namespace.

The raw event lane now negotiates `transport.event_epochs.v1` on PRP v2.
Its authenticated challenge binds the exact sender resume cursor and rotation
limit. The runner persists its intent, pauses event admission, drains the old
outbox, and installs the next `sourceEpoch` only after the controller's atomic
close/head receipt. Old ACKs resolve their exact closed namespace; they cannot
advance the new head. A committed receiver with a lost reply admits only the
matching pending sender intent. Commands, lease renewal and pending provider
work retain their identities through this exchange.

Raw history paging selects one indexed namespace. The normalized reader follows
one exact successor only after consuming the previous final frame, then commits
an explicit zero cursor for that successor. It never compares ordinals across
namespaces or loads the historical chain. Current proof slots preserve their
bounded chronological order separately from history ordinals. Warm attachment
receipts bind the old source namespace and keep the native indexed store live.
These changes rotate raw PRP delivery independently of normalized output and
the public run-log cursor.

Normalized delivery checkpoint revisions and provider outbox entry identities
are also equality-only identities. New effect receipts have no ordering counter.
Encrypted connections re-authenticate with new keys before their nonce counters
reach a bound, preserving the durable delivery cursors and active provider.
The indexed normalized outbox advertises a separate epoch limit. Its producer
atomically commits a close receipt, successor head, reducer snapshot and first
successor event before publishing that event. The first event carries the exact
`sourceEpochTransition`; the database verifies the old contiguous prefix and
absence of an accepted tail beyond it, then atomically installs the successor.
The bounded outbox may contain both namespaces. ACKs remove only the exact next
pending event. Lost ACKs replay the same event and transition. This local durable
outbox variant does not need another network handshake: its first-event receipt
is the receiver's acknowledgement boundary. It never rotates the raw cursor or
provider session.

Recovery checkpoints encode an epoch with its local ordinal. Historical paging
follows an exact successor only at the preceding final ordinal. Body catalogs
use byte offsets within one bounded provider frame, so a body can cross event
namespaces and repeated identical bodies share their chunk references. Goal
projection tracks source epochs separately from run ownership. The alternate
native coordinator now accepts epoch-bearing normalized input while preserving
payload hashes and settlement-anchored ordering.

Public run-event history has opaque row IDs, an `event_epoch`, and bounded
epoch-local `seq` values. API cursors use `e:<epoch>:<seq>` for new epochs;
safe legacy numeric IDs retain their API number representation; larger retained
IDs remain exact decimal strings. Indexed epoch heads and
semantic-lane links support ordered paging without treating `seq` as globally
ordered. Browser event history retains a bounded tail, shows when earlier rows
were collapsed, and treats websocket event notifications as wake hints; durable
polling supplies the rows. Run-log chunks use exact decimal byte-start cursors
as identity and ordering, while `seq` remains legacy diagnostic data. The UI
keeps a bounded recent output window and identifies both retention collapse and
a segmented tail that starts after earlier bytes.

Tiny qualification thresholds exercise repeated rotation with an active turn,
pending semantic calls, replay from the earliest epoch, reconnect, and a process
kill at each transition boundary. Tests must include JavaScript's safe-integer
boundary and database integer boundaries without generating that many records.

## Recovery captures one consistent set of stores

Provider history pagination and provider model-context recovery are separate
requirements. Paperclip requests metadata-only Codex reads/resumes and uses its
indexed reducer to recover delivery. If an active turn settles during a metadata
read, Paperclip checks at most four recent pages and rereads the current status;
it does not search the completed history for an active turn that has disappeared.
An inconsistent active status retains the recovery hold.

A fresh-thread probe of installed Codex 0.153.4 reports `historyMode: paginated`.
Indexed Codex startup now explicitly requests that mode for new threads and
verifies it on both start and resume. Missing or legacy mode is rejected before
turn admission, without creating a replacement provider session. Legacy
Paperclip sessions retain their provider's history contract.

Paginated mode does not establish bounded cold recovery. In that release, the provider's
[model-context loader](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/thread-store/src/local/model_context.rs)
scans backwards to a suitable replacement-history checkpoint. Without one, it
can accumulate the complete replay; legacy rollouts use the full-history path.
`excludeTurns` bounds the API response, not that internal work. Qualification must
therefore measure cold provider recovery as well as Paperclip continuation and
require a supported, bounded current-context checkpoint. Paperclip must not edit
provider journals or replace action receipts with an AI summary to simulate this
capability. The installed provider's cold-recovery guarantee remains unqualified.

Upstream Codex 0.159.0 includes
[the newer compaction-boundary recovery implementation](https://github.com/openai/codex/commit/e7bbc79f482acf285e50a09a9f898aeb2ce3881c).
It persists companion resume metadata and stops at the latest complete
replacement-history checkpoint, including mid-turn compaction. This is the
candidate provider for qualification; the 0.153.4 finding must not be generalized
to that newer release. Missing/incomplete checkpoints still use full replay.
Using the newer release does not by itself qualify incremental persistence,
containment, or whole-session source-loss restoration.

In stock 0.159.0, the SQLite history projection is another recovery path:
`thread_history_materialization.rs` reads the entire unprojected suffix into
memory. Healthy indexed resume and rebuilding a missing/lagged projection
therefore have different costs. The real complete-package browser continuation
test passes, but cannot establish a bound for that missing-index case.
Its app-server protocol has paged history reads and forking, but no immutable
same-session checkpoint/pinning API. A fork changes provider identity and is
not a substitute for that contract. Completing this provider portion requires
provider changes or a qualified persistence implementation underneath it.

A recoverable session consists of controller authority, both native stores,
referenced payloads, provider persistence, and exact process ownership. A native
snapshot or a PostgreSQL dump on its own is only a component. The backup becomes
usable only when one durable recovery manifest binds all required components.

The manifest is a bounded root record, not an array of every historical file.
It contains the company/session/run binding, format and capability versions,
source store identities, current revisions/digests, committed delivery boundary,
provider checkpoint identity, containment identity and an indexed inventory
root. Inventory pages and immutable objects are content verified and independently
addressable. Credentials are freshly provisioned on restore; backup data does
not grant a new process execution authority.

The coordinator has durable states `requested`, `boundary_held`, `copying`,
`verified`, `published` and `released`. Each transition is fenced by the same
maintenance owner, and every copy cursor is resumable. Lost leases cancel owned
workers and wait for their exit before relinquishing local fences. Repeating a
job uses the same request and source revisions; it cannot silently take a newer
snapshot under the old job identity.

At the boundary:

1. Hold new admission for the exact session and establish a recoverable provider
   checkpoint through its supported protocol. An ambiguous active provider is
   held for reconciliation; an empty event queue does not establish quiescence.
2. Establish ownership of both native stores and capture their exact current
   revisions, outbox and receipt roots. Do not copy live SQLite/WAL files as
   ordinary directory contents.
3. Under the controller's write fence, capture the matching authority and raw /
   normalized delivery boundary using one exported PostgreSQL snapshot. The
   exporter and every inventory query use that snapshot, not unrelated queries
   from different transactions. Expired snapshots fail the job.
4. Pin the immutable native/provider generations and payload roots. Once these
   pins and the boundary record are durable, execution can release the boundary
   and continue against newer generations. Copying old bytes is background work.

Publishing requires that each component's identity, size and digest match its
inventory, all references are present, and replay relationships between the
controller and native cursors are valid. There may be unacknowledged data at the
boundary, but it must have an exact durable source and idempotent destination.
There may not be a controller cursor beyond durable source data or an accepted
effect with no recoverable receipt. The manifest is published atomically last.

Repeated checkpoints upload changed immutable generations, newly closed
segments and a bounded current tail. They do not rehash, recopy or enumerate all
historical provider files on each turn. A provider without a checkpoint/pinning
or incremental persistence interface cannot satisfy this foreground guarantee;
its remote activation remains unqualified until that gap is addressed. The
existing full directory/native copy is a maintenance backup, not evidence of
incremental online checkpointing.

Restore creates a new owned destination, verifies the manifest and current
roots, imports the bound controller state, and restores the matching native and
provider checkpoint. Required current/pending objects are verified before
execution. Historical immutable partitions can be restored lazily behind their
verified index, so an unavailable unrelated old body does not prevent current
work. A requested missing/corrupt old receipt is an integrity failure for that
lookup, never permission to repeat the action. Restore cannot synthesize a new
session because one component is missing.

Qualification removes every source volume after publishing, restores solely
from the backup, resumes the same provider identity and reads an early receipt
and output through the browser. It repeats after each copy/publication crash,
concurrent writes, stale ownership, corrupt/missing objects and expired database
snapshots. A component-only source-loss test cannot stand in for this test.

## Process ownership and retirement

A controller incarnation UUID is not an operating-system boot identity. PID,
process start time, process group and parent death are useful observations, but
they cannot prove that a descendant which called `setsid` has stopped.

For automatic recovery after an ambiguous runner/provider crash, the execution
boundary must enforce containment before the first provider child runs. The
qualified Linux implementation may use a protected cgroup v2 subtree or an
equivalently isolated container. It records host/engine identity, OS boot
identity, immutable containment identity, launch identity and owner in durable
intent before admitting effects. The provider cannot write the parent cgroup,
escape through a host runtime socket, join host PID namespaces or acquire the
privileges needed to move outside that boundary.

Retirement fences new launches, requests termination of the entire boundary,
and observes the boundary empty under the same host/boot/containment binding.
For cgroup v2, the check covers descendants (`cgroup.events: populated 0`), not
just the direct child's wait status); see the [kernel containment contract](https://docs.kernel.org/admin-guide/cgroup-v2.html). An authenticated remote provider needs an
equivalent qualified destruction receipt for its immutable sandbox identity.
Only after this proof commits may unresolved owner rows move to historical
receipts and replacement admission proceed. Recycled PIDs, missing metadata,
unreachable hosts and ambiguous destroy responses retain the ownership hold.

Ordinary macOS processes can continue from a successfully committed suspension
through the existing runner protocol. That fact must not be rejected merely
because the checkpoint uses indexed storage. It also must not be repurposed as
permission for destructive maintenance or uncertain crash recovery. Until an
enforced boundary is available, those ambiguous operations remain held. The
product must state which guarantee the selected execution environment provides.

Controller reattachment to the exact surviving local runner validates current
authority and then authenticates that runner's transport. It does not enumerate
historical unresolved process owners: no provider replacement or retirement is
authorized by that claim. Dead-runner admission checks for any unresolved owner
through one indexed existence query. Its presence holds replacement even when
the recorded PID and process group have disappeared; an escaped descendant may
still be alive. This check does not enumerate earlier launches. A qualified
retirement path must still close those owners before automatic replacement can
be enabled. Bounded admission alone does not provide that retirement mechanism.

Containment qualification includes double-forked and `setsid` descendants,
controller/runner kills, host reboot identity changes, reused PIDs, inaccessible
containment metadata and an attempted escape. The replacement provider starts
only after the exact prior boundary's retirement commits.

## Migration and retained sessions

Retained legacy journals are migrated once under explicit maintenance admission.
Migration may take time proportional to legacy history, but streams with bounded
memory and checkpoints its progress. It does not happen as an invisible full
scan on every continuation. The old state stays authoritative until controller,
runner and provider stores are all staged, validated and published by one
activation record. A crash retries that activation rather than mixing formats.

Production admission requires exact stopped/contained ownership, a renewable
maintenance lease, no competing writer and the original session binding. It
cannot be supplied by an always-successful callback, expired lease, dead PID
or missing file. Every database commit and filesystem publication rechecks its
fence. A lost lease preserves staged data for a later authorized owner.

## Capacity, retention and collection

The implementation reserves a bounded control/settlement lane independently
of bulk output. It obtains storage and queue credits before admitting new work
whose results must be persisted. Pressure stops new admission, drains what can
settle, and keeps interrupt, heartbeat and ownership signals available. It does
not silently truncate a receipt or acknowledge data that exists only in memory.

A storage rejection is retryable through the same owner only when a fresh read
proves the exact pre-write revision and bytes are still authoritative. Lost
commit replies and unreadable storage are indeterminate. They require exact
commit-receipt reconciliation, never an assumed rollback. Provider result
delivery similarly persists intent before sending and retains uncertainty when
its acknowledgement is lost.

History retention, replay correctness and backup retention are separate.
Garbage collection is paged background work rooted in current authority,
unacknowledged delivery, live receipt references and published/pending backup
pins. An object uploaded before a failed metadata transaction is an orphan
candidate only after the publication grace period and a fenced root check.
Concurrent writers can publish new references or pins; an old mark pass cannot
delete those objects. Deletion records are resumable and idempotent, and no
collection step scans every historical object on an execution path.

Receipt deletion requires an explicit protocol horizon proving that the same
logical identity can never be admitted again. Without such a horizon, exact
receipts remain. A summary, Bloom filter, age cutoff or cache eviction is not a
receipt-deletion authorization.

## Qualification and activation

Activation is per persisted session and negotiated capability, with an explicit
matrix for provider, host environment, fresh/retained state and recovery mode.
Enabling one cell never implies qualification of another. Budgets, approvals,
company boundaries and operator retention remain enforced throughout.

The final candidate needs all of the following evidence on identified source
and artifacts:

- History growth across former limits, large individual streamed outputs, many
  sequential calls in one active turn, and many continuations; measure bounded
  current bytes, foreground read/write bytes, queue sizes and latency.
- Tiny partition, segment and cursor-epoch thresholds with old exact replay,
  concurrent relocation and fault injection at each durable cutover.
- Real storage exhaustion and restored capacity for database, local/native
  storage, provider persistence and object storage; lost replies, read-only
  storage and corruption remain distinct from a confirmed rollback.
- Whole-session backup/source loss/restore and process-tree retirement through
  the production admission path, including retained-session migration.
- Browser → Paperclip → native runner → actual provider continuation, controller
  restart during output, runner/provider crash cases, and the declared elapsed
  endurance period. A short or accelerated test does not satisfy a 72-hour gate.
- A green coherent full repository check, plus focused provider and protocol
  suites. Earlier failed attempts and unqualified environments stay visible.

The execution guarantee is enabled only for cells whose required evidence is
complete. The implementation record identifies outstanding cells and component
results; it must never turn a successful storage microbenchmark into a claim
that the entire recovery system is finished.
