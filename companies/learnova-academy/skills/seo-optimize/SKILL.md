---
name: seo-optimize
description: >
  SEO Optimizer's classic-SEO skill — pre-publish audit + Search Console
  weekly anomaly pull + content-gap analysis. Use when ticket lands assigned
  to @seo-optimizer with type pre-publish-audit | weekly-sc-pull |
  content-gap.
---

# SEO Optimize

Classic search engine optimization. Schema.org, Core Web Vitals, internal linking, anomaly detection.

## Scope

- Pre-publish audits on G0-passed content
- Weekly Search Console anomaly reports
- Content-gap analyses on demand

## Inputs

- Paperclip ticket
- Vault target (for pre-publish) OR Search Console period (for weekly)

## Workflow

### Pre-publish audit

#### 1. Read the draft + frontmatter

Verify `content_type`, `learning_objectives`, `vendor_tag`, `status: g0-passed`.

#### 2. Validate JSON-LD on the rendered page

Build the page locally + validate:
```bash
cd learnovaBeast/learnova-academy
pnpm dev &  # port 3010
sleep 3
curl http://localhost:3010<route> | grep -A 50 'application/ld+json'
```

Run through validator:
```bash
curl -X POST 'https://validator.schema.org/validate' \
     -F "url=http://localhost:3010<route>"
```

Required JSON-LD blocks per page type:
- Course page → schema.org/Course
- Lesson page → schema.org/HowTo + Course
- Blog → schema.org/Article + FAQPage (if has KnowledgeChecks)
- Video lesson → +VideoObject

#### 3. Check internal linking

```bash
grep -oE '\[\[[a-z0-9/-]+\]\]' <draft-path> | wc -l
```

Required: ≥3 internal wikilinks.

#### 4. Check meta description + OG image

- meta description ≤160 chars
- og:image present + 1200×630 dimensions

#### 5. Run Lighthouse on the page

```bash
lighthouse http://localhost:3010<route> --output=json --output-path=/tmp/lh.json
jq '.categories.performance.score' /tmp/lh.json
```

Targets:
- Performance ≥0.9
- INP <200ms / LCP <2.5s / CLS <0.1

#### 6. Decide

PASS:
```
✅ SEO PASS · vault/<path>/draft.md
- JSON-LD validated (Course schema)
- 4 internal wikilinks
- Meta description 142 chars ✓
- OG image 1200×630 ✓
- Lighthouse: perf 0.94, INP 142ms, LCP 1.9s, CLS 0.03

Routing → @ceo for G3
```

BLOCK:
```
❌ SEO BLOCK · vault/<path>/draft.md

JSON-LD (1 blocker)
- Missing FAQPage block (3 KnowledgeChecks present, schema not generated)

LIGHTHOUSE (1 blocker)
- LCP regressed to 2.7s. Above 2.5s target.

→ @content-author: add FAQPage frontmatter; @chief-engineering: investigate LCP regression
```

### Weekly Search Console anomaly pull

```bash
# Search Console MCP not yet wired; for now use Google Search Console API directly via OAuth
gsc query \
  --site academy.kspl.tech \
  --period last-week \
  --dimensions query,page \
  --output /tmp/sc.json
```

Compute:
- Top 10 winners (≥5 position gain)
- Top 10 losers (≥5 position drop)
- New queries we're now ranking for
- Queries we lost ranking on

Write to `vault/marketing/seo/<week>.md`. Top 5 losers get a fix proposal.

### Content-gap analysis

CEO requests when planning new courses. Compare our top-ranking queries to competitors' (e.g., DeepLearning.AI Short Courses, Khan Academy AI). Output: list of queries we should rank for but don't.

## Output

PASS/BLOCK comment (pre-publish) OR vault report (weekly/gap).

## Notes

- Don't modify markdown. Suggest fixes via ticket on @content-author through chief-content.
- Don't bulk-regen content for SEO purposes. Targeted fixes only.
- Per-task cap $0.50. Pre-publish audits ≤$0.20.

## Escalation

- Top page drops >10 positions → chief-marketing same heartbeat (CEO digest)
- Lighthouse on Home <90 → chief-engineering same heartbeat
- AI-search citation drop (Perplexity referrer) → audit llms.txt
