---
name: geo-optimize
description: >
  SEO Optimizer's generative-engine optimization skill — make pages
  citation-worthy for Perplexity, ChatGPT search, Claude search, Gemini
  search. Maintain /llms.txt + /llms-full.txt. Use when ticket lands assigned
  to @seo-optimizer with type llms-txt-regen or geo-audit.
---

# GEO Optimize

Generative engine optimization. /llms.txt is the front door; answer-first headings + source citations are the currency.

## Scope

- /llms.txt + /llms-full.txt regeneration
- Per-page GEO audits (answer-first H1, citation density, FAQPage)
- AI-search citation tracking (Perplexity / ChatGPT / Claude / Gemini referrer logs)

## Inputs

- Paperclip ticket with `type: llms-txt-regen | geo-audit`
- Convex query: published courses + blogs

## Workflow

### llms-txt-regen

#### 1. Pull all published content

```bash
# Convex query via agent API
curl -X POST https://academy.kspl.tech/api/agents/query \
  -H "Authorization: Bearer $ACADEMY_AGENT_API_KEY" \
  -d '{"query": "courses + blogs WHERE status=published"}'
```

#### 2. Generate /llms.txt (top URLs index)

Format (per Anthropic + Cursor + Mintlify convention):
```
# Koenig AI Academy

> Learn AI the day it ships. Free B2C AI-learning portal at academy.kspl.tech.

## Courses

- https://academy.kspl.tech/learn/claude-tool-use-from-zero
  Course on Claude tool use, 4 chapters, ~45 min total
- https://academy.kspl.tech/learn/anthropic-mcp-from-first-principles
  Course on MCP, 5 chapters, ~60 min total
...

## Blogs

- https://academy.kspl.tech/blog/2026-04-29-anthropic-7-connectors
  How Anthropic's 7 new connectors work, 200 words, source-cited
...

## API + agent endpoints

- https://academy.kspl.tech/api/agents/courses
  Authorized agent course CRUD
```

#### 3. Generate /llms-full.txt (markdown corpus export)

For each entry in /llms.txt, append the full markdown of the lesson/blog (deduplicated, no frontmatter).

```bash
cat <<EOF > learnovaBeast/learnova-academy/public/llms-full.txt
# Koenig AI Academy — Full markdown export

EOF

for slug in $(curl -s ... | jq -r '.[].slug'); do
  echo "## https://academy.kspl.tech/learn/$slug" >> learnovaBeast/learnova-academy/public/llms-full.txt
  cat vault/courses/$slug/*.md | sed '1,/^---$/d; /^---$/,/^---$/d' >> learnovaBeast/learnova-academy/public/llms-full.txt
  echo "---" >> learnovaBeast/learnova-academy/public/llms-full.txt
done
```

#### 4. Validate

- /llms.txt ≤500 entries (truncate to top 500 by traffic if more)
- /llms-full.txt ≤2MB (chunk if larger)
- Each URL returns 200

#### 5. Commit + open PR

```bash
git checkout -b chore/llms-txt-regen-<date>
git add learnovaBeast/learnova-academy/public/llms*.txt
git commit -m "chore(seo): regen llms.txt + llms-full.txt"
gh pr create --title "chore(seo): regen llms.txt + llms-full.txt" --body "<N> entries; <M> KB"
```

### geo-audit (per-page)

For a specific page, check:
- [ ] H1 is answer-first ("How to ..." > "Guide to ...")
- [ ] First paragraph (60-160 chars) directly answers H1
- [ ] ≥3 inline source citations (LLMs reward attribution)
- [ ] FAQPage schema if KnowledgeChecks present
- [ ] No prompt-injection phrases ("ignore previous instructions", etc.)
- [ ] Headings end in actionable verbs/outcomes

Score 0-6. Block if <5.

## Output

Updated /llms.txt + /llms-full.txt PR (regen) OR PASS/BLOCK comment (audit).

## Notes

- Don't modify markdown content. Suggest changes via @content-author through chief-content.
- /llms.txt is auto-discoverable by AI search engines via `<head>` link tag.
- Per-task cap $0.30 (regen) or $0.20 (audit).

## Escalation

- AI-search citation rate drops (Perplexity referrer logs) → propose llms.txt audit
- Same page consistently fails GEO audit → propose course-author skill addition for answer-first heading discipline
