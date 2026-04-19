# Google Drive Context Example

Example connector plugin that syncs configured Google Drive folders into Paperclip project context sources.

It uses `ctx.contextSources` instead of importing any Paperclip server internals. The plugin stores only Drive file metadata and extracted text in project context. OAuth material is read through a configured secret ref and is never written into context bundles.

## Configuration

- `accessTokenSecretRef`: secret ref containing a Google OAuth access token with Drive read access.
- `maxFilesPerFolder`: upper bound per folder sync.
- `folders`: array of `{ companyId, projectId, folderId, title }`.

`folderId` can be either a raw Drive folder ID or a Drive folder URL.

## Sync

The `sync-drive-folders` scheduled job walks configured folders recursively, exports Google Docs/Sheets/Slides to text-friendly formats when possible, and upserts each file as a project context source item.

Unsupported binary files are retained as source items with `unsupported` status so operators can see what was skipped.
