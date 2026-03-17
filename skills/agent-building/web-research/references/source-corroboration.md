# Multi-Source Corroboration

## The 3-Source Rule

No factual claim ships in a research report without 3 independent sources confirming it.

This is not a suggestion. It's the minimum bar that separates "researched" from "probably correct":
- 1 source: you have a claim
- 2 sources: you have a corroborated claim
- 3 independent sources: you have a finding

---

## What "Independent" Means

**Independent = different publishers.** Not different articles from the same publisher.

| Counts as 3 sources | Counts as 1 source |
|---|---|
| TechCrunch + The Register + InfoQ | 3 TechCrunch articles |
| official docs + benchmark paper + practitioner blog | GitHub repo README + GitHub repo wiki + GitHub release notes |
| Reuters + Bloomberg + WSJ | AP story + 2 AP syndications |

**Same parent company = same source.** The Verge and Polygon are both Vox Media. They share editorial infrastructure and sometimes content. Count them as 1 source.

**A source that cites only one primary source is not independent.** If 3 blogs all cite the same benchmark paper, you have 1 source (the paper) confirmed by 3 echo chambers.

---

## Source Hierarchy

### Tier 1: Primary Sources
- Official documentation (docs.*, developer.*, api.*)
- Original research papers (arxiv.org, IEEE, ACM)
- Direct statements from the creators/maintainers (GitHub issues, official blog)
- Raw benchmark data and measurements

**Trust level:** High — but verify the date. Official docs can be outdated.

### Tier 2: Secondary Sources
- Reputable technical journalism (Ars Technica, InfoQ, The Register, ACM Queue)
- Conference talks from named, credentialed speakers
- Practitioner blogs with named authors and primary data
- Widely-cited analyses that reference primary sources

**Trust level:** Medium — evaluate the author's credentials and whether they cite primary sources.

### Tier 3: Aggregators
- SEO-optimized summaries ("Top 10 ways to...", "Complete guide to...")
- Undated or anonymously-authored posts
- Social media posts (LinkedIn articles, Twitter/X threads)
- Medium posts by unknown authors

**Trust level:** Low — use only to find primary sources, never as a source itself. If an aggregator cites something interesting, find the primary source and fetch that instead.

---

## Handling Conflicting Sources

When sources disagree, **record the conflict explicitly — never resolve it silently.**

### Conflict Resolution Protocol

```markdown
## Conflict: [claim topic]

**Version A:** [claim from source 1]
- Source: [URL]
- Evidence type: [primary / secondary]
- Date: [retrieved date]

**Version B:** [claim from source 2]
- Source: [URL]
- Evidence type: [primary / secondary]
- Date: [retrieved date]

**Analysis:**
- Possible reason for conflict: [different versions? different contexts? one more recent?]
- Recommended: [Version A / Version B / UNRESOLVED]
- If UNRESOLVED: flag in the research report as a known conflict
```

**Common conflict causes:**
- Version differences (source A covers v1, source B covers v2)
- Context differences (benchmarks run on different hardware/load)
- Temporal drift (one source is older)
- Motivated reasoning (vendor blog vs. independent benchmark)

**Do not:** Pick the version that fits your hypothesis. Pick the primary source from the more recent date, or mark as UNRESOLVED.

---

## Credibility Rubric

Score each source before including it:

| Signal | Points |
|---|---|
| Named author with verifiable credentials | +2 |
| Primary data (measurements, experiments) | +2 |
| Official domain for the project/org | +2 |
| Published within 12 months | +1 |
| Cited by 3+ other sources in your research | +1 |
| No author name | -2 |
| SEO-optimized structure | -1 |
| Undated | -2 |
| Contradicts 3+ independent sources | -2 |

**Threshold:** Include sources with score ≥ 2. Exclude sources with score ≤ 0.

---

## The Citation Laundering Problem

Citation laundering: Source A cites Source B. Source C cites Source A citing Source B. Now you have "3 sources" that are all downstream of a single unchecked claim.

**Detection:** For every claim, trace citations back to the origin. If all roads lead to one paper or one blog post, you have 1 source.

**Fix:** Find 2 additional primary sources that arrived at the same claim independently, not through the same citation chain.
