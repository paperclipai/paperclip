---
name: image-gen
description: >
  Chief Content's image generation sub-skill. Generates one image (standalone
  mode) or resolves every `auto:*` sentinel in a draft's frontmatter
  (frontmatter-wired mode), uploads to Cloudflare R2, and rewrites the draft
  atomically. Locked ladder (verified 2026-05-01 against `https://openrouter.ai/api/v1/models`):
  primary `google/gemini-3.1-flash-image-preview` (Nano Banana 2), fallback
  `openai/gpt-5.4-image-2`. Skill, not an agent — called inline by chief-content
  or the `image-gen-on-pass` auto-trigger. xAI/Grok image models are OUT
  (researcher-tier only). No DALL-E, no FLUX (none currently expose image-output
  on OpenRouter as of 2026-05-01).
---

# Image Gen

Generates one image per call (standalone mode) or processes every image slot in
a draft in one pass (frontmatter-wired mode). Does not edit copy. Does not
invent prompts beyond the sanitization step.

## REQUIRED ENVIRONMENT

| Var | Why | Failure mode if missing |
|---|---|---|
| `OPENROUTER_API_KEY` | Auth for OpenRouter chat-completions | Skill exits with `blocked: OPENROUTER_API_KEY not configured`. **Never** silently produces a placeholder. |
| `CLOUDFLARE_R2_ACCESS_KEY_ID` / `CLOUDFLARE_R2_SECRET_ACCESS_KEY` / `CLOUDFLARE_R2_ENDPOINT` / `CLOUDFLARE_R2_BUCKET` / `CLOUDFLARE_R2_PUBLIC_BASE` | R2 upload + public URL construction | Skill exits with `blocked: R2 credentials missing`. |

Pre-flight check at Step 0: if any required env var is unset, exit with the
exact `blocked: ...` string above and surface it as the ticket comment.
**Do not fall through to a stub URL.**

## Inputs

| Field | Type | Default | Notes |
|---|---|---|---|
| `prompt` | string | required in standalone mode | Plain English, ≤1000 chars. |
| `aspect` | `16:9` \| `1:1` \| `3:2` | `16:9` | Drives the dimension table below. |
| `quality` | `standard` \| `hd` | `standard` | `hd` = course-cover/homepage tier (2400×1260, PNG). |
| `slot_kind` | `hero` \| `inline` \| `course_cover` | `hero` (standalone) | Controls dimensions, format (WebP vs PNG), and R2 prefix. |
| `draft_path` | string | optional | Absolute path to a draft.md. Activates frontmatter-wired mode. |
| `chapter_meta_path` | string | optional | Absolute path to `<prefix>/chapter-meta.json`. When set, also writes resolved URLs into the sidecar's `assets.*` keys. |

When `draft_path` is set, `prompt` may be omitted — derived from frontmatter
title + `contrarian_angle` + section headings.

## Sentinels

A sentinel = unresolved placeholder in draft frontmatter. Idempotency rule:
**only strings matching `^auto:[a-z0-9-]+$` are treated as sentinels.** Once a
slot's value is a real `https://...` URL, this skill skips it on re-runs.

Recognised sentinels (any suffix matching the regex resolves through the same
ladder):

- `auto:nano-banana-2` — explicit primary
- `auto:gpt-image` — explicit OpenAI fallback
- `auto:flux` — legacy alias, routes to primary
- `auto:gemini-flash` — alias, routes to primary
- bare `auto:default` — routes to primary

A missing `hero_image:` key in frontmatter is treated as `auto:default`.

## Dimension table (locked 2026-05-01)

| Slot kind | Aspect | Width × Height | Format | Why |
|---|---|---|---|---|
| `hero` (blog header) | 16:9 | **1200 × 630** | WebP q85 | OG / Twitter-card standard. Picked over 1920×1080 because every blog hero is consumed primarily as a social share preview, and 1200×630 is the OG spec. Retina full-bleed is achieved by the CDN serving the same asset at 2x via `srcset` — no need to bake a larger file. |
| `inline` (in-body) | 3:2 | **1200 × 800** | WebP q85 | Used inline alongside body copy; user is already scrolling so the image doesn't need OG-perfect dimensions. 1200 wide matches blog content column; 3:2 reads naturally for editorial. |
| `inline` (small) | 16:9 | **768 × 432** | WebP q80 | Diagram-style insets when N>3 inline images. |
| `course_cover` | 1.91:1 (~16:8.4) | **2400 × 1260** | PNG | OG-2x retina. **PNG required** because the slide-deck producer embeds these into PowerPoint and PPTX choking on WebP is well-known (Office 2019 and earlier). |
| `square` | 1:1 | **1024 × 1024** | WebP q85 | Avatar / icon slots. |

