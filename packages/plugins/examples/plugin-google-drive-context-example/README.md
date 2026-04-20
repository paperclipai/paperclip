# Google Drive Context Example

Example connector plugin that syncs Google Drive documents and folders into Paperclip project context sources.

It uses `ctx.contextSources` instead of importing Paperclip server internals. The plugin stores only Drive file metadata and extracted text in project context. OAuth material is read through a configured Paperclip company secret and is never written into context bundles.

## Local Install

From the repo root:

```bash
pnpm --filter @paperclipai/plugin-google-drive-context-example build
pnpm paperclipai plugin install ./packages/plugins/examples/plugin-google-drive-context-example
```

Then open **Settings -> Integrations -> Plugins -> Google Drive Context (Example)**.

## Credential Secret

Create a company secret in **Company settings -> Integrations -> Company secrets**.

For quick local testing, the secret value can be a raw Google OAuth access token with Drive read access.

For durable local sync, use JSON with refresh-token credentials:

```json
{
  "client_id": "...",
  "client_secret": "...",
  "refresh_token": "..."
}
```

The plugin exchanges refresh-token credentials for an access token at sync time.

## Configuration

Preferred config:

- `googleCredentialSecretRef`: Paperclip company secret ID selected from the secret picker.
- `maxFilesPerTarget`: upper bound per folder target, default `50`.
- `targets`: array of `{ companyId, projectId, urlOrId, title }`.

`urlOrId` can be:

- a Google Doc URL
- a Google Sheet URL
- a Google Slides URL
- a generic Drive file URL
- a Drive folder URL
- a raw Drive file/folder ID

Legacy `accessTokenSecretRef`, `maxFilesPerFolder`, and `folders` config still works for local compatibility.

## Sync And Verify

The `sync-drive-folders` job runs hourly. To verify immediately:

1. Open the plugin **Status** tab.
2. Click **Run now** on the active `sync-drive-folders` job.
3. Open the target project's **Context** tab.
4. Confirm the Google Drive source shows nonzero items/chunks.
5. Use **Search Preview** with a phrase from the document.

Google Docs and Slides are exported as `text/plain`; Google Sheets are exported as `text/csv`; direct text files are downloaded as text. Unsupported binary files are retained as source items with `unsupported` status so operators can see what was skipped.
