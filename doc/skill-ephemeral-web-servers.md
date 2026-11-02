# Skills on ephemeral web servers

The skills guarantee is replacement of A by B, and then C, with empty web-server
homes and the same database, object storage, secrets and supported application
artifacts. Disk remains useful for scratch archives, verified caches and transport
staging. It does not own acknowledged managed edits or installed version selection.
This guarantee does not qualify instructions, workspaces, controller state, run
logs, traffic switching or readiness/draining for volume removal.

## Ownership and publication

`managed` is Paperclip ownership. Its locator is null; editability does not depend
on a directory's position beneath a managed root. Existing policies normalize it
to `workspace`, the policy category previously used by managed local skills.
Repository provenance and tracking remain separate from installed content. Forks
and disconnected editable copies retain source access and cannot publish restricted
content through a public source category.

`managed-skill-content.ts` reads immutable version inventories, prepares candidates,
and publishes them against a captured head. Package upload and verification happen
before the final database transaction. That transaction rechecks identity/access,
locks names in sorted order, locks the skill, verifies the base, and publishes the
version, head, projections and applicable mutation audit/receipt. Publication races
return `409`; clients must reconcile instead of automatically rebasing. Complete
inline versions remain the compatibility fallback when external writes are disabled;
they never depend on an installed directory. Normal cloud qualification uses remote
object storage.

The initial create response, including its original version, can be replayed after
a lost response and subsequent edits. Its durable API receipt retains the response
projection without Markdown; the immutable version supplies the body. Receipts
remain scoped to company, actor and operation context. A deleted skill's receipt
fails explicitly rather than creating another identity.

`skill-execution-content.ts` owns temporary materialization. Heartbeat preparation
selects authorized immutable versions, saves the selection (including an empty
selection), and only then materializes admitted entries while retaining the existing
retention lock. A renamed skill is recovered through the version's stable skill ID.
Native recovery resolves the version, reconstructs its v1 projection and requires
the admitted digest, manifest digest, file count and byte count to match. Adjacent
compatible releases must preserve that projection contract.

Studio tests deliver the selected saved version through the same native Runner
path, even without a permanent agent assignment. Their `skill_test` mode remains
explicit in the execution input. The durable test row replaces ordinary agent
assignments with its exact version, independently of the Beta skills preference;
required environment skills remain subject to their existing policy. A shadowed
or inaccessible test skill fails preparation. Preconfigured Runner homes cannot
receive this managed delivery, so Studio requires an isolated home. Task-bound
credentials and native authorization
retain the admitted scope through restart and task-mode edits. Native tools expose
only the harness task and admitted skills; company browsing, task creation,
connectors and assigned MCP tools are unavailable. A rollback image must understand
that mode to continue an active Studio test. Settle tests before rolling back to an
earlier image that rejects it.

Native task completion publishes the Studio result and output snapshot in the
same transaction as its status decision. Replaying a committed decision cannot
recapture later document edits or duplicate completion activity. A successful
provider turn alone does not complete a test whose task remains unfinished.

Bundled release snapshots remain immutable. Reconciliation preserves an installed
head; an older process must never promote its shipped bytes over another installed
version. The shipped release history remains independently selectable. Linked-local
skills retain mutable source behavior and are explicitly excluded from cloud readiness.

## One-time conversion

First deploy compatible readers and shared/API types. Preserve the old volume and
keep legacy writers until the final supported contents can be captured. Automatic
JSONB package migration is separate from installation conversion; passing one does
not prove the other is finished.

Run the existing bounded CLI with the target's explicit database and storage config:

```sh
pnpm --filter @paperclipai/server exec tsx scripts/migrate-skill-packages.ts --phase=eligibility --company=<uuid> --limit=10
pnpm --filter @paperclipai/server exec tsx scripts/migrate-skill-packages.ts --phase=installations --company=<uuid> --limit=10
```

These commands return a cursor. Continue each phase with `--after=<uuid>` until an
empty batch. Eligibility is a metadata-only report, not a storage verification claim.
Installation preview inspects candidate legacy contents without publishing them.
For remote legacy imports it can acquire their exact pinned source; it must never
use the latest branch as a replacement for missing installed content.

1. Inventory all companies and source kinds. Identify missing versions, incomplete
   inventory, local storage receipts, catalog reset snapshots and unresolved runs.
2. Backfill legacy package/version bodies with the existing `snapshots` and
   `versions` phases. The latter also fills missing version metadata indexes so
   subsequent library/history reads need no object downloads. Keep original bytes
   until independent verification succeeds.
