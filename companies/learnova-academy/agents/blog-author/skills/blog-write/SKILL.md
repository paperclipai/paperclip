# Skill: Blog Write — Image-Gen Wiring

## When to use

After the blog draft is complete, before submitting to Content Reviewer.

## Image slots

Identify **1 hero** image and **1–2 inline** images placed at major H2 section boundaries that benefit from visual illustration.

## Calling the image-gen skill

Use the company-level `image-gen` skill in `companies/learnova-academy/skills/image-gen/`.

| Slot | `aspect` | `quality` |
|------|----------|-----------|
| Hero | `16:9` | `standard` |
| Inline | `3:2` | `standard` |

## Hero prompt style

> "clean editorial illustration, [topic], muted teal and amber palette, no text, no logos, 16:9, WebP"

Maximum 150 characters. Do not include brand names, faces, or logos.

## Budget cap

3 images × $0.04 = **$0.12 per task maximum**. Stop at 3 even if more slots exist.

## Writing results into frontmatter

After generation, write the resulting URLs into draft frontmatter:

```yaml
hero_image:
  url: https://...
  alt: "One-sentence description of the image for screen readers"
  prompt: "The prompt used (≤150 chars)"

inline_images:
  - after_heading: "Exact H2 heading text where image should appear"
    url: https://...
    alt: "Description"
    caption: "Optional caption shown below image"
```

The `after_heading` value must match the H2 heading text exactly (case-sensitive) so the renderer can inject the image in the right position.

## Checklist before submitting draft

- [ ] `hero_image` set (url + alt + prompt)
- [ ] 1–2 `inline_images` entries at meaningful H2 boundaries
- [ ] Total images ≤ 3
- [ ] All alts are descriptive (not "image of…")
- [ ] Budget used ≤ $0.12
