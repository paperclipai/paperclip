# Olostep API Reference

Complete endpoint reference for the Olostep web scraping API. For the core skill instructions and common workflows, see the main `SKILL.md`.

**Base URL:** `https://api.olostep.com/v1`  
**Auth:** `Authorization: Bearer $OLOSTEP_API_KEY`  
**Content-Type:** `application/json`

---

## Scrape — `POST /v1/scrapes`

Extract content from a single webpage. Synchronous — returns content immediately.

### Request Body

```json
{
  "url_to_scrape": "https://example.com",
  "formats": ["markdown"],
  "country": "US",
  "wait_before_scraping": 2000,
  "remove_css_selectors": "default"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `url_to_scrape` | string | Yes | — | The webpage URL to scrape |
| `formats` | array | Yes | — | Array of: `markdown`, `html`, `text`, `json`, `raw_pdf`, `screenshot` |
| `country` | string | No | — | ISO country code for geo-targeting (e.g., `US`, `GB`, `DE`, `IN`) |
| `wait_before_scraping` | integer | No | `0` | Milliseconds to wait for JS rendering (0–10000) |
| `parser` | object | No | — | Parser for structured JSON: `{"id": "@olostep/google-search"}` |
| `llm_extract` | object | No | — | LLM extraction: `{"schema": {...}}` and/or `{"prompt": "..."}` |
| `remove_css_selectors` | string | No | `default` | `default`, `none`, or stringified array of selectors |
| `remove_images` | boolean | No | `false` | Remove images from content |
| `transformer` | string | No | — | `postlight` or `none` — HTML transformer |
| `actions` | array | No | — | Page interactions before scraping (see Actions below) |
| `links_on_page` | object | No | — | Get links on page: `{"absolute_links": true}` |
| `screen_size` | object | No | — | `{"screen_type": "desktop"}` or custom width/height |

### Available Parsers

| Parser ID | Use Case |
|-----------|----------|
| `@olostep/google-search` | Google search results (structured SERP data) |
| `@olostep/amazon-it-product` | Amazon product pages |
| `@olostep/extract-emails` | Extract email addresses |
| `@olostep/extract-calendars` | Extract calendar/event data |
| `@olostep/extract-socials` | Extract social media links |

### Page Actions

Array of actions to perform before scraping (e.g., clicking "Load More"):

```json
"actions": [
  {"type": "wait", "milliseconds": 2000},
  {"type": "click", "selector": "#load-more"},
  {"type": "fill_input", "selector": "#search", "value": "query"},
  {"type": "scroll", "direction": "down", "amount": 500}
]
```

### Response

```json
{
  "id": "scrape_6h89o8u1kt",
  "object": "scrape",
  "created": 1745673871,
  "metadata": {},
  "retrieve_id": "6h89o8u1kt",
  "url_to_scrape": "https://example.com",
  "result": {
    "html_content": null,
    "markdown_content": "# Page Title\n\nExtracted content...",
    "text_content": null,
    "json_content": null,
    "screenshot_hosted_url": null,
    "html_hosted_url": null,
    "markdown_hosted_url": "https://olostep-storage.s3.us-east-1.amazonaws.com/markDown_6h89o8u1kt.txt",
    "json_hosted_url": null,
    "text_hosted_url": null,
    "links_on_page": [],
    "page_metadata": {
      "status_code": 200,
      "title": "Page Title"
    }
  }
}
```

Content is in `result.markdown_content`, `result.html_content`, `result.text_content`, or `result.json_content` depending on which formats you requested. Fields for unrequested formats are `null`. If content is large, use the `*_hosted_url` fields to fetch it.

### Example

```sh
curl -sS -X POST "https://api.olostep.com/v1/scrapes" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url_to_scrape": "https://docs.paperclip.ing/guides/getting-started",
    "formats": ["markdown"],
    "wait_before_scraping": 2000
  }'
```

---

## Google Search — via `POST /v1/scrapes`

There is no separate search endpoint. Search Google by scraping a Google URL with the `@olostep/google-search` parser.

### Request Body

```json
{
  "url_to_scrape": "https://www.google.com/search?q=paperclip+ai+orchestration&gl=us&hl=en",
  "formats": ["json"],
  "parser": {"id": "@olostep/google-search"}
}
```

**Constructing the Google URL:**
- Base: `https://www.google.com/search?q=YOUR+QUERY`
- `&gl=us` — country (ISO code lowercase)
- `&hl=en` — language
- URL-encode query (spaces → `+`)

### Response

The `result.json_content` is a **stringified JSON string**. Parse it to access:

