---
name: content-brief-template
description: Generate a structured content brief for a new Bobby Tours page (blog post, itinerary, destination, comparison, FAQ). Output is a markdown brief with H1, subheads, target keyword, CTA placement, internal links, and schema hints — ready for the content agent to draft.
---

# Content Brief Template

## When to use

- Before writing any new page (blog post, itinerary, park/destination, comparison, FAQ)
- After `gsc-audit` finds a content gap that warrants a new page
- When CEO proposes a new editorial direction
- Weekly as part of content-agent routine (one new brief per week per site)

## Brief structure

Every brief must have these 8 sections. Don't skip any.

### 1. Metadata
```yaml
---
brief_id: <YYYY-MM-DD>-<site>-<slug>
site: bobby-safaris | safaris-tanzania | magical-tanzania | safari-kilimanjaro | mount-kilimanjaro-climb
page_type: blog | itinerary | destination | comparison | faq | landing
target_url: /<slug>
locales: [en, de, es, ...]  # primary first, rest by priority
primary_keyword: "<main search query>"
secondary_keywords: ["<q2>", "<q3>"]
search_intent: informational | commercial | navigational
word_count_target: 1200 | 1800 | 2500
publish_priority: P0 | P1 | P2
---
```

### 2. Why this page exists (the wedge)

One paragraph answering: why does Bobby Tours need this page? What gap does it fill vs existing pages? What query does it rank for that we currently lose?

Evidence required — cite GSC data, competitor analysis, or CEO directive.

### 3. Target reader + intent

Who's searching this and what do they actually want?

Example:
> Luxury honeymooners (age 30-45, household income $200k+) searching "tanzania honeymoon safari" want: private tour, not shared vehicles; high-end lodges; wildlife + beach combo; 10-14 days; flexibility to extend. They're NOT shopping on price — proof of quality and trust matters more.

### 4. Structure (H1, H2s, H3s)

Outline the page with ALL headings. Show how it flows.

```markdown
# H1: <Full page title — natural language, includes primary keyword>

## H2: Section 1 — <topic>
  ### H3: <sub-topic>
  ### H3: <sub-topic>

## H2: Section 2 — <topic>

## H2: FAQs (if applicable — links to schema)

## H2: Plan your [trip/climb/safari] (CTA section)
```

### 5. Internal link quota

Minimum **3-5 internal links** to existing relevant pages. List exact target URLs.

Example:
- `/best-time-to-visit-serengeti` in H2 #1
- `/itineraries/serengeti-7-days` as primary CTA
- `/blog/wildebeest-migration-guide` in H2 #2

### 6. CTA placement

- **Primary CTA** — one, above the fold, clear verb ("Plan your trip", "Send inquiry", "See pricing"). Link to `/contact` or inquiry form modal.
- **Secondary CTA** — mid-page, different offer (e.g. "See 7-day itinerary" → related page).
- **Final CTA** — end of page, strong close, usually WhatsApp for SAFA/SAFA/MOU, direct inquiry for BOB/MAG/SAF.

Each site has its own rules — reference `site-voice-<slug>` + `lead-handoff-protocol`.

### 7. Schema hint

Which schema.org type(s) to add:
- Blog post → `BlogPosting` + `BreadcrumbList`
- Itinerary → `TouristTrip` + `BreadcrumbList` + `FAQPage` if has FAQs
- Destination → `TouristDestination` + `BreadcrumbList`
- Comparison → `Article`

Minimum required fields per type — reference `schema-org-validator` skill.

### 8. Meta + social

- **Meta description**: 150-160 chars, primary keyword in first 120, CTA verb. Reference `meta-description-writer`.
- **OG image**: 1200×630 WebP/AVIF, from site's hero library.
- **Twitter card**: summary_large_image, same OG image.

## Voice + tone

Always reference `site-voice-<slug>`. Don't start drafting without it.

## Procedure

1. **Gather inputs:**
   - Target keyword + GSC data (run `gsc-audit` for the specific keyword)
   - Competitor top-3 on this query (quick `curl` + grep titles + H2s)
   - Existing internal pages to link
   - Site voice rules

2. **Draft the 8-section brief** using the template above.

3. **Review against:**
   - Does the structure answer the user's search intent?
   - Are all CTAs natural, not forced?
   - Is there enough substance to justify the word count?
   - Does the brief assume content the site already has (not reinvent)?

4. **Deliver as ticket comment OR markdown file** in `/srv/newpaperclip/bobby-tours/<repo>/docs/briefs/<brief_id>.md`. Then assign a new ticket to the content agent to draft from the brief.

5. **Don't draft the content yourself** — briefs are for content agents. Your job ends at the brief.

## Pitfalls

- Briefs that are actually just outlines → add substance in "Why this page exists" and "Target reader".
- Keyword-stuffed briefs → Google is past this. Natural language that matches intent beats exact-match density.
- Ignoring competitor SERP → you'll ship a page that ranks #15 because it doesn't cover what the top 3 cover.
- Picking primary_keyword with <50 monthly impressions in GSC → not worth the effort. Aim for 500+ impressions opportunity.

## Related skills

- `site-voice-<slug>` — voice anchor
- `meta-description-writer` — for section 8
- `gsc-audit` — keyword data
- `schema-org-validator` — for section 7
- `lead-handoff-protocol` — for CTA section 6

## Budget

$0.20–0.50 per brief. Target 30-60 min of thinking per brief.
