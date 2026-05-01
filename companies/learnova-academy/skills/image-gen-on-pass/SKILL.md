---
schema: agentcompanies/v1
kind: skill
slug: image-gen-on-pass
name: Auto-Image-Gen After G0 PASS
description: Chief Content's auto-trigger that fires the `image-gen` sub-skill the moment a draft passes G0, for any draft whose frontmatter has an unresolved `auto:*` sentinel (matching `^auto:[a-z0-9-]+$`). Locks down the gap that left blogs (e.g. 2026-04-30-gpt-5-5-in-codex) shipping without a hero image. Skill, not an agent.
version: 0.2.0
license: MIT
sources: []
---

# Auto-Image-Gen After G0 PASS

Used by `chief-content` (or `content-reviewer` as the deputy on G0 PASS). Triggered when:
1. A vault file at `vault/blogs/<slug>/draft.md` or `vault/courses/<slug>/<NN>-*.md` flips status to `g0-passed`.
2. AND its frontmatter contains an unresolved sentinel matching `^auto:[a-z0-9-]+$` in any of: `hero_image`, `course_cover`, or any entry of `inline_images[]`. A missing `hero_image` key is treated the same as `auto:default`.

Why this exists: the `image-gen` sub-skill is registered but was never auto-fired on G0 PASS. April audit found `2026-04-30-gpt-5-5-in-codex/draft.md` published with `hero_image: auto:flux` unresolved — no image generated, no R2 asset, frontend rendered with a placeholder gradient. Same pattern across most April blogs.

## Procedure

1. **Detect.** On `issue_status_changed` event where `new_status='g0-passed'`, read the linked vault file. If any slot's value matches `^auto:[a-z0-9-]+$` (or `hero_image` is absent), proceed. Otherwise return silently — image-gen is idempotent and skips already-resolved URLs.

2. **Invoke `image-gen` skill** in frontmatter-wired mode. The sub-skill handles slot detection, prompt derivation, parallel batching (≤3 concurrent), upload, dimension verification, and atomic frontmatter rewrite — this skill is just the trigger.
   ```bash
   paperclip skill invoke image-gen \
     --draft_path "$VAULT_FILE"
   ```
   The image-gen skill routes through the locked ladder — primary `google/gemini-3.1-flash-image-preview` (Nano Banana 2), fallback `openai/gpt-5.4-image-2` — and writes resolved URLs back into the draft frontmatter atomically (`tempfile` + `os.replace`).

3. **Verify.** After image-gen returns, re-read the draft. Every previously `auto:*` value must now be a resolved `https://...` URL. If any sentinel persists, BLOCK the ticket back to author with the reason from image-gen's last comment (image-gen always writes a `blocked: ...` line on failure — never silently nulls).

4. **Commit + push.** Single vault commit per draft: `chore(images): generate hero+inline for <slug>`. Push to `koenig-ai-org` master so Vercel rebuild picks up the URLs.

5. **Comment** on the ticket. Use the dimensions actually emitted by image-gen — these are the locked values from the dimension table in `image-gen/SKILL.md`:
   ```
   Images generated for <slug>
   - hero_image: <r2-url> (Nano Banana 2, 1200x630 webp, 287KB)
   - inline_images[0]: <r2-url> (Nano Banana 2, 1200x800 webp, 198KB)
   - course_cover: <r2-url> (Nano Banana 2, 2400x1260 png, 1.2MB)  // when applicable
   - Total cost: $0.12 · 11s
   ```

## Slot dimensions (must match `image-gen/SKILL.md`)

| Slot | Aspect | Width × Height | Format |
|---|---|---|---|
| `hero_image` | 16:9 | 1200 × 630 | WebP q85 |
| `inline_images[]` | 3:2 | 1200 × 800 | WebP q85 |
| `course_cover` | 1.91:1 | 2400 × 1260 | **PNG** (slide-deck embed compatibility) |

If you see this skill emit different dimensions in a comment, the sub-skill's
table is out of sync — fix `image-gen/SKILL.md`, not this file.

## Inputs

- The G0-passed ticket id + linked vault path
- `OPENROUTER_API_KEY` (for image-gen — image-gen exits `blocked: OPENROUTER_API_KEY not configured` if missing)
- `CLOUDFLARE_R2_*` (for upload — already in `.env.koenig`)

## Outputs

- 1-N images uploaded to R2 (bucket `koenig-academy-media`, prefixes `blog-heroes/`, `blog-inline/`, `course-covers/`)
- Vault frontmatter rewritten to replace each `auto:*` with a resolved URL
- `chapter-meta.json` sidecar updated when run on a course chapter
- 1 git commit per ticket
- 1 ticket comment with image URLs + cost

## Never do

- Never regenerate an image that already has a resolved URL (image-gen is idempotent on `^https?://`).
- Never push partial state (commit only after every sentinel resolved or the ticket is BLOCKED).
- Never bypass the locked ladder. Nano Banana 2 primary; gpt-5.4-image-2 fallback. xAI/Grok image models are out.
- Never put the prompt or API key in the commit message — `vault/_logs/image-gen.jsonl` holds the audit trail.

## Wiring

Triggered by Paperclip's status-change event listener. Add to `chief-content/AGENTS.md`:

```yaml
on_status_change:
  - when: new_status == 'g0-passed' AND vault_file_has_auto_sentinel
    skill: image-gen-on-pass
```

If the event listener isn't available, add to `chief-content`'s heartbeat skill: scan `awaiting-g0` → `g0-passed` transitions in the last hour and fire image-gen-on-pass for any with sentinels.

## Budget

Per invocation cap $0.20 (Nano Banana 2 ≈ $0.04/image; gpt-5.4-image-2 ≈ $0.06/image; allows up to 5 standard images or 3 hd images per draft). Image-gen enforces the cap and exits `blocked: per-task budget exhausted on slot <N>` on overrun.