```json
{
  "searchParameters": {"type": "search", "engine": "google", "q": "..."},
  "knowledgeGraph": {"title": "...", "type": "...", "description": "...", "attributes": {...}},
  "organic": [
    {"title": "...", "link": "https://...", "position": 1, "snippet": "..."},
    {"title": "...", "link": "https://...", "position": 2, "snippet": "..."}
  ],
  "peopleAlsoAsk": [{"question": "..."}],
  "relatedSearches": [{"query": "..."}]
}
```

### Example

```sh
curl -sS -X POST "https://api.olostep.com/v1/scrapes" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url_to_scrape": "https://www.google.com/search?q=how+to+set+up+Paperclip+agent+heartbeats&gl=us&hl=en",
    "formats": ["json"],
    "parser": {"id": "@olostep/google-search"}
  }'
```

---

## Crawl — `POST /v1/crawls`

**Async** — starts a crawl job and returns immediately. Poll for results.

### Request Body

```json
{
  "start_url": "https://docs.example.com",
  "max_pages": 10,
  "include_urls": ["/guides/**"],
  "exclude_urls": ["/admin/**"]
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `start_url` | string | Yes | — | Starting URL for the crawl |
| `max_pages` | integer | Yes | — | Maximum pages to crawl |
| `include_urls` | array | No | `["/**"]` | Glob patterns for URLs to include |
| `exclude_urls` | array | No | — | Glob patterns for URLs to exclude |
| `max_depth` | integer | No | — | Maximum link depth from start URL |
| `include_external` | boolean | No | `false` | Crawl first-degree external links |
| `include_subdomain` | boolean | No | `false` | Include subdomains |
| `search_query` | string | No | — | Sort results by relevance to this query |
| `top_n` | integer | No | — | Only follow top N most relevant links per page |
| `webhook_url` | string | No | — | URL called when crawl completes |
| `timeout` | integer | No | — | End crawl after N seconds |

### Response (create)

```json
{
  "id": "crawl_abc123",
  "object": "crawl",
  "status": "in_progress",
  "created": 1745673871,
  "start_url": "https://docs.example.com",
  "max_pages": 10,
  "pages_count": 0
}
```

### Check Status — `GET /v1/crawls/{crawl_id}`

Poll until `status` is `"completed"`.

### Get Pages — `GET /v1/crawls/{crawl_id}/pages`

| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | integer | Number of pages per request (default: 10) |
| `cursor` | string | Pagination cursor from previous response |

```json
{
  "pages": [
    {"url": "https://docs.example.com/page1", "retrieve_id": "abc123"},
    {"url": "https://docs.example.com/page2", "retrieve_id": "def456"}
  ],
  "cursor": "next_page_token"
}
```

Use `retrieve_id` with the Retrieve endpoint to get content.

### Example

```sh
# Start crawl
curl -sS -X POST "https://api.olostep.com/v1/crawls" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "start_url": "https://docs.example.com/guides",
    "max_pages": 25
  }'

# Check status
curl -sS "https://api.olostep.com/v1/crawls/CRAWL_ID" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY"

