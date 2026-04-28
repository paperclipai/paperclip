---
name: gsc-audit
description: Audit Google Search Console data for a Bobby Tours site to find ranking opportunities, coverage issues, and CTR problems. Use for weekly SEO routine, post-deploy verification, or when diagnosing traffic drops.
---

# Google Search Console Audit

## Access method

GSC API access requires a service-account JSON key. The user has set this up at:
- Key file: `/root/.gsc/service-account.json` (check with `ls /root/.gsc/` — if missing, flag in ticket and escalate to CEO)
- Authorized domains: each of the 5 Bobby Tours brand domains

If API key is missing, **fallback to CSV exports** — ask operator to download a CSV from https://search.google.com/search-console → Performance → Export and attach to the ticket.

## Procedure (API path)

1. **Authenticate:**
   ```bash
   export GOOGLE_APPLICATION_CREDENTIALS=/root/.gsc/service-account.json
   ```

2. **Query performance data** (last 28 days):
   ```bash
   python3 -c "
   from google.oauth2 import service_account
   from googleapiclient.discovery import build
   creds = service_account.Credentials.from_service_account_file('/root/.gsc/service-account.json', scopes=['https://www.googleapis.com/auth/webmasters.readonly'])
   svc = build('searchconsole', 'v1', credentials=creds)
   body = {'startDate': '2026-03-22', 'endDate': '2026-04-19', 'dimensions': ['page','query'], 'rowLimit': 1000}
   r = svc.searchanalytics().query(siteUrl='sc-domain:<DOMAIN>', body=body).execute()
   import json; print(json.dumps(r['rows'][:50], indent=2))
   "
   ```
   Replace `<DOMAIN>` with the site being audited (e.g. `bobbysafaris.com`).

3. **Pull these four reports in order:**
   - **Top pages** (dimension: page, metrics: clicks, impressions, ctr, position)
   - **Top queries** (dimension: query)
   - **Low-CTR high-impression** (filter CTR<2%, impressions>100) — these are meta-description rewrite candidates
   - **Coverage / Index status** via `urlInspection.inspect`

4. **Analyze — look for:**
   - **Zero-click pages** (impressions > 100, clicks = 0) → meta description problem. Route to `meta-description-writer`.
   - **Position 11-20 pages** (`position` between 11 and 20) → "page 2 pages", biggest ranking opportunity. Internal linking + content depth.
   - **Declining pages** (compare to prior 28 days) — flag any with >30% clicks drop.
   - **Impression declines** — possible deindexation, CWV regression, algorithm hit. Cross-check with `core-web-vitals-audit`.
   - **High-impression keywords site doesn't have a dedicated page for** → content gap, file ticket for content agent.
   - **Low-quality queries** (irrelevant, competitor-brand, adult/spam) → usually harmless but flag if >5% of impressions.

5. **Report format:**

   ```
   ## GSC Audit — <domain> (last 28 days)
   
   ### Overview
   | Metric | Value | Δ vs prior 28d |
   |---|---|---|
   | Clicks | 12,430 | +8% |
   | Impressions | 287,500 | +12% |
   | CTR | 4.32% | -0.3pts |
   | Position (avg) | 24.1 | -1.4 |
   
   ### Top 10 zero-click pages (meta rewrite candidates)
   | URL | Impressions | CTR | Top query |
   |---|---|---|---|
   | /itineraries/grumeti | 1,240 | 0% | "grumeti reserve tanzania" |
   ...
   
   ### Page 2 opportunities (position 11-20)
   | URL | Query | Position | Path to fix |
   |---|---|---|---|
   | /best-safari-company | "best tanzania safari" | 14 | +300 words, +3 internal links |
   
   ### Content gaps (high impressions, no matching page)
   - "tanzania honeymoon safari cost" (2,100 imps → file content ticket)
   
   ### Declining pages >30%
   - None
   
   ### Action items
   - [ ] Route 5 meta rewrites to content agent
   - [ ] 3 content gap pages → file briefs with content agent
   - [ ] 1 CWV regression → file ticket with coder
   ```

## Common issues

- GSC data is 2-3 days delayed — always query with `endDate` = 3 days ago.
- Branded queries inflate CTR. Segment: queries containing brand name vs not.
- "Mobile" vs "Desktop" can differ wildly. Run both.
- sc-domain vs sc-site — use `sc-domain:` for domain-wide property (covers all subdomains), `https://domain/` for URL-prefix property (exact match only).

## Pitfalls

- If API returns empty, check the service account email is added as Owner/Full on that property in GSC.
- `dimensions` max 3. Combine page+query carefully — reduces row limit.
- Page dimension filter: use `pageContains` or full URL with protocol. Partial URLs without protocol will return zero rows.

## Related skills

- `meta-description-writer` — downstream of "zero-click pages" finding
- `schema-org-validator` — GSC "Enhancements" section maps to schema issues
- `core-web-vitals-audit` — GSC "Page Experience" report
- `hreflang-consistency-check` — GSC "International Targeting" report flags hreflang errors
- `content-brief-template` — turn "content gap" findings into briefs

## Budget

$0.30–$0.80 per full-site audit (API calls are free; cost is in reading + interpreting 1000+ rows).
