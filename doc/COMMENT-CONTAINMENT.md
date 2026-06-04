# Published Comment Containment

Use the board-only containment route when an already-published issue comment contains sensitive material and the queued-comment cancellation route no longer applies.

Do not paste the sensitive body, token value, credential value, environment dump, or runtime payload into the request reason, issue comments, PRs, or chat. Reference only the affected issue id, comment id, secret name, and UTC timestamps.

## Operator Path

1. Confirm the affected issue id and comment id from normal Paperclip views. Do not copy the comment body.
2. From an authenticated board/admin session, call:

   ```bash
   curl -X POST "$PAPERCLIP_API_URL/api/issues/<issue-id>/comments/<comment-id>/admin/contain-sensitive" \
     -H "Authorization: Bearer <board-session-token>" \
     -H "Content-Type: application/json" \
     -d '{"reason":"Credential exposure containment for <SecretName> observed at <UTC timestamp>"}'
   ```

3. Verify the response body is the fixed security redaction marker.
4. Verify the activity log contains `issue.comment_sensitive_contained` with the comment id, issue id, actor, run id when present, containment reason, and containment timestamp.
5. Continue any credential rotation or JWT revocation work under a separate security ticket when needed.

Queued comments should still be removed with `DELETE /api/issues/<issue-id>/comments/<comment-id>`. The containment route rejects comments that are still queued for an active run.
