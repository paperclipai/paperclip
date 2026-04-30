---
name: audit-llms-txt
description: >
  Chief Marketing's weekly skill — audit /llms.txt and /llms-full.txt for
  freshness + correctness; flag missing entries; coordinate regen with
  seo-optimizer. Use Sun 00:00 IST cron or on-demand after a content blitz.
---

# Audit llms.txt

The /llms.txt file is the GEO front door — what AI search engines see when they crawl us. Stale = bad citations.

## Scope

- Audit `/llms.txt` (top URLs index) and `/llms-full.txt` (full markdown corpus export)
- Verify every URL in the file returns 200 + matches its description
- Find published Academy content NOT in the file
- Dispatch regen ticket to seo-optimizer if drift detected

## Inputs

- The current `learnovaBeast/learnova-academy/public/llms.txt` and `llms-full.txt`
- Published content list (Convex query: courses + blogs where status=published)

## Workflow

### 1. Fetch current llms.txt

```bash
curl -s https://academy.kspl.tech/llms.txt > /tmp/llms.txt
curl -s https://academy.kspl.tech/llms-full.txt > /tmp/llms-full.txt
```

### 2. Verify every URL listed

```bash
grep -E '^https?://' /tmp/llms.txt | while read url; do
  status=$(curl -s -o /dev/null -w "%{http_code}" "$url")
  echo "$status $url"
done | grep -v "^200" > /tmp/dead-urls.txt
```

Each non-200 → flag for replacement.

### 3. Verify URL descriptions match content

For each URL in llms.txt:
- WebFetch the URL
- Check the description (next line in llms.txt) is still accurate

If a course was significantly updated, the description may need updating.

### 4. Find drift (published-not-listed)

Query Convex for `published` courses + blogs. Diff against URLs in llms.txt. Anything published but not listed → drift.

### 5. Decide

If 0 dead URLs + 0 drift → PASS. Comment on cron parent task: "✅ llms.txt healthy."

If drift exists → dispatch regen ticket to seo-optimizer:
```yaml
title: "[llms-txt-regen] Drift: <N> dead, <M> missing"
assignee: seo-optimizer
deadline: 24h
context:
  - dead_urls: [<list>]
  - missing_published: [<list of slugs>]
```

### 6. Write audit report to vault

`vault/marketing/llms-audit-<date>.md`:

```markdown
---
date: 2026-04-30
auditor: chief-marketing
---

# llms.txt audit

## Total URLs in /llms.txt: <N>
## Dead URLs: <M>
## Missing published content: <K>
## Outdated descriptions: <L>

## Action
- Regen ticket dispatched to @seo-optimizer
```

## Output

Vault audit report + (if drift) regen ticket.

## Notes

- /llms.txt schema: each entry is `URL\nOne-line description` (per Anthropic + Cursor + Mintlify convention)
- /llms-full.txt should be markdown export of top URLs, deduplicated
- Don't regen yourself — dispatch to seo-optimizer
- Audit cost should be <$0.30; URL fetches are free

## Escalation

- 5+ dead URLs in a single audit → ping CEO; possible site issue (404 routing broken)
- Drift not corrected after 1 regen ticket → flag in next weekly retro
