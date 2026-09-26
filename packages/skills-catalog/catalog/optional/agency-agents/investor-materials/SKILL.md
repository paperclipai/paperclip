---
name: "investor-materials"
description: "Create pitch decks, one-pagers, memos, financial models, and fundraising materials. Use when the user needs investor-facing docs."
allowed_tools:
  - Read
  - Write
  - WebSearch
key: "paperclipai/optional/agency-agents/investor-materials"
recommendedForRoles:
  - "generalist"
tags:
  - "agency-agents"
  - "generalist"
  - "investor"
  - "materials"
defaultInstall: false
---
# Investor Materials

Build investor materials that are consistent, real, and hard to poke holes in.

## When to Use

- Making or fixing a pitch deck
- Writing an investor memo or one-pager
- Building financial projections
- Answering accelerator applications
- Making sure all fundraising docs tell the same story

> See `example-outline.md` for an example seed deck outline showing slide structure and content depth.

## Golden Rule

All investor materials must agree with each other.

Before writing, confirm one source of truth:
- Traction numbers
- Pricing and revenue math
- Raise size and terms
- Use of funds
- Team bios
- Milestones and timeline

If numbers don't match across docs, stop and fix that first.

## Workflow

1. Collect the real facts
2. Find what's missing
3. Pick the doc type
4. Write it with clear logic
5. Check every number against the source of truth

## Pitch Deck Flow

1. Company + wedge (why you)
2. Problem
3. Solution
4. Product / demo
5. Market
6. Business model
7. Traction
8. Team
9. Competition
10. Ask
11. Use of funds / milestones
12. Appendix

## One-Pager / Memo

- Say what the company does in one sentence
- Show why now
- Put traction early
- Make the ask clear
- Keep claims easy to check

## Financial Model

- Show your assumptions
- Bear / base / bull cases
- Revenue logic layer by layer
- Spending tied to milestones
- Sensitivity analysis where the answer depends on guesses

## Gotchas

- **Numbers that don't match across docs are a deal-killer.** If the deck says $50K MRR and the memo says $40K, the investor trusts neither. Check every number against one source of truth.
- **Market sizing without math is the #1 slide that gets called out.** "The market is $10B" without showing the calculation loses credibility instantly. Always show: X users × Y price × Z frequency.
- **Fake certainty about assumptions kills trust.** "We will reach 100K users in 12 months" — no, you won't know that. Say "we assume" and show bear/base/bull cases.
- **Team titles that don't match LinkedIn get checked.** Investors will look. If your CTO is listed as "Senior Developer" on LinkedIn, they'll notice.
- **Revenue math that doesn't work backwards is obvious.** If you project $1M ARR but your pricing is $10/mo and you need 8,333 paying users, investors will ask how you'll get them.
- **Hype language ("revolutionary", "disruptive") signals first-time founder.** Experienced founders use specific language: "We reduce X by Y% for Z customers."

## Interaction Style

**No BS. Honest feedback only.**

This is a two-way talk:
- I ask you questions → you answer
- You ask me questions → I think hard, give you options, then answer

**When I ask you a question, I always:**
1. Think about it first
2. Give you 2-3 options with my honest take on each
3. Tell you which one I'd pick and why
4. Then ask what you think

**When you ask me something:**
- I give you a straight answer
- I tell you if a claim is weak or a number doesn't hold up
- I push you to cut the hype and show real proof

**Never:**
- Ask a question without giving options
- Let a weak claim slide into the deck
- Say "it depends" without picking a side
- Write hype that you can't back up in a meeting
- Skip the "investor will ask about this" warnings

## Before You Deliver

- Every number matches the source of truth
- Use of funds adds up
- Assumptions are visible
- No hype language
- You could defend this in a meeting

## Output

Save to the project's `04-build/` folder.
