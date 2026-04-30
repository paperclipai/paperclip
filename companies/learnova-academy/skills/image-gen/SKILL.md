---
name: image-gen
description: >
  Chief Content's image generation sub-skill — takes a text prompt and returns a
  stable Cloudflare R2 image URL. FLUX 1.1 Pro (OpenRouter) primary; GPT-image-1
  (OpenAI) fallback. Use when a blog post or course chapter needs a hero or
  inline image. Skill, not an agent — called inline by chief-content.
  Supports frontmatter-wired mode: pass draft_path to auto-detect sentinels,
  generate images, and rewrite the draft's frontmatter in place.
---

# Image Gen

You generate one image per call (standalone mode) or process all image slots in a
draft in one pass (frontmatter-wired mode). You do not write copy or edit prompts
beyond the sanitization step below.

## Inputs

| Field | Type | Default | Notes |
|---|---|---|---|
| `prompt` | string | required in standalone mode | Describe the image in plain English. Max 1000 chars. |
| `aspect` | `16:9` \| `1:1` \| `3:2` | `16:9` | Used to set width/height. |
| `quality` | `standard` \| `hd` | `standard` | `hd` uses FLUX 1.1 Pro Ultra or DALL-E HD; costs ~2×. |
| `draft_path` | string | optional | Absolute path to a draft.md. Activates frontmatter-wired mode. |

When `draft_path` is provided, `prompt` may be omitted — the skill derives prompts
from the draft's title and frontmatter sentinels.

## Sentinels

A sentinel is a placeholder value in draft frontmatter that signals "generate this image":

- `hero_image: auto:flux` — generate the hero image using FLUX 1.1 Pro.
- `hero_image:` absent entirely — treat as `auto:flux`; generate and inject.
- `inline_images[N].url: auto:flux` — generate that inline image (optional; skip if time-constrained).

The sentinel string `auto:flux` may later support other suffixes (`auto:dall-e`),
but for now all sentinels route through the FLUX 1.1 Pro → GPT-image-1 fallback chain.

## Mode A — Standalone (no draft_path)

Proceed directly from Step 1 (Validate inputs) through Step 7.

## Mode B — Frontmatter-wired (draft_path provided)

### B-0. Read and parse draft frontmatter

```bash
# Extract the YAML frontmatter block between the first pair of `---` lines
DRAFT_PATH="$draft_path"
FRONTMATTER=$(awk '/^---/{n++; if(n==2)exit; next} n==1' "$DRAFT_PATH")
TITLE=$(echo "$FRONTMATTER" | grep '^title:' | sed 's/^title: *//' | tr -d '"')
```

### B-1. Detect hero sentinel

```bash
HERO_LINE=$(echo "$FRONTMATTER" | grep '^hero_image:')
if echo "$HERO_LINE" | grep -q 'auto:flux' || [ -z "$HERO_LINE" ]; then
  HERO_NEEDED=true
else
  HERO_NEEDED=false
fi
```

If `HERO_NEEDED=true`, build the hero prompt from the title:

```
HERO_PROMPT="clean editorial illustration, ${TITLE}, muted teal and amber palette, no text, no logos, 16:9, WebP"
```

Cap at 150 characters. Truncate the title portion if needed.

### B-2. Detect inline sentinels (optional)

```bash
# Each inline entry with url: auto:flux is a candidate
INLINE_SENTINELS=$(echo "$FRONTMATTER" | grep -n 'url: auto:flux')
```

Process at most 2 inline sentinels per call. Skip if budget is tight (>$0.08 used).

For each inline sentinel, derive a prompt from the `after_heading` field above it:

```
INLINE_PROMPT="editorial illustration, [after_heading value], muted teal and amber palette, no text, 3:2, WebP"
```

### B-3. Generate images

For each slot flagged (hero first, then inlines), run Steps 1–6 below (standard
generation + upload). Track results in a lookup table:

```
SLOT=hero   | ASPECT=16:9 | IMAGE_URL=https://... | ALT=... | PROMPT=...
SLOT=inline_0 | ASPECT=3:2 | IMAGE_URL=https://... | ALT=... | PROMPT=...
```

### B-4. Rewrite frontmatter

After all generations succeed, rewrite the draft's frontmatter in place using Python
(avoids shell YAML quoting pitfalls):

```bash
python3 - <<'PYEOF'
import re, sys

draft_path = "$DRAFT_PATH"
with open(draft_path, 'r') as f:
    content = f.read()

# Split into frontmatter + body
fm_match = re.match(r'^---\n(.*?)\n---\n', content, re.DOTALL)
if not fm_match:
    sys.exit("No frontmatter found")

fm_text = fm_match.group(1)
body    = content[fm_match.end():]

# Replace hero sentinel or inject new hero_image block
hero_block = """hero_image:
  url: "$HERO_URL"
  alt: "$HERO_ALT"
  prompt: "$HERO_PROMPT_ESCAPED"
"""

if re.search(r'^hero_image:\s*auto:flux', fm_text, re.MULTILINE):
    fm_text = re.sub(r'^hero_image:\s*auto:flux\s*$', hero_block.rstrip('\n'), fm_text, flags=re.MULTILINE)
elif not re.search(r'^hero_image:', fm_text, re.MULTILINE):
    # Inject after the last frontmatter field before closing ---
    fm_text = fm_text.rstrip('\n') + '\n' + hero_block.rstrip('\n')

# Replace inline sentinels if any were processed
# (repeat pattern for each inline slot)

new_content = '---\n' + fm_text + '\n---\n' + body
with open(draft_path, 'w') as f:
    f.write(new_content)

print("Frontmatter rewritten successfully")
PYEOF
```

