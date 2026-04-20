---
name: web-research
description: >
  Search the web, read pages, and extract information. Use for any task
  requiring live web data: research, news, competitor analysis, contact finding,
  fact checking, reading documentation, or scraping public pages.
---

# Web Research Skill

Four tools available. Pick the right one for the job.

---

## Tools

### 1. DuckDuckGo (`duckduckgo`) — free, no key, always works
```
duckduckgo_search query="..." max_results=5
```

### 2. Brave Search (`brave-search`) — better results, needs BRAVE_API_KEY
```
brave_web_search query="..." count=5
```

### 3. Fetch (`fetch`) — read any URL as text/markdown
```
fetch url="https://example.com/page" method="GET"
```

### 4. Playwright (`playwright`) — full browser, JS-rendered sites
```
browser_navigate url="https://example.com"
browser_snapshot
browser_click element="..."
browser_type element="..." text="..."
```

### 5. Hunter (`hunter`) — verified B2B email database (50 searches/mo)
```
hunter_find_email first_name="John" last_name="Smith" domain="company.com"
hunter_search_domain domain="company.com"
hunter_discover domain="company.com"
hunter_enrich_company domain="company.com"
hunter_verify_email email="john@company.com"
```

---

## When to use which

| Task | Tool |
|------|------|
| Search a topic, find URLs | duckduckgo → brave |
| Read a specific page | fetch |
| JS-heavy site, needs login | playwright |
| Find someone's email | fetch site first → duckduckgo → hunter |
| Verify email before sending | hunter_verify_email |
| Get company background | fetch their site → hunter_enrich_company |
| News / recent events | duckduckgo with year in query |
| LinkedIn profile | playwright (fetch gets blocked) |
| Read documentation | fetch |
| Check if a fact is true | duckduckgo → fetch source |

---

## General Search Pattern

```
1. duckduckgo_search query="[topic]" max_results=5
2. Pick best URL from results
3. fetch url="[URL]"
4. Extract what you need
5. If page blocked/empty → playwright instead
```

## Deep Research Pattern

```
1. duckduckgo_search query="[topic] overview"           → get broad picture
2. duckduckgo_search query="[topic] [specific aspect]"  → drill down
3. fetch top 2-3 URLs → read full content
4. Synthesise findings
```

## Company Research Pattern

```
1. duckduckgo_search query="[Company] official site"
2. fetch homepage → get overview
3. fetch /about, /team, /services, /news
4. hunter_enrich_company domain="[domain]" → size, industry, description
5. duckduckgo_search query="[Company] news 2025 2026" → recent events
```

## Contact Finding Pattern

```
1. duckduckgo_search query="[Company] official site" → get domain
2. fetch [domain]/contact, /team, /about → look for email on page
3. If not found: hunter_find_email first_name last_name domain
4. If not found: hunter_search_domain domain → all known emails
5. hunter_verify_email → confirm before sending
```

## Competitor Research Pattern

```
1. duckduckgo_search query="[competitor] pricing features reviews"
2. fetch their pricing/features page
3. duckduckgo_search query="[competitor] vs [us] site:reddit.com OR site:g2.com"
4. fetch those review pages
5. Summarise strengths, weaknesses, positioning
```

---

## Rules

- **Start with duckduckgo** — free, no limits, good enough for most tasks.
- **fetch before playwright** — fetch is 10x faster; use playwright only when fetch fails.
- **Hunter is rate-limited** — 50 searches/month. Web scrape first, Hunter as fallback.
- **Be specific in queries** — add year, location, or site: to narrow results.
- **Max 3 search iterations** — if not found in 3 attempts, state what was found and move on.
- **Cite sources** — always record the URL where info was found.
