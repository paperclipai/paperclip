---
name: gstack-plan-ceo-review
description: >
  CEO/founder-mode plan review. Rethink the problem, find the 10-star product,
  challenge premises, expand scope when it creates a better product. Four modes:
  SCOPE EXPANSION (dream big), SELECTIVE EXPANSION (hold scope + cherry-pick
  expansions), HOLD SCOPE (maximum rigor), SCOPE REDUCTION (strip to essentials).
  Use when asked to "think bigger", "expand scope", "strategy review", "rethink this",
  or "is this ambitious enough".
  Proactively suggest when the user is questioning scope or ambition of a plan,
  or when the plan feels like it could be thinking bigger.
---

# CEO/Founder Plan Review

Review this plan from a CEO/founder perspective. Your job is to ensure we're building the right thing at the right level of ambition — not just reviewing code quality.

## Mode Selection

First, determine the review mode via AskUserQuestion:

> What kind of review do you need?
>
> - **A) SCOPE EXPANSION** — "Dream big" mode. Challenge every scope reduction. Find the 10-star version.
> - **B) SELECTIVE EXPANSION** — Hold current scope but cherry-pick specific expansions that unlock significant value.
> - **C) HOLD SCOPE** — Maximum rigor within current scope. No expansion, no reduction. Focus on execution quality.
> - **D) SCOPE REDUCTION** — Strip to essentials. What's the minimum that ships value?

## Phase 1: Design Context

1. Check for existing design docs:
   - Look in `docs/superpowers/specs/` for design documents
   - If found, read the most recent one for context on the problem and chosen approach

2. Read the plan file or understand the current scope from the conversation

3. Read `CLAUDE.md` and `TODOS.md` for project context

4. Run `git log --oneline -10` to understand recent work

## Phase 2: The CEO Questions

Ask these questions based on the selected mode. Use AskUserQuestion ONE AT A TIME.

### For SCOPE EXPANSION mode:

**Q1: The 10-star question**
"What would make this a 10-star product instead of a 3-star product? Don't think about implementation — think about user delight. What's the version that makes users say 'wow'?"

**Q2: The missed opportunity scan**
"Looking at this plan, what are we NOT doing that users will eventually ask for? What's the obvious gap we're leaving for a competitor to fill?"

**Q3: The time machine**
"If you shipped exactly this plan and came back in 6 months, what would you wish you had built instead? What would users have asked for?"

**Q4: The platform play**
"Is there a platform opportunity here — something that enables others to build on top, or that becomes infrastructure for future features?"

### For SELECTIVE EXPANSION mode:

**Q1: The value multiplier**
"Which single addition to this plan would multiply its value by 10x? Not add features — multiply impact."

**Q2: The viral coefficient**
"Does anything in this plan help users bring other users? If not, is there a natural expansion that does?"

**Q3: The lock-in**
"What keeps users after they try this? Is there an expansion that deepens engagement?"

### For HOLD SCOPE mode:

**Q1: The scope boundary**
"Is everything in this plan essential to the core value proposition? What's 'nice to have' disguised as 'must have'?"

**Q2: The success metric**
"How will you know if this shipped successfully? What's the one number that matters?"

**Q3: The risk assessment**
"What's most likely to go wrong? Technical risk? User adoption? Competitive response?"

### For SCOPE REDUCTION mode:

**Q1: The MVP test**
"If you could only ship ONE thing from this plan, what delivers the most value per hour invested?"

**Q2: The deferral list**
"What can be shipped in v2 without hurting v1? Be aggressive."

**Q3: The complexity audit**
"Which parts of this plan add complexity without adding proportional user value?"

## Phase 3: Premise Challenge

For ALL modes, challenge the core premises:

1. **Is this solving a real problem?** Not hypothetical — real users with real pain.

2. **Is this the right solution?** Could a different approach solve it better/faster/cheaper?

3. **Is this the right time?** Should this wait for a dependency, or ship now and iterate?

4. **Is this differentiated?** What's the "only we can do this" angle?

Output premises as statements:
```
PREMISE CHECK:
1. Real problem: [statement] — agree/disagree?
2. Right solution: [statement] — agree/disagree?
3. Right timing: [statement] — agree/disagree?
4. Differentiation: [statement] — agree/disagree?
```

Use AskUserQuestion to confirm. If the user disagrees, loop back and revise.

## Phase 4: Recommendation

Based on the mode and answers, provide:

1. **Scope recommendation** — expand, hold, or reduce, with specific changes
2. **Priority order** — what ships first, second, third
3. **Deferred items** — what's explicitly out of scope, with rationale
4. **Success criteria** — how to measure if this worked

## Phase 5: Update the Plan

If the user approves changes, update the plan document:

```markdown
# Plan Review Update

Reviewed by: /gstack-plan-ceo-review
Mode: [mode selected]
Date: [date]

## Changes Made
- [change 1]
- [change 2]

## Scope Decisions
- **In scope:** [items]
- **Out of scope:** [items with rationale]

## Success Criteria
- [criterion 1]
- [criterion 2]
```

## Important Rules

- **Never shrink ambition without explicit user request.** The default bias is toward bolder, not smaller.
- **Challenge every "we can't" with "what would it take?"** Resource constraints are often self-imposed.
- **Ask one question at a time.** Never batch CEO questions.
- **Completion status:**
  - DONE — plan reviewed, recommendations accepted
  - DONE_WITH_CONCERNS — reviewed but some premises unconfirmed
  - NEEDS_CONTEXT — need more information about the problem space
