---
name: search
description: >
  Web search and page retrieval for factual lookups, current events, documentation,
  and research. Trigger on: "search for", "look up", "find information on", "what is X",
  "latest news on", "web search", "find docs for", "check if X exists online",
  "search the web for". Uses WebSearch for discovery and WebFetch for reading specific
  pages. Returns structured results with source attribution.
license: MIT
metadata:
  audience: developers
  domain: research, information-retrieval
roles: [all]
---

# Search Skill

Web search and page retrieval. Two tools in order of preference:

1. **WebSearch** --- keyword query, returns ranked results with snippets
2. **WebFetch** --- fetch a specific URL and extract readable content

---

## Telemetry

Emit skill events so usage is tracked in the Paperclip dashboard.

**At skill start:**
```bash
SKILL_START_MS=$(date +%s%3N)
SKILL_SESSION="skill-search-$(date +%s)-$$"
python3 "${CLAUDE_CONFIG_DIR:-/paperclip/.agent-hooks}/hooks/skill_telemetry.py" \
  start search "$SKILL_SESSION" 2>/dev/null &
```

**At skill end (replace --success true/false as appropriate):**
```bash
SKILL_DURATION_MS=$(( $(date +%s%3N) - SKILL_START_MS ))
python3 "${CLAUDE_CONFIG_DIR:-/paperclip/.agent-hooks}/hooks/skill_telemetry.py" \
  end search "$SKILL_SESSION" --success true --duration_ms "$SKILL_DURATION_MS" 2>/dev/null &
```

Fails silently --- a broken backend never blocks search execution.

---

## Step 1: Parse the Query

- **Current information** (news, prices, versions, API changes) -> WebSearch
- **Specific URL given** -> WebFetch directly
- **Ambiguous** -> WebSearch first, WebFetch the most relevant result

---

## Step 2: Run WebSearch

```
WebSearch(query="<optimised query string>")
```

Query optimisation rules:
- Specific nouns over vague descriptions ("FastAPI SQLAlchemy session scoping" not "how to use database")
- Add version/year qualifiers ("python 3.12 asyncio task group")
- Use site: for known sources ("site:docs.anthropic.com tool use")
- For current events: append the year ("2026")

Return top 3-5 results with title, URL, snippet. Auto-select most relevant for follow-up.

---

## Step 3: Fetch Pages (when needed)

```
WebFetch(url="<url>", prompt="Extract: <specific info needed>")
```

Fetch when: snippet does not answer the question, user asks to "read" a page, code examples needed.
Skip when: snippet already contains the answer, or page is clearly an index/list.

---

## Step 4: Synthesise and Return

```markdown
## Search: <query>

**Sources:**
- [Title](URL) --- one-line summary of what this source covers

**Findings:**
<concise answer derived from sources>

**Key details:**
- Fact 1 (source: [Title](URL))
- Fact 2 (source: [Title](URL))
```

Attribution rules:
- Every factual claim traceable to a source URL
- No verbatim reproduction > 15 words
- Surface source conflicts rather than silently picking one

---

## Step 5: Handle Failures

| Failure | Action |
|---------|--------|
| No search results | Rephrase with different keywords, retry once |
| WebFetch 403/blocked | Try another result from the search list |
| Paywall | Note unavailability, surface available snippets |
| WebSearch unavailable | Answer from training data with cutoff caveat (May 2025) |
