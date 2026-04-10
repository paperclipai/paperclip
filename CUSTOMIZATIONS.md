# Customizations

This fork adds an upgrade-friendly approved-artifact seam without baking Transcendiverse-specific behavior into Paperclip core.

## Core Patch Surface

Generic additions live in Paperclip core and stay domain-neutral:

- `packages/db/src/schema/artifacts.ts`
- `server/src/services/artifacts.ts`
- `server/src/services/artifact-events.ts`
- `server/src/routes/artifacts.ts`

Core behavior:

- detect approval-complete transitions from existing approval and issue execution paths
- freeze approved issue documents into immutable markdown artifacts
- version approved document artifacts by source and content hash
- persist generic artifact metadata
- emit a generic `artifact.created` event
- expose approved artifacts through read/list API routes

Conceptual model:

- issue/task = workflow container
- document = durable knowledge candidate
- comment = review and discussion metadata
- vault sync = approved document snapshot only

## Transcendiverse Extension

All vault behavior is isolated under `server/src/extensions/transcendiverse/`.

That module is responsible for:

- loading extension config
- mapping approved document snapshots into vault paths
- writing raw approved document snapshots into the vault
- writing a distilled companion markdown note
- intentionally avoiding canonical page mutation in v1

## Config

Add the extension block to the Paperclip instance config:

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

Environment overrides are also supported:

- `PAPERCLIP_TRANSCENDIVERSE_VAULT_SYNC_ENABLED`
- `PAPERCLIP_TRANSCENDIVERSE_VAULT_ROOT`
- `PAPERCLIP_TRANSCENDIVERSE_RAW_IMPORT_DIR`
- `PAPERCLIP_TRANSCENDIVERSE_DISTILLATION_DIR`
- `PAPERCLIP_TRANSCENDIVERSE_AUTO_WRITE_RAW`
- `PAPERCLIP_TRANSCENDIVERSE_AUTO_WRITE_DISTILLATION`
- `PAPERCLIP_TRANSCENDIVERSE_AUTO_MERGE_CANONICAL`

## Upgrade Notes

- Keep new approval consumers attached to `artifact.created` instead of editing approval routes directly.
- Keep mission-specific export logic under `server/src/extensions/` so upstream approval, issue, and document changes are easier to rebase.
- The current approved snapshot flow is document-only: if an issue has no issue documents, no vault-exportable artifact is produced.
- Artifact dedupe is content-based. Re-approving the same frozen revision noops; approving changed content creates the next version.
- Canonical vault page mutation is intentionally out of scope for v1.

## API

Approved artifacts can be queried through:

- `GET /api/companies/:companyId/artifacts`
- `GET /api/artifacts/:id`
- `GET /api/artifacts/:id/content`
