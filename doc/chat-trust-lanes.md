# Slack and Discord task trust lanes

Status: draft implementation contract. Task isolation is not provider-audience
isolation. Do not treat the checks described here as sufficient authorization to
publish privileged output into a mixed-audience thread.

## Scope

Slack and Discord native threads can bind to separate guest and verified tasks.
Direct messages, linear conversations, and other providers retain their existing
binding behavior.

A task belongs to the guest lane when its `sourceTrust.preset` is
`low_trust_review`; otherwise it belongs to the verified lane. Promotion does not
change this classification: a promoted guest task still originated in the guest
lane. A later identity link does not upgrade or reuse that guest task as verified
work.

## Admission and task creation

The existing task-mutation transaction owns current endpoint and principal
checks. Within that transaction, `inbound/trust-lanes.ts` re-reads the thread's
company-scoped conversation bindings, even if an earlier lookup found none.

- Verified work reuses the newest active/waiting task in its lane. A completed
  newest verified generation creates fresh work; do not fall back to an older
  active generation in that lane.
- Guest work preserves native-thread reuse of the newest guest task, including
  reopening after a published close. Existing exact source/control chronology
  must still authorize that input. This never upgrades the guest task to verified
  execution or downgrades a retained forbidden output disposition.
- Otherwise create a fresh task and conversation generation using ordinary
  endpoint/resource execution defaults. Do not copy the other lane's comments,
  agent session, workspace, or containment policy.
- Preserve the existing low-trust containment path for guest work.
- A conflicting conversation generation must roll back task creation, rather
  than leaving an issue without a conversation.

Before admitting verified work into a thread with a guest task, the draft checks
other accepted inbound authors using the existing current-principal
authorization owner. It refuses when an author is no longer authorized or linked,
or when the distinct other-author count exceeds 25. Refusal uses the existing
durable provider-effect path; it does not create a verified task or wake.

The invoker retains the existing blocking authorization boundary. Additional
accepted authors use nonblocking transaction advisory locks and `NOWAIT`
identity-link and company-membership row locks in that same authorization owner.
Sorting the other authors alone cannot order an invoker's already-held locks or
shared user/sponsor memberships across endpoints. If any additional-author lock
is busy, the entire task mutation rolls back and the existing delivery owner
records a retry with the retained normalized input and its ordinary bounded
retry policy. Contention is not a guest fallback, an unlinked identity, an
accepted-author refusal, or permission to skip an author. This adds no queue,
worker, polling loop, or new retry policy, and does not claim global lock freedom
for existing single-principal authorization or identity writers.

**This is only an accepted-author check.** It does not enumerate all channel or
thread readers, including silent readers, later joiners, and people whose
messages were not admitted. Passing it is not proof that everyone who can read a
reply has access to the underlying company data. The publication policy below
therefore denies verified output rather than treating accepted authors as the
complete audience. It does not qualify any private provider destination.

## Chosen confinement contract — partially implemented

Verified results must stay on the existing authenticated Paperclip task. No
provider destination is allowed, including DMs, private channels, and newly
created private threads. Identity linking and accepted-author checks do not lift
that deny. No new public link, requester access grant, provider notice, or private
handoff is selected by this contract. Ordinary authorized non-verified delivery
must retain its existing behavior.

The draft must not be enabled or released until server-owned provenance survives
all cloning, restart, callback, retry and destination-change paths; all affected
release claims and direct output capabilities must enforce it. If any explicit
provider send/tool capability cannot be confined, verified admission must remain
disabled. The deny covers content and derived existence/state signals, including
controls, attachments, edits, reactions and typing. A transport-only check is
insufficient. This local partial implementation does not satisfy that contract.

`task_provider_output_policies` is a server-only, company/task-bound record,
separate from editable issue metadata, visibility and conversation destination.
The inbound task transaction records `forbidden` for the isolated verified lane
and `ordinary` for new non-verified-lane bindings before committing task input.
The retention owner never downgrades `forbidden`. Issue creation inherits denial
from its existing privacy-source edge and the actual actor run's native/task
identity, including standalone run-created work. This is not a caller-editable
consent field or a new public API contract. Existing non-isolated binding behavior
does not create an additional supported verified lane.

Comment insertion and document upsert also inherit denial from the same-company
writer run in their existing content transaction. The shared retention owner uses
the canonical native/legacy/context task binding with a bounded run projection;
clients cannot supply an output disposition. New documents, revisions and locked
document forks strengthen an already ordinary destination before content commits.
Caller rollback or a rejected revision/attachment rolls back the policy change as
well. Retained denial survives deletion of the source run/task and copied content;
ordinary or human writes cannot downgrade it. Ordinary comment receipt replay
rechecks provenance before returning its existing receipt. Read-only completion
receipt shortcuts are not a retrospective backfill.

Real-database owner tests cover each binding form, canonical binding precedence,
source deletion, fresh service reconstruction, caller savepoint rollback and
uncommitted policy visibility. These are service-level transfer proofs, not full
native-tool/HTTP authorization or transport qualification. A run lookup adds one
primary-key read per run-attributed write; a valid source adds bounded task/policy
reads and, only on denial, a monotonic destination upsert. No history scan, timer,
worker or new schema is involved. Failed database work rejects/rolls back the write.
Attachment registration also inherits denial inside its existing asset,
attachment and artifact-work-product transaction, using only the run accepted by
its current company/agent attribution checks. Rejected parent comments, failed
asset insertion and caller rollback leave neither new content nor its inherited
restriction. Ordinary uploads and unbound human uploads preserve their existing
behavior; this does not add a grant or infer provenance by scanning file bytes.
The native file-handoff and same-conversation reuse owners already register through
this service. Reuse selects attachments from its exact current task; their
ordinary byte-staging and idempotency suites remain separate from a full
restricted native-tool copy qualification.

Proactive in-app chat messages already use the comment writer. Their existing
receipt-replay branch now retains the current authorized source task's disposition
before returning the receipt, including HTTP replay and native recovery. It
creates no second message, wake or provider output. Conflicting-body requests do
not commit inheritance, and a caller rollback preserves the original receipt
without committing the policy change. These checks retain existing task, user,
mode, run, cross-issue and idempotency authority; they do not make an unqualified
runtime eligible to execute the now-restricted destination conversation.

Work-product creation inherits its accepted same-company originating run's denial
inside the existing transaction. Updates retain the original originating run,
explicit accepted replacement attribution and authenticated current writer as
separate sources. The HTTP route passes the writer outside the editable payload;
omitting or clearing `createdByRunId` does not hide the current writer or erase
original provenance. A same-company service-level task move also inherits the
original task's restriction; this does not add a public task-move endpoint.

Real-database work-product tests cover all four run bindings, replay after source
restriction, attribution changes, ordinary/unattributed controls, company isolation,
validation failure, caller rollback and deletion of source/run/product. Route tests
check authenticated-writer forwarding and existing forgery rejection using a mocked
service. This is not full HTTP-to-database or native-tool copy qualification. Updates
resolve at most three distinct run identities through the shared bounded owner,
plus the original task only when moving; no historical scan or background work is
added. Import batching retains its separate contract and remains unqualified.

Cases have no artifact-promotion surface. Their existing write authorization now
rejects agent writes from a task that forbids provider output, and agent writes
to a case whose primary task forbids it. This applies inside the existing create,
upsert and mutation transactions; fresh handoff acceptance checks the same owner
before persisting case facts, instructions or workflow documents. Ordinary case
writes and private-task handoffs retain their current authority and behavior.

The existing case execution-trust owner also checks output disposition for its
primary task, retained task boundaries and recorded writer runs. Both readers use
the canonical native-first run binding with a bounded context projection; existing
historical nested-task fallback remains. Handoff and mutation task locking use the
same binding resolver. Missing referenced sources retain their existing fail-closed
behavior. Current checks add at most two policy/binding reads per resolved task,
with no new history scan, schema, worker or timer; a failed read rejects the action.

