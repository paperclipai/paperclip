# Generated Artifacts and Work Products

When work produces a user-inspectable file, upload true deliverables to the current issue before final disposition. Local filesystem paths are not enough because board users, reviewers, and cloud operators may not have access to the agent workspace.

Use the helper bundled with this skill. From an installed `paperclip` skill directory, the helper lives at `scripts/paperclip-upload-artifact.sh`:

```bash
scripts/paperclip-upload-artifact.sh path/to/output.webm \
  --title "Walkthrough render" \
  --summary "Rendered walkthrough for review"
```

The helper uses `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_TASK_ID`, and `PAPERCLIP_RUN_ID`. It uploads the file as an issue attachment, creates an attachment-backed artifact work product by default, and prints issue-safe markdown links for your final comment.

## Workspace-Only File References

Use a workspace-only reference only when the file should stay in the project or
execution workspace, such as a source file, committed report, generated index,
or other file whose value is tied to the checkout. This is not a substitute for
uploading a deliverable file that a board user should be able to inspect outside
the workspace.

Annotate the work product with `metadata.resourceRef`:

```json
{
  "type": "document",
  "provider": "workspace",
  "title": "Regression test plan",
  "status": "ready_for_review",
  "reviewState": "needs_board_review",
  "summary": "Markdown plan committed in the execution workspace.",
  "metadata": {
    "resourceRef": {
      "kind": "workspace_file",
      "issueId": "<issue-id>",
      "workspaceKind": "execution_workspace",
      "workspaceId": "<execution-workspace-id>",
      "relativePath": "doc/plans/regression-test-plan.md",
      "line": 1,
      "displayPath": "doc/plans/regression-test-plan.md"
    }
  }
}
```

`workspaceKind` is `execution_workspace` for the current issue checkout or
`project_workspace` for a shared project workspace. `line` and `column` are
optional positive integers. `relativePath` must be relative to the selected
workspace root; do not use host-local absolute paths in `resourceRef`.

Create the work product with:

```bash
curl -sS -X POST \
  "$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID/work-products" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  --data-binary @workspace-file-work-product.json
```

If the helper is unavailable, use the Paperclip API directly:

```bash
curl -sS -X POST \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues/$PAPERCLIP_TASK_ID/attachments" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -F 'file=@"path/to/output.webm";type=video/webm'
```

Then create a work product when the file is the deliverable. The server canonicalizes attachment-backed artifact metadata from the `attachmentId`:

```bash
curl -sS -X POST \
  "$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID/work-products" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  --data-binary '{
    "type": "artifact",
    "provider": "paperclip",
    "title": "Walkthrough render",
    "status": "ready_for_review",
    "reviewState": "needs_board_review",
    "isPrimary": true,
    "metadata": { "attachmentId": "<uploaded-attachment-id>" }
  }'
```

In your final issue comment, link the uploaded attachment or work product and
describe what it contains. If the output is workspace-only, name the work
product and the relative path that was recorded in `metadata.resourceRef`.
Browse/search is the fallback for recovering a workspace file when the issue
chip or link cannot open it; it is not the preferred deliverable path. Do not
leave artifact-producing work `in_progress` with only a local path or a
`Remaining` note.

When the current run was started by an external chat request and the file is
part of the response intended for that external conversation, have the upload
helper bind that specific file to an explicit response comment:

```bash
scripts/paperclip-upload-artifact.sh path/to/result.png \
  --title "Requested image" \
  --chat-comment "Here is the requested image."
```

`--chat-comment` uses the current run-scoped API directly, so it does not depend
on a separately installed CLI version. It first uploads the file and creates
the same-run artifact work product, then binds that exact attachment to the
comment. Concurrent matching invocations on one host serialize by API, company,
task, run, filename, content hash, and media type. On retry, the helper reuses
the server's immutable same-run attachment record instead of uploading a second
copy. A retry from a different host is still subject to server-side attachment
admission and should not be run concurrently.

If the upload connection ends without an HTTP response, the helper records that
ambiguous outcome locally. The same command polls briefly for Paperclip's
immutable attachment record and otherwise stops instead of blindly creating a
duplicate. Retry later. Use `--retry-unknown-upload` only after establishing
that the first upload did not commit; this explicit override accepts the risk of
creating a duplicate file.

The binding is durable Paperclip state, but it is not proof of external
delivery—or even proof that the current run has an active external-chat origin.
For an authorized active chat-origin run, Paperclip keeps this selection
internal until it selects the run's final response, then attempts the provider
publication. The final assistant response may use different prose from
`--chat-comment`.

Treat the helper's exit status as confirmation that the Paperclip attachment,
work product, and requested comment binding were saved. Use neutral final prose
such as “I prepared the requested image.” Do not claim the file is shown above,
attached, queued, or delivered. If the bind step fails after upload, say that
the artifact was saved to the Paperclip task but was **not** bound to the
response comment; never also claim that it appears above or is attached.

Do not infer sharing intent from other files on the task or bind every
attachment from a run. Only the file passed with `--chat-comment` is eligible
for external publication; unbound artifacts remain Paperclip-only.
