# Agent Artifact Upload Workflow

Generated files that a board user or reviewer should inspect as deliverables
must be attached to the Paperclip issue before the agent chooses a final
disposition. A local workspace path is not enough, because cloud users and
reviewers often cannot access the agent's disk.

Use the helper bundled with the Paperclip skill from the repo root:

```sh
skills/paperclip/scripts/paperclip-upload-artifact.sh path/to/output.webm \
  --title "Walkthrough render" \
  --summary "Rendered walkthrough for review"
```

The helper uses the authenticated Paperclip API from the current heartbeat
environment:

- `PAPERCLIP_API_URL`
- `PAPERCLIP_API_KEY`
- `PAPERCLIP_COMPANY_ID`
- `PAPERCLIP_TASK_ID`
- `PAPERCLIP_RUN_ID`

It uploads the file to
`POST /api/companies/{companyId}/issues/{issueId}/attachments` and creates an
artifact work product on `POST /api/issues/{issueId}/work-products` by default.
The command prints issue-safe markdown links for the final task comment.

## Uploaded Artifacts vs Workspace Files

Use uploaded artifacts for deliverables: videos, PDFs, screenshots, archives,
reports, rendered HTML, or any file the board should inspect without needing the
agent's checkout. Attachment-backed artifact work products set `type` to
`artifact` and `provider` to `paperclip`, with metadata canonicalized from the
uploaded `attachmentId`.

Use `workspace_file` metadata only for important files that intentionally remain
in a project or execution workspace, such as source files, committed markdown
plans, or generated files whose meaning depends on the checkout. Workspace-only
references are useful signposts, but they are not durable uploads.

Expected work product metadata shape:

```json
{
  "resourceRef": {
    "kind": "workspace_file",
    "issueId": "<issue-id>",
    "workspaceKind": "execution_workspace",
    "workspaceId": "<execution-workspace-id>",
    "relativePath": "doc/plans/example.md",
    "line": 1,
    "column": 1,
    "displayPath": "doc/plans/example.md:1:1"
  }
}
```

`workspaceKind` is `execution_workspace` or `project_workspace`. `line` and
`column` are optional. `relativePath` must be relative to that workspace root;
do not store host-local absolute paths as workspace references.

Workspace file links resolve only inside registered Paperclip workspaces. The
default target is the current issue's execution workspace first, then its
project workspace. A link may target another same-company project workspace only
when it carries both that `projectId` and `workspaceId`. Paperclip does not
resolve arbitrary machine-wide filesystem paths, absolute host paths, home
paths, or relative paths that escape the selected workspace.

## Completion Pattern

When a task produces a user-inspectable deliverable file:

1. Generate and verify the file locally.
2. Upload it with `skills/paperclip/scripts/paperclip-upload-artifact.sh`.
3. Keep the artifact work product unless the file is incidental; pass
   `--no-work-product` only for supporting files that should not be promoted.
4. Link the printed attachment URL in the final issue comment.
5. Then set the final issue status.

Final comments should name and link the uploaded artifact or work product, not
just the local filesystem path. For workspace-only files, include the work
product title and recorded relative path. Local paths can be included as
diagnostic context, but they cannot be the only access path. Browse/search is a
fallback for recovering workspace files when the issue link or chip is not
available, not the preferred way to deliver files to users.

## Video Examples

Upload an `.mp4` render:

```sh
skills/paperclip/scripts/paperclip-upload-artifact.sh dist/demo.mp4 \
  --title "Demo video render" \
  --summary "MP4 render for board review"
```

Upload a `.webm` render:

```sh
skills/paperclip/scripts/paperclip-upload-artifact.sh out/walkthrough.webm \
  --title "Walkthrough video" \
  --summary "WebM walkthrough render"
```

The helper detects `.mp4`, `.webm`, and `.mov` content types. If a renderer uses
an unusual extension, pass the MIME type explicitly:

```sh
skills/paperclip/scripts/paperclip-upload-artifact.sh render.bin \
  --title "Demo video render" \
  --content-type video/mp4
```

## Direct API Pattern

If the helper is unavailable, use the same API shape:

```sh
curl -sS -X POST \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues/$PAPERCLIP_TASK_ID/attachments" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -F 'file=@"dist/demo.mp4";type=video/mp4'
```

Then create a work product when the uploaded file is the deliverable:

```sh
curl -sS -X POST \
  "$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID/work-products" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  --data-binary @artifact-work-product.json
```

Use `type: "artifact"`, `provider: "paperclip"`, and metadata containing the
uploaded `attachmentId`. The server canonicalizes `contentType`, `byteSize`,
`contentPath`, `openPath`, `downloadPath`, and `originalFilename`.
