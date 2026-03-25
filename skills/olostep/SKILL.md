---
name: olostep
description: >
  Scrape webpages, search the web, crawl sites, batch-scrape URLs, map site
  structure, and extract structured data using the Olostep API. Use when your
  task requires fetching live web content — research, competitor analysis,
  documentation scraping, error debugging, data extraction, or any work that
  needs real-time information from the internet. Do NOT use for Paperclip
  coordination (use the paperclip skill for that).
---

# Olostep Web Skill

You can fetch live web content during your heartbeat using the Olostep API. This skill covers scraping, searching, crawling, batch processing, site mapping, and structured data extraction.

## Authentication

Every request requires your API key via the `Authorization` header:

```
Authorization: Bearer $OLOSTEP_API_KEY
```

The base URL for all endpoints is `https://api.olostep.com/v1`.

If `OLOSTEP_API_KEY` is not set in your environment, stop and report this to your manager — the board needs to configure it in your adapter environment.

---

## 1. Scrape a Single Page

Extract content from any URL as markdown, HTML, JSON, or text. Handles JavaScript rendering and anti-bot protections automatically.

```sh
curl -sS -X POST "https://api.olostep.com/v1/scrape" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/page",
    "output_format": "markdown"
  }'
```

**Parameters:**
| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `url` | Yes | — | URL to scrape |
| `output_format` | No | `markdown` | `markdown`, `html`, `json`, or `text` |
| `country` | No | — | Country code for geo-targeted scraping (e.g., `US`, `GB`) |
| `wait_before_scraping` | No | `0` | Milliseconds to wait for JS rendering (0–10000) |
| `parser` | No | — | Specialized parser ID (e.g., `@olostep/amazon-product`) |

**When to use:** Single page content extraction — docs pages, articles, product pages, profiles.

**Tips:**
- Use `markdown` format for cleanest LLM-ready output
- For JavaScript-heavy SPAs, set `wait_before_scraping: 2000`
- Use specialized parsers for Amazon, LinkedIn, etc.

---

## 2. Search the Web

Search the web and get structured results with content.

```sh
curl -sS -X POST "https://api.olostep.com/v1/search" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "best AI orchestration frameworks 2026",
    "country": "US"
  }'
```

**Parameters:**
| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `query` | Yes | — | Search query |
| `country` | No | `US` | Country code for localized results |

**When to use:** Research questions, finding docs, competitive analysis, debugging errors.

**Tips:**
- Use specific, descriptive queries for best results
- Combine with scrape to get full content from interesting results
- For error debugging, search the exact error message in quotes

---

## 3. Crawl a Website

Autonomously discover and scrape pages by following links from a starting URL.

```sh
curl -sS -X POST "https://api.olostep.com/v1/crawl" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "start_url": "https://docs.example.com",
    "max_pages": 10,
    "output_format": "markdown"
  }'
```

**Parameters:**
| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `start_url` | Yes | — | Starting URL |
| `max_pages` | No | `10` | Maximum pages to crawl |
| `follow_links` | No | `true` | Whether to follow discovered links |
| `output_format` | No | `markdown` | `markdown`, `html`, `json`, or `text` |
| `country` | No | — | Country code for geo-targeted crawling |

**When to use:** Ingesting documentation sites, blog archives, product catalogs.

**Tips:**
- Start with `max_pages: 10` to test, then increase
- Use `map` first to understand site structure before crawling
- Set `follow_links: false` to scrape only the starting page

---

## 4. Batch Scrape URLs

Scrape up to 10,000 URLs in a single parallel operation.

```sh
curl -sS -X POST "https://api.olostep.com/v1/batch-scrape" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "urls_to_scrape": [
      {"url": "https://example.com/page1", "custom_id": "page1"},
      {"url": "https://example.com/page2", "custom_id": "page2"}
    ],
    "output_format": "markdown"
  }'
```

**Parameters:**
| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `urls_to_scrape` | Yes | — | Array of `{url, custom_id?}` objects (1–10,000) |
| `output_format` | No | `markdown` | `markdown`, `html`, `json`, or `text` |
| `country` | No | — | Country code |
| `wait_before_scraping` | No | `0` | Milliseconds to wait per URL |

