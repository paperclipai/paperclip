# Research Agent Pattern

## When to Spawn a Research Subagent

| Use inline research | Use a research subagent |
|---|---|
| Quick fact-check (1–3 sources) | Competitive analysis (10+ sources) |
| Single-topic lookup | Multi-topic research brief |
| Part of a larger implementation task | Research is the entire task |
| Low hallucination risk (recent docs) | High hallucination risk (market claims, benchmarks) |
| < 10 minutes of research | > 30 minutes of research |

---

## AGENTS.md Configuration

A dedicated research agent with tool restrictions prevents scope creep. It can only read the web — it cannot edit files, run code, or make API calls.

```markdown
---
name: research-agent
description: Autonomous web research agent. Uses WebSearch and WebFetch to gather multi-source information. Produces structured research reports with confidence levels and citation trails. NOT allowed to edit files, run commands, or make API calls.
---

# Research Agent

You are a research-only agent. Your job is to gather information from the web and produce a structured research report. You cannot write code, edit files, or take actions — research and report only.

## Tool Restrictions
- Allowed: WebSearch, WebFetch, Read (for reading existing research reports)
- Not allowed: Write, Edit, Bash, any MCP tools

## Research Protocol
1. Receive a research question
2. Decompose into 3–5 specific queries
3. Run WebSearch for each query
4. WebFetch the top 2–3 primary sources per query
5. Apply the 3-source corroboration rule
6. Write a structured research report using the output contract schema

## Output Contract
Every response must include:
- Findings table with confidence levels
- Source log (all WebFetch URLs)
- Gaps & Unknowns section
- No claims without at least 1 fetched source

## Handoff Protocol
When research is complete, output:
```
RESEARCH COMPLETE
Topic: [topic]
Findings: [N] verified claims
Confidence: [X high / Y medium / Z low]
Gaps: [N gaps identified]
Report saved to: [path or inline]
```
```

---

## Spawning the Research Subagent

From the main agent, spawn with a clear task and output contract:

```
I need to research [topic]. Spawn a research subagent with this prompt:

"Research [specific question] using the 5-phase research loop:
1. Decompose into 3–5 specific queries
2. WebSearch each query
3. WebFetch top primary sources
4. Corroborate each claim (3-source minimum)
5. Write a research report with:
   - Findings table (claim | confidence | sources)
   - Gaps & Unknowns
   - Complete source log

Confidence levels: high = 3+ independent primary sources, medium = 2 sources or 1 primary, low = 1 secondary.
Do not include inferred claims. If a claim can't be corroborated, mark as UNVERIFIED."
```

---

## Handoff Protocol: Research → Main Agent

When the research subagent completes, it returns a structured report. The main agent's job:

1. **Validate the source log** — check that claimed sources actually appear in the log
2. **Review confidence levels** — flag any high-confidence claims with only 1 source
3. **Check for gaps** — decide whether to spawn additional research or proceed with gaps acknowledged
4. **Consume the report** — use only high/medium confidence findings in downstream work

```
[MAIN AGENT]
The research subagent returned a report. Before using its findings:
1. Check: are all cited URLs in the source log?
2. Check: any claim marked "high" with < 3 sources?
3. Check: are the Gaps relevant to my task?

If source log is missing URLs cited in the report → those claims are hallucinated, do not use them.
```

---

## Tool Restriction Enforcement

Claude Code doesn't natively enforce tool restrictions on subagents, but you can enforce them via the AGENTS.md `description` field and explicit instructions:

```markdown
# Research Agent

You ONLY have these tools available: WebSearch, WebFetch, Read.
If you find yourself about to use Write, Edit, Bash, or any MCP tool — stop.
Research agents do not take actions. They gather information and report.
```

The explicit "stop if you're about to use Write" instruction is more reliable than relying on the description field alone in practice.

---

## Research Agent Composition

The research agent composes with other skills:

- **With #002 (persistent memory)**: Research agent saves findings to `~/.claude/research/` for cross-session reuse
- **With #014 (ubiquitous language)**: Research agent can discover domain terminology from primary sources
- **With #010 (self-improving agent)**: Findings from research sessions improve the agent's domain knowledge over time
- **With #015 (error recovery)**: Stop hook preserves partial research if the session crashes mid-loop
