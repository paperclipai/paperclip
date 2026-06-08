# Document Feedback for Agents

Use this reference when the board or another agent has left feedback on an issue document (plan, product doc, generated report, etc.) and you have to respond, resolve, or revise it without scraping the UI.

Three kinds of feedback live on an issue document, all queryable through the same review index:

- **Anchored annotation threads** — comments tied to an exact text selection in a specific revision (`/issues/:id/documents/:key/annotations`).
- **Document-level review threads** — overall feedback with no anchor (`/issues/:id/documents/:key/review-comments`).
- **Suggested edits** — insertion / deletion / substitution proposals that, when accepted, create a new document revision (`/issues/:id/documents/:key/suggestions`).

All three are returned by `GET /issues/:id/documents/:key/review-index`. Use it instead of refetching the document or reading rendered HTML.

## When this applies

Trigger this workflow when any of the following is true:

- The wake reason is `issue_commented` and `PAPERCLIP_WAKE_PAYLOAD_JSON` (or the wake comment's `metadata`) contains a `documentKey` and either `annotationThreadId` or `mutation: "document_annotation_comment"`. That is how anchored annotation comments wake the assignee today.
- The latest user comment on the issue references a document, document key, or anchored excerpt.
- You're about to finalize a plan, product doc, or generated report and want to confirm there is no pending review feedback before marking the issue `done`.
- Review threads or suggestions are created via the API by another agent or by board UI — these mutations do **not** emit an automatic wake yet, so check the review index opportunistically when you're already on the issue.

## Wake payload shape (anchored annotation comments)

When the board adds an anchored comment, your assignee is woken with:

- `wakeReason: "issue_commented"`
- payload includes `issueId`, `documentKey`, `annotationThreadId`, `annotationCommentId`, `mutation: "document_annotation_comment"`

Acknowledge the new comment first (per the heartbeat rule), then fetch the specific thread and the review index.

## Fetch the review index

```bash
curl -s \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  "$PAPERCLIP_API_URL/api/issues/$ISSUE_ID/documents/$KEY/review-index?status=open&includeComments=true"
```

Query params:

- `status` — `open` (default) returns open annotation threads, open review threads, and pending suggestions. `all` returns resolved/accepted/rejected too. There is no `resolved`-only filter on this route.
- `includeComments` — boolean. Off by default. Set `true` to inline all comments per thread / suggestion in one round trip; otherwise you'll fetch comments per thread.

Response shape (fields you care about):

```json
{
  "documentId": "…",
  "documentKey": "plan",
  "latestRevisionId": "…",
  "latestRevisionNumber": 7,
  "counts": {
    "unresolved": 3,
    "openAnchoredThreads": 2,
    "openReviewThreads": 1,
    "pendingSuggestions": 0,
    "resolvedAnchoredThreads": 5,
    "resolvedReviewThreads": 2,
    "acceptedSuggestions": 1,
    "rejectedSuggestions": 0,
    "staleAnchors": 1,
    "orphanedAnchors": 0
  },
  "annotationThreads": [ /* with selectedText, anchorState, comments[] */ ],
  "reviewThreads":     [ /* with comments[] */ ],
  "suggestions":       [ /* with kind, selectedText, proposedText, anchorState, comments[] */ ]
}
```

Use `counts.unresolved` as the single check for "is there anything left to do". `staleAnchors` / `orphanedAnchors` mean the underlying text moved or disappeared after a revision — those still need an action from you (reply explaining the move, resolve, or propose a replacement suggestion).

## Anchored annotation threads

Anchored threads are the primary form of board feedback today. Each thread is tied to a specific quote and revision.

**Reply** to an existing thread:

```bash
POST /api/issues/:id/documents/:key/annotations/:threadId/comments
{ "body": "Updated the spec — see revision 8." }
```

**Resolve** (or reopen):

```bash
PATCH /api/issues/:id/documents/:key/annotations/:threadId
{ "status": "resolved" }   # or "open" to reopen
```

**Create** a new anchored thread (e.g., to flag something for the board):

```bash
POST /api/issues/:id/documents/:key/annotations
{
  "baseRevisionId": "…current revision id…",
  "baseRevisionNumber": 7,
  "selector": {
    "quote":   { "exact": "exact text from the doc", "prefix": "…", "suffix": "…" },
    "position": { "normalizedStart": 1234, "normalizedEnd": 1267, "markdownStart": 1290, "markdownEnd": 1323 }
  },
  "body": "Flagging this paragraph for security review."
}
```

`baseRevisionId` and `baseRevisionNumber` must match the latest revision the body was selected from; the server enforces this and remaps anchors on every document update so existing threads survive edits.

## Document-level review threads

Use these when feedback is overall ("this plan needs a rollback section") and there is no exact text to anchor to. The board uses them via the review panel; agents can create them too.

```bash
POST   /api/issues/:id/documents/:key/review-comments
       { "body": "Overall: this needs a rollback section before approval." }

POST   /api/issues/:id/documents/:key/review-comments/:threadId/comments
       { "body": "Added a rollback section in revision 8." }

PATCH  /api/issues/:id/documents/:key/review-comments/:threadId
       { "status": "resolved" }
```

Status values: `open`, `resolved`.

Prefer an anchored thread when you can quote exact text. Reserve review threads for genuinely document-level feedback.

## Suggested edits

A suggestion proposes an exact text change. Three kinds:

| `kind`         | `proposedText`     | `insertionPosition`        | Notes                                                  |
| -------------- | ------------------ | -------------------------- | ------------------------------------------------------ |
| `insertion`    | required, non-empty | optional, `before`/`after` | Inserts at the anchor; `insertionPosition` picks side. |
| `substitution` | required, non-empty | must be `null`             | Replaces the anchored selection with `proposedText`.   |
| `deletion`     | must be `null`/omitted | must be `null`         | Removes the anchored selection.                        |

Create a suggestion:

```bash
POST /api/issues/:id/documents/:key/suggestions
{
  "baseRevisionId": "…",
  "baseRevisionNumber": 7,
  "kind": "substitution",
  "selector": { "quote": {...}, "position": {...} },
  "proposedText": "the replacement text",
  "body": "Optional discussion comment that starts the suggestion thread."
}
```

Discuss a suggestion:

```bash
POST /api/issues/:id/documents/:key/suggestions/:suggestionId/comments
{ "body": "Agreed; this matches the security review." }
```

Reject:

```bash
POST /api/issues/:id/documents/:key/suggestions/:suggestionId/reject
{ "reason": "Conflicts with the SLA we agreed on in PAP-…" }
```

Accept (creates a new document revision):

```bash
POST /api/issues/:id/documents/:key/suggestions/:suggestionId/accept
{ "baseRevisionId": "…latest revision id…", "changeSummary": "Apply CTO substitution suggestion" }
```

Accept rules to remember:

- `baseRevisionId` is the latest revision id at the time of acceptance; mismatch returns `409 Conflict`. Re-fetch the document, recheck the suggestion, and retry.
- Acceptance is treated as a deliverable mutation, so the run must own the issue (normal `assertDeliverableMutationAllowedByRunContext` rule). Don't accept suggestions on issues you don't own.
- The new revision's body is what the server computed from the suggestion's anchor; you do not pass new body text.
- Other pending suggestions and annotation threads are remapped automatically. After acceptance, refetch the review index — some may now be `stale` or `orphaned`.

## Stale and orphaned anchors

After any document edit (including accepting a suggestion or restoring a revision), open threads/suggestions whose anchor no longer matches show up with:

- `anchorState: "stale"` — anchor was relocated but text drifted; treat as actionable, the original feedback may still apply.
- `anchorState: "orphaned"` — anchor text disappeared; the feedback may no longer be relevant.

Don't just ignore these. Either reply explaining the move, resolve them, or propose a fresh suggestion against the new revision. The review-index counters surface them so you can call them out in your summary comment.

## Examples

### Plan document (`key = "plan"`)

1. Wake reason `issue_commented` with `documentKey: "plan"` → fetch `/comments/{commentId}`, then `review-index?status=open&includeComments=true`.
2. For each open annotation/review thread: address the point (edit the plan with `PUT /issues/:id/documents/plan`, then `POST … /comments` referencing the new revision) and `PATCH … status=resolved`.
3. If approval is needed, update the plan document and create a fresh `request_confirmation` interaction targeting the latest plan revision (see the SKILL.md "Planning" section).
4. Leave one summary issue comment that links the plan and lists the feedback you handled — see "Summary comment template" below.

### Product / project document (`key = "product"`, `"prd"`, etc.)

Same flow as plan. When suggestions are involved, prefer accepting them in small batches (so each accept produces a clear revision in history) and re-running the review index between accepts to surface any newly-stale anchors.

### Generated report (`key = "report"`, `"qa-report"`, etc.)

Reports usually take review threads more than anchored threads. After re-generating the report, reply on each open review thread with the new revision number and resolve. If the regeneration changes wording the board commented on, expect anchored threads to flip to `stale` — reply, then resolve.

### Review completion

Paperclip does not have a separate "done reviewing" endpoint. The handoff is the existing issue thread: the board's final comment (often the one that woke you) is the signal. After you've drained the review index:

- Resolve every thread you handled.
- Leave exactly one issue comment that links each resolved thread/suggestion and names the next action.
- Move the issue to the right disposition (`done`, or back to `in_review` with a real reviewer path — for plans, that means a `request_confirmation` against the latest revision).

If the board explicitly asks for another review pass, keep the issue in `in_review` and rely on the next `issue_commented` wake to resume.

## Summary comment template

When you finish handling feedback, post a single comment on the issue. Link the document deep-link and any resolved threads using the deep-link convention.

```md
## Document feedback resolved

Handled [plan](/PAP/issues/PAP-10525#document-plan) review feedback.

- Resolved 2 anchored threads (rollback paragraph, naming nit)
- Accepted 1 substitution suggestion → revision 8
- Reopened 1 thread: needs CTO sign-off on the rollback wording

Remaining: CTO confirmation on revision 8 — pending `request_confirmation` linked above.
```

Rules:

- Always include the document deep-link `/<prefix>/issues/<identifier>#document-<key>`.
- Count what you resolved, accepted, rejected, and what is still pending — match the `counts` from the review index after your changes.
- Don't post per-thread comments on the issue; reply on the thread itself and summarize at the end.

## Wake-and-resume contract

- Anchored annotation comments → `issue_commented` wake with `documentKey` + `annotationThreadId` payload. Resume here.
- Review threads and suggestions today do **not** auto-wake. If you're depending on a board reply to one, leave the issue in `in_review` with a clear reviewer/interaction path; do not poll. The board's eventual reply on the issue (or on the linked `issueCommentId`) wakes you.
- For plan approval, use a `request_confirmation` interaction bound to the latest plan revision — that is the real resume path, not a free-text "please review" comment.

## Common mistakes

- Re-reading the document body to "guess" what comments mean instead of calling `review-index`.
- Replying with a fresh issue comment for each annotation thread (noise). Reply on the thread; summarize on the issue.
- Accepting a suggestion against a stale `baseRevisionId` and retrying without refetching — you'll loop on 409.
- Closing the issue while `counts.unresolved > 0` for a document the board reviewed. Handle or explicitly defer each thread.
- Posting `@AgentName` in a thread comment expecting a wake. Anchored thread replies wake the issue assignee, not arbitrary `@`-mentioned agents.
