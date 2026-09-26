---
name: "deep-research"
description: "Run deep research on a topic. Web searches, data collection, source checking, and a structured report. Use when the user needs more than a quick answer."
allowed_tools:
  - WebSearch
  - WebFetch
  - Read
key: "paperclipai/optional/agency-agents/deep-research"
recommendedForRoles:
  - "designer"
  - "researcher"
tags:
  - "agency-agents"
  - "designer"
  - "researcher"
  - "deep"
  - "research"
defaultInstall: false
---
# Deep Research

Go deep on one topic. Come back with facts, not fluff.

## When to Use

- User needs real data on a topic
- Writing a research report or blog post
- Need to understand a new space
- Preparing materials for investors or partners

## Process

### 1. Scope
Ask or confirm:
- What's the question?
- How deep? (quick scan vs full report)
- Any angle? (tech, business, user behavior, etc.)
- Who's the audience? (self, team, investors, public)

### 2. Research
Run multiple web searches. Look for:
- Industry reports and data
- Academic papers or studies
- News articles (last 12 months)
- Expert opinions and blog posts
- Reddit/HN/Twitter discussions
- Company blogs and case studies

### 3. Verify
- Cross-check numbers across sources
- Flag conflicting data
- Note the source quality (press release vs research paper)
- Check dates. Flag anything older than 2 years.

### 4. Synthesize
Don't just list what you found. Connect the dots:
- What do the facts add up to?
- What's the pattern?
- What's missing from the data?
- What surprised you?

### 5. Write Report

Structure:
1. **TL;DR** - 3 sentences max
2. **Background** - Context someone needs to understand
3. **Key Findings** - The meat. Numbered, sourced.
4. **Analysis** - What it means. Your take.
5. **Open Questions** - What we still don't know
6. **Sources** - Every link, with date and source name

## Rules

- Every claim needs a source
- Say "I couldn't find data on X" instead of making stuff up
- Include views that disagree with each other
- Keep your opinion in the Analysis section, not the Findings
- If the user asks for quick research, skip steps 3-4

## Gotchas

- **Old data kills credibility.** A 2021 market size report is useless in 2026. Always check the publish date. Flag anything older than 18 months.
- **Press releases aren't research.** Company announcements are marketing. Cross-check with third-party sources, financial filings, or user data.
- **Conflicting sources are a feature, not a bug.** When two reports disagree, that's where the interesting analysis lives. Don't just pick one.
- **"I couldn't find data" is a valid finding.** Don't fill gaps with guesses. If the data doesn't exist, say so -- that's useful info for the user.
- **Synthesis > summary.** Listing 10 findings isn't research. Connect the dots -- what patterns emerge? What's the "so what?"

## Output

Save to the project's `02-research/` folder.
