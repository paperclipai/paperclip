---
name: team-coordination
description: CTO delegation workflows for the Dev Team. Covers task routing, context handoff, code review, parallel builds, and design-to-implementation flow. For the CTO agent only.
---

# Team Coordination Skill

## When to Use

Use this skill when:
- You need to delegate a build task to a specialist
- A feature requires multiple specialists in sequence
- You are reviewing work from a specialist
- You need to coordinate a design-to-implementation handoff

## sqncr Agent Status

| Agent | Role | Status |
|-------|------|--------|
| OpenClaw CEO | Strategy, delegation to CTO | Active |
| The CTO (you) | Architecture, specs, review | Active |
| Frontend Dev | UI implementation | Not yet hired — report blocker |
| Backend Dev | API/DB/auth | Not yet hired — report blocker |
| Designer | UX, design system | Not yet hired — report blocker |

When specialist agents are unavailable: build scaffolding (types, interfaces, specs) and report blocker to CEO with what remains blocked.

## 1. Task Routing

Before delegating, determine which specialist owns the work:

| Task Type | Route To | Examples |
|-----------|----------|----------|
| UI components, pages, responsive layouts | Frontend Dev | Build login page, add dark mode, implement dashboard |
| API endpoints, database, auth, infra | Backend Dev | Create user API, add OAuth, set up deployment |
| Design specs, UX review, brand, design system | Designer | Design onboarding flow, review checkout UX, create design system |
| Full-stack feature | Sequential: Designer -> Frontend + Backend | New feature requiring design, UI, and API work |
| Architecture, cross-cutting decisions | Do directly | Schema design, tech stack decisions, system design |

**Rule:** If a task spans two specialists, break it into sequential spawns. Never ask a specialist to do work outside their domain.

## 2. Spawn Protocol

Every spawn prompt MUST include all 6 elements:

```markdown
## Task
[Specific task with acceptance criteria]

## Context
[What the specialist needs to know about the project, feature, or system]

## Spec
[API shapes, component specs, design references, data models]

## Files
- Read: [paths to read for background]
- Write: [paths to write output to]

## Quality Checks
- [ ] [Specific acceptance criterion 1]
- [ ] [Specific acceptance criterion 2]
- [ ] [Build/lint/type check passes]

## If Blocked
Report back with:
1. What you attempted
2. What failed
3. What you need to continue
Do NOT improvise or work around the blocker.
```

## 3. Code Review Workflow

After a specialist delivers:

### Quick Review (single file, small change)
1. Read the output
2. Check against acceptance criteria
3. Approve or request specific revision

### Full Review (feature, multi-file)
1. Read all changed files
2. Trace data flow end to end
3. Check types, error handling, edge cases
4. Spawn a review specialist if high-stakes (pattern blindness defense)
5. Approve, request revision, or reject with specific feedback

## 4. Design-to-Implementation Flow

### Phase 1: Design — spawn Designer
### Phase 2: CTO reviews design spec, adds API contracts
### Phase 3: Build Frontend — spawn Frontend Dev with approved spec + API contracts
### Phase 4: Build Backend — spawn Backend Dev with same API contracts
### Phase 5: Design QA — spawn Designer to review implementation
### Phase 6: CTO integration verification

## Spawn Template Reference

Templates in `spawn-templates/`:
- `cto-to-frontend.md` - Frontend build delegation
- `cto-to-backend.md` - Backend build delegation
- `cto-to-designer.md` - Design work delegation