# Get pages
curl -sS "https://api.olostep.com/v1/crawls/CRAWL_ID/pages?limit=10" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY"
```

---

## Batch — `POST /v1/batches`

**Async** — scrape up to 10,000 URLs in parallel. Usually completes in 5–8 minutes.

### Request Body

```json
{
  "items": [
    {"url": "https://example.com/page1", "custom_id": "p1"},
    {"url": "https://example.com/page2", "custom_id": "p2"},
    {"url": "https://example.com/page3", "custom_id": "p3"}
  ],
  "country": "US",
  "parser": {"id": "@olostep/google-search"}
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `items` | array | Yes | — | Array of `{"url": "...", "custom_id": "..."}` objects (1–10,000) |
| `country` | string | No | — | ISO country code |
| `parser` | object | No | — | Parser for structured extraction: `{"id": "parser_id"}` |

### Response (create)

```json
{
  "id": "batch_abc123",
  "object": "batch",
  "status": "in_progress",
  "total_urls": 3,
  "completed_urls": 0
}
```

### Check Status — `GET /v1/batches/{batch_id}`

Poll until `status` is `"completed"`.

### Get Items — `GET /v1/batches/{batch_id}/items`

| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | integer | Items per page |
| `cursor` | string/number | Pagination cursor |
| `status` | string | Filter by item status |

```json
{
  "items": [
    {"custom_id": "p1", "url": "https://example.com/page1", "retrieve_id": "abc123", "status": "completed"},
    {"custom_id": "p2", "url": "https://example.com/page2", "retrieve_id": "def456", "status": "completed"}
  ],
  "cursor": "next_token"
}
```

Use `retrieve_id` with the Retrieve endpoint to get content.

### Example

```sh
# Start batch
curl -sS -X POST "https://api.olostep.com/v1/batches" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "items": [
      {"url": "https://example.com/products/1", "custom_id": "prod-1"},
      {"url": "https://example.com/products/2", "custom_id": "prod-2"},
      {"url": "https://example.com/products/3", "custom_id": "prod-3"}
    ]
  }'

# Check status
curl -sS "https://api.olostep.com/v1/batches/BATCH_ID" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY"

# Get items
curl -sS "https://api.olostep.com/v1/batches/BATCH_ID/items?limit=10" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY"
```

---

## Map — `POST /v1/maps`

Discover all URLs on a website. Synchronous — returns immediately (up to 120s for large sites).

### Request Body

```json
{
  "url": "https://example.com",
  "include_urls": ["/blog/**", "/docs/**"],
  "exclude_urls": ["/admin/**"],
  "top_n": 100
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `url` | string | Yes | — | Website to map |
| `search_query` | string | No | — | Sort URLs by relevance to this query |
| `top_n` | integer | No | — | Max URLs to return |
| `include_urls` | array | No | — | Glob patterns for URLs to include |
| `exclude_urls` | array | No | — | Glob patterns for URLs to exclude |
| `include_subdomain` | boolean | No | `true` | Include subdomains |
| `cursor` | string | No | — | Pagination cursor from previous response |

### Response

```json
{
  "id": "map_abc123",
  "urls_count": 22,
  "urls": [
    "https://example.com/blog/post-1",
    "https://example.com/blog/post-2",
    "https://example.com/docs/getting-started"
  ],
  "cursor": null
}
```

If `cursor` is not null, pass it in the next request to get more URLs (10MB response limit).

### Example

```sh
curl -sS -X POST "https://api.olostep.com/v1/maps" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://docs.example.com",
    "include_urls": ["/guides/**"],
    "top_n": 50
  }'
```

---

## Answers — `POST /v1/answers`

Get AI-powered answers with citations from the web. Synchronous (3–30s depending on complexity).

### Request Body

```json
{
  "task": "What are the pricing tiers for Vercel in 2026?",
  "json_format": {
    "provider": "",
    "tiers": [{"name": "", "price": "", "features": []}]
  }
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `task` | string | Yes | — | Question or research task |
| `json_format` | object | No | — | JSON schema for structured output (object with empty values as template) |

### Response

```json
{
  "id": "answer_9bi0sbj9xa",
  "object": "answer",
  "created": 1745673871,
  "task": "What are the pricing tiers for Vercel in 2026?",
  "result": {
    "json_content": "{\"provider\": \"Vercel\", \"tiers\": [{\"name\": \"Hobby\", \"price\": \"Free\", ...}]}",
    "json_hosted_url": "https://olostep-storage.s3.amazonaws.com/...",
    "sources": ["https://vercel.com/pricing", "https://blog.example.com/vercel-review"]
  }
}
```

The `result.json_content` is a stringified JSON string matching your `json_format` schema. `result.sources` is an array of URL strings.

### Example

```sh
curl -sS -X POST "https://api.olostep.com/v1/answers" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Compare the top 3 headless browser services for web scraping in 2026",
    "json_format": {
      "services": [{"name": "", "pricing": "", "features": [], "pros": [], "cons": []}]
    }
  }'
```

---

## Retrieve — `GET /v1/retrieve`

Retrieve content for crawl pages and batch items using their `retrieve_id`.

### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `retrieve_id` | string | Yes | The retrieve ID from a crawl page or batch item |
| `formats` | string | No | Comma-separated formats: `markdown`, `html`, `text`, `json` |

### Response

```json
{
  "html_content": null,
  "markdown_content": "# Page content...",
  "text_content": null,
  "json_content": null
}
```

### Example

```sh
curl -sS "https://api.olostep.com/v1/retrieve?retrieve_id=abc123&formats=markdown" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY"
```

---

## Error Responses

| Status | Meaning |
|--------|---------|
| 400 | Bad request — check parameters |
| 402 | Invalid or missing API key |
| 500 | Server error — retry once, then report |

---

## Best Practices

1. **Use `formats: ["markdown"]`** by default — most token-efficient for LLM processing
2. **Batch when possible** — one batch call is cheaper and faster than N individual scrapes
3. **Map before crawling** — understand site structure before committing to a large crawl
4. **Set wait times** for JS-heavy sites (SPAs, e-commerce) — `wait_before_scraping: 2000`
5. **Use parsers** when available (Google search, Amazon, etc.) for structured JSON at scale
6. **Poll async endpoints** — crawls and batches return immediately with `status: "in_progress"`
7. **Report errors** — if you get auth failures or rate limits, comment on your Paperclip task so your manager can address it
