---
schema: agentcompanies/v1
kind: skill
slug: vendor-watcher
name: Vendor Watcher
description: Daily routine for a single-vendor researcher. Scrapes official + community sources, extracts items with citations, writes a structured daily note to the Obsidian vault.
version: 0.1.0
license: MIT
sources: []
---

# Vendor Watcher

Used by `researcher-anthropic`, `researcher-openai`, `researcher-google`, `researcher-community`. Runs once per day at 06:00 IST per researcher. Output: one vault note per day, per vendor.

## Inputs

- `VENDOR_NAME` (env) — `anthropic` / `openai` / `google` / `community`
- `VAULT_OUTPUT` (env) — `vault/research/<vendor>` (override per agent)
- The current date (`new Date().toISOString().slice(0, 10)`)

## Sources to scan (per vendor)

### Anthropic
- https://www.anthropic.com/news (Crawl4AI)
- https://www.anthropic.com/engineering (Crawl4AI)
- https://claude.com/blog (Crawl4AI)
- https://docs.anthropic.com/api/changelog (Crawl4AI)
- `gh release list -R anthropics/prompt-eng-interactive-tutorial` (last 24h)
- `gh release list -R anthropics/courses` (last 24h)
- `x.com/AnthropicAI` last 24h via Grok x_search
- r/ClaudeAI hot threads via Tavily

### OpenAI
- https://openai.com/news (Crawl4AI)
- https://openai.com/blog (Crawl4AI)
- https://platform.openai.com/docs/changelog (Crawl4AI)
- `x.com/OpenAI` + `x.com/sama` via Grok x_search
- r/OpenAI hot threads via Tavily

### Google
- https://blog.google/products/google-deepmind (Crawl4AI)
- https://blog.google/technology/ai (Crawl4AI)
- https://ai.googleblog.com (Crawl4AI)
- https://developers.googleblog.com (Crawl4AI)
- `x.com/GoogleDeepMind` + `x.com/JeffDean` via Grok x_search
- r/Bard / r/GoogleAI via Tavily

### Community
- https://news.ycombinator.com (top 30, AI-tagged) via Tavily
- r/LocalLLaMA top-of-day
- r/ClaudeAI top-of-day (community sentiment, separate from Anthropic researcher's official scan)
- r/OpenAI top-of-day
- X "Latest AI news" via Grok x_search (broader sweep)
- The community researcher synthesises across all of these (no single official source)

## Procedure

1. **Plan window** — last 24 hours from `new Date()` UTC; output as ISO date. If running a backfill, use the supplied date.

2. **Scrape** — fire requests in parallel via Crawl4AI (primary) → Tavily (fallback). Set per-source timeout to 20 s; if a source times out, log the gap and continue.

3. **Extract items** — for each scraped page or post:
   - Pull headline + summary + URL + posted-date
   - Reject items not in the 24h window
   - Reject duplicates (same URL, or same headline ±10% similarity to yesterday's vault note)

4. **Cross-check via Grok** — for items that look "HOT" (vendor's own announcement, model release, big number), do a single Grok `x_search` to confirm they're being discussed live on X. Embed the top 1-3 tweet links.

5. **Hot-flag heuristic** — mark an item HOT if any of:
   - It's an official model/feature/connector announcement (mention of "shipped", "launched", "GA", "available now")
   - It's discussed in 5+ X posts in the last 6 hours
   - It potentially obsoletes a current Academy course (pre-load `vault/courses/*` slugs and check overlap)

6. **Write the vault note** at `<VAULT_OUTPUT>/<YYYY-MM-DD>.md` with the schema below.

## Output schema (vault note)

```markdown
---
date: YYYY-MM-DD
vendor: <vendor-id>
researcher: researcher-<vendor>
sources_scanned: <count>
sources_failed: [<source-name>, ...]   # only if non-empty
items_found: <count>
hot_items: <count>
obsoletes_courses: [<course-slug>, ...]   # only if non-empty
---

# <Vendor display name> — YYYY-MM-DD

## TL;DR (3 bullets max)
- <hot item 1, with [link](url)>
- <next most important item>
- <runner-up>

## Items

### 1. <Headline> [HOT]
<2-3 sentence summary in own words. Cite primary source [link](url). Cite cross-checks if any.>

**Affects courses**: <slug-1>, <slug-2> (or "none")
**Recommendation**: blog | course-delta | new-course | no-action

### 2. <Headline>
...
```

## Quality gates (self-checks before writing)

- [ ] Every item has at least one source URL
- [ ] No item invents claims not in the source
- [ ] HOT items have at least one X cross-check
- [ ] All courses I claim are "affected" actually exist in `vault/courses/` or in `lib/fixtures.ts`
- [ ] Total length ≤ 800 lines (CEO + Editor read this; brevity wins)

## Failure modes + handling

| Failure | Handling |
|---|---|
| Crawl4AI returns empty for a source | Try Tavily; if also empty, log in `sources_failed` and continue |
| Grok x_search rate-limited | Skip the cross-check step; mark items as HOT only via heuristic 1 + 3 |
| All sources fail | Write a note with `items_found: 0` and `sources_failed` populated; CEO will escalate to Chief Research |
| Per-task budget hit at 80% mid-scrape | Truncate scraping; write what you have; flag in frontmatter `truncated: true` |

## Reporting

After writing the vault note, post a single Paperclip task comment:

```
06:23 ✅ vault/research/anthropic/2026-04-29.md
- 6 items, 1 HOT
- 7 sources scanned, 0 failed
- ready for Research Editor
```

## Out of scope

- Scraping vendors other than the assigned `VENDOR_NAME`
- Speculation about future announcements
- Editorial synthesis across vendors (that's the Research Editor's job)
- Writing courses or blogs (that's the Content team)
