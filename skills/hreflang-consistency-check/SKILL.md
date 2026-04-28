---
name: hreflang-consistency-check
description: Validate hreflang tags across all locale variants of a Bobby Tours site are present, symmetric, and conformant to Google's rules. Use when adding a new locale, reviewing PRs touching `hreflangAlternates`, or diagnosing "International Targeting" errors in GSC.
---

# Hreflang Consistency Check

## Sites by locale count

| Site | Locales | Notes |
|---|---|---|
| bobbysafaris.com | 19 (ar, bg, de, en, es, fr, he, hi, it, ja, ko, nl, pl, pt, ru, sv, tr, zh, zh-Hant) | Biggest locale matrix |
| safaris-tanzania.com | 11 (ar, de, en, es, fr, hi, it, ja, ko, nl, pt, zh) | |
| magicaltanzania.com | 10 (de, en, es, fr, it, ja, ko, nl, pt, zh) | |
| safari-kilimanjaro.com | 10+ (de, en, es, fr, hi, it, ja, ko, nl, pt, zh) | |
| mountkilimanjaroclimb.com | 9 (de, en, es, fr, it, ja, ko, nl, pt, zh) | |

## Google's rules (hard)

1. **Reciprocal** — if page A links to B via hreflang, B must link back to A with the same pair.
2. **Full locale-region codes** when targeting region (e.g. `en-GB`). Language-only (`en`) means default for all.
3. **Each locale variant links to ALL OTHERS plus itself** (self-referential hreflang required).
4. **`x-default`** — link to the language-selector or the site's global default (usually English homepage).
5. **Absolute URLs** in `href`.
6. **No conflicting canonical** — each locale variant's canonical must point to ITSELF, not to English.

## Procedure

1. **Pick target pages:**
   - Homepage (`/`) and its locale variants (`/de/`, `/es/`, etc.)
   - At least 3 deep pages (itinerary, park, blog)

2. **Extract all hreflang tags from English homepage:**
   ```bash
   curl -sL "https://<domain>/" | grep -oE 'hreflang="[^"]+" href="[^"]+"' | sort -u
   ```
   Expected count = N locales + 1 (x-default).

3. **For each locale variant, extract its hreflang tags:**
   ```bash
   for locale in de es fr it ja ko nl pt zh; do
     echo "=== $locale ==="
     curl -sL "https://<domain>/$locale/" | grep -oE 'hreflang="[^"]+" href="[^"]+"' | wc -l
   done
   ```
   All should return the same count (N+1).

4. **Check reciprocity — for a sample of 3 locales:**
   - From English homepage, pick the `hreflang="de"` href. Visit it. Does it list `hreflang="en"` pointing back to the English source? Repeat for `fr`, `ja`.

5. **Cross-check with hook v12 P14** — rejects pages referencing wrong domains (e.g. `mountkilimanjaro.com` without `climb`). Make sure locale variants use canonical domain.

6. **Check canonical self-reference:**
   ```bash
   curl -sL "https://<domain>/de/" | grep -oE '<link rel="canonical" href="[^"]+"'
   ```
   Must point to `https://<domain>/de/` NOT `https://<domain>/`.

7. **Pull GSC "International Targeting" report** (via `gsc-audit` skill) to catch any hreflang errors Google has already flagged.

## Common issues + fixes

| Issue | Fix |
|---|---|
| Relative hrefs | Use `hreflangAlternates` helper from `@/lib/hreflang` — it returns absolute URLs. |
| Missing locale in some pages but present on homepage | Page's `generateMetadata` or layout doesn't call `hreflangAlternates`. Audit the specific route. |
| Non-reciprocal (EN→DE exists, DE→EN missing) | Locale pages not using the shared hreflang helper. Unify. |
| Canonical pointing at English from locale variants | Remove or fix `alternates.canonical` in page `generateMetadata`. Canonical should self-reference. |
| `x-default` pointing at `/en/` not `/` | By convention `x-default` → global default URL. Next.js App Router serves `/` as default, `/en/` may be optional. Match your routing scheme. |

## Report format

```
## Hreflang audit — <domain>

Expected locales: 10 (de, en, es, fr, it, ja, ko, nl, pt, zh) + x-default = 11 tags

### Pages checked
| Page | Tag count | Reciprocal | Canonical self-ref | Status |
|---|---|---|---|---|
| / | 11/11 | ✓ | ✓ | ✅ |
| /de/ | 11/11 | ✓ | ✓ | ✅ |
| /fr/itineraries/serengeti | 10/11 (missing `ja`) | ⚠ | ✓ | ❌ |
...

### Action items
- [ ] Fix /fr/itineraries/serengeti — missing `ja` hreflang
- [ ] Check `generateMetadata` for /itineraries/[slug]/page.tsx uses `hreflangAlternates`
```

## Pitfalls

- Hreflang tags can live in `<head>` OR in HTTP `Link:` headers. Check both.
- Some pages intentionally exclude a locale (e.g. a blog post that hasn't been translated yet). In that case, DON'T add a broken hreflang — just omit. Next page's sitemap-quality-check will catch the translation gap.
- `zh` vs `zh-Hans` vs `zh-Hant` — use what your site uses consistently. Mixing breaks Google's matching.
- Hreflang changes take weeks for Google to fully reprocess.

## Related skills

- `schema-org-validator` — multi-locale schemas need locale-matching description/name
- `gsc-audit` — International Targeting report shows live hreflang errors
- `meta-description-writer` — each locale needs unique meta in native language

## Budget

$0.10–0.30 per site audit.