Real-database tests cover create/upsert/update, all four canonical bindings and
native/legacy precedence, ordinary controls, historical writer restriction,
readability, primary-task and retained-source denial, missing retained sources,
fresh handoffs, idempotent receipt replay and delayed dispatch authorization.
Route tests supply actor context at the middleware seam, not a fully authenticated
native execution. Read-only handoff replay can return its existing receipt; it
cannot authorize delayed execution after restriction. Historical source/run/event
loss is not reconstructed, and no retrospective restriction propagation to every
previously created case is claimed. Case access sources remain privacy boundaries,
not a parallel output-policy registry; retaining every source there would change
legitimate private-task handoff access and is not part of this correction.

External-object synchronization now checks the source task's output policy in
its caller transaction before detector dispatch and again before replacing
mentions or upserting company-shared objects. Restricted title, description,
comment and document sources neither invoke a plugin nor change a shared object.
Old mentions remain on a denied sync; clearing the source text cannot itself
remove the retained restriction. Ordinary detector context contains only the six
source identity fields, not the body accidentally carried by the old object
spread. Sanitized URL inputs and ordinary detection/resolution remain supported.
The registry checks before each detector, and the existing plugin detector checks
before each worker invocation. Detection results returned after source restriction
are discarded, rather than being copied into an unrelated ordinary task's object.

The existing refresh owner checks all retained, same-company mention sources
before claiming work, after claiming, before plugin dispatch and before applying
a resolver result. Any forbidden source denies the shared refresh; an ordinary
mention does not override it or acquire the forbidden task's authority. The deny
clears the owned lease and refresh deadline without transport, fallback output or
a renewal timer. It does not mark unrelated ordinary tasks forbidden. The GitHub
resolver consumes a narrow reauthorization callback before every HTTP request,
including repository visibility and not-found probes after credential resolution.
Direct provider use without a task callback retains its existing contract; custom
resolver code and an already-running plugin are not process-confined by this API.

Real-database tests cover the four content owners, ordinary controls, caller
policy visibility and rollback, shared-object reuse, cross-company identity,
restriction during detector/resolver calls, repeated plugins, restart, automatic
refresh and the three GitHub credential/probe boundaries. Provider/worker calls
are controlled seams, not installed-plugin or live GitHub qualification. Empty
sources without old mentions avoid extra policy reads. A source check uses the
existing one/two point reads. Each refresh check performs one object-indexed
mention query and up to two point reads per distinct source task, short-circuiting
on denial; there is no company history scan or positive policy cache. This cost
scales with the number of tasks sharing an object. Database errors prevent new
dispatch; existing cancellation and refresh recovery remain the owners.

These changes prevent new restricted object copies and guard retained-source
refreshes. Missing-comment/document cleanup now retains mentions whose task forbids
provider output, rather than releasing a shared snapshot when its content record is
deleted. The existing cleanup transaction checks each distinct company/task once,
not once per URL, and deletes/notifies only ordinary source groups. Source record
IDs have no content-record foreign key; retaining the existing mention adds no
schema, worker or parallel object-policy registry. It does not mark an unrelated
ordinary task forbidden or alter established native read permissions.

One focused real-database regression reproduced a resolver call after actual
document deletion and the route's subsequent sync operation, despite a prior
forbidden refresh result. After correction, the same test passes: restriction
survives service reconstruction, no resolver runs, and the lease/deadline stay
cleared. Its ordinary control still deletes the mention and refreshes the shared
object once. These are service-owner calls and a controlled plugin worker, not
an authenticated route or installed/live-plugin qualification. The shared comment
cleanup branch has not been separately executed in this checkpoint; full affected
checks remain on GitHub Actions, not a local suite sweep.

Task deletion uses its existing transaction and conflict contract to reject with
`409` when shared external objects still reference a forbidden-output source.
Otherwise the task foreign key would cascade away both mentions and task policy,
releasing the shared snapshot. The guard uses the existing company/task-scoped
mention query plus the canonical output-policy read; it adds no tombstone or
parallel registry. Ordinary source deletion remains supported, as does restricted
task deletion without a shared-object reference. A focused real-database regression
failed before this guard and passes afterward, preserving the source, policy and
mentions across rejection and denying resolver dispatch after reconstruction.
Its ordinary control deletes the source and refreshes the shared object once.
These are service-level checks, not authenticated HTTP deletion qualification.

Deletion now locks the task before snapshotting its content and shared-object
references, then holds an existing policy row with a blocking shared read through
commit. The early task lock prevents a new foreign-key reference or policy insert
from committing after the reference scan. The policy lock orders strengthening of
an existing row, whose upsert need not reacquire the task foreign-key lock. A writer
already holding that policy must settle before deletion can decide; commit makes
the deletion reject, while rollback preserves ordinary deletion. The policy reader's
publication-claim default remains NOWAIT; only deletion selects the blocking mode.
There is no new query, schema, worker or timer. Existing database lock/error handling
owns contention; no global deadlock-freedom or wait-duration bound is claimed.

One focused PostgreSQL regression first reproduced a restriction committing between
the final policy read and the deletion cascade. It also exercises a new reference
committing after an empty reference scan, a missing policy row at the late deletion
boundary, and a pre-held writer followed by commit or rollback. Independent lock
probes use a 100ms test-only lock timeout; they do not change production timeouts.
Removal of either policy locking or the early task lock fails the expanded test.
The earlier late-boundary-only probe did not detect removal of the early task lock:
the existing decision-target notification already locks the task later. That pass
is retained in evidence rather than presented as proof of the earlier boundary.
Reconstructed resolvers retain forbidden denial and ordinary exactly-once refresh;
controlled worker calls are not installed-plugin or authenticated-route acceptance.

This is a fail-closed deletion hold, not completed historical retention or product
acceptance of reduced deletion functionality. It does not reconstruct a pre-existing
contaminated snapshot, propagate its restriction to every native reader, qualify all
resource cascades, or order policy writes against already-claimed provider output.
Unknown history lost before these checks remains unqualified. Those history-loss
cases remain release blockers, not authority to refresh an unproven object.

Restriction after the source read, retrospective propagation to other existing
copies, imports, legacy case/object-history loss and other transfer owners remain
unqualified. These transfer checks do not establish arbitrary filesystem copy
provenance or recall content previously displayed or transmitted.

The shared `canPublishIssueToChatAudience` decision checks this disposition before
its ordinary privacy/recipient shortcuts. The existing durable publication claim
consumes that decision; the worker cancels denial without a fallback send. An
unmarked task with a retained chat binding is unsafe legacy provenance and is
denied, not guessed to be a guest. The table-creation migration backfills this deny
for every distinct company/task with a retained binding in any conversation state.
It holds a `SHARE` source-table lock through migration commit, preventing concurrent
binding mutation during the one-time scan without blocking ordinary reads. The
persisted policy survives subsequent last-binding deletion and endpoint cascades;
its company/task foreign key still follows task deletion. Unrelated ordinary tasks
are unchanged. Run the migration transactionally before the new server starts,
with old writers stopped; this adds no worker or startup reconciliation.

Real-database migration tests execute the actual SQL against pre-existing bindings
and cover all conversation states, duplicate generations, company isolation,
endpoint foreign-key cascade, task deletion, rollback and source-lock exclusion.
They do not establish a supported endpoint-delete API or a large-install migration
latency bound. Bindings lost before migration, imported content, old case/object
copies, already-claimed effects and complete derived-work reconstruction remain
open. The initial real company export/import diagnostic copied descriptions,
comments and documents into a fresh task without retaining its source denial.
An editable `ordinary` marker cannot fix this authority gap.

The portability preview/apply owner now rejects selections containing tasks before
import mutation. Native-only quarantined retention remains the target, but complete
native-reader/derived-copy confinement is not qualified, so the fail-safe is
pre-write rejection rather than accepting unmarked content. The same error applies
to benign editable packages, old/missing extension metadata, claimed ordinary or
promoted origins, recurring tasks, and both board/full and agent/safe imports.
Apply resolves and checks the current selection again; preview is not an admission
grant. Rejected previews skip skill-inventory discovery because it may persist
snapshot maintenance. Other selected entities are not silently imported after a
task rejection. Explicit task deselection retains the existing non-task journey;
it is a revised selection, not full task-history import.

