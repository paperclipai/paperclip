# Progressive Deepening Protocol

## The Pattern

Research fails at both extremes: too broad (surface noise, no depth) or too narrow (misses the landscape). Progressive deepening solves this with a staged approach.

```
Broad keyword search
    → Identify source landscape (which domains, publishers, voices cover this?)
        → Select authority sources per domain
            → Drill into primary sources
                → Detect gaps
                    → Stop (diminishing returns signal)
```

---

## Stage 1: Keyword Search (Breadth)

Goal: map the terrain, not retrieve facts.

**Queries to run:**
- `[topic] overview`
- `[topic] best practices [year]`
- `[topic] vs [alternative]`
- `[topic] problems limitations`
- `[topic] official documentation`

**Output:** A map of which domains/publishers cover the topic and at what depth. Group into: official sources, expert practitioners, aggregators/SEO content.

**Do not fetch pages yet.** Just note domains and source types from WebSearch results.

---

## Stage 2: Authority Source Selection

From the source map, select the highest-authority sources per tier:

| Tier | Examples | Use for |
|---|---|---|
| Official | docs.framework.io, github.com/project, arxiv.org | Ground truth for specs and capabilities |
| Practitioner | specific dev blogs, conference talks, GitHub issues | Real-world usage patterns and gotchas |
| Journalism | Ars Technica, InfoQ, The Register | Announcements, competitive context |
| Aggregators | Medium SEO posts, listicles | Finding links to primary sources only |

**Rule:** Select 2–3 sources per tier. Never more than 10 total sources for a single research question — quality over quantity.

---

## Stage 3: Primary Source Drilling

WebFetch authority sources first. Extract claims verbatim. Look for:
- Official benchmarks, version numbers, feature lists
- Author credentials and publication date
- Internal citations that point to deeper primary sources

**Following the citation chain:** If a practitioner blog cites a paper or official benchmark, fetch the paper too. The citation chain is your path to primary sources.

---

## Stage 4: Gap Detection

After 3+ primary sources, audit what's still unknown:

```markdown
## Gap Audit — [topic]

| Question | Answered? | Sources | Remaining Gap |
|---|---|---|---|
| [Q1] | yes | [urls] | — |
| [Q2] | partial | [urls] | Missing: [specific aspect] |
| [Q3] | no | — | No source found |
```

For each remaining gap: decide whether to dig further or mark as UNKNOWN in the report.

---

## Stop Signal: Diminishing Returns

Stop digging when **3 consecutive sources add no new claims** not already in raw-claims.md.

This is the diminishing returns signal. You've reached saturation for this research question.

**Anti-pattern:** Fetching a 10th source hoping it has something new. If sources 7, 8, and 9 were redundant, source 10 won't help. Write the report with gaps acknowledged.

---

## Paywall Handling

When a high-authority source is paywalled:

1. **Check the abstract / preview**: Often contains the key claims
2. **Check Google Scholar**: Many papers have free preprint versions
3. **Check the authors' institutional page**: Authors often post PDFs
4. **Check Archive.org**: Cached versions of older paywalled articles
5. **If still blocked**: Mark as "source identified but inaccessible" in source-candidates.md, find an alternative secondary source that cites it

**Never** report a paywalled claim you couldn't verify as if you read the full source.

---

## Domain Authority Signals

Positive signals (higher weight):
- Official project domain (`.io`, GitHub org, official docs subdomain)
- Named author with verifiable credentials
- Recent update date
- Primary data (benchmarks, measurements, original experiments)
- Cited by other sources in your research

Negative signals (lower weight or exclude):
- No author name
- SEO-optimized structure ("10 best...", "complete guide to...")
- Thin content (< 500 words on a complex topic)
- Undated or > 2 years old for fast-moving topics
- Contradicts 3+ other sources with no explanation
