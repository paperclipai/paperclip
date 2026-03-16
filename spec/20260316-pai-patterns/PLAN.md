# PAI-Inspired Platform Upgrades

## Overview
Six patterns borrowed from danielmiessler/Personal_AI_Infrastructure (10K stars) adapted to our skill/agent ecosystem. These upgrade our skills from flat files to composable, testable, customizable, installable packages — and give our Research agent iterative depth.

## Status
⬜ Not Started

**Progress:** 3/6 steps
**Branch:** feat/pai-patterns
**Depends on:** None

## Research Context

**Source repo:** github.com/danielmiessler/Personal_AI_Infrastructure
**Key patterns identified:**
- Workflow sub-routing (SKILL.md as router → Workflows/*.md)
- User customization layer (~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/)
- Deep Investigation (progressive iterative research with persistent vault)
- Agent composition from traits (expertise + personality + approach → agent prompt)
- Evals as first-class workflow (skill evaluation runner with history)
- Pack distribution (INSTALL.md + VERIFY.md auto-generated install wizards)

**Current skill structure:**
- 14 skills under `skills/agent-building/`, each with SKILL.md + references/
- `scripts/publish-skill.ts` handles publishing to aiskillslab.dev
- `skills/learnings/` has cross-skill failure patterns
- `agents/` has 11 agent configs (AGENTS.md, SOUL.md, HEARTBEAT.md, TOOLS.md)
- `skills/briefs/` has 12 research briefs

**Reusable patterns:**
- Phase detection in highimpact-skill-builder — already does routing within one file
- Quick Entry table in context-cost-management — proto-routing pattern
- Optimizer's keep/discard loop — reusable for evals framework
- Research agent's smart routing — foundation for Deep Investigation

**Relevant learnings (from skills/learnings/_patterns.md):**
- SkillBuilder's creative output is consistently good; bottleneck is testing discipline
- Inline code blocks in SKILL.md that duplicate reference files are dead weight
- At 100% trigger score, all gains are simplicity-only

## Architecture Decisions
1. **Workflow files are markdown, not TypeScript** — LLM reads and follows .md instructions. No runtime needed.
2. **Customization is freeform PREFERENCES.md** — No schema enforcement. The LLM interprets preferences naturally.
3. **Research vaults persist on disk** — Artifact-aware resumption across sessions, not in-memory state.
4. **Traits are prompt fragments** — No templating engine (Handlebars). Composition = concatenation + LLM coherence.
5. **Evals reuse existing test-cases.md** — No new test format. Runner wraps what we already have.
6. **INSTALL.md/VERIFY.md auto-generated** — publish-skill.ts produces them. Authors never write them manually.

## Dependencies Graph
```
Step 1 (Sub-Routing) ─► Step 3 (Deep Investigation)
                     ─► Step 6 (Pack/Install)
Step 2 (Customization) ─► Step 6 (Pack/Install)
Step 4 (Traits) ── independent
Step 5 (Evals) ── independent
```

**Dependency notes:**
- Step 1 retrofits context-cost-management as proof-of-concept. Step 3 applies the same sub-routing pattern to the Research agent (separate artifact, separate files). Step 6 is independent from Step 3's Research agent changes.
- Steps 1 and 2 can run in parallel (no shared files). Steps 4 and 5 can also run in parallel.

## Steps Overview

| # | Step | Status | Dependencies | Complexity |
|---|------|--------|--------------|------------|
| 1 | Workflow Sub-Routing | ✅ | None | M |
| 2 | User Customization Layer | ✅ | None | S |
| 3 | Deep Investigation | ⬜ | Step 1 | M |
| 4 | Agent Composition from Traits | ✅ | None | M |
| 5 | Evals Framework | ⬜ | None | M |
| 6 | Pack/Install Wizard | ⬜ | Steps 1, 2 | S |

## Step Details

### Step 1: Workflow Sub-Routing
- **Folder:** `./01-workflow-sub-routing/`
- **Branch:** `feat/pai-patterns-01-sub-routing`
- **Dependencies:** None
- **Complexity:** M
- **Description:** Define the sub-routing convention, retrofit context-cost-management as proof-of-concept, update highimpact-skill-builder to support Workflows/ in new skills.

### Step 2: User Customization Layer
- **Folder:** `./02-user-customization-layer/`
- **Branch:** `feat/pai-patterns-02-customization`
- **Dependencies:** None
- **Complexity:** S
- **Description:** Create the customization convention, add check-and-load pattern to skill invocation, document for skill authors.

### Step 3: Deep Investigation
- **Folder:** `./03-deep-investigation/`
- **Branch:** `feat/pai-patterns-03-deep-investigation`
- **Dependencies:** Step 1 (uses sub-routing for Research skill integration)
- **Complexity:** M
- **Description:** Build progressive iterative research workflow with persistent vault, entity scoring, artifact-aware resumption. Integrates as a Workflow under the Research agent.

### Step 4: Agent Composition from Traits
- **Folder:** `./04-agent-composition-traits/`
- **Branch:** `feat/pai-patterns-04-traits`
- **Dependencies:** None
- **Complexity:** M
- **Description:** Create trait library (expertise/personality/approach), build compose-agent script, integrate with Paperclip agent creation flow.

### Step 5: Evals Framework
- **Folder:** `./05-evals-framework/`
- **Branch:** `feat/pai-patterns-05-evals`
- **Dependencies:** None
- **Complexity:** M
- **Description:** Build eval runner that wraps existing test-cases.md, adds judge prompts, historical result tracking, and /eval slash command.

### Step 6: Pack/Install Wizard
- **Folder:** `./06-pack-install-wizard/`
- **Branch:** `feat/pai-patterns-06-pack`
- **Dependencies:** Steps 1, 2 (install wizard references Workflows/ structure and customization setup)
- **Complexity:** S
- **Description:** Auto-generate INSTALL.md and VERIFY.md during publish. Upgrade publish-skill.ts with 5-phase install wizard template.

## Files to Create/Modify
| File | Purpose |
|------|---------|
| `skills/agent-building/context-cost-management/Workflows/*.md` | Proof-of-concept sub-routing (Step 1) |
| `skills/agent-building/context-cost-management/SKILL.md` | Refactor to router (Step 1) |
| `skills/agent-building/highimpact-skill-builder/SKILL.md` | Add Workflows/ support to creation flow (Step 1) |
| `~/.claude/skill-customizations/` convention | User customization directory (Step 2) |
| `agents/research/Workflows/DeepInvestigation.md` | Deep Investigation workflow (Step 3) |
| `agents/traits/expertise/*.md` | Trait library - expertise (Step 4) |
| `agents/traits/personality/*.md` | Trait library - personality (Step 4) |
| `agents/traits/approach/*.md` | Trait library - approach (Step 4) |
| `scripts/compose-agent.ts` | Agent composition script (Step 4) |
| `scripts/eval-runner.ts` | Eval orchestrator (Step 5) |
| `skills/evals/judges/skill-quality.md` | Judge prompt (Step 5) |
| `scripts/publish-skill.ts` | Upgrade with INSTALL.md/VERIFY.md generation (Step 6) |

## Completion Log
| Step | Completed | Summary |
|------|-----------|---------|
| 1 | 2026-03-16 | Workflow Sub-Routing: convention doc, 7 workflow files for context-cost-management (202→38 lines), publish-skill.ts updated, skill-builder updated |
| 2 | 2026-03-16 | User Customization Layer: convention doc, ~/.claude/skill-customizations/ with README + example, skill-builder + context-cost-management updated |
| 4 | 2026-03-16 | Agent Composition from Traits: 16 trait files (6 expertise + 6 personality + 4 approach), compose-agent.ts with --list/--task, README |
