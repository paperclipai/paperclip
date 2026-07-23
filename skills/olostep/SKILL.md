---
name: olostep
description: >
  Scrape webpages, search Google, crawl sites, batch-scrape URLs, map site
  structure, and get AI-powered answers using the Olostep API. Use when your
  task requires fetching live web content — research, competitor analysis,
  documentation scraping, error debugging, data extraction, or any work that
  needs real-time information from the internet. Do NOT use for Paperclip
  coordination (use the paperclip skill for that).
---

# Olostep Web Skill

You can fetch live web content during your heartbeat using the Olostep API. This skill covers scraping, searching, crawling, batch processing, site mapping, AI-powered answers, and structured data extraction.

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
curl -sS -X POST "https://api.olostep.com/v1/scrapes" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url_to_scrape": "https://example.com/page",
    "formats": ["markdown"]
  }'
```

**Response** (key fields):
```json
{
  "id": "scrape_abc123",
  "object": "scrape",
  "result": {
    "markdown_content": "# Page Title\n\nExtracted content...",
    "html_content": null,
    "text_content": null,
    "json_content": null,
    "markdown_hosted_url": "https://olostep-storage.s3.amazonaws.com/...",
    "links_on_page": [],
    "page_metadata": { "status_code": 200, "title": "Page Title" }
  }
}
```

The content is inside `result.markdown_content` (or `result.html_content`, `result.text_content`, etc. depending on which formats you requested).

**Parameters:**
| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `url_to_scrape` | Yes | — | URL to scrape |
| `formats` | Yes | — | Array of: `markdown`, `html`, `text`, `json`, `raw_pdf`, `screenshot` |
| `country` | No | — | Country code for geo-targeted scraping (e.g., `US`, `GB`, `IN`) |
| `wait_before_scraping` | No | `0` | Milliseconds to wait for JS rendering (0–10000) |
| `parser` | No | — | Parser object `{"id": "@olostep/google-search"}` for structured JSON |
| `llm_extract` | No | — | Object with `schema` and/or `prompt` for LLM-based extraction |
| `remove_css_selectors` | No | `default` | `default`, `none`, or stringified array of selectors to remove |
| `actions` | No | — | Array of page actions: `wait`, `click`, `fill_input`, `scroll` |

**When to use:** Single page content extraction — docs pages, articles, product pages, profiles.

**Tips:**
- Use `formats: ["markdown"]` for cleanest LLM-ready output (content in `result.markdown_content`)
- For JavaScript-heavy SPAs, set `wait_before_scraping: 2000`
- Use specialized parsers for structured JSON (see Section 2)
- Request multiple formats at once: `formats: ["markdown", "html"]`

---

## 2. Search Google

Search Google by scraping a Google search URL with the `@olostep/google-search` parser. There is no separate search endpoint — search is done through the scrapes endpoint.

```sh
curl -sS -X POST "https://api.olostep.com/v1/scrapes" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url_to_scrape": "https://www.google.com/search?q=best+AI+orchestration+frameworks+2026&gl=us&hl=en",
    "formats": ["json"],
    "parser": {"id": "@olostep/google-search"}
  }'
```

**Response** (key fields):
```json
{
  "id": "scrape_xyz789",
  "object": "scrape",
  "result": {
    "json_content": "{\"searchParameters\":{...},\"organic\":[{\"title\":\"...\",\"link\":\"...\",\"snippet\":\"...\"},...],\"peopleAlsoAsk\":[...],\"relatedSearches\":[...]}",
    "json_hosted_url": "https://olostep-storage.s3.amazonaws.com/..."
  }
}
```

The `result.json_content` is a **stringified JSON string** — parse it to get:
- `searchParameters`: query info
- `knowledgeGraph`: entity info (when available)
- `organic`: array of `{title, link, position, snippet}` results
- `peopleAlsoAsk`: related questions
- `relatedSearches`: suggested follow-up queries

**How to construct the Google URL:**
- Base: `https://www.google.com/search?q=YOUR+QUERY`
- Add `&gl=us` for country (use ISO codes: `us`, `gb`, `de`, `in`, etc.)
- Add `&hl=en` for language
- URL-encode the query (replace spaces with `+`)

**When to use:** Research questions, finding docs, competitive analysis, debugging errors.

**Tips:**
- Use specific, descriptive queries for best results
- Combine with scrape to get full content from interesting results
- For error debugging, search the exact error message in quotes
- The `organic` array gives you titles, URLs, and snippets of top results

---

## 3. Crawl a Website

Start an async crawl that discovers and scrapes pages by following links. Crawls run in the background — poll for results.

```sh
# Start the crawl
curl -sS -X POST "https://api.olostep.com/v1/crawls" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "start_url": "https://docs.example.com",
    "max_pages": 10
  }'
```

