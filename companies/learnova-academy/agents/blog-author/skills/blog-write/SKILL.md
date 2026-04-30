# Skill: Blog Write — Image-Gen Wiring

## When to use

After the blog draft is complete and before submitting to Content Reviewer.

## Trigger logic (end of draft)

At the **end of every drafting run**, before handing off to Content Reviewer, check the
draft's frontmatter for image sentinels:

```bash
DRAFT_PATH="vault/blogs/<slug>/draft.md"   # adjust to actual path

HERO_LINE=$(awk '/^---/{n++; if(n==2)exit} n==1 && /^hero_image:/' "$DRAFT_PATH")

if echo "$HERO_LINE" | grep -q 'auto:flux' || [ -z "$HERO_LINE" ]; then
  # Trigger image-gen in frontmatter-wired mode
  IMAGE_GEN_NEEDED=true
fi
```

If `IMAGE_GEN_NEEDED=true`, call the company-level `image-gen` skill with:

```
draft_path = <absolute path to draft.md>
```

The image-gen skill handles everything: prompt derivation, FLUX generation, R2 upload,
and frontmatter rewrite. You do not need to call it per-slot or pass explicit prompts.

### Do not call image-gen when

- `hero_image` is already a structured object (`url:`, `alt:`, `prompt:` fields present)
- The draft is a correction/minor edit and images are unchanged

## Image slots

image-gen will populate **1 hero** image and, if budget allows, **1–2 inline** images
at major H2 section boundaries. You do not need to pre-populate sentinel values —
simply omit `hero_image` from the frontmatter and image-gen will detect the absence.

If you want to explicitly request generation (e.g. to force a regen), set:

```yaml
hero_image: auto:flux
```

## Slot specs (for reference only — image-gen enforces these internally)

| Slot | `aspect` | `quality` |
|------|----------|-----------|
| Hero | `16:9` | `standard` |
| Inline | `3:2` | `standard` |

## Hero prompt style (for reference — image-gen derives this automatically)

> "clean editorial illustration, [title], muted teal and amber palette, no text, no logos, 16:9, WebP"

Maximum 150 characters. No brand names, faces, or logos.

## Budget cap

3 images × $0.04 = **$0.12 per task maximum**. image-gen enforces this; stop if it
reports budget exceeded.

## Post image-gen checklist (before submitting draft)

- [ ] `hero_image` is a structured object (url + alt + prompt) — not `auto:flux` or absent
- [ ] 1–2 `inline_images` entries present at meaningful H2 boundaries (if budget allowed)
- [ ] Total images ≤ 3
- [ ] All alts are descriptive (not "image of…")
- [ ] Budget used ≤ $0.12
