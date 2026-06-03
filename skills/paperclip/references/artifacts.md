# Generated Artifacts and Work Products

When work produces a user-inspectable file, upload it to the current issue before final disposition. Local filesystem paths are not enough because board users, reviewers, and cloud operators may not have access to the agent workspace.

Use the helper bundled with this skill. From an installed `paperclip` skill directory, the helper lives at `scripts/paperclip-upload-artifact.sh`:

```bash
scripts/paperclip-upload-artifact.sh path/to/output.webm \
  --title "Walkthrough render" \
  --summary "Rendered walkthrough for review"
```

The helper uses `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_TASK_ID`, and `PAPERCLIP_RUN_ID`. It uploads the file as an issue artifact, which stores an issue attachment and creates an attachment-backed artifact work product by default, then prints issue-safe markdown links for your final comment.

If the helper is unavailable, use the Paperclip API directly:

```bash
curl -sS -X POST \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues/$PAPERCLIP_TASK_ID/artifacts" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -F 'file=@"path/to/output.webm";type=video/webm' \
  -F 'title=Walkthrough render' \
  -F 'summary=Rendered walkthrough for review' \
  -F 'status=ready_for_review' \
  -F 'isPrimary=true'
```

The response contains `{ "attachment": ..., "workProduct": ... }`. Use the
attachment-only upload route only for supporting files that should not be
promoted as issue outputs. In your final issue comment, link the uploaded
attachment or work product and describe what it contains. Do not leave
artifact-producing work `in_progress` with only a local path or a `Remaining`
note.
