---
name: meta-description-writer
description: Write or audit 150-160 character meta descriptions for Bobby Tours site pages — CTR-optimized, keyword-aligned, intent-matched, locale-aware. Use for new pages, bulk audits, and SERP appearance fixes.
---

# Meta Description Writer

## When to use

- Drafting meta for a new page before publish
- Auditing existing pages where GSC shows low CTR on high-impression keywords
- Fixing duplicate or truncated meta descriptions flagged by `sitemap-quality-check` or GSC
- Translating meta for new locale rollouts

## Hard rules

| Rule | Why |
|---|---|
| **150–160 characters** | Google truncates at ~160 on desktop, ~120 on mobile. Target 155. |
| **Include the primary keyword** naturally — ideally in first 120 chars | Bolds on SERP + signals relevance |
| **End with a CTA verb** | "Inquire", "Plan your trip", "Book direct", "See pricing" |
| **Unique per page** (across site + locales) | Duplicate meta = Google ignores and uses page text fragment |
| **No brand suffix** (don't append "— Bobby Safaris") — the `<title>` already has it | Saves ~15 chars for substance |
| **Sentence case**, not Title Case | Reads natural |
| **No emojis** unless brand voice allows (SAFA only) | Mobile SERP pulls them in; lux brands omit |

## Procedure

1. **Gather context:**
   - Page H1 + first H2s
   - Primary target keyword (check GSC "Performance" for queries ranking top 20)
   - The site's voice (invoke `site-voice-<slug>` skill for tone)
   - Competitor meta on same query (quick `curl` + grep of SERP is fine)

2. **Draft 3 variants** using this template:
   ```
   [Action/Position statement with keyword]. [Proof point / differentiator]. [CTA verb].
   ```
   
   Example for bobby-safaris homepage:
   > "Tanzania's oldest ultra-luxury safari operator since 1978. Four generations, zero brokers, 4,067 TripAdvisor 5★ reviews. Contact Don directly."
   (157 chars ✓)

3. **Score each on:**
   - Character count (must be 148–162)
   - Keyword presence (primary + 1 variant)
   - CTR triggers: numbers, year, guarantee words, superlatives backed by proof
   - Voice match (use `site-voice-<slug>` to check)
   - Truthfulness — no claims the site can't back up

4. **Pick winner + log to ticket:**

   ```
   ## Meta for /itineraries/serengeti-7-days
   
   Primary keyword: "serengeti safari 7 days"
   Secondary: "private serengeti itinerary"
   
   Final: "Private 7-day Serengeti safari with your own Land Cruiser, guide, and bush camp. No shared vehicles, no fixed dates. From $8,200. Inquire direct."
   Chars: 156 ✓
   ```

5. **For multi-locale:** write the English first, then have native-speaker or high-quality MT translate, keeping the keyword + CTA verb. Don't just auto-translate — check character count per language (German typically 15-20% longer).

## Anti-patterns (reject these drafts)

- "Welcome to [site]" / "Home of [brand]" — wastes chars, says nothing.
- Generic "We offer" / "Our services include" — low CTR.
- Keyword stuffing: "Tanzania safari, Tanzania tours, Tanzania holidays, Tanzania safari" — Google penalizes.
- >160 chars — will be truncated mid-word. Unacceptable.
- Duplicate across pages — worse than having none.
- Starting with the brand name — brand already in title tag.

## Site-specific defaults

| Site | Voice anchor | Typical structure |
|---|---|---|
| bobbysafaris.com | Ultra-luxury, heritage, 1978, family | "[Superlative] [offering] since 1978. [Proof point]. [Direct-contact CTA]." |
| safaris-tanzania.com | Direct-operator, warm-confident | "[Differentiator vs brokers]. [Specific detail]. [Plan CTA]." |
| magicaltanzania.com | Editorial, unbiased, transparent | "[Insight hook]. [Transparency claim]. [See/Read CTA]." |
| safari-kilimanjaro.com | Adventure + combo + WhatsApp | "[Kili+Safari combo hook]. [Price-from OR duration]. [WhatsApp CTA]." |
| mountkilimanjaroclimb.com | Bold, athletic, data-confident, success-rate | "[Route/stat hook]. [Success rate %]. [Plan route CTA]." |

## Audit mode (bulk)

When running a site-wide meta audit:
1. Pull sitemap.xml
2. For each URL, fetch and extract `<meta name="description">`
3. Flag: missing, <120 chars, >160 chars, duplicate (exact match), keyword-stuffed, generic
4. Prioritize fixes by GSC impressions (high-traffic + low-CTR = biggest ROI)
5. Report top 20 to fix in ticket, file per-page PRs for content agent

## Related skills

- `site-voice-<slug>` — tone/brand rules per site
- `gsc-audit` — pulls CTR data to prioritize which pages to rewrite
- `schema-org-validator` — the `description` field in JSON-LD often should match meta description (but can be longer)

## Budget

$0.05–0.10 per meta drafted. $2–3 for a full site audit (100+ pages).
