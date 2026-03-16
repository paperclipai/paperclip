# Lifecycle Overview: Idea → Shipped Product

## The Problem This Solves

40% of Claude Code project failures come from drift — the AI goes in unpredictable directions because there's no persistent spec. You re-explain context every session. Features grow beyond scope. Bugs compound.

The fix isn't willpower. It's structure: a TASK.md that tracks what's done, a CLAUDE.md that enforces what never changes, and a repeatable 5-phase workflow you follow every time.

## The 5 Phases

```
Phase 1: Idea → Spec
└── Plan mode session: brainstorm, scope, write PRD
└── Write CLAUDE.md invariants: what this project NEVER does
└── Output: PRD.md + CLAUDE.md project section

Phase 2: Spec → Task Breakdown
└── Read PRD, decompose into sequential steps
└── Each step: title, acceptance criteria, status
└── Output: TASK.md

Phase 3: Implementation Loop
└── Per step: plan mode → approve → execute
└── Claude runs, edits, verifies — you approve scope
└── Session ends: update TASK.md status + notes
└── Output: Working code + marked-done steps

Phase 4: Quality Gates
└── Hooks validate: build passes, tests green, no banned patterns
└── Step acceptance criteria verified before marking done
└── Output: Validated, shippable diff

Phase 5: Ship
└── gh pr create (auto-populated from TASK.md + git log)
└── Changelog entry
└── Deploy verification
└── TASK.md archived to git
└── Output: Merged PR + clean history
```

## What Lives Where

| Artifact | Purpose | When Written | When Read |
|---|---|---|---|
| `CLAUDE.md` | Project invariants + session state | Phase 1 + ongoing | Every session start |
| `TASK.md` | Implementation steps + status | Phase 2 | Phase 3 loop |
| `PRD.md` | Product requirements | Phase 1 | Phase 2 |
| Git commits | Immutable history + changelog source | Phase 3-5 | Phase 5 |
| Hooks config | Quality enforcement | Phase 4 | Phase 3-4 auto |

## Composition with Other Skills

This skill is the skeleton. Other skills attach:
- **Git worktrees** (skill #005): Run Phase 3 in parallel for independent features
- **Multi-agent coordination** (skill #003): Delegate spec steps to subagents
- **TDD workflow** (skill #007): Phase 3 implementation loop uses TDD for each step
- **MCP integration** (skill #006): Add external data sources to Phase 1 planning

None are required. All are additive.
