# Agent Artifact Upload Workflow

Generated files that a board user or reviewer should inspect must be attached to
the Paperclip issue before the agent chooses a final disposition. A local
workspace path is not enough, because cloud users and reviewers often cannot
access the agent's disk.

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
`POST /api/companies/{companyId}/issues/{issueId}/artifacts` by default. The
server stores the file as an issue attachment and creates the attachment-backed
artifact work product in the same request.
The command prints issue-safe markdown links for the final task comment.

## Completion Pattern

When a task produces a user-inspectable file:

1. Generate and verify the file locally.
2. Upload it with `skills/paperclip/scripts/paperclip-upload-artifact.sh`.
3. Keep the artifact work product unless the file is incidental; pass
   `--no-work-product` only for supporting files that should not be promoted.
4. Link the printed attachment URL in the final issue comment.
5. Then set the final issue status.

Final comments should name the uploaded artifact, not just the local filesystem
path. Local paths can be included as diagnostic context, but they cannot be the
only access path.

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
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues/$PAPERCLIP_TASK_ID/artifacts" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -F 'file=@"dist/demo.mp4";type=video/mp4' \
  -F 'title=Demo video render' \
  -F 'summary=MP4 render for board review' \
  -F 'status=ready_for_review' \
  -F 'isPrimary=true'
```

The response contains `{ "attachment": ..., "workProduct": ... }`. Use
`POST /api/companies/{companyId}/issues/{issueId}/attachments` only for
supporting files that should not be promoted as issue outputs.
