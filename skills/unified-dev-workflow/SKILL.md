---
name: unified-dev-workflow
description: Use when starting any development task. Combines gstack (QA/review/deploy) + superpowers (TDD/planning/subagents) into a single non-contradictory workflow. Resolves overlaps by delegating each phase to the strongest tool.
---

# Unified Development Workflow

Combines the best of **gstack** and **superpowers** into one coherent process.
When both tools cover the same phase, this skill specifies which one leads.

## The Unified Cycle

```
THINK → PLAN → BUILD → REVIEW → TEST → SHIP → REFLECT
```

### 1. THINK (gstack leads)
- Use `/office-hours` to challenge assumptions before coding
- Captures: problem statement, constraints, prior art, risks
- Output: validated problem definition

### 2. PLAN (gstack leads, superpowers supplements)
- **Architecture**: `/plan-eng-review` for technical design
- **Scope**: `/plan-ceo-review` for vision/scope validation
- **Design**: `/plan-design-review` for UI/UX
- **Detailed plan**: Use superpowers `writing-plans` methodology for step-by-step implementation plans
- **Worktrees**: Use superpowers `using-git-worktrees` to create isolated branches

### 3. BUILD (superpowers leads)
- Use `subagent-driven-development` to parallelize tasks from the plan
- Use `dispatching-parallel-agents` for independent work items
- Use `test-driven-development` (RED → GREEN → REFACTOR) for each unit of work
- Each subagent follows `executing-plans` methodology

### 4. REVIEW (gstack leads, superpowers supplements)
- **Automated review**: `/review` — staff-engineer-level with auto-fixes
- **Cross-model review**: `/codex` — second opinion via different model
- **Process review**: Follow superpowers `requesting-code-review` for structured handoff
- **Receiving feedback**: Follow superpowers `receiving-code-review` to process comments
- **Security audit**: `/cso` — OWASP + STRIDE analysis when touching auth/data

### 5. TEST (gstack leads)
- **Browser QA**: `/qa` — real browser testing with Playwright
- **Quick QA**: `/qa-only` — skip build, test only
- **Performance**: `/benchmark` — measure against baselines
- **Verification**: Follow superpowers `verification-before-completion` checklist
- **Debugging**: Use superpowers `systematic-debugging` for failures, `/investigate` for deep dives

### 6. SHIP (gstack leads, superpowers supplements)
- **Deploy**: `/ship` — automated deployment with verification
- **Land PR**: `/land-and-deploy` — merge and deploy
- **Branch cleanup**: Follow superpowers `finishing-a-development-branch`
- **Canary**: `/canary` — post-deploy monitoring

### 7. REFLECT (gstack leads)
- **Retrospective**: `/retro` — shipping velocity & test health
- **Documentation**: `/document-release` — automated release notes
- **Skill creation**: Use superpowers `writing-skills` to codify new patterns

## Conflict Resolution Rules

1. **Planning**: gstack's 3-tier review (CEO/Eng/Design) replaces superpowers brainstorming for scope. Use superpowers `writing-plans` only for detailed implementation steps.
2. **Code Review**: `/review` runs first (automated). If it passes, superpowers review process is optional. If complex changes, use both.
3. **Debugging**: Start with superpowers `systematic-debugging` (structured). Escalate to `/investigate` for deep dives.
4. **Verification**: Always run superpowers `verification-before-completion` before `/ship`.

## Quick Reference

| Need | Command |
|---|---|
| Challenge idea | `/office-hours` |
| Plan architecture | `/plan-eng-review` |
| Detailed steps | superpowers: writing-plans |
| Isolated branch | superpowers: using-git-worktrees |
| Parallel work | superpowers: subagent-driven-development |
| TDD cycle | superpowers: test-driven-development |
| Auto code review | `/review` |
| Security audit | `/cso` |
| Browser testing | `/qa` |
| Performance | `/benchmark` |
| Debug | superpowers: systematic-debugging → `/investigate` |
| Final check | superpowers: verification-before-completion |
| Deploy | `/ship` |
| Monitor | `/canary` |
| Retrospective | `/retro` |
