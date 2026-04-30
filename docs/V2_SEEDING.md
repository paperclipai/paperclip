# V2 Content Seeding — 7 Blogs + 3 Courses

> Seed list authored 2026-04-30 evening to fan out a meaningful first content batch through the agent organization. Living document; future seed batches go in dated sibling files.

## Why we seeded these specific topics

Each piece had to clear three filters:

1. **Time-relevant** — the AI ecosystem moves daily; topics tied to specific April-2026 vendor moves (Anthropic 9 connectors, OpenAI on AWS Bedrock, Gemini Enterprise on Vertex) earn search volume now and lose it in 2 months.
2. **Hard to find elsewhere** — if a Stratechery / Latent Space / Pragmatic Engineer post already covers it, we don't repeat. Each blog has a contrarian or non-obvious angle.
3. **Funnels to a course** — every blog ends with a wikilink into an Academy course. Blogs are the front door; courses are the product.

## Quality bar — Medium-grade

The seed YAML enforces (via `defaults` block):

| Constraint | Blog | Course chapter |
|---|---|---|
| Word count | 800–1500 (HARD bounds) | 2,000–5,000 |
| Inline citations | ≥5 (primary sources only) | ≥3 per chapter |
| Contrarian/non-obvious angle | Required | Required |
| Runnable example | Required | ≥2 RunPromptCells per chapter |
| Internal wikilinks | ≥1 (course funnel) | ≥3 |
| Voice | Confident, source-citing, never hype-y | Patient, scaffolded, opinionated |
| AI tells | None ("delve", "in conclusion", "furthermore" → hard reject at G0) | None |

## Blog vs Course — different agents, different success metrics

We split `content-author` into two agents 2026-04-30 evening because the success metrics diverge enough that one role can't optimize for both.

| | **blog-author** | **course-author** |
|---|---|---|
| Goal | Earn website traffic + AI-search citations + course click-throughs | Make a learner ship the thing the course promised |
| Success metric (30 days) | Ranks p1 Google for primary_query OR cited by ≥1 AI search engine | Capstone completion rate (manual review V2.5) |
| Word count | 800–1500 (HARD) | 2,000–5,000/chapter |
| Required structure | Lead claim + contrarian angle + RunPromptCell + KnowledgeCheck + course funnel | Outline first → per-chapter writes with hands-on exercises |
| Workflow | One-shot drafting | Two-stage: outline → chapter |
| Per-task budget | $1 | $2 |
| Model | Sonnet 4.6 (subscription-billed) | Sonnet 4.6 (subscription-billed) |

## The 7 blogs

| # | Slug | Vendor | Priority | Contrarian angle |
|---|------|--------|----------|------------------|
| 1 | `openai-on-aws-bedrock-the-real-tradeoffs` | OpenAI | HOT | "AWS-only orgs that previously couldn't use OpenAI now can — but Bedrock's auth/observability story is non-trivial; this isn't 'OpenAI-on-Azure parity'" |
| 2 | `gemini-enterprise-vertex-the-first-real-agent-platform` | Google | HOT | "Why Vertex's agent platform finally bridges 'I built a demo' to 'this runs in prod' — and what's still missing vs Anthropic's Agent SDK" |
| 3 | `claude-code-hermes-billing-three-lessons` | Community | HOT | "It's tempting to laugh, but every agent-in-prod team will hit a similar class bug. Here's the 3-layer guardrail you should have today" |
| 4 | `mcp-from-first-principles` | Anthropic | normal | "Most explainers describe MCP. This one explains why JSON-RPC over stdio + a manifest spec was the right design call vs WebSockets + OpenAPI" |
| 5 | `tool-use-vs-function-calling-the-three-vendor-comparison` | Community | normal | "The three vendors have surface-level identical APIs but very different reliability profiles" |
| 6 | `why-your-rag-is-slow` | Community | normal | "Most 'speed up RAG' posts focus on embedding latency. The actual bottleneck is usually one of these 5 things, in order of frequency" |
| 7 | `harness-engineering-pattern-2026` | Anthropic | normal | "Anthropic published the harness pattern in April. Here's what we learned running it on a real engineering ticket" |

## The 3 courses

| # | Slug | Type | Level | Vendor | Priority |
|---|------|------|-------|--------|----------|
| 1 | `claude-tool-use-from-zero` | course-delta (add Ch.7 — creative connectors) | Builder | Anthropic | HOT |
| 2 | `mcp-server-scaffolding-production` | new-course (5 chapters) | Builder | Anthropic | normal |
| 3 | `agent-eval-harnesses` | new-course (4 chapters) | Professional | Community | normal |

## Dispatch policy

```
HOT priority:
  - dispatch_immediately: true
  - max_in_flight: 2  (don't overwhelm Author + Reviewer)

normal priority:
  - queue_in_backlog: true
  - chief_content_picks_up: hourly
  - max_in_flight: 1
```

**Pace policy:** Author bandwidth is the constraint, not budget. Vardaan is on Claude Max 20x at 31% / 46% utilization (2-hr / weekly). Quota is healthy; quality is the bottleneck. Allow extra revision cycles per piece.

## How chief-content consumes this file

The `seed-content-batch` skill at `companies/learnova-academy/skills/seed-content-batch/SKILL.md` reads `seed-topics-<date>.yaml` and:

1. Validates the YAML schema
2. Capacity-checks Author load (defers all but HOT items if Author has ≥3 in-flight)
3. Creates one Paperclip child issue per topic with the Medium-grade DOD baked into the description
4. Dispatches HOT items immediately to `blog-author` or `course-author` (depending on `kind`)
5. Queues normal items at `priority: backlog` for chief-content's hourly cron to pick up
6. Writes a comment on the seeding meta-issue with a summary
7. Adds an entry to today's EOD digest

## How to add a new topic

1. Open `companies/learnova-academy/seed-topics-<date>.yaml` (or create a new dated file)
2. Copy an existing topic block, edit:
   - `slug` (URL-safe, lowercase, hyphenated)
   - `title` (answer-first, ≤80 chars)
   - `vendor_tag` (anthropic | openai | google | community)
   - `priority` (hot | normal | backlog)
   - `angle` (the contrarian or non-obvious claim)
   - `runnable_example` (concrete code/curl example to embed)
   - `sources_required` (≥1 primary source URL the Author MUST cite)
   - `affects_courses` (slugs to wikilink from this post)
3. Save. Chief-content's next heartbeat picks it up.

## Reference — the seed file

- Path: `companies/learnova-academy/seed-topics-2026-04-30.yaml`
- Owner: chief-content (consumed via seed-content-batch skill)
- Size: 10 topics (7 blogs + 3 courses)

## When to seed the next batch

- After ≥7 of these 10 have shipped through G4 (validates the pipeline at scale)
- When researchers flag a HOT vendor moment that can't wait
- Quarterly content-planning batch (~30 topics covering an emerging theme)

## Cross-references

- Seed source: `companies/learnova-academy/seed-topics-2026-04-30.yaml`
- Skill: `companies/learnova-academy/skills/seed-content-batch/SKILL.md`
- Blog Author: `companies/learnova-academy/agents/blog-author/AGENTS.md`
- Course Author: `companies/learnova-academy/agents/course-author/AGENTS.md`
- Quality bar: `companies/learnova-academy/CULTURE.md` (voice rules) + `skills/blog-write/SKILL.md` + `skills/course-architect/SKILL.md` + `skills/course-chapter-write/SKILL.md`
