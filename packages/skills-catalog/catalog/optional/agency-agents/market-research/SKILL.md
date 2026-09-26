---
name: "market-research"
description: "Run market research, competitive analysis, investor due diligence, and industry scans. Use when the user wants market sizing, competitor comparisons, fund research, or tech scans."
allowed_tools:
  - WebSearch
  - WebFetch
  - Read
key: "paperclipai/optional/agency-agents/market-research"
recommendedForRoles:
  - "researcher"
tags:
  - "agency-agents"
  - "researcher"
  - "market"
  - "research"
defaultInstall: false
---
# Market Research

Make research that helps decisions, not research for show.

## When to Use

- Researching a market, company, investor, or tech trend
- Building TAM/SAM/SOM numbers
- Comparing competitors
- Checking investor fit before outreach
- Testing a thesis before building

## Process

### 1. Pick the Research Type

Figure out which kind of research the user needs:
- Investor / Fund Check
- Competitor Check
- Market Size
- Tech / Tool Research

### 2. Run Investor / Fund Check

Get:
- Fund size, stage, check size
- Portfolio companies that matter
- Public thesis and recent deals
- Why they fit or don't fit
- Red flags

### 3. Run Competitor Check

Get:
- What the product really does (not marketing fluff)
- Funding and investors
- Traction if public
- How they get users and what they charge
- Strengths, weaknesses, gaps

### 4. Run Market Size

Use:
- Top-down from reports
- Bottom-up from real customer numbers
- Show your math. Every guess should be clear.

### 5. Run Tech / Tool Research

Get:
- How it works
- Trade-offs and who's using it
- How hard to set up
- Lock-in, security, and risk

### 6. Write It Up

Structure every deliverable as:
1. Quick summary (2-3 sentences)
2. Key findings
3. What this means
4. Risks and caveats
5. What to do next
6. Sources

## Rules

- Every big claim needs a source.
- Use recent data. Flag old data.
- Include the bad news too. Show risks.
- End with a decision, not just a summary.
- Keep facts, guesses, and suggestions separate.
- All numbers have sources or are marked as guesses.
- Old data is flagged.
- The suggestion follows from the facts.
- Someone can make a decision from this.

## Gotchas

- **Top-down TAM is lazy and always wrong.** "10% of the $X billion market" is not analysis. Bottom-up from real customer numbers or go home.
- **Analyst reports have built-in bias.** Reports from vendors (like AWS sizing the cloud market) overstate their own segment. Use independent sources.
- **Revenue proxies are unreliable.** SimilarWeb traffic estimates can be off by 5x. Combine multiple signals: hiring, social, Crunchbase, app store rankings.
- **Don't confuse market size with addressable market.** The CRM market is $80B, but if you're building for freelancers, your market is a fraction of that.
- **Recency matters.** A market growing 40% in 2024 might be flat in 2026. Always check the latest data points, not just the headline number.

## Output

Save to the project's `02-research/` folder.

Format each deliverable with: quick summary, key findings, what this means, risks and caveats, next steps, and sources.
