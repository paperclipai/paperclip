---
name: issue-attachments
description: >
  List and download issue attachments (images, logs, exports) via the Paperclip API,
  then reason over file contents. Use when comments mention screenshots, the board
  used the paperclip attach control without inline markdown, or thread text alone is
  insufficient. Complements the core paperclip skill (checkout, comments, documents).
---

# Issue attachments

Issue **attachments** are files stored on the issue (optionally linked to a comment). They are **not** the same as **issue documents** (`plan`, etc.) — use `GET /api/issues/{issueId}/documents` for those.

Heartbeat and local adapters pass **text** prompts only; they do not auto-load image pixels into the model. To use visual context you must **fetch** attachment bytes (for example with `curl`) into the workspace and then inspect them with whatever your runtime supports (image-aware tools, manual review, or describing after opening locally).

## Trigger

Use this skill when:

- The issue or comment says “see attached”, “screenshot”, “diagram”, or similar.
- You were @-mentioned but the comment body has **no** `![](...)` — the board may have used **Attach image** (paperclip) only; still **list attachments**.
- Markdown in the thread contains `/api/attachments/...` — resolve it with `PAPERCLIP_API_URL` and download if you need the file.
- You need logs, exports, or non-text binaries tied to the issue.

## Preconditions

- `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, and `PAPERCLIP_RUN_ID` as documented in the **paperclip** skill.
- Resolve `issueId` from `PAPERCLIP_TASK_ID` when set, otherwise from the issue you are working on.
- For mutating calls elsewhere, send `X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID`. Read-only GETs below need **Authorization only**.

## Step 1 — List attachments

```bash
curl -sS "$PAPERCLIP_API_URL/api/issues/$ISSUE_ID/attachments" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

Typical attachment object fields:

- `id` — attachment id (use for download path)
- `originalFilename`, `contentType`, `byteSize`, `sha256`
- `issueCommentId` — set when the upload was tied to a comment (may be null for issue-level uploads)
- `contentPath` — **relative** path, always **`/api/attachments/{id}/content`** for issue attachments

Example shape:

```json
{
  "id": "8f2c…",
  "issueId": "…",
  "issueCommentId": null,
  "originalFilename": "error.png",
  "contentType": "image/png",
  "byteSize": 45632,
  "contentPath": "/api/attachments/8f2c…/content"
}
```

## Step 2 — Download binary or text

Use the **`id`** from the list (or parse `contentPath`). Do **not** use `/api/assets/...` for issue attachments — that is a **different** API surface.

```bash
ATTACHMENT_ID="<id from list>"
curl -sS "$PAPERCLIP_API_URL/api/attachments/$ATTACHMENT_ID/content" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -o "./attachment-$ATTACHMENT_ID.bin"
```

For small text-like files you can omit `-o` and pipe to a pager, or use `-o` and `head`/`less`.

Then:

- **Images** — open or analyze with an image-capable workflow; state concrete observations (exact error strings, UI labels, layout).
- **Text / logs** — search for errors, timestamps, stack traces; quote short relevant spans in your issue comment.
- **Large files** — sample or summarize; do not dump entire binaries into comments.

## Step 3 — Correlate with the thread

1. If `PAPERCLIP_WAKE_COMMENT_ID` is set, fetch that comment (`GET /api/issues/{issueId}/comments/{commentId}`) and see if the body includes markdown images.
2. If the body has `![alt](/api/attachments/.../content)`, treat it as a hint to download that attachment id.
3. If the body has **no** image markdown but attachments exist, prefer the **most recent** attachment(s) matching the comment’s `createdAt` window when `issueCommentId` matches; otherwise list all and ask in a comment only if still ambiguous.

## Step 4 — Reference in your comment

Prefer **human-meaningful** summaries over “I saw the image”:

```markdown
## Attachment review

Downloaded `error.png` (attachment `8f2c…`). The modal shows **401 Unauthorized** on
`POST /api/session` at 14:32 UTC.

Next: trace auth middleware for that route.
```

## Limitations

- No server-side OCR or automatic vision injection in heartbeat (V1).
- PDFs, archives, and video need explicit tooling; not unpacked automatically.
- `contentPath` is relative — always prefix with `$PAPERCLIP_API_URL`.

## Related

- Core API workflow, checkout, comments, documents: **paperclip** skill (`/api/skills/paperclip`).
- Deeper endpoint list: `skills/paperclip/references/api-reference.md` if present in your tree.

## Installing this skill in the repo

Shipped under `skills/issue-attachments/SKILL.md`. Runtime fetch: `GET /api/skills/issue-attachments` (board or agent per server auth rules). Symlink or copy into the agent’s skills home if your adapter discovers skills from disk.
