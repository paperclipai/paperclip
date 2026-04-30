---
name: seed-content-batch
description: >
  Chief Content's batch-seeding skill — read a topic seed YAML file, fan out
  into Paperclip child issues with Medium-quality bar (≥5 citations,
  contrarian angle, runnable example), pace dispatch at 2-3/day to avoid
  Author saturation. Use when ticket lands assigned to @chief-content with
  type seed-batch.
---

# Seed Content Batch

Take a topic list, produce a backlog of well-spec'd content tickets at sustainable pace.

## Scope

- Input: a YAML file at `companies/learnova-academy/seed-topics-<date>.yaml`
- Output: 7-15 Paperclip child issues (one per topic) with Medium-quality DOD baked in
- Pace: 2-3 ticket-starts/day; queue the rest with `priority: backlog` and dispatch as Author + Reviewer free up

## Inputs

- Seed topics YAML (see schema below)
- Current Author + Reviewer load via `GET /api/companies/.../tasks?assignee=<id>&status=in_progress`
- Today's research notes (for HOT-flagged topics, prioritize same-day)

## Seed YAML schema

```yaml
date: 2026-04-30
seeded_by: chief-content
quality_bar: medium-grade
defaults:
  word_count_blog: 800-1500
  word_count_chapter: 2000-5000
  min_citations: 5
  require_contrarian_angle: true
  require_runnable_example: true

topics:
  - kind: blog
    title: "OpenAI on AWS Bedrock — what AWS-native teams gain (and what they still can't do)"
    vendor_tag: openai
    priority: hot
    angle: "AWS-only orgs that previously couldn't use OpenAI now can — but Bedrock's auth/observability story is non-trivial"
    runnable_example: "Bedrock InvokeModel boto3 call vs raw OpenAI SDK call — token-cost diff"
    sources_pinned:
      - https://openai.com/index/openai-on-aws/
    affects_courses: []

  - kind: course-delta
    title: "Claude Tool-Use from Zero — connector pipeline chapter"
    course_slug: claude-tool-use-from-zero
    priority: hot
    chapter_to_add: "Creative pipelines with the 9 connectors"
    angle: "Why Anthropic chose creative apps as the connector beachhead (not enterprise SaaS)"
    runnable_example: "Blender Python API: Claude generates a wave-grid scene"
```

## Workflow

### 1. Read + validate seed YAML

```bash
yq eval '.topics[] | .title' companies/learnova-academy/seed-topics-<date>.yaml | wc -l
```

Confirm topics ≤15 and each has required fields. If malformed → block + escalate to CEO.

### 2. Capacity check

```bash
curl -s 'http://localhost:3100/api/companies/.../tasks?assignee=content-author&status=in_progress' | jq '. | length'
```

If Author load >2 → defer ALL but the HOT topics; queue rest.

### 3. Per-topic ticket creation

For each topic, POST to Paperclip issues API:
```yaml
title: "[<kind>] <title>"
description: |
  ## Topic
  <full topic from seed YAML>

  ## Quality bar (per Medium-grade brief)
  - Word count: <word_count>
  - Inline citations: ≥<min_citations>
  - Required: contrarian or non-obvious angle (specified: <angle>)
  - Required: runnable example (specified: <runnable_example>)
  - Voice: confident, friendly, source-citing, never hype-y. Answer-first H1.
  - Cross-link to related Academy course: [[course/<slug>]]

  ## Sources to ground from
  <sources_pinned + today's vault/research/_daily/>

  ## Routing
  - Author: content-author
  - Reviewer: content-reviewer (G0 — strict)
  - SEO/AEO audit: seo-optimizer post-G0
  - G3: ceo
  - G4: Vardaan
  - G5 publish-verify: publish-verifier
ticket_type: <kind>
priority: <priority>
assignee: chief-content   # for further dispatch
```

### 4. Dispatch first wave (top 3 by priority)

For HOT priority items: dispatch immediately to content-author via `dispatch-content-task` skill.
For normal priority items: status `backlog`; chief-content's hourly cron picks them up as capacity frees.

### 5. Comment on parent meta-issue

```
✅ Seeded <N> tickets from seed-topics-<date>.yaml
- HOT: 3 dispatched (KOE-X, KOE-Y, KOE-Z)
- normal: 7 in backlog (will dispatch at 2/day max)
- estimated total throughput: ~5-7 days

Cross-links: [[seed-topics-<date>]]
```

### 6. Notify @ceo

EOD digest entry: "Content backlog: <N> seeded, <X>/day throughput, ETA <date>".

## Output

- 7-15 Paperclip child issues created
- 1-3 dispatched to @content-author immediately
- Comment on parent meta-issue with summary
- Vault entry at `vault/decisions/seed-batch-<date>.md`

## Notes

- Don't dispatch all topics at once — Author + Reviewer have per-task budget caps
- For course-delta tickets, link to existing course outline + new chapter spec
- For new-course tickets, first dispatch a "course outline" sub-ticket; full chapters only after outline approval

## Escalation

- Author load saturated for >3 days → defer next batch + flag in weekly retro
- Same Reviewer block class on 3+ seeded blogs → propose seed YAML quality-bar update
- Topic source URL goes 404 before Author drafts → swap from researcher's daily note + comment