Verification step (Step 6) refuses any image whose actual decoded dimensions
deviate from the table above by more than ±2 px (some encoders round).

## Mode A — Standalone

Run Steps 0 → 7 once.

## Mode B — Frontmatter-wired

Run Step 0 (env check), Step B-0 (parse), Step B-1 (collect slots), then loop
Steps 1 → 6 over slots (parallelised — see Step B-2), then Step B-3 (atomic
rewrite), then Step 7 (sidecar + ticket comment).

---

## Step 0 — Environment pre-flight

```bash
for v in OPENROUTER_API_KEY CLOUDFLARE_R2_ACCESS_KEY_ID CLOUDFLARE_R2_SECRET_ACCESS_KEY CLOUDFLARE_R2_ENDPOINT CLOUDFLARE_R2_BUCKET CLOUDFLARE_R2_PUBLIC_BASE; do
  if [ -z "${!v}" ]; then
    echo "blocked: $v not configured"
    exit 64
  fi
done
```

Any failure here = ticket comment `blocked: <var> not configured`.
**Do not** continue with a stub or placeholder.

---

## Step B-0 — Parse draft frontmatter (Mode B only)

Always parse with PyYAML — never with sed, awk, or shell string ops. YAML
contains colons, quotes, multi-line strings, and Unicode; hand-built parsing
will silently corrupt drafts.

```python
import yaml, re, pathlib
raw = pathlib.Path(draft_path).read_text(encoding="utf-8")
m = re.match(r'^---\n(.*?)\n---\n(.*)$', raw, re.DOTALL)
if not m:
    raise SystemExit("blocked: draft has no YAML frontmatter")
fm = yaml.safe_load(m.group(1)) or {}
body = m.group(2)
```

## Step B-1 — Collect slots needing generation

A slot needs generation iff its current value is a string matching
`^auto:[a-z0-9-]+$`. URL strings, dicts with a resolved `url`, or absent keys
treated per the sentinel rules above.

```python
SENTINEL_RE = re.compile(r'^auto:[a-z0-9-]+$')

def needs_gen(v):
    if v is None: return True            # missing hero -> generate
    if isinstance(v, str) and SENTINEL_RE.match(v): return True
    if isinstance(v, dict):
        u = v.get("url")
        return isinstance(u, str) and SENTINEL_RE.match(u)
    return False

slots = []
if needs_gen(fm.get("hero_image")):
    slots.append({"key": "hero_image", "kind": "hero", "aspect": "16:9"})

inline = fm.get("inline_images") or []
for i, entry in enumerate(inline):
    if needs_gen(entry):
        slots.append({"key": f"inline_images[{i}]", "kind": "inline",
                      "aspect": "3:2", "index": i,
                      "after_heading": (entry or {}).get("after_heading") if isinstance(entry, dict) else None})

if fm.get("course_cover") is not None and needs_gen(fm.get("course_cover")):
    slots.append({"key": "course_cover", "kind": "course_cover", "aspect": "1.91:1"})
```

If `slots == []`: log `image-gen: nothing to do (all slots resolved)`, exit 0.

## Step B-2 — Derive prompts + parallel batch

For each slot, derive the prompt:

```python
def prompt_for(slot, fm, body):
    title = fm.get("title", "").strip()
    angle = (fm.get("contrarian_angle") or "").strip()
    vendor = (fm.get("vendor_tag") or "").strip()
    palette = "muted teal and amber palette"
    if slot["kind"] == "hero":
        base = f"editorial illustration, {title}"
        if angle: base += f", visual metaphor for {angle}"
    elif slot["kind"] == "course_cover":
        base = f"premium course cover art, {title}, cinematic, depth-of-field"
    else:  # inline
        ctx = slot.get("after_heading") or _nearest_h2(body, slot.get("index", 0)) or title
        base = f"editorial concept illustration, {ctx}"
    return f"{base}, {palette}, no text, no logos, no brand marks, clean composition"[:1000]
```

Run image generation concurrently with at most **3 in-flight requests**
(per-task budget cap is $0.20; 3 concurrent at ~$0.04 each is well within).
Use `concurrent.futures.ThreadPoolExecutor(max_workers=3)`.

```python
from concurrent.futures import ThreadPoolExecutor
results = {}
with ThreadPoolExecutor(max_workers=3) as ex:
    futs = {ex.submit(generate_and_upload, s, prompt_for(s, fm, body)): s for s in slots}
    for f in futs:
        s = futs[f]
        results[s["key"]] = f.result()   # may raise -> propagate to ticket
```

