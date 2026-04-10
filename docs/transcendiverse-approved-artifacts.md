# Transcendiverse Approved Artifacts

## Goal

Freeze only approved Paperclip document snapshots and sync those immutable outputs into the Transcendiverse Research vault.

This keeps live review documents editable inside Paperclip while ensuring the vault only ingests approved document snapshots.

## Unit Model

- Issue or task: workflow container for planning, assignment, approval routing, and execution state.
- Document: durable knowledge candidate that can be revised, reviewed, approved, frozen, and exported.
- Comment: review and discussion metadata that can inform decisions but is not itself a vault-sync unit.
- Vault sync: approved document snapshot only.

## Flow

1. A Paperclip approval path reaches an approved state.
2. Paperclip builds a markdown snapshot from the latest issue documents.
3. Paperclip stores the snapshot as an immutable artifact under the Paperclip instance root.
4. Paperclip emits `artifact.created`.
5. The Transcendiverse extension reads the artifact and writes:
   - a raw approved document snapshot into the vault import area
   - a distilled companion note into the vault synthesis area

## Core Hook Points

Current approval detection is intentionally narrow and additive:

- `server/src/routes/approvals.ts`
  - after `approvalService.approve(...)` returns `applied: true` and `approval.status === "approved"`
- `server/src/routes/issues.ts`
  - after an issue execution decision is recorded with `outcome === "approved"`

Those routes call `artifactService.ensureApprovedSnapshotsForIssueDocuments(...)`.

## Artifact Model

Artifacts are stored in the `artifacts` table with generic fields:

- `companyId`
- `sourceType`
- `sourceId`
- `status`
- `version`
- `format`
- `storageType`
- `storagePath`
- `contentHash`
- `createdByType`
- `createdById`
- `metadata`

Current approved snapshot source:

- `issue_document`

Explicitly not vault-sync units:

- issues or tasks by themselves
- issue descriptions or legacy plan text by themselves
- issue comments
- approval records by themselves

## Storage Layout

Paperclip instance storage:

```text
.paperclip/instances/default/artifacts/approved/{companyId}/{sourceType}/{sourceId}/v001.md
```

Recommended Transcendiverse vault outputs:

```text
wiki/sources/internal/paperclip/{year}/{slug}.md
wiki/syntheses/paperclip/{slug}-synthesis.md
```

## Snapshot Format

The raw approved document snapshot is self-describing markdown:

- frontmatter with artifact metadata
- source section
- exact approved content
- JSON context metadata

This file is the immutable source of truth.

## Distillation Format

The Transcendiverse extension writes a second markdown note with:

- summary
- key decisions
- actionable insights
- Transcendiverse research relevance
- follow-up link back to the raw approved document snapshot

The current distillation is deterministic and file-based. It does not mutate canonical doctrine pages.

## Configuration

Enable the extension in the Paperclip config file.

Default local config path:

```text
~/.paperclip/instances/default/config.json
```

Windows example:

```text
C:\Users\<you>\.paperclip\instances\default\config.json
```

Config block:

```json
{
  "extensions": {
    "transcendiverseVaultSync": {
      "enabled": true,
      "vaultRoot": "C:\\Users\\User\\projects\\transcendiverse-research",
      "rawImportDir": "wiki/sources/internal/paperclip",
      "distillationDir": "wiki/syntheses/paperclip",
      "autoWriteRaw": true,
      "autoWriteDistillation": true,
      "autoMergeCanonical": false
    }
  }
}
```

Required behavior for the v1 workflow:

- `enabled` must be `true`
- `vaultRoot` must point at the Transcendiverse vault root
- `autoWriteRaw` must be `true`
- `autoWriteDistillation` must be `true`
- `autoMergeCanonical` must remain `false`

Restart Paperclip after changing this config so the handler registers on startup.

## Operator Workflow

Safe day-to-day workflow:

