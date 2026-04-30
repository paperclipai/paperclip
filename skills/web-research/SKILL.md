---
name: web-research
description: >
  Search the web, read pages, and extract information. Use for any task
  requiring live web data: research, news, competitor analysis, contact finding,
  fact checking, reading documentation, or scraping public pages.
---

# Web Research Skill

## Core Principle

**Do not stop at first result. Collect from ALL relevant sources, then reconcile.**

Real researchers cross-check. One source = guess. Three agreeing sources = fact.
Every email must be verified before use. No exceptions.

---

## Tools

### 1. DuckDuckGo (`duckduckgo` MCP) — free search, no limit
```
search query="..." max_results=5
```

### 2. Fetch (`fetch` MCP) — read known URL directly
```
fetch url="https://example.com/contact"
```
Instant, free. Use on company website, /contact, /team, /about.

### 3. Brave Search (`brave-search` MCP) — richer results
```
brave_web_search query="..." count=5
```
Only when `BRAVE_API_KEY` env var exists. Better quality than DDG for niche queries.

### 4. Apify — web scraping actors (all via `apify` MCP)

Requires `APIFY_API_KEY` env var. Four actors, each has different strengths:

#### How `apify_call_actor` works — read this first

`apify_call_actor` runs **synchronously by default**: it waits for the Actor to finish, then returns inline results. However, the inline `items` preview is **char-limited** and may be truncated. Always call `get-actor-output` after every actor call to get full results.

```
# Step 1 — call actor (sync by default, waits for finish)
apify_call_actor actorId="..."
  input={...}

# Step 2 — ALWAYS fetch full results using datasetId from step 1 response
get-actor-output  datasetId="<datasetId from response>"  limit=50
```

**`-32000: Connection closed` error** = MCP layer timed out while waiting. The Actor is still running on Apify's servers. Use `async: true` for slow actors, then poll:

```
# For slow actors (vdrmota scraper, deep crawlers) — use async mode
apify_call_actor actorId="..."
  input={...}
  async=true
→ returns runId immediately

# Poll until status is SUCCEEDED, then fetch
get-actor-output  runId="<runId from response>"  limit=50
```

**Rule:** After EVERY `apify_call_actor` call (sync or async), call `get-actor-output` before concluding the actor found nothing. Never trust the inline preview alone.

#### 4a. RAG Web Browser — general search + scrape
```
# Step 1
apify_call_actor actorId="apify/rag-web-browser"
  input={"query": "...", "maxResults": 3}

# Step 2 — always fetch full results
get-actor-output  datasetId="<datasetId>"  limit=20
```
Google search → scrapes top results → returns clean extracted text. Use for general research when DDG+fetch returns thin content.

#### 4b. Contact Details Scraper — PRIMARY contact extractor
**Actor:** `vdrmota/contact-info-scraper`

Crawls website, extracts emails, phones, LinkedIn, Twitter, Facebook, Instagram, YouTube, TikTok, Telegram, WhatsApp, Discord. Optional: lead enrichment with individual employee records + built-in email verification.

This actor can be slow (multi-page crawl + enrichment). Use `async: true` to avoid `-32000` timeout:

```
# Step 1 — use async=true for this slow actor
apify_call_actor actorId="vdrmota/contact-info-scraper"
  input={
    "startUrls": [{"url": "https://company.com"}],
    "maxPagesPerCrawl": 5,
    "maximumLeadsEnrichmentRecords": 5,
    "verifyLeadsEnrichmentEmails": true
  }
  async=true

# Step 2 — fetch full results (poll runId until SUCCEEDED)
get-actor-output  runId="<runId>"  limit=50
```

Output includes:
- `emails` — all emails found on site
- `phones` — phone numbers
- `linkedIns`, `twitters`, `facebooks`, `instagrams`, etc.
- `leadsEnrichment[]` — per-person: name, jobTitle, email, linkedinProfile, department, seniority
- `leadsEnrichment[].emailVerification` — `{result: "ok"|"invalid"|"disposable"|"catch_all"|"unknown"}`

Use `maximumLeadsEnrichmentRecords: 0` to skip enrichment (faster, cheaper). Set higher when you need individual employee contacts.

#### 4c. Fast Email + Social Extractor — quick scan
**Actor:** `logical_scrapers/extract-email-from-any-website`

Handles JS-rendered pages. Prioritises /contact, /about, /team pages automatically. Extracts emails + categorised social links.

```
# Step 1
apify_call_actor actorId="logical_scrapers/extract-email-from-any-website"
  input={"urls": ["https://company.com"]}

# Step 2 — always fetch full results
get-actor-output  datasetId="<datasetId>"  limit=20
```

