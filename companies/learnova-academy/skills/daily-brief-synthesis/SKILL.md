---
schema: agentcompanies/v1
kind: skill
slug: daily-brief-synthesis
name: Daily Brief Synthesis
description: Synthesises 4 vendor researchers' notes into a single CEO-readable daily brief at 06:30 IST. Cross-links related items, recommends ticket creation, scopes out work.
version: 0.1.0
license: MIT
sources: []
---

# Daily Brief Synthesis

Used by `research-editor`. Runs once per day at 06:30 IST. Output: `vault/research/_daily/<YYYY-MM-DD>.md`.

## Inputs

- The 4 vendor researchers' notes for today: `vault/research/{anthropic,openai,google,community}/<date>.md`
- The current `lib/fixtures.ts` `courses` array (so you know which courses are alive)
- Yesterday's daily brief (for continuity / "still in progress" items)

## Procedure

1. **Read** all 4 vendor notes via the Filesystem MCP. If any are missing, note the gap (don't fail).

2. **Extract items** — flatten all items from all 4 notes into one list. Preserve the source vendor + source URL.

3. **Deduplicate cross-vendor** — if Anthropic and OpenAI both announced MCP-related changes, group them under one "tool-use frontier" cross-cut item. Don't double-count.

4. **Tag each item by relevance to existing courses**:
   - `affects: <course-slug>` — when an item changes how an existing course should be taught
   - `inspires: <new-topic>` — when an item suggests a future course
   - `not-ours` — when an item is just industry news with no Academy hook

5. **Recommend per-item action**:
   - `blog` — for HOT items that need same-day commentary
   - `course-delta` — for items that change a specific module of a live course
   - `new-course` — for big-enough topics with high learner demand signal
   - `no-action` — most items; just background noise

6. **Identify cross-cuts** — themes spanning multiple vendors. These often deserve their own course in V2 (defer for now). Examples: "Tool-use is the 2026 frontier", "Long context is converging on RAG", "MCP servers are stabilising".

7. **Write the brief** in the schema below. Keep it ≤ 3 pages.

## Output schema

```markdown
---
date: YYYY-MM-DD
editor: research-editor
sources_synthesized: <count>      # 4 if all researchers delivered
items_total: <count>
hot_items: <count>
recommendations: { blogs: <n>, course_deltas: <n>, new_courses: <n>, no_action: <n> }
missing_vendors: [<vendor-id>, ...]  # only if any researcher missed
---

# Daily brief — YYYY-MM-DD

## Hot today
- **<headline>** — <one-line explanation>. Affects [[course/<slug>]]. Recommend: <action>.
- (max 3 hot items)

## Recommendations
| Action | Topic | Affects | Owner |
|---|---|---|---|
| Blog (today) | <topic> | <course-slug> | content-author |
| Course-delta | <module of course> | <course-slug> | content-author |
| ...

## By vendor

### Anthropic
- <bulleted summaries with cited links>

### OpenAI
- ...

### Google
- ...

### Community
- ...

## Cross-cuts
- <theme 1> — vendors involved + what it suggests
- (defer for now / V2)

## Out-of-scope
- <items that aren't worth tickets, with reason>
```

## Quality gates (self-checks)

- [ ] Every item has its source vendor cited (no anonymous "someone said")
- [ ] Every recommendation names an affected course (or "none yet" with reason)
- [ ] No item appears twice (deduplication ran)
- [ ] Hot items at the top
- [ ] Total length ≤ 3 pages of markdown
- [ ] Cross-cuts section flags at least one theme (even if just to defer)

## Reporting

After writing the brief, post a single Paperclip task comment:

```
06:55 ✅ vault/research/_daily/2026-04-29.md
- 19 items synthesised from 4 sources, 0 missing
- 2 HOT, 1 blog + 2 course-deltas + 1 new-course recommended
- ready for CEO triage at 07:00 IST
```

## Failure modes

| Failure | Handling |
|---|---|
| One researcher's note is missing | Write the brief without that vendor; flag in frontmatter `missing_vendors` |
| Two researchers contradict on the same item | Cite both; flag in the item with `**conflict**:` prefix; let CEO arbitrate at 07:00 |
| HOT item potentially obsoletes a course | Mark `obsoletes_course: <slug>` on the item; add to weekly retro proposal "audit this course" |

## Budget

Per-task cap: $0.50. Synthesis is cheap if you trust the researchers' work. Don't re-scrape; that's not your job.

## Out of scope

- Scraping vendors yourself (researchers do that)
- Writing course content (Content team does that)
- Ticket creation (CEO does that based on your recommendations)
- Multi-day synthesis (one brief per day; weekly themes go in retros)
