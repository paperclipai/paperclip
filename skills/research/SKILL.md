---
name: research
description: "Research any topic using one of two modes: AutoResearchClaw (autonomous 23-stage pipeline → verified citations, experiment code, full academic paper) or Regular Research (fast Claude-native synthesis with structured brief). Always trigger on: 'research X', '/research', 'investigate X', 'look into X', 'write a paper on X', 'give me a brief on X'."
roles: [all]
---

## Mode Selection

Topic: **$ARGUMENTS**

Choose a research mode:

**1. AutoResearchClaw** — Full autonomous pipeline
- Produces: academic-quality paper with verified citations, reproducible experiment code, structured sections (abstract, methods, results, discussion)
- Time: ~10–60 minutes depending on topic depth
- Best for: novel or niche topics, full papers, verified citations from Semantic Scholar, situations where you need a publishable artifact

**2. Regular Research** — Fast Claude synthesis
- Produces: structured brief (background, key findings, open questions, recommended sources)
- Time: ~30 seconds
- Best for: known/established topics, quick answers, orientation before deeper work, topics where AutoResearchClaw's Semantic Scholar index is unlikely to have coverage

Which mode? **(1 or 2)** — reply with your choice and I'll proceed.

---

## If Mode 1: AutoResearchClaw

Load and follow: `skill/researchclaw/SKILL.md`

This will run the 23-stage ResearchClaw pipeline: topic refinement → literature search (Semantic Scholar) → hypothesis generation → experiment design → code generation → results analysis → full paper compilation.

---

## If Mode 2: Regular Research

Load and follow: `skill/regular-research/SKILL.md`

This will run a fast Claude-native synthesis: web search if needed → structured brief with background, key findings, open questions, and recommended sources.
