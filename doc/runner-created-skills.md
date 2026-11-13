# Skills created by the Runner

## Search and load company skills

Native agents can use `search_skills` and `load_skill` to read accessible company
library skills even when those skills are not assigned to them. These read-only
tools are available in Auto, Ask and Plan modes without generic API access or a
mounted workspace. The closed Muse, completion-review and skill-test profiles
keep their existing tool scopes.

Call `search_skills` with a `query` to match a name, key, slug or description.
An empty query browses the library. Results include IDs, version IDs, source type,
trust level and compatibility. `limit` is at most 20. Follow `nextCursor` with the
same query until it is null. Search reads stored metadata; it does not synchronize
sources, install catalog entries or fetch repositories.

Call `load_skill` with the returned skill ID and `versionId`. An exact key also
works; a slug must be unique. The default file is `SKILL.md`. To read a referenced
text file, pass its relative `path` and the same version ID. The response includes
a SHA-256 digest on the first text page (`null` on continuation pages), byte size,
and up to 6,000 UTF-16 characters. Retain the first page's digest. Follow `nextOffset`
in `offset`; a version ID is required for subsequent pages. The file list contains
up to 50 entries; use `nextFileOffset` as `fileOffset` to read more entries. Do not
switch to the latest version partway through a read. Missing or retired versions
return an error instead of silently substituting different content.

Loads use the existing saved package reader, including repository skill wrappers
and supporting files. Text files above 16 MiB are rejected before body reads;
accepted text is cached for the run with a 64 MiB budget and at most 64 files.
Later pages reuse cached text and still check current access. Evicted files are
read again. Repository reads use verified warm files or isolated recovery without
holding the company startup lock. Supporting paths use the saved package limit
of 4,096 characters plus the generated repository prefix.
Binary files and unsafe paths are rejected. Access is
checked against the current run and the existing company and project source
boundaries, including after file I/O. Loaded content does not change persistent
assignments, pinned runtime bundles, permissions, connections, or approval gates.
Skill mutation policy continues to govern authoring and installation through the
existing APIs. Reading instructions does not authorize actions described in them.

## Create and update skills

The native Runner exposes `create_skill` in Auto and skill-test work. An agent
can save a reusable, single-file skill directly in the company's skill library.
The tool is unavailable in Ask and pre-acceptance Plan modes.

The native Runner also exposes `update_skill` in the same modes. Read the
existing skill and its `currentVersionId` through the company skill API before
editing. Supply the **complete** primary file, not a fragment:

```json
{
  "skillId": "<existing skill UUID>",
  "expectedVersionId": "<current version UUID>",
  "markdown": "---\nname: release-review\ndescription: Review release notes.\n---\n\n# Review\nCheck each release note and its tests.\n",
  "idempotencyKey": "review-update-1"
}
```

The tool uses the existing Skill Studio file endpoint and company `skills.edit`
policy. It returns a skill ID, path, resulting version ID, and Skill Studio
path. Retry a lost response with **exactly** the same key and inputs; that
returns the original receipt without another version or activity record.
Reusing the key with different inputs, or updating after the version changes,
returns a conflict. After a version conflict, reread the skill and choose a
new key for the revised edit. Policy is checked again even on exact retries.

```json
{
  "name": "release-review",
  "description": "Review release notes.",
  "markdown": "---\nname: release-review\ndescription: Review release notes.\n---\n\n# Review\nCheck each release note against its change.\n",
  "idempotencyKey": "release-review-1"
}
```

The name is lowercase with hyphens. The complete `SKILL.md` must have matching
name and description frontmatter and a nonempty instruction body. An optional
`slug` must equal the name. Company, task, agent and run identity come from the
authenticated run; they are not tool inputs.

The tool uses the same company skill policy and storage as Skill Studio. Skills
are open by default unless company policy restricts creation. Creating a skill
does not assign it to an agent or introduce a new approval step. Once the skill
is saved, the task can finish normally if no other work remains.

The result contains the skill ID, name, slug, description, version ID and Studio
path. Reuse the same idempotency key and inputs after a lost response. A retry
returns the existing skill without another creation event. A key reused with
different inputs, or a name that belongs to another skill, returns a conflict.
Published files are never replaced as part of a competing creation request.
Deleting a managed skill releases its name for a later creation. Deletion uses
the same name lock as creation and retains its source files until the database
deletion commits. Imported local and project source folders are not removed.

## User interface

Successful creation adds a **Skill created** card to the originating task's
feed. The card opens a named skill tab in the task sidebar. Repeated clicks
focus that tab. The tab reads the company skill directly, so it is not a second
editable copy of the instructions.

**Open in Skill Studio** opens that same skill for editing. After saving and
returning to the task, the sidebar shows the latest saved version. Reloading the
task restores the tab. The historical card remains a creation receipt even if
the skill is later edited or removed. The sidebar reports missing skills,
denied access and retryable load errors explicitly.

## Verification

Server regressions cover authenticated creation, company isolation, policy
denials and revocation, mode restrictions, initial version/file persistence,
idempotency, conflicting retries and concurrent creation. UI tests cover the
creation card, saved tabs, frontmatter-free preview and error states.

The companion Runner Eval case `create-skill` tests provider tool use against
the seeded mock control plane, not production storage or company policy.
The standalone mock uses a generated production frontmatter parser and schema
validator. Regenerate it with
`node packages/shared/scripts/generate-runner-skill-frontmatter.ts` after changing
the shared frontmatter contract. A shared-package test checks synchronization.
Invalid inputs are covered by deterministic tests: a live model should not be
penalized for declining to send a schema-invalid request. Product E2E's
`create-skill-studio` case checks real creation, task completion, the feed card,
sidebar, Studio editing and the updated skill after returning to the task.
See [the eval guide](evals.md) for the difference between these suites.