**When to use:** Large-scale extraction — scraping many product pages, directory listings, documentation sets.

**Tips:**
- Use `custom_id` to label URLs for easier result tracking
- Combine with `map` to discover URLs first, then batch scrape them
- All URLs are processed in parallel for speed

---

## 5. Map a Website

Discover all URLs on a website without scraping their content. Useful for planning what to scrape or crawl.

```sh
curl -sS -X POST "https://api.olostep.com/v1/map" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "website_url": "https://example.com",
    "search_query": "blog"
  }'
```

**Parameters:**
| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `website_url` | Yes | — | Website to map |
| `search_query` | No | — | Filter URLs by keyword |
| `top_n` | No | — | Limit number of URLs returned |
| `include_url_patterns` | No | — | Glob patterns to include (e.g., `/blog/**`) |
| `exclude_url_patterns` | No | — | Glob patterns to exclude (e.g., `/admin/**`) |

**When to use:** Site analysis, content auditing, planning before a crawl or batch scrape.

---

## 6. AI-Powered Answers

Get web-sourced answers with citations. Optionally provide a JSON schema for structured output.

```sh
curl -sS -X POST "https://api.olostep.com/v1/answers" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "task": "What are the top 5 AI agent orchestration platforms in 2026?"
  }'
```

With structured output:
```sh
curl -sS -X POST "https://api.olostep.com/v1/answers" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Find the founders and funding of Paperclip AI",
    "json": {"company": "", "founders": [], "total_funding": "", "last_round": ""}
  }'
```

**Parameters:**
| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `task` | Yes | — | Question or research task |
| `json` | No | — | JSON schema for structured output |

**When to use:** Research, fact-checking, competitive analysis, gathering structured web intelligence.

---

## 7. Extract Structured Data

Scrape a page and parse it into a specific schema. Combine scrape + parsing for typed output.

**Workflow:**
1. Scrape the target URL with `output_format: markdown`
2. Parse the markdown against the desired schema
3. Output clean JSON

```sh
# Step 1: Scrape the page
CONTENT=$(curl -sS -X POST "https://api.olostep.com/v1/scrape" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/product", "output_format": "markdown"}')

# Step 2: Parse the content against your schema
# (Use your own LLM reasoning to extract fields from the markdown)
```

Alternatively, use the **answers** endpoint with a JSON schema for one-step extraction:
```sh
curl -sS -X POST "https://api.olostep.com/v1/answers" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Extract product details from https://example.com/product",
    "json": {"name": "", "price": "", "rating": 0, "features": []}
  }'
```

**When to use:** Database seeding, building directories, extracting product data, parsing profiles.

**Tips:**
- Markdown format strips HTML noise — best for extraction accuracy
- Use `null` for missing fields — never hallucinate data
- For many URLs, batch scrape first, then parse each result
- Use `wait_before_scraping: 3000` for sites with client-side rendering

---

## Common Workflows

### Research a topic for your task
1. **Search** for the topic to find relevant sources
2. **Scrape** the most relevant results for full content
3. Synthesize findings into your task deliverable

### Ingest documentation for code work
1. **Map** the docs site to discover all pages
2. **Crawl** or **batch scrape** the relevant sections
3. Use the content to write code, integrations, or summaries

### Debug an error
1. **Search** the exact error message
2. **Scrape** GitHub issues, Stack Overflow answers, or official docs
3. Apply the fix to your codebase

### Competitive analysis
1. **Answers** with a structured schema for quick comparison
2. **Scrape** competitor landing pages for deeper analysis
3. Compile into a comparison report

---

## Critical Rules

- Always check that `$OLOSTEP_API_KEY` is available before making requests.
- Use `markdown` output format by default — it's the most token-efficient for LLM processing.
- Do not scrape pages unnecessarily. Only fetch what your current task actually needs.
- Report any API errors (rate limits, auth failures) in your task comment so your manager can investigate.
- This skill is for fetching web data. Use the **paperclip** skill for task coordination, and do your actual domain work (coding, writing, analysis) separately.

## Full Reference

For complete API documentation and additional parameters, see:
`skills/olostep/references/api-reference.md`