Where `generate_and_upload` runs Steps 1 → 6 below for one slot.

---

## Step 1 — Validate inputs

- `prompt` non-empty and ≤1000 chars
- `aspect` ∈ {`16:9`, `1:1`, `3:2`, `1.91:1`}
- `slot_kind` ∈ {`hero`, `inline`, `course_cover`, `square`}

Fail = `blocked: invalid input <field>=<value>`.

## Step 2 — Resolve dimensions

Use the dimension table above. Compute `WIDTH`, `HEIGHT`, `FORMAT` (`webp`|`png`),
`QUALITY` (q-value).

## Step 3 — Generate (primary: Nano Banana 2)

OpenRouter image generation runs through the **chat-completions** endpoint with
`modalities: ["image", "text"]`. The image returns as a base64 data URI at
`choices[0].message.images[0].image_url.url`. Verified 2026-05-01 against
`https://openrouter.ai/docs/guides/overview/multimodal/image-generation`.

```python
import requests, json, base64, re

def call_openrouter(model, prompt, width, height):
    body = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "modalities": ["image", "text"],
        "image_config": {
            "aspect_ratio": _aspect_string(width, height),
            # image_size honored by Gemini family; ignored elsewhere
            "image_size": "1K" if max(width, height) <= 1280 else "2K",
        },
    }
    r = requests.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {os.environ['OPENROUTER_API_KEY']}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://academy.kspl.tech",
            "X-Title": "Koenig AI Academy image-gen",
        },
        json=body,
        timeout=120,
    )
    return r

PRIMARY  = "google/gemini-3.1-flash-image-preview"
FALLBACK = "openai/gpt-5.4-image-2"

resp = call_openrouter(PRIMARY, prompt, WIDTH, HEIGHT)
```

## Step 4 — Handle moderation, errors, fallback

Three failure shapes to handle, in this exact order:

```python
def is_moderation_block(resp):
    if resp.status_code == 403: return True
    try:
        err = resp.json().get("error", {})
        return err.get("code") in ("content_policy_violation", "moderation_blocked") \
               or "policy" in (err.get("message") or "").lower()
    except Exception:
        return False

def extract_image(resp):
    """Returns data-URI string or None."""
    try:
        data = resp.json()
        msg = data["choices"][0]["message"]
        imgs = msg.get("images") or []
        if not imgs: return None
        return imgs[0]["image_url"]["url"]
    except Exception:
        return None
```

Decision tree:

1. **Primary returns image** → continue to Step 5.
2. **Primary returns moderation block** → retry on `FALLBACK` (one shot).
   - Fallback also blocks → **sanitize prompt** (strip vendor names,
     brand mentions, named persons via regex below) and retry `PRIMARY`.
   - Sanitized prompt also blocks → exit `blocked: image-gen blocked by content policy on slot <slot.key>; sanitized prompt also blocked. Author should manually pick or describe a non-policy-blocking concept.`
3. **Primary returns non-200 / no image / network error** → retry on `FALLBACK`.
   - Fallback also empty → exit `blocked: image-gen failed on <slot.key>: primary=<status> fallback=<status>`.
4. **Never silently return null.** Every code path must either emit a real URL
   or write a `blocked: ...` ticket comment.

Sanitization regex:

```python
def sanitize(p):
    # Strip recognisable brand/vendor names + person names
    BRANDS = r'\b(OpenAI|Anthropic|Google|Microsoft|Meta|xAI|DeepMind|Claude|GPT|Gemini|Grok|ChatGPT|Copilot)\b'
    p = re.sub(BRANDS, "", p, flags=re.IGNORECASE)
    # Collapse whitespace
    return re.sub(r'\s+', ' ', p).strip()
```

## Step 5 — Decode, transcode, upload