Real-database tests use actual exported descriptions, comments and documents,
inline files and a controlled GitHub package transport. They cover new/existing
targets, mutation-free rejection, source changes after preview and local ordinary
content controls. The internal bulk task writer separately requires a server-resolved
`forbidden` output disposition for every row; missing or invalid runtime decisions
reject before mutation. It inserts destination-owned deny policies in the same
transaction as all task chunks, identifier allocation and labels. The portability
row mapper supplies the deny, never a package-controlled ordinary flag. This does
not bypass or remove the earlier admission hold.

The existing work-product late-chunk rollback regression now seeds a native task
independently of the held public importer. Every destination passes ownership
preflight; a database constraint rejects the 501st product after the first chunk
executes. The writer rolls back all products and its newly strengthened output
policy. Removing the constraint permits all 501 products in two inserts and
retains the destination deny. This qualifies the internal writer transaction,
not successful public import, complete fidelity or global storage rollback.

Real-database bulk cases cover multi-chunk batches, late task/policy constraint
failures, outer rollback/isolation, duplicate replay, foreign task-ID collision,
service reconstruction and untouched ordinary traffic. The extra writes scale as
one narrow policy row per task, using the existing chunked insert owner, with no
per-row source-history queries. No task can commit from this writer without its
deny; this is not a claim of full-import rollback across separate child/storage
transactions.

The four direct bulk child writers (comments, documents, attachments and work
products) now use a shared import-boundary check inside their existing transactions.
It validates destination company/task ownership before writing content or signals,
locks distinct destinations in sorted order, and monotonically strengthens each
destination's output policy to `forbidden`. Attachments also require any comment
reference to belong to that exact company/task and retain a shared lock on the
comment through commit. Missing or mismatched ownership rejects the whole writer
batch without a valid-prefix write. Separate valid companies keep separate
policies; unknown imported content is never an ordinary-output grant.

Ownership checks and policy upserts are chunked over distinct destination IDs,
not repeated per child. Tests cover policy-write failure, late child-chunk failure,
outer rollback/invisibility, service reconstruction, foreign and contradictory
ownership, multi-company and 502-destination batches, and a competing ownership
update before the first policy write. Removing the destination lock fails the
last check. Existing denial survives child rollback and cannot be downgraded.
This qualifies database registration/link ownership, not storage-object ownership,
full source-trust retention or every historical author/run/project/workspace
reference. The public task-import hold stays in place; legacy import success
expectations are not acceptance evidence for it. Verified execution remains
unavailable.

Comment export, package parsing and the direct bulk comment writer separately
retain declared low-trust history as `low_trust_review` / `quarantined`. The optional
portable `sourceTrust` field is descriptive only. Source task/run/agent IDs and
promotion records are not exported or installed as local authority. A portable
promotion cannot bind a local sanitized review, so it is re-quarantined; malformed
or unsupported declarations reject rather than silently disappearing. The bulk
writer validates the entire batch before entering its transaction and commits
normalized trust alongside content and destination output denial. This adds no
source-history lookup, worker or schema change.

Unmarked comments retain null source trust rather than a fabricated low-trust
origin; their destination still receives the independent provider-output deny.
Removing a portable marker therefore does not establish ordinary output authority
or bypass the public task-import hold. Local promotion and ordinary local writes
are unchanged. Tests cover display-author variants, invalid mixed batches, caller
rollback, source deletion/reconstruction, export/parser/bulk-copy/re-export and
the existing higher-trust sanitizer. These are not authenticated native-reader or
successful full-import qualification. Attachment storage, historical author references,
prior copies and derived-content confinement remain open.

Document and work-product export/parsing now retain the same optional descriptive
trust declaration. Their direct bulk writers independently validate the entire
batch and re-quarantine portable promotions using the shared import normalizer.
Historical source IDs and promotion assertions are discarded, not installed as
local review authority. Document revision run attribution and work-product
run/workspace/runtime-service bindings are cleared even when those IDs exist in
the destination database, including another company. Display authorship, mapped
project ownership and arbitrary metadata are separate from those live bindings;
this change does not qualify all embedded historical references.

Unmarked documents/work products retain null source trust and the independent
destination output denial. Ordinary local document/product writes and local
promotion are unchanged. Real-database tests cover mixed invalid batches, caller
rollback, export/parser/bulk copy after source deletion, missing resource IDs and
existing same/foreign-company runtime resources. The document body sanitizer and
work-product trust predicate are not authenticated native-reader acceptance.
The public task-import hold is unchanged: successful full-import fidelity and
complete derived-copy confinement remain unqualified.

The existing bulk attachment registration owner now rejects storage keys outside
`<destination-company>/issues/<destination-task>/` before opening its transaction.
It requires canonical nonempty storage segments, rejecting traversal, backslashes,
encoded separators, whitespace and control characters rather than normalizing
aliases into a different object. This matches the existing import materializer's
namespace and does not add a storage lookup, network call or repeated source scan.
It does not certify blob existence, hash/length integrity, configured provider
identity or a fresh storage receipt. Those remain with the storage/materialization
owner; arbitrary host filesystem writes and historical aliases are not qualified.

Real-database/local-disk tests cover mixed-batch rejection, actual same/foreign-
company source objects, generated destination keys, service reconstruction and
outer rollback. Staged bytes survive a database rollback: global import storage
cleanup is not established. Separate full-app HTTP tests use real Better Auth
sign-in/session resolution, PostgreSQL and local-disk bytes, not injected actors.
Authenticated company members can inspect imported bytes without lifting output
denial; anonymous/foreign-company reads stop before storage. Private-task and
private-ancestor grants authorize ranged reads and revocation denies later reads.
These five human-reader cases do not qualify higher-trust agent readers,
documents/work products, derived copies, cached bytes after revocation, S3 or
live/deployed behavior. Their first setup exhausted the sign-in rate limit;
reusing two real sessions fixes that fixture without changing authentication or
rate-limit behavior. Verified content execution and public task import remain held.

Separate full-app cases now exercise standard agent JWT authentication for both
attachment and asset byte routes, foreign-company denial before storage, and the
responsible user's private-grant revocation for ranged reads. Native tool authority
also rejects paused agents and cancelled runs before byte access. These are
synthetic, already-running fixtures, not evidence that restricted execution can
pass admission. After a read on its own restricted task, that bound run's comment,
document and new-task copies retain denial through actual native API dispatch,
receipt replay, authority reconstruction and run termination. Ordinary local input
controls preserve ordinary copy behavior. Stored content and the shared publication
authorization predicate are asserted independently; no provider transport is invoked.

This narrower bound-run evidence does not track an ordinary run reading restricted
content from another task, arbitrary filesystem copies, asset reuploads or every
native content surface. Run termination is not deletion: audit foreign keys prevent
the fixture from deleting referenced runs, and no source-history deletion is claimed.
No running process, provider context, cached byte buffer or already-admitted tool is
confined by these read checks. Complete native-reader/derived-copy qualification is
still open; public task import and verified execution remain held.

Eight further native-dispatch cases qualify a narrower cross-task boundary: two
ordinary attachment/asset reads preserve their content and output policy, while
six private-task, privacy-ancestor and private-project cases deny before storage
is opened. The reader has a distinct running task/run in the same company. The
privacy ancestor uses the canonical `privacyParentIssueId`, not structural
`parentId`; native asset reads use the existing ranged-response contract. These
checks do not qualify authorized reads of restricted content into ordinary runs.
The current copy-inheritance helper follows the writer run's bound task; source
read authorization is a separate contract, not durable provenance for everything
a reader may later write or send. No such propagation or process confinement is
claimed, and this test addition changes no runtime permissions or admission hold.

The native-reader technical disposition retains rejection of new verified execution
and unsafe restricted/unknown imports. Established native reads keep their existing
permissions. Before reconsidering admission, authenticated source/run/context binding
must durably restrict every consuming execution and destination before bytes or
derived metadata enter context. That restriction must share an ordering boundary
with output claims and writes, survive shared caches/resume/restart and copies, and
reject unsupported or ambiguous automated context. A task bit or asynchronous
cancellation does not confine an already-claimed streaming output. This is an
acceptance prerequisite, not authorization to build a new reader framework or
change established native-agent/no-run read compatibility. Those compatibility
choices require a separate product decision; no admission or publication hold is
lifted here.

