---
name: web-research
description: Web research methodology for Claude Code using native WebSearch and WebFetch tools. Replaces one-shot WebFetch with a structured multi-source research loop (Plan → Search → Extract → Corroborate → Synthesize), PostToolUse source-log hook, and research subagent AGENTS.md config. Use when Claude is hallucinating sources, making up URLs, or returning shallow research. Triggers on: "claude code web research", "research the web", "multi-source research", "webfetch workflow", "research loop", "progressive deepening", "anti-hallucination research", "autonomous research agent", "source verification", "web search automation", "information gathering workflow", "verify from multiple sources", "check multiple sources", "research this topic", "find sources for", "Claude made up a source", "Claude is hallucinating facts", "can't trust Claude's research", "research agent", "competitor research automation", "market analysis automation", "dependency audit research", "spend hours verifying Claude's sources", "Claude invents sources". NOT for: MCP server setup for external search APIs (skill #006), debugging root cause analysis (skill #013).
---

# Web Research

One-shot WebFetch fills gaps with training data — silently, confidently, wrongly. This skill replaces it with a structured multi-source loop, a PostToolUse hook that creates an explicit source log, and a research subagent pattern for large tasks.

---

## Quick Setup

Install the source-log hook in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "WebFetch",
        "hooks": [{"type": "command", "command": "bash ~/.claude/hooks/source-log.sh"}]
      }
    ],
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [{"type": "command", "command": "bash ~/.claude/hooks/load-research.sh"}]
      }
    ]
  }
}
```

Full hook scripts: `references/anti-hallucination-hooks.md`

---

## The Research Loop

Five phases. Always run them in order.

| Phase | Action | Output |
|---|---|---|
| 1. Plan | Decompose the research question into 3–5 specific queries | query-list.md |
| 2. Search | WebSearch broad terms, identify the source landscape | source-candidates.md |
| 3. Extract | WebFetch targeted pages, strip boilerplate, extract claims | raw-claims.md |
| 4. Corroborate | Cross-reference each claim across 3+ independent sources | corroborated-claims.md |
| 5. Synthesize | Write structured report with confidence levels and citation trail | research-report.md |

Never skip Phase 4. Uncorroborated claims are opinions, not findings.

→ Full loop with sample prompts and output templates: `references/research-loop.md`

---

## Why One-Shot WebFetch Fails

Claude fills gaps in fetched content with training data. A single source amplifies bias. The more confident the output sounds, the more likely part of it is hallucinated.

**Detection signal:** If Claude cites a URL without having explicitly called WebFetch on it this session, that citation is hallucinated.

→ Failure taxonomy and hallucination detection patterns: `references/research-loop.md`

---

## Progressive Deepening Protocol

1. Keyword search → identify the source landscape (which domains cover this topic?)
2. Authority source drilling → fetch primary sources, not aggregators
3. Gap detection → what questions remain unanswered after 3+ sources?

**Stop signal:** When the 3rd source adds no new claims not already in sources 1 and 2 — stop digging.

→ Paywall handling, domain authority ranking, stop signals: `references/progressive-deepening.md`

---

## Multi-Source Corroboration

**The 3-source rule:** No factual claim ships in a research report without 3 independent sources confirming it.

**What counts as independent:** Different publishers. TechCrunch + Ars Technica + The Verge = 3 sources. Three TechCrunch articles = 1 source.

**Source hierarchy:**
1. Primary — official docs, original research, direct statements
2. Secondary — analysis, reputable journalism
3. Aggregators — use only to find primary sources, never as a source itself

**Conflicting sources:** Record the conflict explicitly. Never silently resolve it with a judgment call.

→ Full hierarchy, conflict protocol, credibility rubric: `references/source-corroboration.md`

---

## Structured Output Contract

Every research deliverable uses this schema:

```markdown
## Research Report: [Topic]
**Query:** [original question]  **Retrieved:** [date]

### Findings
| Claim | Confidence | Sources | Gaps |
|---|---|---|---|
| [claim] | high/medium/low | [URLs] | [what's missing] |

### Gaps & Unknowns
[Unanswered questions remaining after research]

### Source Log
[Every URL fetched this session — auto-appended by hook]
```

**Confidence:** high = 3+ independent primary sources; medium = 2 sources or 1 primary; low = 1 secondary or inferred.

→ Full template and confidence calibration guide: `references/output-contracts.md`

---

## Anti-Hallucination Hooks

**PostToolUse (WebFetch):** Appends every fetched URL to `~/.claude/source-log.md`. Any URL cited but absent from source-log.md is hallucinated.

**SessionStart:** Loads prior research reports matching the current project as context, preventing duplicate fetches across sessions.

→ Full hook scripts and source-log.md format: `references/anti-hallucination-hooks.md`

---

## Research Agent Pattern

For large tasks, spawn a subagent with restricted tools (WebSearch + WebFetch only). It cannot edit files or run code — research and report only.

**When to use inline vs. subagent:**
- Inline: quick fact-check, single topic, < 5 sources
- Subagent: competitive research, multi-topic, > 10 sources, or high hallucination risk

→ AGENTS.md config, tool restrictions, handoff protocol: `references/research-agent-pattern.md`

---

## Anti-Rationalization

| What you'll tell yourself | The truth |
|---|---|
| "One source is enough for this" | One source is never enough for a factual claim. Medium confidence = 2 sources. High = 3. |
| "I'll verify later" | You won't. The source-log hook forces verification at fetch time, not later. |
| "Claude's training data is current enough" | Training data has a cutoff. Anything recent = hallucinated confidence. |
| "The source cited sounds right" | "Sounds right" is exactly how hallucinated URLs end up in reports. Check source-log.md. |
| "This is just exploratory, no report needed" | Exploratory research without a report becomes hallucinated memory next session. |
| "WebSearch results are good enough" | WebSearch returns snippets. You need WebFetch to verify the actual page content. |

---