```python
import base64, hashlib, subprocess, tempfile, os

def decode_data_uri(uri):
    # data:image/png;base64,XXXX
    head, b64 = uri.split(",", 1)
    return base64.b64decode(b64)

raw = decode_data_uri(data_uri)
src = tempfile.NamedTemporaryFile(suffix=".png", delete=False); src.write(raw); src.close()

ext = "webp" if FORMAT == "webp" else "png"
dst = tempfile.NamedTemporaryFile(suffix=f".{ext}", delete=False); dst.close()

# Transcode with ffmpeg; resize to exact target dims.
subprocess.run([
    "ffmpeg", "-y", "-loglevel", "error",
    "-i", src.name,
    "-vf", f"scale={WIDTH}:{HEIGHT}:flags=lanczos",
    *( ["-c:v", "libwebp", "-quality", str(QUALITY)] if ext == "webp" else ["-compression_level", "6"] ),
    dst.name,
], check=True)

# Slug from prompt + content hash
slug_base = re.sub(r'[^a-z0-9]+', '-', prompt.lower())[:40].strip("-")
content_hash = hashlib.sha256(raw).hexdigest()[:8]
date = __import__("datetime").date.today().isoformat()
prefix = {"hero": "blog-heroes", "inline": "blog-inline", "course_cover": "course-covers", "square": "squares"}[SLOT_KIND]
key = f"{prefix}/{date}-{slug_base}-{content_hash}.{ext}"

# Upload via boto3 (S3-compatible); avoids rclone dependency.
import boto3
s3 = boto3.client("s3",
    endpoint_url=os.environ["CLOUDFLARE_R2_ENDPOINT"],
    aws_access_key_id=os.environ["CLOUDFLARE_R2_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["CLOUDFLARE_R2_SECRET_ACCESS_KEY"],
    region_name="auto",
)
s3.upload_file(dst.name, os.environ["CLOUDFLARE_R2_BUCKET"], key,
               ExtraArgs={"ContentType": "image/webp" if ext == "webp" else "image/png",
                          "CacheControl": "public, max-age=31536000, immutable"})

image_url = f"{os.environ['CLOUDFLARE_R2_PUBLIC_BASE'].rstrip('/')}/{key}"
local_size = os.path.getsize(dst.name)
```

## Step 6 — Verify uploaded asset

Fail-loud verification — three checks, all must pass:

```python
import io
from PIL import Image

# (a) HTTP HEAD returns 200 + matching Content-Length
head = requests.head(image_url, timeout=15, allow_redirects=True)
if head.status_code != 200:
    raise RuntimeError(f"verify failed: HEAD {image_url} -> {head.status_code}")
remote_len = int(head.headers.get("Content-Length", 0))
if abs(remote_len - local_size) > 16:   # tiny CDN-side metadata wobble allowed
    raise RuntimeError(f"verify failed: size mismatch local={local_size} remote={remote_len}")

# (b) GET + decode + dimension check
img_bytes = requests.get(image_url, timeout=30).content
im = Image.open(io.BytesIO(img_bytes))
if abs(im.width - WIDTH) > 2 or abs(im.height - HEIGHT) > 2:
    raise RuntimeError(f"verify failed: dims {im.width}x{im.height} != target {WIDTH}x{HEIGHT}")

# (c) basic non-corruption check
im.verify()
```

Failure here = `blocked: image-gen verification failed for <slot>: <reason>`.

Cleanup: `os.unlink(src.name); os.unlink(dst.name)`.

---

## Step B-3 — Atomic frontmatter rewrite (Mode B only)

Idempotent + crash-safe. Never open the destination file with `'w'` directly.

```python
import os, tempfile, yaml, pathlib

def merge_results(fm, results):
    # results[key] is a dict like {"url":..., "alt":..., "prompt":..., "width":..., "height":..., "model":...}
    if "hero_image" in results:
        fm["hero_image"] = {
            "url":    results["hero_image"]["url"],
            "alt":    results["hero_image"]["alt"],
            "prompt": results["hero_image"]["prompt"],
            "width":  results["hero_image"]["width"],
            "height": results["hero_image"]["height"],
            "model":  results["hero_image"]["model"],
        }
    if "course_cover" in results:
        fm["course_cover"] = { ... same shape ... }

    # Inline list update — merge by index
    inline = fm.get("inline_images") or []
    for k, v in results.items():
        m = re.match(r'inline_images\[(\d+)\]', k)
        if not m: continue
        i = int(m.group(1))
        while len(inline) <= i: inline.append({})
        existing = inline[i] if isinstance(inline[i], dict) else {}
        inline[i] = {
            **existing,
            "url":    v["url"],
            "alt":    v["alt"],
            "prompt": v["prompt"],
            "width":  v["width"],
            "height": v["height"],
            "model":  v["model"],
        }
    if inline:
        fm["inline_images"] = inline
    return fm

fm_new = merge_results(fm, results)

# Re-emit YAML safely. block style, sorted keys preserved by default_flow_style=False.
new_fm_yaml = yaml.safe_dump(fm_new, sort_keys=False, allow_unicode=True,
                             default_flow_style=False, width=4096)
new_content = "---\n" + new_fm_yaml + "---\n" + body

# Atomic write: temp file in same dir, fsync, then os.replace().
draft = pathlib.Path(draft_path)
fd, tmp_path = tempfile.mkstemp(prefix=".draft-", suffix=".tmp", dir=str(draft.parent))
try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(new_content)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, draft)        # POSIX-atomic rename
except Exception:
    try: os.unlink(tmp_path)
    except FileNotFoundError: pass
    raise
```