The existing publication authorization owner also rechecks task output policy
following credential resolution, Slack Board-author membership probes and provider
text preparation, before claiming a task-control authorization action or returning
transport authority. A restriction committed during those earlier awaits must not
become a new transport claim. The worker retains its current cancellation path;
no fallback send, retry, worker or timer is added. This adds one indexed policy
read per transport claim, plus the existing binding lookup when policy is missing,
not a second full retained-source authorization pass or a history scan.

Ten real-database Slack Board cases cover pending and due-retry publications:
ordinary delivery, restriction before the claim, restriction committed during the
membership probe, policy removal during that probe and a rolled-back restriction.
They assert durable cancellation/no provider receipt and zero posts or edits for
denied work, ordinary exactly-once posts and preserved native comments. Provider
membership and transport are controlled fakes.

The final policy read now takes a nonblocking shared lock on an existing policy
row, after task-control principal authorization. That lock lasts through the
existing claim transaction's commit; a concurrent upsert or deletion cannot
commit between this read and claim commit. An already-held writer causes the
claim transaction to roll back through the existing publication-read failure
and bounded retry owner, not a fallback transport or a new retry mechanism.
Ordinary policy readers are unchanged. This adds no query or schema: the indexed
policy read takes the row lock only for this claim owner.

A focused real-PostgreSQL owner regression failed before the lock and passes
afterward. At the final credential-ownership callback, independent restriction
and deletion transactions receive lock timeout rather than commit ahead of the
claim. A held, uncommitted restriction causes the claim's retryable read error;
rollback preserves ordinary policy. A restriction committed after claim completion
denies a subsequent claim. Credential/runtime checks are controlled seams; this
is not complete worker/restart, provider transport or task-control race qualification.

A focused worker regression also holds an actual policy writer through the first
close-control attempt. Contention leaves its authorization issued and unchanged,
its publication retryable with a deadline, its conversation open, and no provider
output. After service reconstruction, writer rollback permits exactly one ordinary
send; committed restriction or deletion completes the linked user's control
internally without constructing a provider runtime. A second pass cannot replay
any of the three settled outcomes. The test advances only the retained retry's
deadline; it does not prove scheduler wakeup or a process-level restart. Removing
the claim's policy lock makes the test fail by publishing during the held writer.
Controlled SDK/credential transports are not live provider qualification. Existing
published rows retain their old next-attempt timestamp but are no longer eligible
work; internally completed rows clear it. No runtime or retry behavior changed in
this qualification.

Missing policy rows have no row to lock, and this does not establish all-source
provenance or global writer lock freedom. No restriction after claim commit is
ordered against network dispatch; no committed claim or in-flight call is revoked.
The execution/import/publication holds remain.

The first unfiltered
chat-file attempt exceeded its 1,000-second command timeout without a suite summary;
focused passes do not establish complete chat acceptance or explain that timeout.
A later bounded exact-cover run completed all twelve isolated partitions without
a timeout: 2,149 tests passed and five failed. Two Telegram close-control assertions
counted processed setup/typing effects as well as the target command. They now
select the exact close delivery, preserving their required `failed` and
`delivery_unknown` outcomes and all no-replay/state assertions; both affected
partitions pass all 433 tests. The remaining linked-user setup receipt, direct
external-chat execution and bare-mention reaction expectations conflict with the
current output/execution holds and remain failing, not skipped or relaxed.
This is not a green full-chat result, nor a diagnosis of the earlier timeout or
historical missing-link/Retry/queue-worker failures. The initial empty SDK base-URL
collection failure is also retained separately from executed test results.

The real-database `confines provider egress` cases now cancel synthetic verified
results without Slack/Discord posts or edits, including stored DM-flag changes
and source-trust/origin metadata resets. A missing-policy guest binding is denied
as ambiguous. Ordinary marked guest controls deliver once and native comments
remain stored. Separate cases cover parent/run-derived task denial and a fresh
Slack publication worker consuming a pre-existing queued effect after shutdown,
with verified cancellation and an ordinary delivery control. These are provider
fakes, not a real DM, complete producer/tool confinement, native-reader acceptance,
or deployed qualification. Preserve the original four failures in the acceptance
ledger; passing this slice does not explain the historical setup/queue failures
or establish revocation/destination-change ordering against the durable claim.

The durable `provider_effect` authorization owner also checks retained action,
source-delivery and completion-target conversation bindings before its safe-notice
shortcut or any thread/ephemeral/fallback transport. Each referenced binding must
remain in the endpoint's company, and each source task must permit provider
output. Denial uses the existing action cancellation path, not another queue or
provider fallback. Reads are bounded by the three retained references and use
existing primary keys; no audience lookup or periodic scan is introduced.

Real-database effect cases cover Slack and Discord thread messages, safe notices,
ephemeral messages and public fallbacks, with ordinary guest delivery controls.
They also cover retained delivery/completion bindings when the action's direct
binding is absent, missing-policy quarantine, and a restriction committed after
staging but before the transport claim. They do not qualify races after the claim,
provider-effect crash/restart, already-claimed actions, or provenance that was
never retained. Direct command callbacks and explicit tools remain separate
confinement blockers; the inbound typing slice below reuses this owner.

The existing receipt-reaction claim owner checks retained action and delivery
conversation bindings against the same task disposition before claiming either
an add or removal. Missing referenced bindings, unbound legacy receipts and
legacy bound tasks without a disposition fail closed. Slack's early receipt
retains its conversation in the task transaction, before delivery acceptance fills
that binding. Denied actions settle as cancelled without resolving provider
transport or scheduling another retry. Reads use delivery/conversation/task keys,
not a historical message-link scan. No new worker, audience lookup or periodic
scan is introduced.

Real-database reaction cases reproduce the original forbidden add/removal sends,
then cover automatic Slack/Discord receipts, ordinary guest add/removal controls,
restart/replay, action-only provenance, unbound-delivery quarantine, due retries
and stale processing claims. They do not qualify deleted or never
retained provenance, an already-running provider call, or policy strengthening
between the claim and transport. An already-applied reaction is not removed on
behalf of a forbidden task. This slice is not complete reaction noninterference
or permission to enable verified admission.

The Slack session-status owner applies the task output policy in its existing
credential-fenced claim transaction. Both the destination conversation's task
and a distinct retained publication-source task must allow provider output.
Forbidden or unmarked bound tasks settle the selected action as cancelled, with
no status call and no renewal deadline. Primary-key policy/binding lookups add
no audience scan or independent worker. Cancellation retains the selected
revision/status/timestamp guard, so an older selection cannot cancel a newly
staged revision.

Real-database session-status cases exercise all four provider statuses with guest,
verified, missing-policy and restriction-before-claim sources. They cover restart,
stale processing recovery, due retry, distinct publication-source provenance and
a newer revision winning after selection. Guest controls retain transport,
processing renewal and the existing rate-limit/restart behavior. Historical
published rows are simulated retained history, not proof that forbidden output
was safely published or that old provider state was removed. These checks do not
qualify policy changes after claim, an in-flight status request, command callbacks
or explicit tools. Verified admission remains unqualified.

The two inbound typing call sites now delegate to the same durable provider-effect
owner. A processed inbound wake supplies the retained delivery, conversation and
principal; one `inbound_typing` action per delivery retains its original runtime
fence. Missing callback fences suppress staging rather than resampling credentials
for an old SDK object. Slack still creates no typing action because its manifest
omits `assistant:write`, and replayed Slack typing actions are denied as well.

The typing claim requires an active/waiting exact destination conversation, a
processed same-company/endpoint delivery, and its matching processed wake with
the same principal and task. It consumes the existing source-task output-policy,
current principal/destination and credential checks. Missing provenance cannot
fall through to an ordinary unbound provider effect or safe notice. Typing uses
no message/DM fallback and records a typing acceptance, not a message receipt.
These additions stay with the existing effect state machine and authorization
owner despite taking that module over 1,000 lines; separating the small typing
branch would duplicate the claim, credential and failure ownership.