Output: `emails[]`, `social_links{facebook,twitter,linkedin,instagram,...}`, `phone_numbers[]`, `scanned_pages[]`

Use when fast scan needed or `vdrmota/contact-info-scraper` is slow/overkill.

#### 4d. Deep HTML Email Crawler — thorough crawl
**Actor:** `jazzy_projector/email-scraper-apify`

Deep multi-page crawl. Scans mailto links, visible text, meta tags, HTML attributes, inline JS. Deduplicates. Records exact page where each email was found.

```
# Step 1 — use async=true for this deep/slow crawl
apify_call_actor actorId="jazzy_projector/email-scraper-apify"
  input={
    "startUrls": [{"url": "https://company.com"}],
    "maxPagesPerSite": 20,
    "proxyConfiguration": {"useApifyProxy": true}
  }
  async=true

# Step 2 — fetch full results
get-actor-output  runId="<runId>"  limit=50
```

Output per email: `email`, `foundOnPage`, `sourceUrl`, `rootDomain`, `scrapedAt`

Use when other actors missed emails or site is large with many internal pages.

### 5. Playwright (`playwright` MCP) — interactive browser
```
browser_navigate url="https://linkedin.com/in/person"
browser_snapshot
browser_click element="..."
browser_type element="..." text="..."
```

**Max 3 Playwright pages per research session.** Slow and heavy. Use for:
- LinkedIn profiles (always JS, sometimes shows email in Contact Info)
- Crunchbase / Apollo (JS-rendered company data)
- Any "Show more" / "Load more" content not accessible via scraping

### 6. Hunter (`hunter` MCP) — verified B2B email database
**Check credits first. If exhausted, skip to Apify actors above.**

```
# Check remaining credits
hunter_account_info

# Find specific person's email
hunter_find_email first_name="Jane" last_name="Doe" domain="company.com"

# All emails at domain
hunter_search_domain domain="company.com"

# Verify email
hunter_verify_email email="jane@company.com"

# Company enrichment
hunter_enrich_company domain="company.com"

# Person enrichment from email
hunter_enrich_person email="jane@company.com"

# Both in one call
hunter_enrich_combined email="jane@company.com"

# Discover companies
hunter_discover query="healthcare SaaS India 50-200 employees"
```

50 searches/month on Free plan. When `hunter_account_info` shows credits exhausted, use `vdrmota/contact-info-scraper` with `verifyLeadsEnrichmentEmails: true` as full replacement.

---

## Contact Research Pattern

**Goal: find and verify email + phone + address for a person/company.**

Do NOT stop when first source returns a hit. Run all phases.

### Phase 1 — Broad collect (run simultaneously)

```
A. search query="{person} {company} email contact" max_results=5
   fetch each promising URL (company website, press releases, bios)

B. fetch https://[company.com]/contact
   fetch https://[company.com]/about
   fetch https://[company.com]/team

C. apify_call_actor actorId="logical_scrapers/extract-email-from-any-website"
     input={"urls": ["https://company.com"]}
   → THEN: get-actor-output datasetId="<datasetId>" limit=50
   → fast scan, social links too

D. hunter_account_info → if credits available:
     hunter_find_email first_name last_name domain
     hunter_search_domain domain
   → if credits exhausted:
     apify_call_actor actorId="vdrmota/contact-info-scraper"
       input={"startUrls": [{"url": "https://company.com"}], "maximumLeadsEnrichmentRecords": 5, "verifyLeadsEnrichmentEmails": true}
       async=true
     → THEN: get-actor-output runId="<runId>" limit=50
```

### Phase 2 — Deep extract (if Phase 1 insufficient)

```
E. apify_call_actor actorId="vdrmota/contact-info-scraper"
     input={"startUrls": [{"url": "https://company.com"}], "maxPagesPerCrawl": 5,
            "maximumLeadsEnrichmentRecords": 5, "verifyLeadsEnrichmentEmails": true}
     async=true
   → THEN: get-actor-output runId="<runId>" limit=50
   → lead enrichment gives per-person email + job title + LinkedIn

F. apify_call_actor actorId="jazzy_projector/email-scraper-apify"
     input={"startUrls": [{"url": "https://company.com"}], "maxPagesPerSite": 20}
     async=true
   → THEN: get-actor-output runId="<runId>" limit=50
   → deep crawl catches emails hidden in text, JS, meta tags

G. browser_navigate url="https://linkedin.com/in/{person}"  ← Playwright
   browser_snapshot → check Contact Info section for email
   (counts toward 3-page Playwright limit)
```