3. Stop admission and skill/source writers; retire every filesystem-authoritative
   process. The `--writers-stopped` flag attests this operator action; it does not
   stop the application itself.
4. Apply final installation conversion on the host with the legacy files:

   ```sh
   pnpm --filter @paperclipai/server exec tsx scripts/migrate-skill-packages.ts --phase=installations --company=<uuid> --limit=10 --apply --writers-stopped
   ```

5. Sweep `eligibility` and `verification`, including all historical versions. The
   latter verifies object bytes independently of caches. Follow all cursors; a
   successful first batch is not a complete readiness report.
6. Start a compatible server with a fresh home and test list, file read, authoring,
   history and exact selected execution before reopening normal admission.

Managed conversion preserves skill IDs, keys, history, assignments, pins and access
provenance. Identical complete snapshots reuse their version IDs. Catalog conversion
preserves the original reset version as well as installed content. A missing legacy
directory can use a complete verified saved version. A partial Markdown-only rescue,
unknown revision, unsafe source tree or active legacy selection without exact version
identity is a blocker. Settle or snapshot such runs while A is still available; do
not cancel them simply to pass preflight.

Report statuses distinguish linked-local sources, legacy managed/catalog records,
missing current versions, unknown active-run selections, missing/corrupt packages,
local storage and provider mismatch. Expired unused Git history keeps its existing
30-day/exact-commit policy. Current, pinned, authored and recovering versions need
independent durable content. `local_storage` is supported self-hosted durability;
it does not satisfy remote empty-disk recovery.

## Storage and rollback

Cloud readiness requires external Postgres and remote object storage. Migrate and
verify existing local-disk objects before changing provider/bucket configuration;
changing configuration alone does not copy receipts or objects. Keep the old provider
available until a provider migration has copied and independently verified every
referenced object and atomically updated its storage receipt. This command does not
perform provider migration: `local_storage` and `provider_mismatch` are blocking
results for cloud qualification, not instructions to switch configuration and retry.
A directory of extracted caches is never a durable object backend.

The maintenance CLI reads the existing storage configuration directly so it can
verify legacy local-disk objects before cutover. On Cloud it still requires the
persisted runtime configuration and never seeds or changes that configuration.
This maintenance boundary does not start a server or relax Cloud server startup
requirements for external PostgreSQL, shared object storage and a stable secret
key. Apply operations retain their existing stopped-writer gates.

Conversion establishes the rollback floor. Afterward only compatible version-reading
binaries may overlap or be rolled back against the same remote state. Reattaching an
old volume does not roll back committed content. Filesystem-authoritative binaries
require an explicit reverse migration and are unsupported rollback targets.
A routine compatible A → B upgrade needs no skills conversion or filesystem copy.

A current version ID alone does not establish conversion completeness. Eligibility
and independent verification compare its file inventory with the installed record
and report `incomplete_current_version` when supporting files are missing. Installation
conversion can reacquire a complete exact pinned source; unavailable or unpinned
sources remain blockers. Historical versions are not compared with newer installed
inventories, since later revisions may legitimately add files.

## Qualification

The focused service suite covers publication rollback/conflict, supporting and binary
files, executable modes, restore/fork/rename, active-run deletion protection and legacy
conversion. The opt-in process suite starts independent Node servers with one database
connection each, exercises real HTTP routes and object storage, removes predecessor
homes and executes a delivered harmless script. It also injects a lost response, failed
upload and process death during upload. It is a skills-router qualification, not a
full hosted Runner or whole-application deployment claim.

Use owned disposable Postgres and S3-compatible fixtures. The optional admin URL
creates a random database per test suite and never migrates the database named in
that URL. The S3 test creates and removes its own random bucket. Supply test-only AWS
credentials through the environment:

```sh
PAPERCLIP_TEST_POSTGRES_ADMIN_URL=<disposable-postgres-url> \
PAPERCLIP_TEST_S3_ENDPOINT=<disposable-s3-endpoint> \
pnpm exec vitest run server/src/__tests__/ephemeral-skills-process.test.ts
```

Record revision, fixture image digests, version IDs, cache/object reads, cold/warm
timings and useful output. These local timings do not establish hosted latency.
Separately qualify one disposable staging tenant and a real remote Runner, including
an explicit repository import, historical pin, fresh-home replacements, compatible
rollback and recovery without predecessor paths. Publish the observed evidence with
the PR; a passing local suite is not that staging evidence.
