# Skills created by the Runner

The native Runner exposes `create_skill` in Auto and skill-test work. An agent
can save a reusable, single-file skill directly in the company's skill library.
The tool is unavailable in Ask and pre-acceptance Plan modes.

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
