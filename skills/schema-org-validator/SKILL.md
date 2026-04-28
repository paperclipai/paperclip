---
name: schema-org-validator
description: Validate JSON-LD structured data on Bobby Tours site pages (TouristTrip, FAQPage, BreadcrumbList, LocalBusiness, etc.) against schema.org. Use when shipping new pages, reviewing PRs touching metadata, or investigating missing rich results in Google.
---

# Schema.org Validator

## When to use

- Before merging any PR that touches `app/**/layout.{ts,tsx}`, `app/**/page.{ts,tsx,jsx}`, or components rendering `<script type="application/ld+json">`.
- When a page drops out of Google Rich Results or shows "missing fields" warnings in GSC.
- Before publishing a new itinerary / tour / route page.
- As part of the weekly SEO routine.

## Schemas we use across the 5 sites

| Page type | Primary schema | Required fields |
|---|---|---|
| Homepage | `Organization`, `WebSite`, `SearchAction` | name, url, logo, sameAs |
| Itinerary / tour detail | `TouristTrip` | name, description, itinerary, touristType, offers.price/priceCurrency |
| Park / destination | `TouristDestination` | name, description, geo.latitude/longitude, containsPlace |
| FAQ sections | `FAQPage` | mainEntity[].name, mainEntity[].acceptedAnswer.text |
| Breadcrumbs | `BreadcrumbList` | itemListElement[].position, item.@id, item.name |
| Local operator | `TravelAgency` or `LocalBusiness` | name, url, logo, contactPoint, address |
| Reviews | `AggregateRating` (on parent) | ratingValue, reviewCount, bestRating |

## Procedure

1. **Extract JSON-LD from the target URL:**
   ```
   curl -sL "https://<domain>/<path>" | grep -oP '(?<=<script type="application/ld\+json">).*?(?=</script>)' | jq .
   ```

2. **Validate structure per schema type:**
   - Required fields present and non-empty
   - `@context` = `"https://schema.org"`
   - `@type` matches page intent
   - No deprecated properties (e.g. `priceValidUntil` on offers requires ISO date)
   - `url` fields absolute, not relative

3. **Run Google's Rich Results Test API** (public, no key needed for sampled runs):
   ```
   curl -sS -X POST "https://searchconsole.googleapis.com/v1/urlTestingTools/mobileFriendlyTest:run" \
     -d '{"url":"https://<domain>/<path>"}' 
   ```
   NOTE: Rich Results API endpoint varies — fall back to manual inspection at https://search.google.com/test/rich-results?url=<URL> if API path drifts.

4. **Cross-check with GSC "Enhancements" reports** — if `gsc-audit` is available, pull any "Invalid" or "Valid with warnings" entries for this page and match them to your JSON-LD output.

5. **Common issues + fixes:**
   - Missing `offers.price` on TouristTrip → breaks Rich Results. Add `offers: { "@type": "Offer", "price": "X,XXX", "priceCurrency": "USD", "availability": "https://schema.org/InStock" }`
   - BreadcrumbList with relative `item.@id` → absolute URLs required. Use `hreflangAlternates` helper or site's `absoluteUrl()` util.
   - FAQPage with `<p>` tags inside `acceptedAnswer.text` → plain text only (or use proper CDATA). Strip HTML before passing to JSON-LD.
   - Multiple `WebSite` schemas on homepage (layout + page-level) → pick one. Layout-level is typical.

6. **Report format (ticket comment):**

   ```
   ## Schema.org validation — <URL>
   Found schemas: Organization, WebSite, TouristTrip
   
   ### ✅ Organization
   All required fields present.
   
   ### ⚠ TouristTrip
   Missing: offers.priceCurrency
   Deprecated: uses `areaServed` on non-Service schema
   
   ### Action items
   - [ ] Add priceCurrency on /app/itineraries/serengeti-7-days/page.tsx line 42
   - [ ] Remove areaServed (harmless but wasted bytes)
   ```

## Pitfalls

- `jq` fails if the JSON-LD has unescaped newlines in `description`. Strip with `tr -d '\n'` first.
- Next.js can emit MULTIPLE JSON-LD blocks (one from layout.tsx, one from page.tsx). Parse all.
- Nested `@graph` arrays are the modern way — don't flag them as wrong. Individual types inside `@graph` each need their own required fields.
- Schema changes take 24-72h to reflect in Google's Rich Results Test. Use live JSON-LD for the source of truth.

## Site-specific notes

- `bobbysafaris.com` — ultra-luxury positioning, `TravelAgency` primary, 4,067 reviews hardcoded in AggregateRating
- `magicaltanzania.com` — editorial brand, uses `Article` schema on blog-style destination pages
- `safari-kilimanjaro.com` — `TouristTrip` with combined Kili+Safari as single trip, multi-activity
- `mountkilimanjaroclimb.com` — per-route schema (Machame, Marangu, Rongai, Lemosho, Umbwe, Northern)
- `safaris-tanzania.com` — `TravelAgency` with sub-tours, 11-locale LocalBusiness variants

## Related skills

- `meta-description-writer` — the `description` field in schema often mirrors meta description
- `gsc-audit` — GSC flags schema errors in Enhancements section
- `hreflang-consistency-check` — multi-locale sites need schema in each locale's language

## Budget

$0.05–0.20 per page audit. Cheap.
