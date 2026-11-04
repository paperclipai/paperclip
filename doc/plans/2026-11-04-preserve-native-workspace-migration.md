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