**Response:**
```json
{
  "id": "crawl_abc123",
  "object": "crawl",
  "status": "in_progress",
  "pages_count": 0
}
```

**Check status:**
```sh
curl -sS "https://api.olostep.com/v1/crawls/CRAWL_ID" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY"
```

**Get crawled pages** (once `status` is `completed`):
```sh
curl -sS "https://api.olostep.com/v1/crawls/CRAWL_ID/pages?limit=10" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY"
```

Pages response returns `retrieve_id` per page. Use `/v1/retrieve?retrieve_id=RETRIEVE_ID&formats=markdown` to get the actual content.

**Parameters:**
| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `start_url` | Yes | — | Starting URL |
| `max_pages` | Yes | — | Maximum pages to crawl |
| `include_urls` | No | `["/**"]` | Glob patterns for URLs to include (e.g., `["/blog/**"]`) |
| `exclude_urls` | No | — | Glob patterns for URLs to exclude (e.g., `["/admin/**"]`) |
| `max_depth` | No | — | Maximum link depth from start URL |
| `include_external` | No | `false` | Whether to crawl first-degree external links |
| `search_query` | No | — | Sort crawled pages by relevance to this query |
| `top_n` | No | — | Only follow top N most relevant links per page |
| `timeout` | No | — | End crawl after N seconds |

**When to use:** Ingesting documentation sites, blog archives, product catalogs.

**Tips:**
- Crawls are **async** — you must poll `/v1/crawls/{id}` until `status: "completed"`
- Start with `max_pages: 10` to test, then increase
- Use `map` first to understand site structure before crawling
- Use `include_urls` to limit crawling to relevant sections

---

## 4. Batch Scrape URLs

Scrape up to 10,000 URLs in a single parallel batch. Batches run async — poll for results.

```sh
curl -sS -X POST "https://api.olostep.com/v1/batches" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "items": [
      {"url": "https://example.com/page1", "custom_id": "page1"},
      {"url": "https://example.com/page2", "custom_id": "page2"}
    ]
  }'
```

**Response:**
```json
{
  "id": "batch_abc123",
  "object": "batch",
  "status": "in_progress",
  "total_urls": 2,
  "completed_urls": 0
}
```

**Check status:**
```sh
curl -sS "https://api.olostep.com/v1/batches/BATCH_ID" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY"
```

**Get results** (once `status` is `completed`):
```sh
curl -sS "https://api.olostep.com/v1/batches/BATCH_ID/items?limit=10" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY"
```

Items response returns `retrieve_id` per item. Use `/v1/retrieve?retrieve_id=RETRIEVE_ID&formats=markdown` to get content.

**Parameters:**
| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `items` | Yes | — | Array of `{"url": "...", "custom_id": "..."}` objects (1–10,000) |
| `country` | No | — | Country code |
| `parser` | No | — | Parser object for structured extraction, e.g. `{"id": "@olostep/google-search"}` |

**When to use:** Large-scale extraction — scraping many product pages, directory listings, documentation sets.

**Tips:**
- Batches are **async** (usually 5–8 minutes regardless of size)
- Use `custom_id` to label URLs for easier result tracking
- Combine with `map` to discover URLs first, then batch them
- Use parser for structured JSON output at scale

---

## 5. Map a Website

Discover all URLs on a website without scraping their content. Synchronous — returns immediately.

```sh
curl -sS -X POST "https://api.olostep.com/v1/maps" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "include_urls": ["/blog/**"],
    "top_n": 50
  }'
```

**Response:**
```json
{
  "id": "map_abc123",
  "urls_count": 50,
  "urls": [
    "https://example.com/blog/post-1",
    "https://example.com/blog/post-2"
  ],
  "cursor": null
}
```

If `cursor` is not null, pass it in the next request to get more URLs.

**Parameters:**
| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `url` | Yes | — | Website to map |
| `search_query` | No | — | Sort URLs by relevance to this query |
| `top_n` | No | — | Limit number of URLs returned |
| `include_urls` | No | — | Glob patterns to include (e.g., `["/blog/**"]`) |
| `exclude_urls` | No | — | Glob patterns to exclude (e.g., `["/admin/**"]`) |
| `include_subdomain` | No | `true` | Whether to include subdomains |
| `cursor` | No | — | Pagination cursor from previous response |

**When to use:** Site analysis, content auditing, planning before a crawl or batch scrape.

---

## 6. AI-Powered Answers

Get web-sourced answers with citations. Optionally provide a JSON schema for structured output. Synchronous.

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
    "json_format": {"company": "", "founders": [], "total_funding": "", "last_round": ""}
  }'