### Phase 3 — Reconcile + score confidence

Collect all candidate emails found across all sources. Score each:

| Sources agreeing | Confidence |
|---|---|
| 1 source only | **LOW** — flag, must verify before use |
| 2 sources agree | **MEDIUM** — usable, note confidence |
| 3+ sources agree | **HIGH** — use confidently |

If two different emails found for same person — note both, investigate which is current (check recency of source pages).

### Phase 4 — Verify ALL emails (mandatory)

Every email must be verified before any outreach or storage.

```
PRIORITY ORDER:
1. vdrmota/contact-info-scraper with verifyLeadsEnrichmentEmails: true
   → built-in verification, results in leadsEnrichment[].emailVerification

2. hunter_verify_email email="..."  (if credits available)

3. Quote-search: search query='"jane.doe@company.com"'
   → if email appears in real documents, it exists
```

**Verification result handling:**
| Result | Action |
|---|---|
| `ok` / `accepted_email` | Use — deliverable |
| `invalid` | Drop — non-existent |
| `disposable` | Drop — temp address |
| `catch_all` | Use with LOW confidence — domain accepts all, can't confirm individual |
| `unknown` / `error` | Flag for human — could not verify |

### Phase 5 — Final output

Report:
```
email: jane.doe@company.com
  sources: [company.com/team, vdrmota scraper, hunter]
  confidence: HIGH (3 sources agree)
  verification: ok (accepted_email)

phone: +91-98765-43210
  sources: [company.com/contact, logical_scrapers actor]
  confidence: MEDIUM (2 sources agree)

address: 123 MG Road, Bengaluru 560001
  sources: [company.com/contact]
  confidence: LOW (1 source — verify manually)
```

---

## General Research Pattern

For non-contact research (news, company overview, fact-checking):

```
1. search query="[topic]" max_results=5
2. fetch top 2-3 URLs
3. If fetch thin/blocked →
     apify_call_actor actorId="apify/rag-web-browser"
       input={"query": "[topic]", "maxResults": 3}
     → THEN: get-actor-output datasetId="<datasetId>" limit=20
4. If JS-rendered and still blocked → Playwright (counts toward 3-page limit)
5. Cross-check: do 2+ sources agree on key facts?
```

---

## Company Research Pattern

```
1. search query="[Company] official site"
2. fetch homepage, /about, /team, /services
3. search query="[Company] news 2025 2026"
4. apify_call_actor actorId="apify/rag-web-browser"
     input={"query": "[Company] overview funding team", "maxResults": 3}
   → THEN: get-actor-output datasetId="<datasetId>" limit=20
5. hunter_enrich_company domain="[domain]"  ← industry, size, tech stack
   OR vdrmota/contact-info-scraper if Hunter exhausted:
     apify_call_actor actorId="vdrmota/contact-info-scraper"
       input={"startUrls": [{"url": "https://[domain]"}], "maximumLeadsEnrichmentRecords": 5}
       async=true
     → THEN: get-actor-output runId="<runId>" limit=50
6. Reconcile: note any conflicting facts, flag which source is newer
```

---

## Rules

- **Collect from ALL sources first, reconcile after** — never stop at first hit.
- **Always verify emails** — every single one, no exceptions.
- **Hunter exhausted → Apify** — `vdrmota/contact-info-scraper` with `verifyLeadsEnrichmentEmails: true` is full Hunter replacement.
- **Playwright max 3 pages per session** — slow and rate-limited; use surgically.
- **Apify requires `APIFY_API_KEY`** — never hardcode; always from env.
- **Brave only when key exists** — errors if `BRAVE_API_KEY` missing.
- **Report confidence** — always state how many sources agree, never just output an email cold.
- **Note conflicts** — if two sources disagree, surface both; don't silently pick one.
- **Cite sources** — record exact URL where each data point was found.
- **Always call `get-actor-output` after every Apify actor call** — inline preview is char-limited; full results only come from `get-actor-output`. Use `datasetId` (sync runs) or `runId` (async runs). Never conclude an actor found nothing without calling this first.
- **Use `async=true` for slow Apify actors** — `vdrmota/contact-info-scraper` and `jazzy_projector/email-scraper-apify` can take minutes. Use `async=true` to get `runId` immediately, then poll with `get-actor-output runId="..."`. This avoids `-32000: Connection closed` MCP timeout.
- **`-32000: Connection closed` recovery** — MCP layer timed out but Actor is still running on Apify servers. Call `get-actor-output runId="<runId from original call>"` to retrieve results. The `runId` is always in the actor call response even on timeout.
