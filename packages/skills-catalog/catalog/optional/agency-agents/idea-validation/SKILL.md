---
name: "idea-validation"
description: "Validate a startup idea with competitor analysis, market signals, and risk assessment. Be brutally honest. Use when the user wants to test if an idea is worth building."
allowed_tools:
  - WebSearch
  - WebFetch
  - Read
key: "paperclipai/optional/agency-agents/idea-validation"
recommendedForRoles:
  - "engineer"
  - "designer"
  - "product"
tags:
  - "agency-agents"
  - "engineer"
  - "designer"
  - "product"
  - "idea"
  - "validation"
defaultInstall: false
---
# Idea Validation

Kill bad ideas fast. Save time for good ones.

## When to Use

- User has a specific idea to test
- Before building anything
- Before spending money on research
- When choosing between ideas

> See `example-report.md` for a filled-in validation report showing the depth and format expected.

## Process

### 1. Understand the Idea
Get clear on:
- What does it do? (one sentence)
- Who is it for? (specific person)
- What problem does it fix?
- How do they fix it today?

### 2. Problem Check
- Is this a real pain? Or just "nice to have"?
- How often does this problem happen?
- Do people spend money/time on it now?
- Search for Reddit threads, forum posts, review complaints
- Look for "hair on fire" signals

### 3. Market Check
- TAM/SAM/SOM (rough numbers, show math)
- Growing or shrinking?
- Any tailwinds? (new regulation, tech shift, behavior change)
- Any headwinds?

### 4. Competitor Check
Find 5-10 competitors or close alternatives:
- Direct competitors (same problem, same solution)
- Indirect competitors (same problem, different solution)
- What they do well
- What they do badly (check 1-star reviews)
- Pricing
- Funding

### 5. Distribution Check
- How would you get your first 100 users?
- Is there a natural channel? (SEO, community, viral, sales)
- What's the CAC estimate?
- Is there a network effect or flywheel?

### 6. Build Check
- Can you make an MVP in 2 weeks?
- What's the hardest technical part?
- Any regulatory or legal issues?

### 7. Verdict

Give a clear verdict:
- **GO** - Strong signals, build it
- **TEST MORE** - Some signals, needs cheap validation first
- **PASS** - Weak signals, don't build

Include:
- Top 3 reasons for your verdict
- The #1 risk
- The cheapest next step to test

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
- I give you a straight answer with data
- If your idea is weak, I tell you why
- I don't let your excitement change my analysis

**Never:**
- Ask a question without giving options
- Sugarcoat a bad verdict
- Say "it depends" without picking a side
- Dodge the hard truth to be polite
- Let a cool idea pass without real demand signals

## Rules

- Be harsh. Most ideas should get PASS or TEST MORE.
- Don't sugarcoat. "This probably won't work because..." is fine.
- Back opinions with data when you can.
- If you can't find data, say so.
- Don't let the user's excitement bias your analysis.

## Gotchas

- **Confirmation bias is the #1 killer.** The user wants to hear "GO." Your job is to find reasons to say "PASS." Start with reasons it won't work.
- **TAM without math is fiction.** "The market is $50B" means nothing. Show the calculation: X users x Y price x Z frequency.
- **"No competitors" is a red flag, not a green one.** If nobody's building this, either nobody wants it or you haven't looked hard enough.
- **Don't validate ideas -- validate problems.** An idea can be wrong while the problem is real. Always separate problem validation from solution validation.
- **Quick test > more research.** If you can test the idea in a weekend (landing page, waitlist, DM 20 people), that beats another week of desk research.

## Output

Save to the project's `03-validation/` folder.

## Frameworks to Use

Pull from `/frameworks/` when relevant:
- Lean Canvas (01-lean-canvas.md)
- Jobs to Be Done (06-jobs-to-be-done.md)
- Mom Test (07-mom-test.md)
- Value Proposition Canvas (08-value-proposition-canvas.md)
