---
name: buffer-queue-draft
description: Push a drafted Instagram caption + image into the Buffer queue for a Bobby Tours site, scheduled for a specific time. Uses Buffer's GraphQL API. Tokens loaded from /root/.newpaperclip/instances/default/bobby-tours.env.
---

# Buffer Queue Draft

## Token / config

Load from `/root/.newpaperclip/instances/default/bobby-tours.env`:
- `BUFFER_ACCESS_TOKEN` — GraphQL auth
- `BUFFER_GRAPHQL_URL` — API endpoint
- `BUFFER_ORG_ID` — org
- `BUFFER_CHANNEL_BOBBY`, `BUFFER_CHANNEL_SAFARIS`, `BUFFER_CHANNEL_MAGICAL`, `BUFFER_CHANNEL_KILI` — 4 known channel IDs

```bash
source /root/.newpaperclip/instances/default/bobby-tours.env
```

## Procedure (per post)

1. **Determine channel** based on site slug:
   ```bash
   case "$SITE_SLUG" in
     bobby-safaris) CHANNEL="$BUFFER_CHANNEL_BOBBY" ;;
     safaris-tanzania) CHANNEL="$BUFFER_CHANNEL_SAFARIS" ;;
     magical-tanzania) CHANNEL="$BUFFER_CHANNEL_MAGICAL" ;;
     safari-kilimanjaro|mount-kilimanjaro-climb) CHANNEL="$BUFFER_CHANNEL_KILI" ;;
     *) echo "Unknown site: $SITE_SLUG"; exit 1 ;;
   esac
   ```
   **Note**: safari-kilimanjaro + mount-kilimanjaro-climb both map to `BUFFER_CHANNEL_KILI` — only one IG account exists for both. If separate needed, escalate to operator.

2. **Prepare the image** — upload to a public URL Buffer can fetch:
   - Option A: copy to `/srv/newpaperclip/bobby-tours/<repo>/public/<path>` and reference `https://<domain>/<path>` after deploy (requires fresh build)
   - Option B: use existing public site image URL
   
   Simplest: use Option B — reference an existing public image on the live site.

3. **Construct GraphQL mutation**:

   The `CreatePostInput` requires:
   - `schedulingType`: `"automatic"` (enum: `automatic` | `notification`)
   - `channelId`: channel ID string (NON_NULL)
   - `mode`: queue mode (NON_NULL, enum: `addToQueue` | `shareNow` | `shareNext` | `customScheduled` | `recommendedTime`)
   - `text`: caption string
   - `assets.images[]`: `[{url: "https://..."}]`
   - `metadata.instagram.type`: `"post"` | `"reel"` | `"story"` (NON_NULL)
   - `metadata.instagram.shouldShareToFeed`: `true` (NON_NULL)
   - `saveToDraft`: `true` (for draft mode)
   
   **Important**: `dueAt` cannot be used with `mode: "addToQueue"` — use `mode: "customScheduled"` if you need a specific time.

   ```bash
   CAPTION_JSON=$(echo "$CAPTION" | jq -sRc .)
   IMG_URL="https://<domain>/<path-to-image>"
   
   curl -sS -X POST "$BUFFER_GRAPHQL_URL" \
     -H "Authorization: Bearer $BUFFER_ACCESS_TOKEN" \
     -H "Content-Type: application/json" \
     -d @- <<EOF
   {
     "query": "mutation CreatePost(\$input: CreatePostInput!) { createPost(input: \$input) { ... on PostActionSuccess { post { id status dueAt text } } ... on InvalidInputError { message } ... on UnexpectedError { message } } }",
     "variables": {
       "input": {
         "schedulingType": "automatic",
         "channelId": "$CHANNEL",
         "text": $CAPTION_JSON,
         "assets": {"images": [{"url": "$IMG_URL"}]},
         "metadata": {"instagram": {"type": "post", "shouldShareToFeed": true}},
         "mode": "addToQueue",
         "saveToDraft": true
       }
     }
   }
   EOF
   ```

4. **Capture response + post ID:**
   ```bash
   RESP=$(... curl above ...)
   TYPE=$(echo "$RESP" | jq -r '.data.createPost.__typename')
   if [ "$TYPE" = "PostActionSuccess" ]; then
     POST_ID=$(echo "$RESP" | jq -r '.data.createPost.post.id')
     echo "Buffer draft created: $POST_ID"
   else
     MSG=$(echo "$RESP" | jq -r '.data.createPost.message // "unknown error"')
     echo "FAIL ($TYPE): $MSG" >&2
     exit 1
   fi
   ```

5. **Log to ticket comment**:

   ```
   ## Buffer post queued — <site>
   
   **Channel**: BUFFER_CHANNEL_<XXX>
   **Scheduled**: 2026-04-23T10:00:00+03:00 (Thu 10am EAT)
   **Caption**: [first 80 chars]...
   **Image**: https://<domain>/<path>
   **Buffer post ID**: abc123xyz
   **Edit/cancel**: https://publish.buffer.com/ (log in with org admin)
   ```

## Draft-only mode (MVP — recommended)

Instead of `"status": "scheduled"`, use `"status": "draft"`:
- Agent drafts caption + queues as DRAFT in Buffer
- Operator reviews in Buffer UI + approves / schedules manually
- Shifts to `"status": "scheduled"` once agent output is trusted

Enabled for first 2-4 weeks per site. Flip to auto-schedule after quality check.

## Error handling

- **401 Unauthorized** — BUFFER_ACCESS_TOKEN expired. Regenerate in Buffer dashboard + update bobby-tours.env.
- **`InvalidInputError`** — check `.message` field. Common cause: `dueAt` + `addToQueue` conflict, missing `metadata.instagram.type`, missing `metadata.instagram.shouldShareToFeed`.
- **`UnexpectedError`** — check `.message` field. Common cause: Instagram post without image/video, Instagram post without `metadata.instagram.type`.
- **Rate limit** — Buffer allows ~1 req/sec. Space out.
- **Image fetch fail** — Buffer couldn't fetch the `media.url`. Verify URL is publicly accessible (not behind basic auth).

## Verified schema (2026-04-23)

Buffer's GraphQL `CreatePostInput` requires these fields for Instagram posts:
- `schedulingType: "automatic"`
- `channelId: "<channel_id>"` (NON_NULL)
- `mode: "addToQueue"` (NON_NULL)
- `assets.images: [{url: "<public-url>"}]`
- `metadata.instagram.type: "post" | "reel" | "story"` (NON_NULL)
- `metadata.instagram.shouldShareToFeed: true` (NON_NULL)
- `saveToDraft: true` (for draft mode)

## Related skills

- `instagram-caption-writer` — generates the caption + hashtag block
- `site-voice-<slug>` — voice rules

## Budget

$0.02–0.05 per call.