Once staged, typing uses the existing event/deadline worker, bounded failure
retry and stale-processing quarantine; it adds no action kind, schema, worker,
independent timer or recurring idle scan. A best-effort typing failure does not
reopen the already-accepted inbound delivery. Restart/replay rechecks current
source policy before any retry; a strengthened policy cancels the effect without
creating another deadline. A stale processing claim is delivery-unknown, not
blindly retried. A crash before typing staging can still omit this cosmetic
signal; no exactly-once provider delivery or complete typing-producer inventory
is claimed.

Real-database cases exercise live and recovered inbound paths, ordinary guest and
verified lanes, missing-policy quarantine, restriction before claim, lost or
mismatched wake/delivery bindings, destination mismatch, old credential fences,
completed conversations, restart, duplicate recovery, due retry, stale processing
and actual injected typing failure. Ordinary controls type once and Slack stays
quiet. These provider fakes do not qualify live typing duration, provider-owned
renewal, a policy change after claim, already-running calls or removal of existing
provider state. Callbacks/tools, complete legacy/derived provenance and claim
races still block verified-admission deployment.

Discord progress-retirement tests explicitly distinguish genuine guest admission
from linked-user verified admission. Guest tests retain their original public
receipt/edit assertions; verified tests require cancelled progress/control
publications, internal close completion and zero transport posts/edits, including
exact command replay. Verified cases also require no receipt additions or
removals for that source, while ordinary cases preserve receipt retirement.
They do not establish callback confinement or the remaining reaction race and
provenance boundaries above.

Post-close publication-binding regressions use genuine ordinary guest admission
and preserve public receipt, coalescing, source-freshness, restored-authority and
idle-wake assertions. Identity-revocation cases link that guest principal only
after source admission, without changing the task's retained output provenance.
The signed Slack Stop notice-retirement control qualifies ordinary guest setup
and uses a separate linked controller, preserving the guest source's accepted
identity throughout cancellation and retirement. Separate verified tests require
internal close completion, new task/generation admission, exact replay targeting, retained native
results, and cancelled publication without posts/edits. Registration-restart and
cross-lane chronology cases exercise both outcomes, not a public acknowledgement
for verified work. This separation does not qualify linked verified setup,
provider callbacks, reactions or typing.

## Discord native command callbacks

The Discord command owner checks the selected task's server-owned output policy
inside its existing command transaction, after current actor, runtime, registration,
destination and Gateway-lease authorization. A forbidden task or a legacy binding
without policy yields a content-free `suppressed` completion rather than returning
its status, title, identifier or control acknowledgement. The same check precedes
an exact receipt replay; a prior ordinary response is not perpetual release authority.
The native command receipt and any internal task-control obligation still commit.
No provider publication is restored, and no second effect queue or worker is added.

The shared SDK completion contract carries this one explicit outcome so the Discord
adapter can return without `editReply`, including without its usual unconfirmed or
denied-text fallback. This narrow shared change is necessary because returning void
or an unrecognized object currently sends fallback text. Ordinary accepted/denied
responses and other providers keep their existing behavior. The existing immediate
private defer is content-free ingress protocol acknowledgement, sent before any task
lookup and independent of its result; it is not a verified result publication. A
suppressed completion intentionally leaves that acknowledgement without task-derived
text. No new notice, delete, cleanup timer or response retry is introduced.

Real-database tests with the installed parser cover all three commands, missing
policy, restriction before receipt replay, duplicate/concurrent commands and current
authority changes. Actual admitted DM sources also exercise forbidden policy without
pretending that a DM flag mutation qualifies the DM ingress path. Installed discord.js
boundary tests inspect the independent type-5 private defer and absence of a REST
completion. These are local transport proofs, not live-provider UX qualification or
proof of ordering a policy change after the transaction's policy read. Explicit tools,
other callback producers and complete legacy/derived provenance remain unqualified;
verified admission stays under its deployment hold.

## Explicit Slack mutation tools

The existing `connectors/slack-writes.ts` executor checks the server-owned task
output disposition before any provider call or durable action creation, including
before returning an old action receipt. Current run/requester/endpoint authority,
standard work mode, governed invocation and required approval remain mandatory.
The same executor serves the native, CLI and approved-operation gateway paths;
read tools retain their existing access checks rather than losing the entire
Slack connection.

After claiming an action, the executor rechecks output policy. Every mutating
Slack API call also rechecks it after intervening authorization reads. The upload
path checks before allocating a provider upload, sending bytes and completing the
file share. A late definite denial uses the existing failed-action disposition
and retains any allocated file receipt; it does not delete remote state, send a
notice, schedule a retry or claim that already-transferred bytes were recalled.
The existing definite-rate-limit retry owner declines to reopen a forbidden task's
action/invocation. These indexed, company/task-scoped policy reads introduce no
worker, timer, schema or historical scan.

Real-database cases cover every catalog mutation at the initial executor boundary,
the governed connector path, native verified channel admission, an actual admitted
DM strengthened to forbidden, legacy missing-policy quarantine, registration
restart, retained action replay, pending approval execution and due retry. Separate
ordinary controls retain posting, DM opening, reactions, topic/channel creation,
upload and exact delivery/approval/recovery behavior. Controlled authorization and
upload callbacks strengthen policy between specific effect boundaries. They do
not order a policy write after the last policy read against the network call,
prove in-flight cancellation or qualify all external tool capabilities. DM ingress
still follows ordinary binding behavior; restricting an actual DM source is not
proof of privileged verified-DM admission. Complete provenance and claim-race
qualification remain deployment blockers.

## Explicit GitHub bot tools

The existing `chat-github-reviews.ts` owner checks task output disposition before
all five side-effecting catalog tools: comment, progress edit, begin assessment,
submit assessment and formal review. Begin assessment is not read-only: it queues
a provider check. Forbidden and unmarked bound tasks cannot use it to create new
check work. PR/file reads retain their current authorization. This is not a grant
to read arbitrary repositories or transmit protected content through read arguments.

Publication receipt replay rechecks current output policy, including formal
reviews. The publication worker's existing authority boundary checks it again
before provider client creation. Each mutation through that worker's API checks
it after intervening head/history reads and durable pre-write bookkeeping. This
covers response/summary edits, inline findings, check results and formal reviews.
A late denial uses existing cancellation and non-retryable handling; prior receipts
and uncertainty evidence remain. There is no alternate send, remote cleanup,
new worker, schema, timer or historical scan. Indexed company/task policy reads
remain separate from ordinary run, identity, tool policy and approval checks.

Real-database cases cover the catalog, ordinary delivery/replay controls, both
receipt replay entries, missing-policy quarantine, due retry after restart and
restrictions committed at individual mutation boundaries. Controlled removal of
the per-mutation check must expose summary/progress, inline, check and formal
review sends. The checks do not order a policy write after the final policy read
against transport, cancel in-flight I/O or retract earlier ordinary output.
Automatic GitHub acknowledgement/failure/check producers have separate owners
and are not qualified by these explicit-tool cases. Other enabled tool providers,
complete retained/legacy/derived provenance and claim ordering still block
verified-admission deployment.

## Automatic GitHub responses and checks

The existing response service checks task output policy before staging or replaying
an acknowledgement, failure or terminal response. A forbidden task is not working
provider-response work. Current identity, runtime and publication-lease checks
remain in place. The shared response writer also checks policy before receipt
replay and each mutation, including retirement of a legacy placeholder. Denial
uses the existing cancelled/non-retryable response outcome, without a fallback
notice, remote cleanup or replacement worker.

The existing automatic review-check state owner checks the review task and
retained action/automatic-delivery conversation bindings before choosing a
provider state. A present binding without policy is denied. That disposition
cancels the existing check action, rather than generating an error check or
retrying. Each check mutation re-evaluates the policy after intervening provider
head/history reads. Pre-admission manual-required checks with no task remain
under their existing configuration contract; they are not task-result output.
These checks add company/task reads and a retained-binding lookup within the
existing active obligation, not a timer or independent polling path.

