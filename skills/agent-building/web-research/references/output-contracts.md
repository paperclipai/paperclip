# Structured Output Contracts

## Why Output Contracts Matter

Research without a structured output contract produces confident-sounding summaries that blend verified claims with inferences. The reader can't tell which is which.

A structured contract forces three things:
1. **Explicit confidence levels** — every claim is rated, not just reported
2. **Citation trail** — every claim is linked to the sources that support it
3. **Gap acknowledgment** — unknowns are named, not silently omitted

---

## The Research Report Schema

```markdown
## Research Report: [Topic]

**Query:** [The original research question]
**Retrieved:** [YYYY-MM-DD]
**Researcher:** [Claude Code session / subagent]

---

### Findings

| Claim | Confidence | Sources | Notes |
|---|---|---|---|
| [Verbatim or close-paraphrase claim] | high | [url1], [url2], [url3] | — |
| [Claim with limited sources] | medium | [url1] | Only 1 primary source found |
| [Claim that conflicts across sources] | low | [url1], [url2] | CONFLICT: see Conflicts section |
| [Claim from training data, not fetched] | inferred | — | Not fetched — inference from training |

---

### Conflicts

For each CONFLICT claim above:

**[Claim topic]:**
- Source A says: [version A] — [url]
- Source B says: [version B] — [url]
- Status: UNRESOLVED / Resolved in favor of [A/B] because [reason]

---

### Gaps & Unknowns

Questions that could not be answered from available sources:
- [Unanswered question 1]
- [Unanswered question 2]

---

### Source Log

Every URL fetched during this research session (auto-appended by PostToolUse hook):
- [url1] — fetched [date]
- [url2] — fetched [date]
- [url3] — fetched [date]
```

---

## Confidence Level Calibration

### High Confidence
- 3+ independent primary sources confirm the claim
- Sources are recent (< 12 months for fast-moving topics)
- No conflicting sources found
- Example: "React 19 introduced the `use` hook" — confirmed in official docs, React blog, and 2 independent practitioner reports

### Medium Confidence
- 2 independent sources, or 1 strong primary source
- May be slightly dated (12–24 months)
- No conflicting sources, but limited corroboration
- Example: "Most teams use X pattern for Y" — confirmed in 2 practitioner blogs, no official benchmark

### Low Confidence
- 1 secondary source, or inferred from context
- May be outdated or context-dependent
- Example: "Some users report performance issues with X" — from 1 forum post, unverified

### Inferred (Not Fetched)
- Came from Claude's training data, not from a WebFetch this session
- **All inferred claims must be flagged explicitly.** They are not research findings.
- If an inferred claim is important, initiate a fetch to verify it before including it

---

## Reusable Templates

### Minimal Research Brief (quick fact-check)
```markdown
## Quick Research: [Question]
Retrieved: [date]

**Answer:** [claim]
**Confidence:** high/medium/low
**Source:** [url]
**Gaps:** [what wasn't answered]
```

### Competitive Research Report
```markdown
## Competitive Analysis: [Product/Market]
Retrieved: [date]

### Competitors
| Competitor | Key Claims | Confidence | Sources |
|---|---|---|---|
| [A] | [claims] | high/med/low | [urls] |

### Market Positioning
[Synthesized from corroborated claims only]

### Gaps
[What couldn't be determined]

### Source Log
[All fetched URLs]
```

### Dependency Audit Report
```markdown
## Dependency Audit: [Package/Library]
Retrieved: [date]

| Question | Answer | Confidence | Source |
|---|---|---|---|
| Current stable version? | [v] | high | [url] |
| Last updated? | [date] | high | [url] |
| Known CVEs? | [Y/N] | high | [url] |
| Actively maintained? | [Y/N] | medium | [url] |
| Breaking changes in latest? | [Y/N] | high | [url] |

### Source Log
[All fetched URLs]
```

---

## Saving Research for Reuse

Research reports saved to `~/.claude/research/[topic]-[date].md` are auto-loaded by the SessionStart hook when the same topic appears in a new session. This prevents re-fetching the same sources and builds a cumulative research base.

**Naming convention:** `~/.claude/research/[slug]-[YYYY-MM-DD].md`

The SessionStart hook scans for reports matching keywords in the current conversation context and prepends relevant reports as read-only context.
