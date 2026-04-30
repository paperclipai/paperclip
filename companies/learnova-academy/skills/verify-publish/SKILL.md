---
name: verify-publish
description: >
  Publish Verifier's primary skill — G5 post-publish gate. Fetch the live URL,
  validate schema, source URLs, og:image, sitemap presence, performance.
  Route BLOCKs to the right team. Use when ticket lands assigned to
  @publish-verifier with status published.
---

# Verify Publish

You verify; others fix.

## Scope

- One published URL per pass
- 7 checks: status, JSON-LD, citations, og:image, sitemap, llms.txt, page weight
- PASS routes to CEO retro; BLOCK routes per matrix below

## Inputs

- Paperclip ticket with `status: published` and a published URL
- The vault file (for cross-checking citations)

## Workflow

### 1. HTTP status check

```bash
curl -sI -o /dev/null -w "%{http_code}\n" "$URL"
```

Expected: 200. Anything else → BLOCK to chief-engineering ("Production page returns HTTP X — deploy issue or routing").

### 2. JSON-LD validation

Fetch HTML and parse all `<script type="application/ld+json">` blocks:

```bash
curl -s "$URL" | python3 -c "
import re, json, sys
html = sys.stdin.read()
blocks = re.findall(r'<script type=\"application/ld\\+json\"[^>]*>(.*?)</script>', html, re.DOTALL)
for i, b in enumerate(blocks):
    try:
        d = json.loads(b)
        if isinstance(d, list):
            for x in d: print(f'block {i}: type={x.get(\"@type\")}')
        else:
            print(f'block {i}: type={d.get(\"@type\")}')
    except Exception as e:
        print(f'block {i}: PARSE FAIL: {e}')
"
```

Required @types per page kind:
- Blog post: `BlogPosting` + `BreadcrumbList`
- Course: `Course`
- Lesson: `Course` + (optional) `HowTo`
- Home: `Organization` + `WebSite`

Missing required types or parse failures → BLOCK to chief-engineering ("Schema regression: <details>").

### 3. Citation check

For each `https?://...` URL in the source vault file's body (excluding internal `[[wikilinks]]`):

```bash
curl -sI -o /dev/null -w "%{http_code}\t$URL\n" "$URL"
```

Pick 3 at random. Each must:
- Return 200 (or 30x to a 200)
- WebFetch and verify the page actually contains content matching the claim in our prose

Any failure → BLOCK to **content-author** (route through @chief-content): "Citation rot: <URL> → <status>; replace + re-route via G0".

### 4. og:image check

```bash
OG_URL=$(curl -s "$URL" | grep -oE 'property="og:image" content="[^"]+"' | sed 's/.*content="\([^"]*\)".*/\1/' | head -1)
curl -sI -o /dev/null -w "og:image %{http_code}, size %{size_download}\n" "$OG_URL"
```

Expected: 200 + image content-type. Failure → BLOCK to chief-engineering.

### 5. Sitemap presence

```bash
curl -s https://academy.kspl.tech/sitemap.xml | grep -F "$URL"
```

Missing → BLOCK to chief-engineering ("Page not in sitemap.xml — generation regression").

### 6. llms.txt presence (blog + course only)

```bash
curl -s https://academy.kspl.tech/llms.txt | grep -F "$URL"
```

Missing → BLOCK to chief-engineering ("Page not in llms.txt — GEO regression").

### 7. Page weight check

```bash
SIZE=$(curl -s "$URL" | wc -c)
echo "Page weight: $SIZE bytes"
```

Threshold: blog ≤80KB, course ≤90KB, lesson ≤100KB. Above target → flag (warn, don't block); >20% over prior comparable page → BLOCK.

### Decide + comment

PASS:
```
✅ G5 PUBLISH VERIFIED · <URL>
- HTTP 200 ✓
- JSON-LD: <N> blocks (BlogPosting ✓ BreadcrumbList ✓)
- Citations: 3/3 verified live + on-claim
- og:image: 200, 1200×630
- sitemap.xml ✓ · llms.txt ✓
- Page weight <X>KB (within target)

Routing → @ceo for retro
```

BLOCK (route per matrix):
```
❌ G5 BLOCK · <URL>

ISSUE: Citation 2 is dead.
- URL: https://example.com/foo  → HTTP 404
- Claim affected: para 5 "Anthropic shipped X feature"

Routing → @content-author via @chief-content (revise + replace source URL → re-G0 → republish)
Cc: @ceo
```

### Write vault sidecar

`vault/marketing/publish-verify/<YYYY-MM-DD>-<slug>.md` — frontmatter + 7-check status table.

## Output

PASS/BLOCK comment + vault sidecar.

## Notes

- Per-task cap $0.20. Most checks are shell + curl; reasoning is light (Haiku 4.5).
- Auto-trigger: 2 min after publish event (deploy completes ~90s; small buffer for CDN warmup).
- Don't run on pre-publish drafts. Only `status: published`.

## Escalation

- Same regression class 3+ in a week → propose chief-engineering deploy-validation skill upgrade
- Citation rot rate >5% weekly → propose chief-content URL-pre-validate skill update
- 5xx production responses → CEO + chief-engineering same-heartbeat (severity high)
