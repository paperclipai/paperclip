---
name: "brainstorm"
description: "Run a structured brainstorm session for startup ideas. Takes a theme or problem and generates ideas with quick gut-checks. Use when the user wants to explore a space or generate new ideas."
allowed_tools:
  - WebSearch
key: "paperclipai/optional/agency-agents/brainstorm"
recommendedForRoles:
  - "designer"
  - "product"
tags:
  - "agency-agents"
  - "designer"
  - "product"
  - "brainstorm"
defaultInstall: false
---
# Brainstorm

Turn a vague direction into a list of concrete ideas worth testing.

## When to Use

- User has a theme, problem, or space they want to explore
- Generating new project ideas
- Expanding on a half-baked idea
- Looking for adjacent opportunities

## Process

### 1. Set the Frame
Ask or confirm:
- What space? (health, finance, dev tools, etc.)
- Who's the user? (founders, students, parents, etc.)
- Any limits? (no hardware, must be B2B, etc.)
- What's the goal? (side project, VC-backed, bootstrap)

### 2. Generate Ideas (Go Wide)
Produce 8-15 ideas. For each:
- **Name** - Working title
- **One-liner** - What it does in 10 words
- **Who** - Target user
- **Problem** - What pain it fixes
- **Why now** - Why this didn't work before
- **Quick risk** - Biggest thing that could kill it

### 3. Gut-Check Filter
Rate each idea on:
- Demand signal (0-5): Are people searching for this? Paying for alternatives?
- Buildability (0-5): Can you build an MVP in 2 weeks?
- Moat potential (0-5): Can you defend this?

### 4. Pick Top 3
Pick the 3 best ideas. For each, write:
- The key bet (what must be true for this to work)
- First validation step (cheapest way to test)
- Existing competitors (who's doing something close)

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
- I tell you what's wrong with your thinking if I see it
- I push back if your idea is weak

**Never:**
- Ask a question without giving options
- Sugarcoat bad ideas
- Say "it depends" without picking a side
- Give soft answers to hard questions
- Skip the tough feedback to be nice

## Rules

- No idea is too dumb during generation
- But be brutal during filtering
- "Interesting" is not enough. Need a real pain point.
- If the user already has a direction, skip to expanding that
- Don't fall in love with clever solutions to fake problems

## Gotchas

- **Don't brainstorm solutions — brainstorm problems.** Founders jump to features too fast. Force "what pain?" before "what product?"
- **"Interesting" ≠ real demand.** If you can't find anyone searching for it, paying for alternatives, or complaining online, the problem might be fake.
- **Avoid clever-founder bias.** Technical founders fall in love with clever solutions to problems nobody has. Test the problem first.
- **Don't skip "Why now?"** Every good idea needs a timing argument. If this could've been built 5 years ago and nobody did, ask why.
- **Too many ideas = no decision.** If you generate 15 ideas and can't pick 3, the frame is too broad. Narrow the space.

## Output

Save to the project's `01-brainstorm/` folder.

After delivering, suggest: "Want me to run /validate on any of these?"
