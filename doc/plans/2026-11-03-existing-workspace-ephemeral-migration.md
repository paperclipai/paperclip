# Preserve existing workspaces during ephemeral enrollment

The deployment endpoint remains a volume-free Cloud tenant, followed by a real
rolling deployment while an agent works and new work is admitted. Enrollment must
preserve existing task files and historical recovery sources. It must not reset
task workspaces, manufacture successful copyback, or weaken migration guards.

## Evidence and remaining work

| Required outcome | Current evidence | Remaining gap | Owner / next action |
| --- | --- | --- | --- |
| Existing active task retains files | The current import encrypts, uploads, independently restores, compares the source again and publishes under the lifecycle lock. A live completed task imported successfully with its original directory retained. | The importer only accepts an active workspace with the current task binding. | Workspace migration owner: support historical records without changing the task binding or lifecycle state. |
| Archived task retains its saved files | Retention records include encrypted task-directory restore points, Git restore points and verified Git reconstruction recipes. | The importer rejects missing local folders even when an existing restore point can reconstruct them. | Restore-point owners: reconstruct into migration scratch space, reject expired/missing/corrupt sources, and feed the verified result into the normal import publication. |
| Shared project roots preserve all task files | Legacy roots contain nested task worktrees and multiple records can reference one physical folder. | A naive root capture recursively imports those other workspaces; the current per-record writer check does not fence aliases. | Workspace migration owner: inventory physical overlaps, fence all writers, and preserve nested workspace coverage before excluding any directory. |
| Failed runs retain unsaved files | Provider inspection distinguishes surviving archived sandboxes from missing allocations. Existing recovery validation accepts some sources and rejects others for missing provenance or ambiguous allocation ownership. | Recovery must settle or durably preserve each exact source. A successful old preservation action does not necessarily update the legacy sync descriptor. | Workspace recovery owner: verify existing preservation receipts, recover eligible sources, and retain explicit unresolved obligations for unavailable/ambiguous sources. Do not replay agent work. |
| Tenant is eligible without its volume | External DB and S3 are configured; the original volume remains attached. | Workspaces, local run logs and remaining owner-maintained data must pass the packaged maintenance receipt. | Cloud enrollment owner, after workspace migration is complete. |
| Ordinary upgrades remain available | The no-drain Cloud deployment path is merged and qualified on another enrolled tenant. | Exact final app image qualification and a live deployment on this tenant. | Cloud deployment owner: qualify, enroll, then prove reads, submissions and active-run adoption through an actual replacement. |

## Acceptance boundaries

The first implementation slice supports archived and historical records,
encrypted task-directory restoration, Git restoration recipes, and legacy
branch-deletion receipts. PostgreSQL and real-file tests prove cold restoration
of saved bytes, index state, and unpushed commits, including after pruning the
old Git object store. Invalid or unavailable retained data still blocks import.
The next slice adds leaf-first offline migration of overlapping folders, verified
nested snapshot dependencies, interruption recovery, and dependency retention.
Recovery-obligation reconciliation remains a separate gap; these slices do not
yet make the whole tenant eligible for enrollment.

- Import existing files or a verified retained source. A missing folder alone is
  not permission to publish an empty workspace or choose a newer Git branch.
- Preserve archived status, task bindings, task history, unpushed Git history,
  staged and unstaged edits, and saved recovery copies.
- Preserve original files and the detached original volume until verified
  migration receipts and the retention interval permit removal.
- Parent roots may omit a nested workspace only with durable, inspectable
  coverage of that exact nested directory. Arbitrary exclusion globs are not an
  acceptable data migration.
- Resume interrupted imports with their original identity; cancellation may
  release an empty reservation only after the producer is stopped and no upload
  was journaled. Preserve an audit receipt.
- Verify restored file bytes independently, including after making the old
  source unavailable in an isolated test. Exercise current and historical
  bindings, archived sources, overlap/writer races, and unavailable sources.
- Unrelated tenants, production services, and agent task execution remain outside
  the migration's mutation scope.