Verify the file was written:

```bash
grep -A3 'hero_image:' "$DRAFT_PATH" | head -6
```

---

## Step 1 — Validate inputs (both modes)

- `prompt` non-empty and ≤1000 chars (or derived from draft)?
- `aspect` is one of the allowed values?

If not → BLOCK immediately, ask ticket to clarify.

## Step 2 — Resolve dimensions

| Aspect | Width | Height |
|---|---|---|
| 16:9 | 1344 | 768 |
| 1:1 | 1024 | 1024 |
| 3:2 | 1216 | 832 |

## Step 3 — Try FLUX 1.1 Pro via OpenRouter (primary)

```bash
IMAGE_B64=$(curl -s -X POST "https://openrouter.ai/api/v1/images/generations" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"black-forest-labs/flux-1.1-pro\",
    \"prompt\": \"$PROMPT\",
    \"width\": $WIDTH,
    \"height\": $HEIGHT,
    \"num_inference_steps\": 28,
    \"response_format\": \"b64_json\"
  }" | jq -r '.data[0].b64_json')
```

If `$IMAGE_B64` is empty or `null` → log failure, fall through to Step 4.

For `quality=hd`, use model `black-forest-labs/flux-1.1-pro-ultra` instead.

## Step 4 — GPT-image-1 fallback (OpenAI)

```bash
IMAGE_B64=$(curl -s -X POST "https://api.openai.com/v1/images/generations" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"gpt-image-1\",
    \"prompt\": \"$PROMPT\",
    \"size\": \"${WIDTH}x${HEIGHT}\",
    \"quality\": \"$QUALITY\",
    \"response_format\": \"b64_json\"
  }" | jq -r '.data[0].b64_json')
```

If still empty → BLOCK; escalate to chief-content.

## Step 5 — Decode and upload to Cloudflare R2

```bash
SLUG=$(echo "$PROMPT" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | cut -c1-40)
FILENAME="images/$(date +%Y-%m-%d)-${SLUG}.webp"

# Decode base64 → PNG, convert to WebP
echo "$IMAGE_B64" | base64 --decode > /tmp/raw.png
ffmpeg -i /tmp/raw.png -c:v libwebp -quality 85 /tmp/output.webp -y -loglevel error

# Upload via rclone (assumes rclone remote "r2" configured from CLOUDFLARE_R2_* env)
rclone copyto /tmp/output.webp "r2:${CLOUDFLARE_R2_BUCKET}/${FILENAME}" \
  --s3-endpoint "$CLOUDFLARE_R2_ENDPOINT"

IMAGE_URL="${CLOUDFLARE_R2_ENDPOINT}/${CLOUDFLARE_R2_BUCKET}/${FILENAME}"
```

> **Fallback if rclone unavailable**: use `curl` to PUT directly to R2 presigned URL (see `scripts/r2-upload.sh` when it exists).

## Step 6 — Verify accessibility

```bash
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$IMAGE_URL")
```

If `HTTP_STATUS != 200` → BLOCK; report upload failure.

## Step 7 — Write sidecar + reply on ticket

```json
{
  "tool": "flux-1.1-pro" | "gpt-image-1",
  "prompt_chars": 142,
  "aspect": "16:9",
  "width": 1344,
  "height": 768,
  "quality": "standard",
  "image_url": "https://...",
  "produced_at": "2026-04-30T15:45:00Z",
  "cost_estimate_usd": 0.04
}
```

Comment on Paperclip ticket:
```
✅ image-gen · 16:9 · flux-1.1-pro
- URL: https://...
- Dims: 1344×768, WebP 85q
- Prompt: "<first 80 chars>…"
- Cost est: $0.04
```

In frontmatter-wired mode, additionally confirm:
```
✅ frontmatter rewritten: hero_image set in <draft_path>
```

Return `IMAGE_URL` to the caller (chief-content) in standalone mode.

## Cost guide

| Model | Per image (standard 1MP) |
|---|---|
| FLUX 1.1 Pro (OpenRouter) | ~$0.04 |
| FLUX 1.1 Pro Ultra (hd) | ~$0.06 |
| GPT-image-1 standard | ~$0.04–0.08 |
| GPT-image-1 hd | ~$0.08–0.16 |

Keep `quality=standard` for blog heroes. Use `hd` only for course landing page covers.

## Notes

- No ElevenLabs. Not relevant here, but hard rule throughout.
- Never log the full prompt to git or vault (may contain personal data). Log first 80 chars + char count.
- Always convert to WebP before upload — halves file size vs PNG/JPEG at same quality.
- Per-task cap for this skill is $0.20 (5 standard images max per ticket). Escalate if more needed.
- In frontmatter-wired mode the YAML rewrite must be idempotent — running twice must not corrupt the file.

## Escalation

- Both FLUX and GPT-image-1 fail → ping chief-content; do not generate placeholder.
- R2 upload fails → report in ticket comment; try once more; then escalate.
- Image quality below threshold (blurry, wrong subject, text hallucinations) → regenerate once with revised prompt; if still poor, escalate.
- Frontmatter parse error → BLOCK; do not overwrite the draft; escalate to chief-content.
