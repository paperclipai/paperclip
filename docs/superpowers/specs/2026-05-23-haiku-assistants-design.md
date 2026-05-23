# Haiku Assistants for Sonnet Agents

**Date:** 2026-05-23  
**Status:** Approved  
**Goal:** Reduce weekly Sonnet quota consumption by ~40% by giving each high-output Sonnet agent a paired Haiku assistant that handles self-contained subtasks.

---

## Context

All 12 agents in MV Automation are configured on `claude-sonnet-4-6`. The 7-day Sonnet quota is being exhausted by cumulative output volume (~16.5M Sonnet output tokens/week across all agents). Prompt caching is already at ~100% — no wins left there. The primary lever is moving eligible work off Sonnet quota.

### Current Sonnet output (7-day baseline)

| Agent | Output tokens/wk |
|---|---|
| BackendEngineer | 3,083,413 |
| CodeReviewer | 2,710,036 |
| FoundingEngineer | 1,867,583 |
| SecurityEngineer | 1,597,964 |
| SeniorCodeArchitect | 1,565,812 |
| ProjectManager | 1,392,233 |
| DevOpsEngineer | 1,334,815 |
| SeniorFrontendDeveloper | 1,265,877 |

---

## Design

### Pattern: Delegation-down

Each high-output Sonnet agent gets a paired Haiku assistant. The Sonnet agent remains the owner of every task and handles all complex reasoning. It delegates self-contained subtasks to its assistant via child issues. The assistant completes the work and marks it done; Sonnet is woken by `issue_children_completed`, reviews, and continues.

```
Task assigned to Sonnet agent
         │
         ▼
Sonnet reads task, plans work
         │
    ┌────┴────────────────────────────┐
    │ complex / sensitive             │ self-contained subtask
    ▼                                 ▼
Sonnet handles directly         child issue → Haiku assistant
                                      │
                                      ▼
                               Haiku executes + marks done
                                      │
                                      ▼
                            Sonnet woken (issue_children_completed)
                            reviews + continues
```

No routing changes. Tasks continue to land on Sonnet agents as before. Sonnet decides what to delegate.

### Agent pairs

| Sonnet agent | Haiku assistant | Model |
|---|---|---|
| BackendEngineer | BackendAssistant | claude-haiku-4-5-20251001 |
| CodeReviewer | ReviewAssistant | claude-haiku-4-5-20251001 |
| FoundingEngineer | FoundingAssistant | claude-haiku-4-5-20251001 |
| SecurityEngineer | SecurityAssistant | claude-haiku-4-5-20251001 |
| SeniorCodeArchitect | ArchitectAssistant | claude-haiku-4-5-20251001 |
| ProjectManager | PMAssistant | claude-haiku-4-5-20251001 |
| DevOpsEngineer | DevOpsAssistant | claude-haiku-4-5-20251001 |
| SeniorFrontendDeveloper | FrontendAssistant | claude-haiku-4-5-20251001 |

### What Haiku assistants handle

Anything self-contained that the Sonnet agent judges Haiku can complete without supervision:

- File reading, codebase research, context gathering
- Boilerplate code generation, test writing
- Config edits, dependency bumps, small fixes
- Documentation updates, comment cleanup
- Routine status updates and triage (PM assistant)
- CI/CD config changes, YAML edits (DevOps assistant)

### What stays with Sonnet

- Architectural decisions and system design
- Security-sensitive code (auth, crypto, data integrity)
- Complex logic and cross-service integration
- Code review final judgment
- Any subtask where failure would be hard to detect or reverse

---

## Instructions

### Haiku assistant instructions (short by design)

> You are the assistant to [SonnetAgent]. You execute self-contained subtasks delegated to you as child issues.  
>  
> Work thoroughly. Document what you did in a comment. Mark done when complete.  
>  
> If the task turns out to be more complex than it appeared, reassign to [SonnetAgent] with a one-line explanation.

Each assistant gets a personalised version with the correct Sonnet agent name and agent ID filled in.

### Sonnet agent instruction addition

A short paragraph appended to each existing Sonnet agent's instructions:

> You have a Haiku assistant: [AssistantName] (agent id: `<uuid>`). Delegate self-contained subtasks to them via child issues — research, file reading, boilerplate, config edits, simple fixes, test writing. Set `parentId` to the current issue so you are woken when they finish. Handle architectural decisions, complex logic, and anything security-sensitive yourself.

---

## Implementation

All changes are agent configuration and instructions — no code changes to the Paperclip codebase.

### Steps

1. Create 8 Haiku assistant agents via `POST /api/companies/:companyId/issues` (hire flow) or the agent creation API with `model: claude-haiku-4-5-20251001`.
2. Record each assistant's agent ID.
3. Append the delegation paragraph to each paired Sonnet agent's instructions, filling in the assistant name and ID.
4. Set Haiku assistant instructions for each assistant, filling in the Sonnet agent name.

### No routing changes required

Tasks continue to be assigned to Sonnet agents by PM and CTO exactly as today. The delegation decision is made by the Sonnet agent each heartbeat.

---

## Expected outcome

Assuming Sonnet agents delegate ~40% of their work to assistants:

| Metric | Before | After (estimated) |
|---|---|---|
| Sonnet output tokens/wk | ~16.5M | ~10M |
| Haiku output tokens/wk | ~1.5M | ~8M |
| Sonnet quota reduction | — | ~38% |

Haiku output tokens draw from a separate quota pool and cost ~5× less per token, so total spend also falls.

---

## Risks

- **Delegation overhead:** If Sonnet agents create child issues for tasks that would have been faster to do inline, we burn extra tokens on the delegation itself. Mitigated by keeping the assistant-delegation paragraph brief and explicit about what's worth delegating.
- **Haiku quality floor:** Haiku may produce lower-quality output on tasks near the complexity boundary. Sonnet reviews child work before continuing, so errors should be caught. The reassignment escape valve handles cases Haiku identifies as too complex.
- **Instruction drift:** Sonnet agent instructions will grow slightly with the delegation paragraph. Keep it under 100 words per agent.
- **Cold-start calibration:** Sonnet agents may over- or under-delegate initially. Expect a tuning period of 1–2 weeks.
