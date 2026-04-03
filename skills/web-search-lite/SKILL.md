---
name: web-search-lite
description: >
  Search and inspect public web sources from local adapters when no dedicated
  search tool is available. Use this when you need current information and the
  runtime only exposes tools such as bash and webfetch.
---

# Web Search Lite

Use this skill when you need current public web information but the runtime does
not provide a native search tool such as `google:search`.

Do not call unavailable tools. In this environment, the reliable path is:

1. search with `bash` using a public HTML search endpoint
2. inspect the most relevant URLs with `webfetch`
3. cite the URLs you actually used

## Rules

- Do not say "I cannot access the internet" if `bash` or `webfetch` is available.
- Do not call `google:search`.
- Use search only when current web information is actually needed.
- Prefer 2 to 4 relevant sources over broad scraping.
- If search results are noisy, refine the query and retry once.

## Search Procedure

### Option A — quick search with `bash`

Run a DuckDuckGo HTML search and extract the first result URLs:

```bash
python3 - <<'PY'
import json, re, sys, urllib.parse, urllib.request

query = "YOUR QUERY HERE"
url = "https://html.duckduckgo.com/html/?q=" + urllib.parse.quote(query)
req = urllib.request.Request(
    url,
    headers={"User-Agent": "Mozilla/5.0"},
)
html = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", errors="ignore")
matches = re.findall(r'nofollow" class="[^"]*result__a" href="(.*?)"', html)
out = []
for raw in matches[:5]:
    clean = urllib.parse.unquote(raw)
    if clean.startswith("//"):
        clean = "https:" + clean
    out.append(clean)
print(json.dumps({"query": query, "results": out}, ensure_ascii=False, indent=2))
PY
```

If the query is company or product specific, tighten it:

- add the brand/site name
- add a year or month if freshness matters
- add `site:linkedin.com`, `site:company.com`, `site:docs...` only when helpful

### Option B — open a specific result with `webfetch`

After you have a URL, inspect it with `webfetch` instead of scraping more.

Use it for:

- articles
- LinkedIn posts/pages
- docs
- landing pages
- press releases

## Output expectations

When your task depends on web research, include:

- what you searched
- which URLs you used
- the concrete facts extracted
- any uncertainty or conflict between sources

If no reliable source is found after one refinement pass, say that clearly and
continue with the best defensible answer instead of pretending certainty.
