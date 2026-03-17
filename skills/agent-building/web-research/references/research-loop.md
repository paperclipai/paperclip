# The Research Loop

## Why One-Shot WebFetch Fails

The hallucination trap: when Claude fetches a page, it reads the content but fills gaps using training data. There is no separator between "I read this on the page" and "I filled this in from memory." The result is a confident-sounding synthesis that blends real fetched content with hallucinated additions.

Failure modes:
- **Gap filling**: Claude fetches a page about a library but the page doesn't mention versioning. It fills in a version number from training data — which may be 18 months stale.
- **Single-source bias**: One source has a strong opinion. Claude reports it as consensus.
- **Confidence inversion**: The more coherent the output sounds, the more likely gaps have been smoothed over with hallucinations.
- **URL hallucination**: Claude cites URLs it never fetched. These often look valid (correct domain, plausible path) but don't exist or contain different content.

**Detection**: After any research session, compare the cited URLs against `~/.claude/source-log.md`. Every URL in the report that isn't in the source log was hallucinated.

---

## The Five-Phase Research Loop

### Phase 1: Query Planning

Decompose the research question before searching. A single broad query returns noisy results.

```
I need to research [topic]. Before searching, I will decompose this into:
1. [specific query 1 — factual core]
2. [specific query 2 — competitive landscape]
3. [specific query 3 — technical specifics]
4. [specific query 4 — recent developments]
5. [specific query 5 — counterarguments / limitations]

I will save these to query-list.md before proceeding.
```

Rule: 3–5 queries minimum. Vague single-query research is Phase 0 — it doesn't count.

### Phase 2: Broad Search

Use WebSearch for each query. Goal: identify the source landscape, not retrieve facts yet.

```
For each query in query-list.md:
1. Run WebSearch("[query]")
2. Record the top 5 result URLs and domains in source-candidates.md
3. Annotate each with source type: primary / secondary / aggregator
4. Do NOT read the results yet — build the map first
```

Output: `source-candidates.md` — a prioritized list of URLs grouped by source type.

### Phase 3: Source Extraction

WebFetch the highest-priority sources. Extract claims only — strip boilerplate, navigation, ads.

```
For each primary source in source-candidates.md:
1. WebFetch the URL
2. Extract factual claims (not summaries) into raw-claims.md
3. Tag each claim with: [source-url] [retrieved-date]
4. Note any contradictions with claims already in raw-claims.md
```

**Critical**: Write claims verbatim from the page. No paraphrasing yet. Paraphrasing introduces interpretation.

Output: `raw-claims.md` — tagged claim list with source URLs.

### Phase 4: Corroboration

Cross-reference every claim in raw-claims.md. This is the phase that prevents hallucinations from shipping.

```
For each claim in raw-claims.md:
1. Count independent sources confirming it
2. Assign confidence: high (3+ independent primary), medium (2 sources or 1 primary), low (1 secondary)
3. Flag any claim with < 2 independent sources as UNVERIFIED
4. For conflicting claims: record both versions + sources, mark as CONFLICT — do not resolve silently
```

Output: `corroborated-claims.md` — claims with confidence ratings and source counts.

### Phase 5: Synthesis

Write the research report from corroborated-claims.md only. Do not introduce new claims during synthesis.

```
Structure: Research Report schema (see output-contracts.md)
Rules:
- Only include claims from corroborated-claims.md
- Mark confidence levels explicitly
- List all fetched URLs in the Source Log section
- List unsolved gaps in Gaps & Unknowns
- Never introduce a claim during synthesis that wasn't in corroborated-claims.md
```

---

## Sample Prompts

### Starting a research session:
```
I need to research [topic]. Use the 5-phase research loop:
1. Decompose into 3-5 specific queries → save to query-list.md
2. WebSearch each query, build source-candidates.md
3. WebFetch primary sources, extract claims to raw-claims.md
4. Corroborate each claim across 3+ independent sources → corroborated-claims.md
5. Write research-report.md using only corroborated claims, with confidence levels and source log

Do not skip Phase 4. Any claim with < 2 independent sources must be marked UNVERIFIED.
```

### Checking for hallucinations:
```
Compare the URLs cited in research-report.md against ~/.claude/source-log.md.
List any cited URL that is not in the source log — those are hallucinated citations.
```

---

## Output File Templates

### query-list.md
```markdown
# Research Queries: [topic]
Generated: [date]

1. [query 1]
2. [query 2]
3. [query 3]
4. [query 4]
5. [query 5]
```

### raw-claims.md
```markdown
# Raw Claims: [topic]

| Claim | Source URL | Retrieved | Verbatim? |
|---|---|---|---|
| [claim] | [url] | [date] | yes/paraphrased |
```

### corroborated-claims.md
```markdown
# Corroborated Claims: [topic]

| Claim | Confidence | Sources | Status |
|---|---|---|---|
| [claim] | high/medium/low | [url1], [url2], [url3] | VERIFIED / UNVERIFIED / CONFLICT |
```
