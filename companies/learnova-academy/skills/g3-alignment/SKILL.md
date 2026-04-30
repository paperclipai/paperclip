---
schema: agentcompanies/v1
kind: skill
slug: g3-alignment
name: G3 — CEO Alignment Gate
description: CEO checks that a piece of work (course, blog, code change) aligns with the original ticket + the company strategy. Catches scope creep before G4 (human).
version: 0.1.0
license: MIT
sources: []
---

# G3 — CEO Alignment Gate

Used by `ceo`. Triggered when work hits `awaiting-g3` after passing earlier gates (G0 content, G_code, G2 QA).

## Procedure

1. **Read the original ticket** — what did Vardaan or you (CEO) ask for? What were the success criteria?
2. **Read the work product** — the vault note, the markdown chapter, the merged PR, etc.
3. **Read the budget consumed** — `GET /api/costs/by-task?id=<ticket>` — vs `budget_estimate` in the ticket
4. **Check 5 questions:**
   - Does the work product match the ticket's success criteria? (Y/N each)
   - Did scope creep beyond the ticket? (Y/N)
   - Did budget overrun materially (>1.5×)? (Y/N)
   - Are there obvious red flags QA didn't catch? (Y/N)
   - Is this consistent with company strategy (V1 vendor scope; content-first; brand voice)? (Y/N)
5. **Decide**:
   - **PASS** — flip status to `awaiting-g4` and route to human (g4-routing skill)
   - **BLOCK** — flip status back to the relevant earlier gate with a specific reason
6. **Comment on the ticket**:

```
✅ G3 PASS · KOE-123 · vault/courses/.../04-connectors.md
- Matches original ticket "course-delta on connectors after Anthropic launch"
- Budget: $0.78 spent / $1.00 estimated ✓
- No scope creep
- Strategy aligned (V1 vendor: Anthropic ✓; content-first ✓; brand voice ✓)
- Routing → @ceo g4-routing
```

OR

```
❌ G3 BLOCK · KOE-123 · scope creep
- Ticket asked for course-delta on Module 4 (connectors)
- Work product modifies Module 5 (multi-tool flows) too
- Budget overrun: $1.40 spent / $1.00 estimated (40% over)
- Route back: @chief-content for ticket split or trim
```

## Inputs

- Ticket text + success criteria
- Work product (vault file or PR)
- Cost data

## Outputs

- A PASS or BLOCK comment + status flip
- If PASS, an entry handed to the g4-routing skill

## Never do

- Never approve work that doesn't match ticket success criteria — even if "the work is good"
- Never auto-approve based on prior G0/G_code/G2 alone — those gate quality, not alignment
- Never skip cost check; budget overruns matter
- Never let scope creep through "this time"

## Escalation

- Work product is obviously off-strategy (e.g., a course about a vendor we haven't approved) → BLOCK + ping the chief who dispatched
- 3+ G3 blocks for the same chief in a week → flag in next weekly retro

## Budget

Per-task cap $0.50.
