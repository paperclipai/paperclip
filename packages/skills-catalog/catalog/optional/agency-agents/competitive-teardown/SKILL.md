---
name: "competitive-teardown"
description: "Deep competitor analysis. Tear apart a specific competitor or compare multiple competitors. Use when the user names a competitor or asks \"who else is doing this?\""
allowed_tools:
  - WebSearch
  - WebFetch
  - Read
key: "paperclipai/optional/agency-agents/competitive-teardown"
recommendedForRoles:
  - "researcher"
tags:
  - "agency-agents"
  - "researcher"
  - "competitive"
  - "teardown"
defaultInstall: false
---
# Competitive Teardown

Study competitors like you're planning to beat them.

## When to Use

- User names a specific competitor
- "Who else is doing this?"
- Before building, to find gaps
- Preparing for investor "competition slide"

> See `example-analysis.md` for a filled-in competitor teardown showing the format and depth expected.

## Single Competitor Teardown

### Product
- What do they actually do? (use the product, not just the landing page)
- Key features
- What's good about it
- What sucks (check 1-star reviews on App Store, G2, Reddit)
- Pricing tiers

### Business
- Funding (Crunchbase, PitchBook)
- Revenue if known (press, SimilarWeb traffic guesses)
- Team size (LinkedIn)
- Founded when
- Growth signals (hiring? launching new features? going quiet?)

### Users
- Who uses it? (check case studies, reviews, social mentions)
- How do they get users? (SEO, ads, viral, sales team)
- Community size (Discord, Reddit, Twitter followers)
- NPS or satisfaction signals

### Weaknesses
- Negative reviews (patterns, not one-offs)
- Missing features users ask for
- Pricing complaints
- Technical limitations
- Support complaints

## Multi-Competitor Comparison

Create a table:

| | Competitor A | Competitor B | Competitor C | Us (planned) |
|---|---|---|---|---|
| One-liner | | | | |
| Target user | | | | |
| Key feature | | | | |
| Pricing | | | | |
| Funding | | | | |
| Weakness | | | | |
| Our advantage | | | | |

## Find the Gap

After analysis, answer:
- Where are ALL competitors weak?
- What do users want that nobody does well?
- Is there an underserved segment?
- What positioning would make us different?

## Rules

- Use the product. Don't just read the landing page.
- Check reviews on multiple platforms
- Look for patterns in complaints, not single reviews
- Be fair. Give credit where it's due.
- If a competitor is way ahead, say so. Don't hide it.

## Gotchas

- **Don't just read the landing page.** Sign up for free trials. Watch demo videos. Read user forums. The landing page is marketing, not the product.
- **One-star reviews are gold, but look for patterns.** A single angry review means nothing. Ten people saying the same thing is a signal.
- **Funding ≠ success.** A competitor with $50M raised and no revenue is weaker than one with $2M raised and growing 20% monthly.
- **Don't confuse features with moat.** A feature can be copied in a sprint. Distribution, data, and network effects can't.
- **Check if they're growing or coasting.** Recent job postings, new features, blog activity — these signal momentum. Silence signals trouble.

## Output

Save to the project's `02-research/` folder.
Use the template from `templates/competitor-analysis.md` if it fits.