Real-database regressions cover issue, main-PR and inline failure replies, final
receipt replay, terminal restart, received/due-retry recovery, check dispatch,
missing review rows with retained action/delivery bindings and restrictions
committed during provider reads. Ordinary replies/checks and existing idle,
shutdown, lease and retry controls remain tested. These fixtures strengthen an
ordinary admitted task to forbidden; they do not qualify privileged GitHub
ingress. Complete deleted/legacy/derived provenance and post-last-read claim
ordering remain unqualified. They do not cancel in-flight I/O or remove historical
output. Other enabled tools still block verified-admission deployment.

## Voice session creation and phone tools

The existing Speko agent-tool authority hides and denies `call_my_phone` for a
forbidden task or a retained chat binding without output policy. Current run,
identity, requester, endpoint, company membership and callback opt-in checks
remain. Cached descriptors do not grant execution authority.

The existing voice session service checks the resolved task before creating or
reusing a conversation binding, checks retained session receipts before returning
them, and rechecks after credentials/current session authorization immediately
before browser or phone session creation. A generic resume without an issue
argument cannot evade the resolved-task check. Newly authorized conversations
without an existing chat binding retain ordinary policy before binding, in the
same transaction; existing forbidden policy cannot be downgraded. A denial before
reservation rolls back without a new session. A denial at the pre-transport
boundary uses the existing failed/known creation outcome, not an uncertain call
or automatic retry. Existing calls can still be explicitly ended; denial does
not redial, retract historical media or claim to hang up an in-flight call.

Real-database tests cover both transports, ordinary creation, forbidden/missing
policy, discovery and direct tool execution, retained and uncertain replay,
restart, generic resume, new-conversation policy retention and restrictions
committed during credential reads. Existing ordinary gateway delivery, requester
revocation, idempotency, uncertain-call and lifecycle tests remain. These are
transport fakes, not live phone/browser qualification or verified ingress. The
live-session output checks below are separate from session creation. General
remote HTTP/stdio/plugin tools, complete retained/derived provenance and
post-last-read ordering remain unqualified. Verified admission stays undeployable.

## Existing voice session output

The existing voice session store checks the task disposition after current
session/token authorization, before any fresh tool result or saved response
replay. This includes request acknowledgements, work status, published answers,
explicit repeats and question resolution receipts. A second check before saving
a new result rolls back accepted work if policy strengthened during acceptance.
Reply collection and notification feeds use the same check, so neither recovery
nor a previously queued publication grants release authority. Publication enqueue
also requires the exact current company/endpoint/conversation/task binding.

The existing phone reply owner consumes that check before claiming speech and
rechecks after credential resolution immediately before each provider message.
A late denial uses its existing failed-action outcome, without a retry or a
fallback send. Due ordinary retry receipts are retained, but forbidden sessions
cannot reopen them; the existing reply scheduler returns no next deadline. An
already accepted prefix remains an acceptance receipt, not proof of playback or
permission to send the remaining parts. Session recovery, explicit end and
uncertain-dispatch reconciliation retain their existing owners.

Fresh public guest-call tasks retain ordinary output policy in their existing
creation transaction before binding. This is not a repair/backfill of existing
missing policy and never downgrades forbidden provenance. The pre-session tool
path also checks a retained intake task before returning task-derived status.
Pre-task rings and approval prompts remain governed by their existing admission
contract, not by a guessed task identity. These indexed policy/binding reads add
no schema, worker, timer or recurring scan. Cost grows with active tool calls,
reply candidates and speech parts, not retained idle history.

Real-database cases cover fresh and cached responses, question resolution,
restart, repeat, notifications, queued speech, due retries, partial speech,
restriction during acceptance/credentials and same-company publication rebinding.
Signed public-call ingress proves fresh ordinary policy retention and denial after
restriction without changing provenance. Existing ordinary guest/member,
authority-revocation, idempotency, uncertain-call and idle/lifecycle controls remain.
The first version exposed missing ordinary policy at guest creation; the correction
retains it only at that owner, not by allowing unmarked tasks. These local provider
fakes do not prove live speech, in-flight cancellation, revoked-output recall,
ordering a policy write after the last read against dispatch, or complete
legacy/deleted/derived provenance. Other enabled gateway capabilities still block
verified-admission deployment.

## General tool gateway confinement (partial)

The existing tool-access policy owner denies general remote HTTP, REST, local
stdio and plugin tools for forbidden tasks or chat-bound tasks missing policy.
Read-labelled tools are included: their arguments can carry task content. This
check runs before profiles, remembered grants, rate consumption and Ask first;
approval is not an output-policy override. Native Paperclip self tools retain
their established authenticated read checks. Native chat/voice tools retain their
separate owners described above; this is not an exhaustive capability inventory.

Listing uses the existing request-scoped decision cache for one company/task
policy read, rather than two reads per catalog tool. Executing and admitted
invocations read fresh policy. Restricted receipt replay is rejected without
rewriting the prior successful receipt. Approved/recovered execution consumes
the same policy decision under the existing admission and review owners.

The gateway rechecks at the existing remote executor and each MCP/REST HTTP
request, before local stdio invocation and at both plugin dispatch routes.
Late denial uses existing failed-invocation handling, without fallback dispatch.
No schema, worker, timer or retry mechanism was added. The shared policy reader
requires only the database select capability, including transactional admission.

Real-database cases cover HTTP and plugin no-dispatch, fixture stdio slot denial,
missing policy, ordinary controls, restart/replay, pending and recovered approval,
restricted native reads, and policy strengthening at the invocation-status write
and between MCP initialize and its next request. Removing the final check causes
the three late-boundary cases to fail. Configured subprocess coverage is described
below; the earlier fixture slot alone did not qualify it. The tested HTTP path
is not qualification of every REST/browser/SSH/credential-refresh branch. Indirect provider branches and the
complete enabled capability inventory remain open. Post-last-read ordering,
in-flight cancellation, complete retained/legacy/deleted/derived provenance and
deployed wiring remain unqualified; verified admission must remain disabled for
deployment.

Named-gateway context resources and prompts use the same task-output decision,
after current token action and run authorization but before assigned connection
resolution. This covers both direct protocol requests and the existing wrapper
tools, which delegate to that owner. Each assigned-connection call rechecks policy
before credentials, and the remote context owner checks again after credential
resolution before HTTP dispatch. The local stdio context owner checks before its
existing invocation, including after acquiring a runtime slot. A context denial
returns the existing policy error without a fallback, new invocation, approval,
worker or timer. These indexed policy reads scale with active protocol requests
and the connections being called, not idle history.

Real-database cases use a loopback HTTP server through the production egress
path. All four methods retain ordinary context behavior and deny forbidden or
missing-policy task output for heartbeat-run and task-bound client tokens. Cases
also cover retained handles after restart, existing token/run denials, policy
strengthening during the credential resolver and before a second assigned
connection. The credential resolver is a controlled fixture, not live refresh
qualification. The checks do not order a restriction after the last policy read
against dispatch or cancel already-running protocol calls.

Configured local stdio acceptance uses a real Node subprocess selected through a
saved command template, connection, profile and task-bound named token. The local
synthetic server records process start and every received JSON-RPC message on disk.
All five methods (`tools/call` and the four context operations) exercise ordinary,
forbidden and missing-policy tasks. Ordinary cases assert initialize/notification/
request order, exact upstream parameters and returned content; denial cases assert
no process start, no runtime slot and no approval. Retained handles and a restarted
gateway remain denied after restriction. Five additional cases commit restriction
from a disposable-database trigger during runtime-slot acquisition: no subprocess
starts, and the existing supervisor records failed-slot cleanup. This is a
controlled acquisition boundary, not proof of post-last-read ordering.

These cases use no real provider credentials or remote service. They qualify the
configured subprocess path, not an installed third-party server, a live OAuth
refresh, indirect REST/browser/SSH/Cognee transports, deployed wiring, in-flight
cancellation or output recall. No production correction was needed for this
qualification slice; existing admission and pre-invocation checks remain.

