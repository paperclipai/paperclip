---
schema: agentcompanies/v1
kind: skill
slug: image-gen-on-pass
name: Auto-Image-Gen After G0 PASS
description: Chief Content's auto-trigger that fires the image-gen sub-skill the moment a draft passes G0, for any draft whose frontmatter has an `auto:*` hero_image sentinel. Locks down the gap that left blogs (e.g. 2026-04-30-gpt-5-5-in-codex) shipping without a hero image. Skill, not an agent.
version: 0.1.0
license: MIT
sources: []
---

# Auto-Image-Gen After G0 PASS

Used by `chief-content` (or `content-reviewer` as the deputy on G0 PASS). Triggered when:
1. A vault file at `vault/blogs/<slug>/draft.md` or `vault/courses/<slug>/<NN>-*.md` flips status to `g0-passed`
2. AND its frontmatter contains an unresolved sentinel like `hero_image: auto:flux`, `hero_image: auto:nano-banana-2`, or `inline_images: [auto:*]`

Why this exists: the `image-gen` sub-skill is registered but was never auto-fired on G0 PASS. April audit found `2026-04-30-gpt-5-5-in-codex/draft.md` published with `hero_image: auto:flux` unresolved — no image generated, no R2 asset, frontend rendered with a placeholder gradient. Same pattern across most April blogs.

## Procedure

1. **Detect.** On `issue_status_changed` event where `new_status='g0-passed'`, read the linked vault file. If frontmatter has any `hero_image: auto:*` or `inline_images:` containing `auto:*` entries, proceed. If no sentinel, return silently (no-op).

2. **Derive prompts.** For each `auto:*` slot, derive the prompt from:
   - Draft `title`
   - Frontmatter `contrarian_angle` (if present, anchors the visual concept)
   - Vendor brand (frontmatter `vendor_tag`) — sets palette + iconography
   - Slot context (`hero_image` = wide editorial photo; `inline_image` = concept diagram)

   Skip slots that already have a resolved URL.

3. **Invoke `image-gen` skill** in frontmatter-wired mode:
   ```bash
   paperclip skill invoke image-gen \
     --draft_path "$VAULT_FILE" \
     --aspect "16:9"  # or 1:1 for inline
   ```

   The image-gen skill handles model routing (Nano Banana 2 primary → FLUX 2 Max for HD course covers → FLUX 2 Klein 4B fallback) and writes the R2 URL back into the draft frontmatter atomically.

4. **Verify.** After image-gen returns, re-read the draft. Every `auto:*` should now be a resolved `https://pub-…r2.dev/…` URL. If any sentinel persists, BLOCK the ticket back to author with reason "image-gen failed to resolve <slot>; see image-gen log".

5. **Commit + push.** Single vault commit per draft: `chore(images): generate hero+inline for <slug>`. Push to `koenig-ai-org` master so Vercel rebuild picks up the URLs.

6. **Comment** on the ticket:
   ```
   ✅ Images generated for <slug>
   - hero_image: <r2-url> (Nano Banana 2, 1024×576, 287KB)
   - inline_images: [<3 r2-urls>]
   - Total cost: $0.04 · 4s
   ```

## Inputs

- The G0-passed ticket id + linked vault path
- `OPENROUTER_API_KEY` (for image-gen)
- `CLOUDFLARE_R2_*` (for upload — already in `.env.koenig`)

## Outputs

- 1-N images uploaded to R2 (bucket `koenig-academy-media`, prefix `blog-heroes/` or `course-images/`)
- Vault frontmatter rewritten to replace `auto:*` with resolved URLs
- 1 git commit per ticket
- 1 ticket comment with image URLs + cost

## Never do

- Never regenerate an image that already has a resolved URL — costs $$ and changes the page over time
- Never push partial state (commit only after every sentinel resolved or the ticket is BLOCKED)
- Never bypass the model ladder (Nano Banana 2 primary; falling back to FLUX 2 only on quota error)
- Never put the prompt or token in the commit message — image-gen logs hold those

## Wiring

Triggered by Paperclip's status-change event listener. Add to `chief-content/AGENTS.md`:

```yaml
on_status_change:
  - when: new_status == 'g0-passed' AND vault_file_has_auto_sentinel
    skill: image-gen-on-pass
```

Or, if the event listener isn't available, add to `chief-content`'s heartbeat skill: scan `awaiting-g0` → `g0-passed` transitions in the last hour and fire image-gen-on-pass for any with sentinels.

## Budget

Per invocation cap $0.20 (Nano Banana 2 averages $0.04/image; allows up to 5 inline images per draft).
