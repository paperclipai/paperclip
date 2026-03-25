# Olostep API Reference

Complete endpoint reference for the Olostep web scraping API. For the core skill instructions and common workflows, see the main `SKILL.md`.

**Base URL:** `https://api.olostep.com/v1`  
**Auth:** `Authorization: Bearer $OLOSTEP_API_KEY`  
**Content-Type:** `application/json`

---

## Scrape — `POST /v1/scrape`

Extract content from a single webpage.

### Request Body

```json
{
  "url": "https://example.com",
  "output_format": "markdown",
  "country": "US",
  "wait_before_scraping": 2000,
  "parser": "@olostep/amazon-product"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `url` | string | Yes | — | The webpage URL to scrape |
| `output_format` | string | No | `markdown` | One of: `markdown`, `html`, `json`, `text` |
| `country` | string | No | — | ISO country code for geo-targeting (e.g., `US`, `GB`, `DE`) |
| `wait_before_scraping` | integer | No | `0` | Milliseconds to wait for JS rendering (0–10000) |
| `parser` | string | No | — | Specialized parser ID for popular platforms |

### Available Parsers

| Parser ID | Platform |
|-----------|----------|
| `@olostep/amazon-product` | Amazon product pages |
| `@olostep/linkedin-profile` | LinkedIn profiles |
| `@olostep/google-maps` | Google Maps listings |

### Response

```json
{
  "result": {
    "content": "# Page Title\n\nExtracted content in markdown...",
    "url": "https://example.com",
    "status_code": 200
  }
}
```

### Example

```sh
curl -sS -X POST "https://api.olostep.com/v1/scrape" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://docs.paperclip.ing/guides/getting-started",
    "output_format": "markdown",
    "wait_before_scraping": 2000
  }'