`yaml.safe_dump` handles colons, quotes, newlines, and Unicode in prompts
correctly. **Never f-string YAML.**

Idempotency check: a second run of this skill must find zero slots needing
generation (every value is now a real `https://...` URL), so it exits at the
end of Step B-1 without re-spending budget.

## Step B-4 — chapter-meta.json sidecar (when applicable)

If `chapter_meta_path` is set OR if the draft path matches
`vault/courses/<slug>/<NN>-*.md`, also write resolved URLs into the chapter's
sidecar. Use atomic write same as B-3.

```python
import json
meta_path = chapter_meta_path or _infer_chapter_meta(draft_path)
if meta_path and pathlib.Path(meta_path).exists():
    meta = json.loads(pathlib.Path(meta_path).read_text())
    meta.setdefault("assets", {})
    if "hero_image" in results:
        meta["assets"]["hero_image"] = results["hero_image"]["url"]
    if "course_cover" in results:
        meta["assets"]["course_cover"] = results["course_cover"]["url"]
    inline_urls = [v["url"] for k, v in sorted(results.items())
                   if k.startswith("inline_images[")]
    if inline_urls:
        meta["assets"]["inline_images"] = inline_urls
    # atomic write
    fd, tmp = tempfile.mkstemp(prefix=".meta-", suffix=".tmp", dir=str(pathlib.Path(meta_path).parent))
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)
        f.flush(); os.fsync(f.fileno())
    os.replace(tmp, meta_path)
```

---

## Step 7 — Sidecar log + ticket comment

Per slot, append to `vault/_logs/image-gen.jsonl`:

```json
{"ts":"2026-05-01T15:45:00Z","slot":"hero_image","model":"google/gemini-3.1-flash-image-preview","aspect":"16:9","width":1200,"height":630,"format":"webp","quality":85,"image_url":"https://...","local_bytes":287104,"remote_bytes":287104,"prompt_chars":142,"cost_estimate_usd":0.04}
```

Comment on Paperclip ticket (one comment per skill invocation, not per slot):

```
image-gen complete for <draft_slug>
- hero_image: <url> (Nano Banana 2, 1200x630 webp, 287KB)
- inline_images[0]: <url> (Nano Banana 2, 1200x800 webp, 198KB)
- inline_images[1]: <url> (gpt-5.4-image-2 [primary moderation-blocked], 1200x800 webp, 224KB)
Total: 3 images, $0.12, 11s
```

In standalone mode, return `image_url` directly to caller.

## Outputs

- 1..N images in R2 under `blog-heroes/`, `blog-inline/`, `course-covers/`, or `squares/`
- Atomic frontmatter rewrite of `draft.md` (Mode B)
- Atomic update of `chapter-meta.json` (when course chapter)
- Append-only line in `vault/_logs/image-gen.jsonl`
- Single ticket comment summarising all slots

## Never do

- Never open the draft with `open(path, 'w')`. Always temp-file + `os.replace()`.
- Never hand-build YAML from f-strings. Use `yaml.safe_dump`.
- Never silently fall through to `null` or a stub URL on moderation/error.
  Every failure path emits a `blocked: ...` comment.
- Never re-generate a slot whose value is already a `https://...` URL.
- Never push partial state. If any slot fails after others succeeded, the
  partial successes still get written (R2 spend is sunk) but the draft
  rewrite is gated: failed slots remain as their `auto:*` sentinel; ticket
  comment lists exactly which slots succeeded vs blocked.
- Never log full prompts to git. First 80 chars + char count only.
- Never call any image model outside the locked V1 vendor scope
  (Anthropic / OpenAI / Google / community). xAI image models are out.

## Wiring

This skill is invoked by:
- `chief-content` directly when the author requests inline image generation
- `image-gen-on-pass` skill on G0 PASS for sentinel-bearing drafts
- Manually: `paperclip skill invoke image-gen --draft_path <abs-path>`

Required Python deps (already in `requirements.koenig.txt`): `pyyaml`,
`requests`, `pillow`, `boto3`. Required system deps: `ffmpeg`.

## Budget

Per-task cap: **$0.20**. Nano Banana 2 ≈ $0.04 / image; gpt-5.4-image-2 ≈ $0.06.
Allows ≤ 5 standard images or 3 hd images per ticket. Hard exit at $0.20 with
`blocked: per-task budget exhausted on slot <N>`.