```

**Response:**
```json
{
  "id": "answer_abc123",
  "object": "answer",
  "result": {
    "json_content": "{\"company\": \"Paperclip\", \"founders\": [...], ...}",
    "json_hosted_url": "https://olostep-storage.s3.amazonaws.com/...",
    "sources": ["https://example.com/article1", "https://example.com/article2"]
  }
}
```

The `result.json_content` is a stringified JSON string matching your schema. `result.sources` lists the URLs used.

**Parameters:**
| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `task` | Yes | — | Question or research task |
| `json_format` | No | — | JSON schema for structured output (object with empty values as template) |

**When to use:** Research, fact-checking, competitive analysis, gathering structured web intelligence.

---

## 7. Extract Structured Data

Three approaches, from simplest to most powerful:

### Option A: LLM Extraction (simplest)

Use the scrapes endpoint with `llm_extract` to extract structured data in one call:

```sh
curl -sS -X POST "https://api.olostep.com/v1/scrapes" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url_to_scrape": "https://example.com/product",
    "formats": ["json"],
    "llm_extract": {
      "schema": {"name": "", "price": "", "rating": 0, "features": []}
    }
  }'
```

Response: `result.json_content` contains the extracted structured JSON.

### Option B: Answers endpoint (quick research + extraction)

```sh
curl -sS -X POST "https://api.olostep.com/v1/answers" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Extract product details from https://example.com/product",
    "json_format": {"name": "", "price": "", "rating": 0, "features": []}
  }'
```

### Option C: Scrape + LLM reasoning (most control)

```sh
# Step 1: Scrape the page
RESPONSE=$(curl -sS -X POST "https://api.olostep.com/v1/scrapes" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url_to_scrape": "https://example.com/product", "formats": ["markdown"]}')

# Step 2: The response is JSON. Extract the markdown content:
# MARKDOWN=$(echo "$RESPONSE" | jq -r '.result.markdown_content')
# Then use your own LLM reasoning to extract fields from the markdown.
```

**When to use:** Database seeding, building directories, extracting product data, parsing profiles.

**Tips:**
- LLM extraction (`llm_extract`) costs 20 credits vs 1 credit for plain scrape
- Use parsers (e.g., `@olostep/google-search`, `@olostep/amazon-it-product`) for known site types — faster and cheaper
- Use `null` for missing fields — never hallucinate data
- For many URLs, batch first, then retrieve each result

---

## Retrieving Content by ID

Crawl and batch results return a `retrieve_id` per page/item. Use this endpoint to get the actual content:

```sh
curl -sS "https://api.olostep.com/v1/retrieve?retrieve_id=RETRIEVE_ID&formats=markdown" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY"
```

---

## Common Workflows

### Research a topic for your task
1. **Search Google** via scrapes with `@olostep/google-search` parser to find sources
2. **Scrape** the most relevant result URLs for full content
3. Synthesize findings into your task deliverable

### Ingest documentation for code work
1. **Map** the docs site to discover all pages
2. **Crawl** or **batch** the relevant sections
3. Retrieve content via `/v1/retrieve` and use it

### Debug an error
1. **Search Google** for the exact error message
2. **Scrape** GitHub issues, Stack Overflow answers, or official docs
3. Apply the fix to your codebase

### Competitive analysis
1. **Answers** with a structured `json_format` for quick comparison
2. **Scrape** competitor landing pages for deeper analysis
3. Compile into a comparison report

---

## Available Parsers

Use with `"parser": {"id": "PARSER_ID"}` and `"formats": ["json"]` in scrapes or batches:

| Parser ID | Use Case |
|-----------|----------|
| `@olostep/google-search` | Google search results (organic, knowledge graph, PAA) |
| `@olostep/amazon-it-product` | Amazon product pages |
| `@olostep/extract-emails` | Extract email addresses from pages |
| `@olostep/extract-calendars` | Extract calendar/event data |
| `@olostep/extract-socials` | Extract social media links |

---

## Critical Rules

- Always check that `$OLOSTEP_API_KEY` is available before making requests.
- Use `formats: ["markdown"]` by default — it's the most token-efficient for LLM processing.
- Response content is inside `result.markdown_content` (or `result.html_content`, etc.) — not a top-level field.
- Crawls and batches are **async** — poll their status endpoint before fetching results.
- Do not scrape pages unnecessarily. Only fetch what your current task actually needs.
- Report any API errors (rate limits, auth failures) in your task comment so your manager can investigate.
- This skill is for fetching web data. Use the **paperclip** skill for task coordination, and do your actual domain work (coding, writing, analysis) separately.

## Full Reference

For complete API documentation and additional parameters, see:
`skills/olostep/references/api-reference.md`