1. Keep the live Paperclip issue document in `in_review` while drafting and editing.
2. When the content is ready to freeze, create or use a linked board approval for that issue.
3. Approve the linked issue.
4. Paperclip writes an immutable approved document snapshot under the instance artifact store.
5. The Transcendiverse extension writes:
   - the raw approved document snapshot into the configured vault import directory
   - the deterministic synthesis note into the configured vault synthesis directory
6. Keep editing the live in-review document if needed. Later live edits do not mutate the already approved document snapshots.
7. Re-approve unchanged content only when you need a fresh approval event; it should dedupe and not create a new artifact version.
8. Approve changed content when you want a new frozen version; it should create the next artifact version and a new raw + synthesis vault pair.

If an issue reaches approval without any issue documents, Paperclip does not create a vault-exportable artifact for that issue.

## Upgrade Safety

- Core code stays generic and emits a reusable artifact event seam.
- Transcendiverse logic is isolated under `server/src/extensions/transcendiverse/`.
- Approval routes only contain the minimum call needed to create an approved document artifact.
- No upstream plugin-system redesign was introduced.

## Repeatable Smoke Test

Run the real local smoke harness:

```sh
pnpm smoke:transcendiverse-approved-artifacts
```

What it verifies:

- a live issue document can still be edited while the issue remains `in_review`
- the first approval creates approved document snapshot `v1`
- unchanged re-approval dedupes and does not create `v2`
- approving changed content creates `v2`
- later live edits do not mutate frozen approved document snapshots
- only the expected raw + synthesis vault files are created

What the smoke command does:

- reads the active local Paperclip config to confirm `transcendiverseVaultSync` is enabled
- uses the real local HTTP API and real approval route
- writes a clearly labeled smoke issue and `review` document
- verifies artifact files and vault files directly on disk
- prints the exact artifact and vault file paths it created

Optional environment variables:

- `PAPERCLIP_SMOKE_BASE_URL` to target a non-default Paperclip base URL
- `PAPERCLIP_SMOKE_COMPANY_ID` to target a specific company
- `PAPERCLIP_SMOKE_COMPANY_NAME` to target a company by name when id is inconvenient
- `PAPERCLIP_SMOKE_WAIT_SECONDS=90` to control how long the smoke harness waits for `/api/health` to become ready
- `PAPERCLIP_AUTH_HEADER` or `PAPERCLIP_COOKIE` for authenticated mode
- `PAPERCLIP_SMOKE_CLEANUP_VAULT=true` to remove the smoke-created raw + synthesis vault files after a successful run

Operational note:

- the smoke command intentionally leaves the Paperclip issue and immutable Paperclip artifacts in place
- vault cleanup is optional because operators often want to inspect the exact synced files after a run
- the smoke issue title is prefixed with `SMOKE-TRANSCENDIVERSE-APPROVED-ARTIFACT-...` so it is easy to spot
- the smoke command waits for `/api/health` to report `status: ok` before it starts creating data, which avoids false failures during slow local boots

## Tests

Coverage added for:

- approved document snapshot creation
- approval without documents produces no vault-exportable artifact
- content-hash dedupe for repeated approval of the same revision
- version increment when the approved revision changes
- Transcendiverse raw and distilled vault writes
- Transcendiverse ignoring unsupported artifact source types

## V1 Non-Goals

Intentionally not done in v1:

- no canonical Transcendiverse doctrine page mutation
- no canonical merge automation
- no mutation of previously approved document snapshots
- no attempt to make the live in-review document immutable

## Startup Notes

Known local-dev behavior:

- a transient embedded PostgreSQL `57P03` (`the database system is starting up`) can happen during local boot
- Paperclip now retries that narrow startup condition instead of failing immediately
- the smoke harness also waits for local health to go green before running

If local dev still stays unhealthy:

1. Stop the managed runner with `pnpm dev:stop`.
2. Confirm the configured embedded PostgreSQL port is not listening.
3. Remove `~/.paperclip/instances/default/db/postmaster.pid` only if that embedded port is not actually in use.
4. Restart with `pnpm dev:once`.

What was not changed here:

- no broader plugin-loader or dev-runner restart refactor
- no automatic canonical vault merge behavior
- no attempt to auto-heal every overlapping local restart edge case