### Indirect REST, SSH and refresh qualification (partial)

The Railway gateway's existing SSH callback now checks task output before resolving
its SSH key and again immediately before calling the SSH transport. Its GraphQL
preflights already consume the per-request check, but their completion is not
permission for a later non-HTTP effect. A definite denial fails the existing
invocation without dispatch, approval, fallback or retry; it does not cancel an
already-started process. No schema, worker or timer is added.

Real-database gateway tests use the configured Railway catalog/grant and actual
secret-resolution audit path, with controlled GraphQL responses and an SSH
transport fake. Ordinary work preserves exact target validation, key resolution
and one SSH dispatch. Forbidden and missing-policy work sends neither GraphQL nor
SSH. Restrictions committed after deployment validation and during SSH-key audit
prevent SSH; the earlier boundary also prevents reading that key. Retained replay
after restriction and service restart is denied. No real SSH host or shell command
was contacted or executed; these qualify the gateway callback, not OpenSSH or
remote-container confinement.

A configured Vercel REST catalog/grant exercises ordinary GET/PATCH behavior,
forbidden/missing-policy no-dispatch, restriction after ownership preflight and
retained replay after restart. The current REST client wraps the local pre-request
denial as `vercel_outcome_unknown`; the failed invocation and absence of PATCH
are asserted separately. This is not proof that all REST providers or every
native-provider adapter is confined.

Controlled customer-OAuth and Vercel-Connect credential resolvers verify initial
restriction before HTTP, denial before credential resolution for already-forbidden
work, and ordinary dispatch. A 401 refresh that strengthens policy does not replay
the original call; explicit retry after service restart is denied without another
credential request. These exercise the saved grant/resolver contract with synthetic
credentials, not a live token endpoint or the production refresh lease/CAS owner.
The complete enabled-capability/provenance inventory remains unqualified.
Post-last-read dispatch ordering, in-flight cancellation, output recall and
deployed wiring remain outside these proofs. Verified admission must remain
disabled for deployment.

### Production credential-refresh owners (local qualification)

Additional gateway cases use `toolAccessService.refreshOAuthGrantCredentials`,
not a replacement grant refresher. Direct OAuth exercises the real token-form
serializer, secret resolution, database refresh lease, token rotation and grant
updates with a controlled HTTP response. Managed OAuth uses the same production
lease/transaction owner with a controlled cloud-connector client. Both verify
expired-token renewal, forbidden/missing-policy denial before renewal, restriction
committed during renewal, refresh failure, restart denial and the existing 401
explicit-retry contract. Ordinary explicit retry uses the rotated access token;
restriction prevents that retry. Every attempted renewal must release its durable
lease. Successful renewals rotate both synthetic secrets once without storing raw
tokens in the grant; failed or unattempted renewals leave their versions unchanged.

The Vercel cases use `createVercelConnectClient` and the installed Connect SDK,
with its global HTTP fetch intercepted rather than replacing `getToken`. They
verify initial token requests, SDK cache reuse across gateway reconstruction,
forced renewal after 401, failure and denial before/after token resolution. A
cached bearer never overrides task policy. The synthetic request body contains
only its app subject and scopes, not task content. The existing 401 owner does
not replay the tool call; an ordinary explicit retry consumes the refreshed token,
while a restricted retry makes no further credential or tool request. Unique
connector identities isolate the SDK cache between cases.

These 24 real-database cases add no production correction, schema, worker or
retry policy. Removing only the final MCP HTTP output-policy guard causes all
three direct/managed/Vercel restriction-during-resolution cases to fail. The guard
is restored before full verification. Initial test failures exposed two fixture
assumptions: managed OAuth renews within one hour of expiry, and this Vercel
resolver does not supply a resource list. Their original logs and the SDK request
diagnostic remain in the verification record.

This qualifies local production-owner behavior with synthetic credentials and
controlled HTTP/cloud responses, not real OAuth consent, workload OIDC, live
Vercel/cloud connector protocols or deployment wiring. Credential-only renewal
already in progress may finish after restriction; the tests prove no subsequent
task-bearing tool dispatch, not zero network I/O or cancellation of that renewal.
They do not order a restriction after the final policy read against dispatch,
prove cross-process lease contention beyond the existing OAuth protocol suite,
or qualify complete retained/deleted/derived provenance. The enabled-capability
inventory, provenance and ordinary durable claim ordering remain incomplete;
verified admission must remain disabled for deployment.

### Browser gateway and bundled Cognee qualification (partial)

The bundled Cognee bridge now rechecks task output before each HTTP request,
including the recall POST after dataset discovery. The existing gateway supplies
that check; the bridge retains its reviewed payloads, tenant URL validation,
DNS/redirect guard and bounded response reader. This adds no provider protocol to
the policy owner, subprocess, runtime slot, worker or timer.

Real-database tests execute the actual bundled remember/recall/forget bridge with
a controlled HTTP transport and synthetic credentials. Ordinary multipart/JSON
payloads and dataset discovery remain; forbidden and missing-policy tasks send
nothing. Restriction during actual credential audit prevents dispatch, and retained
receipts cannot replay after restriction and service restart. A restriction
committed after the discovery response prevents the subsequent query POST. This
qualifies serialization and gateway policy boundaries, not the live Cognee API or
the DNS/redirect transport itself.

All seven Browser Use catalog tools are exercised through saved gateway
connection/grant/catalog state with ordinary, forbidden and missing-policy tasks.
Ordinary start/continue payloads, allowed profiles and native session/control
results remain; denied work neither calls the provider nor creates a browser run
or changes the seeded session. Real credential-audit interleavings qualify the
start/continue admission and profile-request checks. Profile pagination checks
policy before the next page; retained start/profile receipts are denied after
restriction and service restart.

A separate database trigger strengthens policy at the existing paid-dispatch
commit. The gateway request wrapper prevents the POST, but the Browser Use client
conservatively classifies its local request exception as an unknown creation:
no provider ID, a retained budget hold, and `billingUnknown`. The tests preserve
that existing behavior rather than claiming definite rejection or released budget.
Worker recovery is qualified separately below; these gateway tests do not
qualify autonomous browser activity or viewer/control surfaces. Transport responses
are controlled fakes; no hosted browser or paid task was started. No
post-final-read ordering or cancellation/recall guarantee is made.

The existing Browser Use worker calls the gateway's current policy evaluator with
the retained session/run/invocation binding, as in the app wiring. Real-database
cases now exercise ordinary running, idle and detached sessions, then restriction
or missing-policy quarantine followed by worker reconstruction. Restricted remote
work is cancelled, discovered browsers are stopped and confirmed, terminal usage
is accounted once and the durable session closes. Ordinary sessions remain live.
Removing the worker's policy result causes eight regression failures; no production
correction, worker, schema, timer or retry mechanism was needed for this slice.

Lost start/continuation replies retain their unknown run and held budget across
bounded recovery pages and worker restart. Matching work is located by the existing
request marker, never by resubmitting task text; it is then cancelled, stopped and
accounted. A list with no matching work, including the locally denied creation
above, retains the unknown hold and a cleanup deadline rather than inventing a
rejection or releasing budget. A failed cancel retains a retry obligation and the
next worker can finish cleanup. Credential removal still performs shutdown before
revoking the grant. Restriction committed during actual worker credential audit
also causes shutdown. Assertions inspect durable rows and provider methods: after
restriction the only mutations are body-free run cancellation and browser
`{ action: "stop" }`, not another create or task-bearing request.

These cases qualify local cleanup of previously admitted ordinary work, not zero
provider I/O after restriction or a claim that verified work may be started.
An autonomous remote browser can act before the worker observes the restriction;
shutdown and discovery are not instantaneous confinement or output recall. The
worker authorization callback is exercised with the same constructor contract as
the app, not a deployed server or hosted browser. Complete capability inventory
and post-last-read ordering remain unqualified.

### Native browser viewing and controls (partial)

