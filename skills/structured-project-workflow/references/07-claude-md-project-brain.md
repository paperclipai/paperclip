# CLAUDE.md as the Project Brain

## The Problem CLAUDE.md Solves

Claude Code has no persistent memory between sessions. Every session, it reads CLAUDE.md and TASK.md to reconstruct context. Without CLAUDE.md, the AI makes fresh decisions each session — often contradicting prior ones.

CLAUDE.md is the invariant layer: "no matter what else is true, these things never change."

## Three-Layer Structure

```markdown
# [Project Name] — Project Brain

## Layer 1: Global Rules
[Rules that apply regardless of project — copied from your user-level CLAUDE.md]

## Layer 2: Project Invariants

### Architecture
- State management: [pattern] — DO NOT change without migrating all existing state
- API layer: [pattern] — all external calls go through [module], never direct
- Auth: [approach] — session tokens NEVER stored in localStorage

### Anti-Patterns (Never Do This)
- NEVER use [X] — we use [Y] because [reason]
- NEVER commit without running [test command]
- NEVER modify [module A] without updating [module B]

### Tech Stack
- Runtime: [e.g., Bun]
- UI: [e.g., React + Tailwind]
- Data: [e.g., Convex]
- Deploy: [e.g., Vercel]

## Layer 3: Session State

### Current Phase
Phase: [1-5]
Active Step: Step N — [title]
Status: [in_progress | blocked]

### Last Session ([date])
Done: [what was completed]
Next: [what to start]
Blocker: [if any]

### Open Decisions
- [Question that came up and was deferred]
- [Architecture decision still open]
```

## Writing Strong Invariants

**Weak:** "Use good naming conventions"
**Strong:** "All API functions must be named `[resource][Action]` (e.g., `userCreate`, `sessionGet`). Deviate only with explicit comment."

**Weak:** "Keep the code clean"
**Strong:** "No function longer than 50 lines. Split at logical boundaries. No exceptions."

**Weak:** "Test your changes"
**Strong:** "NEVER mark a step done without running `bun test`. If tests don't exist for new code, write them first."

Format: `NEVER [do X]` or `ALWAYS [do Y]`. Binary. Testable. Non-negotiable.

## When Invariants Break

Signs Claude has violated an invariant:
- New code uses a library you explicitly banned
- Files modified outside the current step's scope
- Architecture pattern changed without a session decision

Fix:
1. Stop. Don't approve the diff.
2. Tell Claude: "This violates invariant [X]. Revert the [specific change] and re-approach using [Y]."
3. Update CLAUDE.md if the invariant was wrong — write a new decision with the reason for change.

## Session State Maintenance

**Update CLAUDE.md at the end of every session:**
```markdown
### Last Session (2026-03-15)
Done: Implemented auth flow (Step 3 complete)
Next: Start Step 4 — build dashboard skeleton
Blocker: None
```

Next session, Claude reads this and picks up exactly where you left off. No re-explanation.

## How Invariants Prevent Drift

| Without Invariants | With Invariants |
|---|---|
| Session 3: uses Redux for state | Invariant: "Use Zustand" — caught in plan mode |
| Session 7: direct API calls in components | Invariant: "All API calls via service layer" |
| Session 12: inconsistent naming | Invariant: "All API functions: `[resource][Action]`" |
| Session 15: you discover architecture diverged 8 sessions ago | Invariant violations surfaced immediately |

