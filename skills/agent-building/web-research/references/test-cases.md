# Test Cases: web-research

## Trigger Tests (Should Fire)

| # | Prompt | Expected |
|---|---|---|
| T1 | "I need Claude Code to do web research on competitor pricing" | TRIGGER |
| T2 | "Claude keeps making up sources when I ask it to research things" | TRIGGER |
| T3 | "How do I set up a multi-source research workflow in Claude Code?" | TRIGGER |
| T4 | "I want to build an autonomous research agent" | TRIGGER |
| T5 | "Claude hallucinated a URL in my research report - how do I fix this?" | TRIGGER |
| T6 | "Set up a WebFetch workflow with source verification" | TRIGGER |
| T7 | "I need a research loop for autonomous information gathering" | TRIGGER |
| T8 | "Claude is hallucinating facts in my research - how do I stop it?" | TRIGGER |
| T9 | "Help me build a progressive deepening research approach" | TRIGGER |
| T10 | "How do I verify information from multiple sources in Claude Code?" | TRIGGER |
| T11 | "Set up web search automation for market research" | TRIGGER |
| T12 | "I can't trust Claude's research - it invents sources" | TRIGGER |

## No-Trigger Tests (Should NOT Fire)

| # | Prompt | Expected |
|---|---|---|
| N1 | "Set up an MCP server for Exa search API" | NO-FIRE (→ skill #006) |
| N2 | "My code has a bug I need to debug" | NO-FIRE (→ skill #013) |
| N3 | "Fetch this URL for me: https://example.com" | NO-FIRE (single fetch, not a research workflow) |
| N4 | "How do I write unit tests?" | NO-FIRE (→ TDD skill) |
| N5 | "What is WebSearch?" | NO-FIRE (conceptual question, not a workflow request) |

## Output Tests (After Triggering)

When the skill triggers on T1–T12, the response must include all of the following:

| # | Assertion |
|---|---|
| O1 | Mentions the 5-phase Research Loop (Plan → Search → Extract → Corroborate → Synthesize) |
| O2 | Mentions the 3-source rule or multi-source corroboration |
| O3 | References a PostToolUse hook for WebFetch source logging |
| O4 | Includes or references the research report schema (Findings table + Confidence + Source Log) |
| O5 | Mentions progressive deepening or broad-to-specific search approach |
| O6 | Includes an anti-rationalization table or addresses the "one source is enough" rationalization |
| O7 | References the research subagent pattern or AGENTS.md config |
| O8 | Distinguishes primary sources from aggregators |
| O9 | References `references/research-loop.md` or equivalent detail file |
| O10 | Does NOT recommend installing an external search API MCP server |

## Scoring

- Trigger score: X/12 (target: ≥ 10/12, 83%+)
- No-fire score: X/5 (target: 5/5, 100%)
- Output score: X/10 (target: ≥ 8/10, 80%+)
- Combined: X/27

**Pass threshold:** 80% across all three categories.
