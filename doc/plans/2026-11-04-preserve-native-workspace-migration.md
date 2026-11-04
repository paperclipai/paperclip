# Preserve native sessions when enrolling a legacy workspace

A retained native session binds both its Core workspace address and the provider's
sandbox address. Migrating files to object storage must preserve these addresses;
a new `.paperclip-workspaces` directory alone is not session continuity.

The offline workspace owner records selected native source bindings in its
successful migration operation. It checks the source again before publication.
The workspace points to that operation; arbitrary metadata is insufficient.
Each binding retains company/workspace, agent, task, normalized session, source
run, logical address, and the shared provider address. Conflicting or missing
identity blocks publication without deleting source files.

Runtime selection uses the original logical address only for the exact retained
session. The remote workspace owner restores at the original provider address,
refuses another base path or an occupied unowned root, and may publish into a
verified empty directory on a newly allocated sandbox. The environment owner
includes the migration operation in its reusable lease fingerprint, so existing
warm policy obtains a fresh allocation and then reuses it normally. A verified
migration binding permits restoration of the exact retained warm backup into
that new allocation. Existing backup digest and identity checks remain required.

Verification covers real PostgreSQL, filesystem restore after removal of the old
controller workspace, unchanged provider bytes, warm and per-turn policy, forged
receipts, wrong targets, occupied roots, and reusable-lease replacement. The live
acceptance gate is an ordinary agent continuation through the packaged offline
migration, followed by a rolling deployment with active ownership transfer.
Named staging enrollment remains pending until this proof and the PR gates pass.

The first live enrollment also found that already-packaged local skill objects
were skipped by the older database-body migration. The skill storage owner now
copies each verified local archive and manifest to a new S3 upload claim, reads
back their exact bytes, then publishes the new receipt with a compare-and-swap.
Package and version IDs stay unchanged. Failed copies retain the original
receipt, local objects and durable upload journal. The maintenance entry pages
through this owner before its existing package and version verification.

Fresh provider allocations can contain provider-owned runtime files. The plugin
lease metadata exposes a bounded `workspaceAllocationFiles` receipt containing
the exact provider lease, remote root, relative paths and SHA-256 hashes. Daytona
owns its sentinel encoding; workspace restore only consumes that normalized
receipt. The restore owner admits only the declared regular files, preserves
those bytes alongside the restored workspace, and refuses unknown files, changed
hashes and links. A parked allocation directory makes interrupted publication
retryable. Providers without the optional receipt retain empty-root behavior.

The all-Runner prerequisite merged as `612d9931a6`. The second live Codex migration
at `469d28314f` verified all ten local skill objects, the original workspace and
provider backup, and reached a ready maintenance receipt. Its next turn exposed
the allocation-marker restore failure; that attempt remains failed. The exact
owned sandboxes, temporary credentials, database and object bucket were cleaned.
The original task remains staging enrollment, active handoff, and admission of
new work with existing warm/per-turn policies; staging has not yet been enrolled.

The `91db767eb8` live attempt successfully restored the workspace and preserved
its reference bytes, but the next turn incorrectly selected a fresh provider
session. Its recorded admission reason was an adapter-configuration change.
A no-provider reproduction isolated the cause: importing unchanged managed
instructions creates a durable head, after which normal fingerprints omit the
old local instruction paths. Session preparation now compares the complete old
fingerprint using the verified imported content hash and the still-recorded
paths. It does not waive content, model, credential or other configuration
changes. Ordinary future turns retain the location-independent fingerprint.

Migration qualification also waits for a live question to become a saved
handoff and for its task lock to release before requesting offline enrollment.
The maintenance owner's active-run rejection remains unchanged.

The same failed attempt also exposed a fixture conflict: it requested a generated
reference file but forbade delivering it, and completion stayed blocked. The
migration journey now asks for that exact reference as an attachment after the
answer, alongside the confirmation. The byte/session/path preservation oracle
is unchanged; initial delivery remains forbidden and final task completion is
still required. This is fixture setup, not a relaxation of product completion.

Live Codex at `2d5bb9a6d1` retained the same native and provider session, both
workspace addresses and exact reference bytes after old-home destruction. It
finished the task and delivered its confirmation and reference attachment.
The original campaign failed one generic output-count check because it counted
the explicitly requested reference as a second primary output. The migration
owner now grades that attachment separately and excludes only its independently
verified original bytes from the primary-output count; duplicates and unrelated
files remain failures. Regrading the retained evidence passes all 21 checks.
The original failed disposition remains recorded. Forty-four grader/readiness
controls pass; further live provider and warm-policy qualification follows.

OpenCode per-turn and Codex warm at harness `94bb917947` passed all 21 product
checks. Their diagnostic observer held the disposable database open at cleanup;
the observer now closes on the final case receipt, and an ordinary PostgreSQL
drop reproduces both the failure and fix without a provider. Owned sandboxes,
keys and buckets were independently cleaned. Original campaign failures remain
recorded. Full repository build passed at `94bb917947`; full repository typecheck
and 38 focused harness tests passed at `b12ecd823e`.

The next Grok migration preserved the workspace and session selection but failed
at the Runner's strict attachment check. Imported instructions and skills had
new registered copy paths. Grok still used immutable-instruction attachment,
while Claude already allowed only the authenticated canonical asset-path suffix
to move. A no-provider Grok regression reproduces that exact rejection. Grok now
uses the same narrow asset-path policy. Content, skill digests, workspace/session
identity, unknown context policy, same-run mutations and unauthenticated run
rotation remain rejected. All 57 ACPX provider tests pass after the fix. A fresh
Linux Runner and real Grok continuation must still verify the provider boundary.

The released ACPX Codex profile had the same immutable-path default. Its
no-provider regression also reproduces the attachment rejection, and the same
narrow policy fixes it. All 58 ACPX provider tests pass. Unknown profiles retain
their prior restrictive default. Claude at `b12ecd823e` passed both strict
migration assertions, including the downloaded reference, but its full browser
workflow failed on an unnecessary confirmation and incorrect booking text.
That failed user-flow result remains recorded separately from preservation.
