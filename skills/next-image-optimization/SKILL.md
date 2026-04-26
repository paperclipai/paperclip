---
name: next-image-optimization
description: Enforce Next.js <Image> component best practices across Bobby Tours site repos. Ensures LCP protection, CLS prevention, proper format (WebP/AVIF), lazy loading, and correct sizing. Use during coder work or review.
---

# Next.js Image Optimization

## When to use

- Writing a new page/component that renders images
- Reviewing a PR that touches `src/app/**` or any component with `<img>` / `<Image>` tags
- Auditing a page with bad LCP (correlates with hero image issues)
- Before shipping any hero section change

## Hard rules

1. **NEVER use raw `<img>` tags** in JSX/TSX. Always `<Image>` from `next/image`. The only exception: external SVGs that Next.js can't optimize (e.g. Twitter widgets) — and even those should be wrapped in a component.

2. **Hero / above-fold images MUST have `priority`**:
   ```tsx
   <Image
     src="/images/serengeti-hero.webp"
     alt="Serengeti plains at sunrise"
     priority
     width={1920}
     height={1080}
     sizes="(max-width: 768px) 100vw, (max-width: 1200px) 80vw, 1200px"
     className="object-cover"
   />
   ```

3. **`alt` attribute ALWAYS** — empty string `alt=""` is acceptable ONLY for decorative images. Screen readers need this.

4. **Explicit `width` + `height`** on all `<Image>` — prevents CLS. For dynamic images, use `fill` + aspect-ratio container.

5. **Format precedence** — source should be in this order:
   - `.avif` (best, ~30% smaller than webp)
   - `.webp` (widely supported)
   - `.jpg` / `.png` (fallback only)
   NEVER ship images as `.jpg` or `.png` unless you're sure AVIF/WebP conversion isn't available in the pipeline.

6. **`sizes` attribute** — not optional. Without it, Next serves the largest size on every device. Minimal example for responsive images:
   ```
   sizes="(max-width: 768px) 100vw, 50vw"
   ```

## Procedure (for review)

1. **Find all images in the PR diff:**
   ```bash
   git diff main...HEAD --name-only | xargs grep -lE '<img|<Image' 2>/dev/null | head
   ```

2. **For each file, check:**
   - No `<img>` tags → use `<Image>` or MDXImage wrapper
   - Hero image has `priority` prop
   - All have `alt`
   - All have `width`+`height` OR `fill` with sized container
   - `sizes` attribute present on responsive layouts
   - Source format is AVIF or WebP

3. **Check public/images/ — ensure file formats are good:**
   ```bash
   find public/images -name "*.jpg" -o -name "*.png" | head -20
   ```
   Any JPG/PNG over 200 KB is a conversion candidate. Convert with `sharp` or `cwebp`:
   ```bash
   npx @squoosh/cli --webp '{"quality":80}' public/images/*.jpg
   ```

4. **LCP protection** — run this after build to see which image is the LCP:
   ```bash
   npx lighthouse http://localhost:3000/ --only-audits=largest-contentful-paint-element --output=json --quiet --chrome-flags="--headless --no-sandbox" | jq '.audits["largest-contentful-paint-element"].displayValue'
   ```
   Verify the element has `priority` and is WebP/AVIF.

## Site-specific image rules

| Site | Hero pattern | CDN / storage |
|---|---|---|
| bobbysafaris.com | Hero 1920×1080 WebP, luxury camp imagery, must compress without banding | `/public/images/` |
| safaris-tanzania.com | Hero with Framer Motion fade-in — the fade-in itself can cause INP spikes; use `will-change: opacity` and `translate3d(0,0,0)` | `/public/images/` |
| magicaltanzania.com | Editorial full-bleed `max-w-[1920px]` heroes, aspect-ratio 16:9 | `/public/images/` + Cloudinary for blog thumbs |
| safari-kilimanjaro.com | Kili peak imagery, low-light → AVIF saves 40%+ over WebP | `/public/images/` |
| mountkilimanjaroclimb.com | Mountain photo-heavy, ~80 pages with hero image | `/public/images/routes/<route-slug>/` |

## Common issues + fixes

| Issue | Fix |
|---|---|
| LCP > 4s, hero is 3 MB JPG | Convert to WebP at 80% quality (~300 KB), add `priority` |
| CLS 0.2 on product page | Image without `width`/`height`. Add explicit dims or use `fill` |
| INP spikes on blog page | Carousel loading all images eagerly. Add `loading="lazy"` + virtualize |
| Hero shows placeholder flash | Missing `placeholder="blur"` with `blurDataURL`. Next can auto-generate for local images at build |
| Hydration mismatch on image | SSR vs CSR size mismatch — use `sizes` consistently, or use `fill` |

## Pitfalls

- `priority` on multiple images per page = defeats the purpose. Max 1-2 hero images.
- `placeholder="blur"` with external URLs requires explicit `blurDataURL`. Don't try on dynamic remote images without it.
- `next/image` with external domains requires allowlist in `next.config.js` `images.remotePatterns`. If a remote image breaks after deploy, check this.
- AVIF has browser support gaps on older iOS — Next auto-fallbacks to WebP, so you're fine.

## Related skills

- `core-web-vitals-audit` — LCP/CLS/INP diagnosis
- `accessibility-audit` — alt text auditing
- `next-build-gate` — catches image config errors at build time

## Budget

$0.05–0.15 per PR review. Conversion scripts are free.