```

---

## Search — `POST /v1/search`

Search the web and get structured results.

### Request Body

```json
{
  "query": "AI agent orchestration tools 2026",
  "country": "US"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | string | Yes | — | Search query |
| `country` | string | No | `US` | ISO country code for localized results |

### Response

```json
{
  "results": [
    {
      "title": "Result Title",
      "url": "https://example.com/article",
      "snippet": "Brief description of the result...",
      "content": "Full scraped content if available..."
    }
  ]
}
```

### Example

```sh
curl -sS -X POST "https://api.olostep.com/v1/search" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "how to set up Paperclip agent heartbeats",
    "country": "US"
  }'
```

---

## Google Search — `POST /v1/google-search`

Get Google-specific SERP data with rich snippets.

### Request Body

```json
{
  "query": "paperclip ai orchestration",
  "country": "US"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | string | Yes | — | Search query |
| `country` | string | No | `US` | ISO country code |

---

## Crawl — `POST /v1/crawl`

Autonomously crawl a website by following links.

### Request Body

```json
{
  "start_url": "https://docs.example.com",
  "max_pages": 10,
  "follow_links": true,
  "output_format": "markdown",
  "country": "US"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `start_url` | string | Yes | — | Starting URL for the crawl |
| `max_pages` | integer | No | `10` | Maximum pages to crawl |
| `follow_links` | boolean | No | `true` | Whether to follow discovered links |
| `output_format` | string | No | `markdown` | One of: `markdown`, `html`, `json`, `text` |
| `country` | string | No | — | ISO country code |
| `parser` | string | No | — | Specialized parser ID |

### Response

```json
{
  "results": [
    {
      "url": "https://docs.example.com/page1",
      "content": "# Page content in markdown...",
      "status_code": 200
    }
  ]
}
```

### Example

```sh
curl -sS -X POST "https://api.olostep.com/v1/crawl" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "start_url": "https://docs.example.com/guides",
    "max_pages": 25,
    "output_format": "markdown"
  }'
```

---

## Batch Scrape — `POST /v1/batch-scrape`

Scrape up to 10,000 URLs in parallel.

### Request Body

```json
{
  "urls_to_scrape": [
    {"url": "https://example.com/page1", "custom_id": "p1"},
    {"url": "https://example.com/page2", "custom_id": "p2"},
    {"url": "https://example.com/page3"}
  ],
  "output_format": "markdown",
  "country": "US",
  "wait_before_scraping": 2000
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `urls_to_scrape` | array | Yes | — | Array of `{url, custom_id?}` objects (1–10,000 items) |
| `output_format` | string | No | `markdown` | One of: `markdown`, `html`, `json`, `text` |
| `country` | string | No | — | ISO country code |
| `wait_before_scraping` | integer | No | `0` | Milliseconds to wait per URL (0–10000) |
| `parser` | string | No | — | Specialized parser ID |

### Response

```json
{
  "results": [
    {
      "url": "https://example.com/page1",
      "custom_id": "p1",
      "content": "# Page 1 content...",
      "status_code": 200
    }
  ]
}
```

### Example

```sh
curl -sS -X POST "https://api.olostep.com/v1/batch-scrape" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "urls_to_scrape": [
      {"url": "https://example.com/products/1", "custom_id": "prod-1"},
      {"url": "https://example.com/products/2", "custom_id": "prod-2"},
      {"url": "https://example.com/products/3", "custom_id": "prod-3"}
    ],
    "output_format": "markdown"
  }'
```

---

## Map — `POST /v1/map`

Discover all URLs on a website.

### Request Body

```json
{
  "website_url": "https://example.com",
  "search_query": "blog",
  "top_n": 100,
  "include_url_patterns": ["/blog/**", "/docs/**"],
  "exclude_url_patterns": ["/admin/**", "/internal/**"]
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `website_url` | string | Yes | — | Website to map |
| `search_query` | string | No | — | Filter URLs by keyword |
| `top_n` | integer | No | — | Max URLs to return |
| `include_url_patterns` | array | No | — | Glob patterns for URLs to include |
| `exclude_url_patterns` | array | No | — | Glob patterns for URLs to exclude |

### Response

```json
{
  "urls": [
    "https://example.com/blog/post-1",
    "https://example.com/blog/post-2",
    "https://example.com/docs/getting-started"
  ]
}
```

### Example

```sh
curl -sS -X POST "https://api.olostep.com/v1/map" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "website_url": "https://docs.example.com",
    "include_url_patterns": ["/guides/**"],
    "top_n": 50
  }'
```

---

## Answers — `POST /v1/answers`

Get AI-powered answers with citations from the web.

### Request Body

```json
{
  "task": "What are the pricing tiers for Vercel in 2026?",
  "json": {
    "provider": "",
    "tiers": [{"name": "", "price": "", "features": []}]
  }
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `task` | string | Yes | — | Question or research task |
| `json` | object | No | — | JSON schema for structured output |

### Response (unstructured)

```json
{
  "answer": "Based on current information, Vercel offers three tiers...",
  "sources": [
    {"url": "https://vercel.com/pricing", "title": "Vercel Pricing"},
    {"url": "https://blog.example.com/vercel-review", "title": "Vercel Review 2026"}
  ]
}
```

### Response (with JSON schema)

```json
{
  "answer": {
    "provider": "Vercel",
    "tiers": [
      {"name": "Hobby", "price": "Free", "features": ["..."]},
      {"name": "Pro", "price": "$20/mo", "features": ["..."]}
    ]
  },
  "sources": [...]
}
```

### Example

```sh
curl -sS -X POST "https://api.olostep.com/v1/answers" \
  -H "Authorization: Bearer $OLOSTEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Compare the top 3 headless browser services for web scraping in 2026",
    "json": {
      "services": [{"name": "", "pricing": "", "features": [], "pros": [], "cons": []}]
    }
  }'
```

---

## Rate Limits

| Plan | Requests/min | Concurrent | Batch Max |
|------|-------------|------------|-----------|
| Free | 10 | 5 | 100 |
| Pro | 100 | 50 | 10,000 |
| Enterprise | Custom | Custom | Custom |

When rate-limited, the API returns HTTP 429. Back off and retry after the `Retry-After` header value.

---

## Error Responses

| Status | Meaning |
|--------|---------|
| 400 | Bad request — check parameters |
| 401 | Invalid or missing API key |
| 429 | Rate limited — wait and retry |
| 500 | Server error — retry once, then report |

All errors return:
```json
{
  "error": {
    "message": "Description of what went wrong",
    "code": "ERROR_CODE"
  }
}
```

---

## Best Practices

1. **Use markdown format** by default — most token-efficient for LLM processing
2. **Batch when possible** — one batch call is cheaper and faster than N individual scrapes
3. **Map before crawling** — understand site structure before committing to a large crawl
4. **Set wait times** for JS-heavy sites (SPAs, e-commerce) — `wait_before_scraping: 2000`
5. **Use specialized parsers** when available (Amazon, LinkedIn, etc.) for higher accuracy
6. **Report errors** — if you get auth failures or rate limits, comment on your Paperclip task so your manager can address it