Browser list/viewer/presence/viewport/release/control routes are board-only, not
agent tools. Their shared route boundary now applies the existing task-read SQL
predicate as well as company access before reaching the browser service. This
fixes a pre-existing gap where company membership and credential sharing alone
allowed access to a private task's browser. Private task, privacy-ancestor and
private-project rules, explicit native read grants and their revocation retain
the canonical authorization owner's semantics, including its rollout/admin
behavior. No new grant or output exception is created.

Real-database route/service tests use an injected authenticated actor and the
actual gateway policy evaluator. All eight operations reject agent actors under
ordinary, forbidden and missing-policy conditions without provider/viewport calls
or durable browser changes. Private-task readers without permission receive the
same 404 as missing tasks; native grants permit viewing, while cross-company
actors and subsequently revoked grants cannot read or control it. Eleven initial
regression failures exposed the missing task-read gate before correction.

A currently authorized human can still view a previously ordinary browser through
the native API after output restriction. Viewer URLs remain confined to that
response with no-store/no-referrer headers; list responses omit them, and CDP
addresses are not returned. Human resizing/release uses only the existing viewport
contract and ownership key, not task content. Presence and keep-open retain idle
lease/deadline semantics, but do not authorize agent continuation or override the
next worker's restriction-driven shutdown. Closed browsers cannot be reopened by
keep-open. Explicit human end remains available. Tests inspect transport methods,
durable runs/sessions, and viewport arguments; the viewport call is a spy, not a
live CDP/browser test. The existing separate viewport protocol suite is also run.

This is local route/service qualification, not actual session authentication,
authorization changes after the last read, hosted-browser confinement or live UX
qualification. Human interaction is not a verified execution-driven provider
effect. No automatic viewer link is published, and no new verified browser task
is admitted. The separate credential-refresh slice above qualifies local owners,
not deployed credentials. The complete enabled-capability/provenance inventory,
full authenticated native-reader acceptance and deployed wiring remain unqualified.
Verified admission must remain disabled for deployment.

## Fail-closed execution admission

The existing run-dispatch owner checks the server-owned task output disposition
before committing a provider-dispatch claim, and again at the final ownership
handoff. No runtime currently has a qualified confinement contract for
forbidden-output tasks. Such content execution is denied, including process,
HTTP, local CLI, native Runner and external-adapter dispatch. Agent configuration
and wake-context flags cannot qualify a runtime or override the task policy.
Ordinary work retains the existing dispatch, budget and authority checks.

The dispatch reader resolves the persisted native task, persisted legacy task,
then context `issueId`/`taskId`, in that order. Disabling continuation-ownership
enforcement does not disable this check. The existing task-policy reader also
quarantines retained channel bindings without a policy. Missing historical
bindings and content copied into an unmarked ordinary task remain separate
provenance gaps; this gate does not reconstruct them.

Denial is recorded as `task_provider_output_execution_unqualified`, a
non-retryable preflight failure under the existing heartbeat and recovery owners.
It must not become assignment/continuation replay or an adapter failure. The
existing accounting owner separately settles the durable pending no-provider-work
evidence and releases its reservation without inventing usage. A claimed,
audited native Stop recovery whose only effect is releasing existing run
resources keeps its existing cleanup exception; an ordinary recovery lease or a
content-bearing effect is not that exception.

Real-database dispatch cases cover retained denial/reconstructed services,
canonical task precedence, a restriction committed between the two gates,
ordinary controls and the exact cleanup predicate. Assembled process/HTTP
heartbeat cases use a fake adapter to check zero callback entry, stable failure,
no automatic replay, real accounting settlement and later ordinary work after
service reconstruction. Runtime labels do not qualify installed provider
protocols. These checks do not prevent preparatory filesystem/environment work,
order a restriction after the final policy read, cancel previously dispatched
work, or confine a running provider/process. There is no enablement switch or
new sandbox, worker or timer. Verified content execution remains unavailable;
publication and deployment holds are unchanged.

## Existing message and control bindings

- A message edit keeps the task recorded on the original inbound message link,
  even when a newer task exists in the other lane. A now-unlinked author cannot
  edit a verified task through that link. Replayed lifecycle events retain their
  existing idempotency behavior.
- A fresh Discord native-thread command selects the invoker's lane. A verified
  invoker can fall back to an existing guest task when no verified task exists;
  an unlinked invoker cannot fall back to verified work. A recorded command
  replay keeps its original target and the existing authority checks.
- Completed close/new chronology for native-thread intake and fresh Discord
  commands is lane-scoped, across all generations in that lane. A completed
  guest close cannot filter verified input, or vice versa. Intake chooses its
  lane only after current principal authorization under the mutation lock;
  same-lane stale input still fails the existing exact control-proof checks.
  Other surfaces and the stricter publication reader retain their existing
  behavior. This does not add publication or audience authority.
- A provider-denied task control can settle internally in the existing publication
  authorization transaction. It requires the current runtime/lease, destination,
  exact conversation/task binding, issued control action and currently authorized
  linked user. Sponsored guest authority after link revocation is insufficient.
  The action is recorded as processed with an internal-completion result; its
  acknowledgement publication is cancelled without a provider message ID. Close
  and new complete the conversation through the existing completion owner;
  status does not. Retained completion and chronology readers recognize the
  internal result without treating it as a send receipt. Chronology still requires
  exact delivery/native-command provenance. This does not authorize direct command
  callbacks, reactions, typing or any other provider effect.
- Slack Stop prefers conversations with execution or pending-wake work eligible
  at the click boundary before applying lane preference. An idle verified task,
  or a verified run created or started after Stop, must not hide eligible guest
  work. Candidate runs must still be active, assigned to the endpoint's agent,
  and bound to the same task. Pending work includes claimed, runless wakes
  requested before Stop. The existing durable Stop executor revalidates the
  selected target and retains exact-run and exact-snapshotted-wake cancellation
  authority, including when that wake starts after Stop.

These selection rules do not grant permission to govern another task, bypass
current identity checks, or cancel unrelated later work.

## Verification boundaries

`server/src/services/chat-channels/inbound/trust-lanes.test.ts` checks lane
classification and selection. The trust-lane group in
`server/src/__tests__/chat-channels.integration.test.ts` exercises real-database
binding, fresh-task isolation, containment, promotion, identity revocation,
accepted-author refusal, original-message edits, and stale initial lookups.
Contention cases hold each additional-author advisory/link/membership lock,
verify rollback and retained retry work, then restart the service and verify
exactly-once task/comment/wake recovery. A bounded two-endpoint authority-owner
test holds opposing invokers before additional-author acquisition; it verifies
nonblocking deferral rather than relying on PostgreSQL deadlock detection. It
does not exercise the full endpoint/FK lock graph or prove global lock freedom.
Relevant Discord command and Slack Stop groups exercise the existing durable
control paths with multiple tasks in one thread. A controlled duplicate-handler
case pauses after real admission and claim commits: callback completion without
a message link is valid while another handler owns processing. Releasing that
handler must persist one source comment/link/wake, without duplicate effects on
replay. Setup fixtures wait for their exact source link, not callback completion
alone. This does not identify the cause of an earlier uninstrumented setup failure.
Post-close fixtures also settle each exact setup wake through the durable owner
and require its processed action and scheduler receipt before constructing closed
history. A raw scheduler spy call is not acceptance: a reproduced endpoint-lock
conflict left the setup source issued with no receipt, whose legitimate later
retry polluted the total-call assertion for a different recovered source. That
strict assertion and its before/after source/receipt diagnostics remain intact.
No production dispatch or retry timing was changed.

Run the focused selection from the repository root:

```sh
pnpm --dir server exec vitest run \
  src/services/chat-channels/inbound/trust-lanes.test.ts \
  src/__tests__/chat-channels.integration.test.ts \
  -t 'chat trust lanes|verified linked-user turns in guest-admitted threads|Discord native commands with durable service authority|Slack.*Stop|Slack.*stop|signed Stop|queued.*wake.*Stop'
```

These fixtures use simulated provider transport. They do not qualify live Slack
or Discord delivery, complete provider readership, publication-time security,
or deployed-release behavior. Retain material failures in the verification
record even when a later attempt succeeds.
