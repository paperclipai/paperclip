# Step 3: Deep Investigation

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this task.

## Quick Reference
- **Branch:** `feat/pai-patterns-03-deep-investigation`
- **Complexity:** M
- **Dependencies:** Step 1 (Workflow Sub-Routing)
- **Estimated files:** 6-8

## Objective
Build a progressive iterative research workflow that creates a persistent knowledge vault. Instead of one-shot research briefs, the Deep Investigation workflow does broad landscape analysis first, discovers and scores entities, then progressively deep-dives the highest-value ones across multiple iterations. The vault persists on disk for cross-session resumption.

## Context from Research
PAI's Deep Investigation (Packs/Research/src/Workflows/DeepInvestigation.md) uses:
- Progressive narrowing funnel: broad landscape → discover entities → score → deep-dive one per iteration
- Artifact-aware resumption: each iteration checks what's already in the vault
- Domain template packs for different investigation types
- 9-12 parallel agents for the initial landscape phase

Our adaptation:
- Uses our Research agent's existing data sources (ClawHub, GitHub, Grok, YouTube, Reddit, Google Trends)
- Integrates as a Workflow under the Research agent (using Step 1's sub-routing)
- Skips domain template packs initially (dynamic entity discovery instead)
- Uses our existing Agent tool for parallel research, not a custom framework

**Key insight:** The vault structure (LANDSCAPE.md + ENTITIES.md + per-entity profiles) is the real value. The iteration logic is simple — check what's done, pick the next highest-value entity, deep-dive it.

## Prerequisites
- [ ] Step 1 (Workflow Sub-Routing) complete — Research agent needs to support Workflows/
- [ ] Research agent's data sources working (ClawHub, GitHub issues, Grok)

## Implementation

**Read these files first** (in parallel):
- `agents/research/AGENTS.md` — Current Research agent config and workflow
- `skills/agent-building/context-cost-management/SKILL.md` — See how Step 1 refactored it (model for Research agent refactor)

### 1. Create Research Vault Convention

Create `docs/conventions/research-vault.md` documenting:

**Vault location:**
```
~/.claude/research-vaults/
├── YYYY-MM-DD_topic-slug/
│   ├── LANDSCAPE.md        ← Broad domain overview (iteration 1 only)
│   ├── ENTITIES.md         ← Scored catalog: status, value, effort
│   ├── INDEX.md            ← Vault table of contents
│   └── entities/
│       ├── entity-a.md     ← Deep-dive profile
│       └── entity-b.md     ← Deep-dive profile
```

**ENTITIES.md format:**
```markdown
# Entity Catalog

| Entity | Category | Status | Value | Effort | Profile |
|--------|----------|--------|-------|--------|---------|
| LangChain | Framework | PENDING | CRITICAL | EASY | — |
| CrewAI | Framework | RESEARCHED | HIGH | MODERATE | entities/crewai.md |
| AutoGen | Framework | PENDING | HIGH | EASY | — |
| SmolAgent | Framework | SKIP | LOW | EASY | — |

Status: PENDING / RESEARCHED / SKIP
Value: CRITICAL / HIGH / MEDIUM / LOW
Effort: EASY / MODERATE / HARD
```

**Entity profile template:**
```markdown
# [Entity Name]

## Overview
[2-3 paragraph summary]

## Key Facts
- Founded/Created: [date]
- Category: [from ENTITIES.md]
- Size/Scale: [relevant metrics]

## Strengths
- [bullet points]

## Weaknesses
- [bullet points]

## Relevance to Investigation
[How this entity connects to the broader landscape]

## Sources
[Verified URLs only — no hallucinated links]
```

### 2. Create the Deep Investigation Workflow

Create `agents/research/Workflows/DeepInvestigation.md`:

**Iteration detection (Step 0):**
```
Check vault directory for existing artifacts:
- Neither LANDSCAPE.md nor ENTITIES.md exists → FIRST ITERATION (Step 1)
- LANDSCAPE.md exists but ENTITIES.md has PENDING CRITICAL/HIGH → CONTINUATION (Step 3)
- All CRITICAL/HIGH are RESEARCHED → COMPLETE (report and exit)
```

**First iteration (Steps 1-2):**
1. Create vault directory at `~/.claude/research-vaults/YYYY-MM-DD_topic-slug/`
2. Launch 3 parallel research agents using existing data sources:
   - Agent 1: ClawHub + GitHub issues (quantitative demand)
   - Agent 2: Grok web search (sentiment, trends, recent developments)
   - Agent 3: YouTube + Reddit (content landscape, community discussion)
3. Synthesize into LANDSCAPE.md
4. Extract discovered entities into ENTITIES.md with initial scoring
5. Create INDEX.md
6. Deep-dive the highest-value PENDING entity

**Continuation iterations (Step 3):**
1. Read ENTITIES.md
2. Find highest-value PENDING entity (CRITICAL first, then HIGH)
3. Research that entity using 1-2 targeted data sources
4. Write entity profile to `entities/[slug].md`
5. Update ENTITIES.md status to RESEARCHED
6. Update INDEX.md

**Completion check:**
- All CRITICAL entities RESEARCHED
- All HIGH entities RESEARCHED (or explicitly SKIP'd with reason)
- At least one entity per category RESEARCHED

**Integration with Research agent:**
This workflow gets triggered when the Research agent receives a task containing "deep investigation", "investigate [topic]", "map the landscape", or "comprehensive research on [domain]". The Research agent's AGENTS.md gets a workflow routing section (matching Step 1's pattern) that dispatches to this file.

### 3. Add Workflow Routing to Research Agent

Add to `agents/research/AGENTS.md` a routing section:

```markdown
## Workflow Routing

| Request Pattern | Route To |
|---|---|
| "deep investigation", "investigate [topic]", "map the landscape" | `Workflows/DeepInvestigation.md` |
| Standard skill research (default) | Current inline workflow (below) |
```

Keep the existing workflow inline for standard briefs. Only the deep investigation gets its own file.

### 4. Create Vault Management Helpers

At the bottom of DeepInvestigation.md, include:

**Resume an existing vault:**
```bash
# List existing vaults
ls ~/.claude/research-vaults/

# Check vault status
head -20 ~/.claude/research-vaults/[vault]/ENTITIES.md
```

**The workflow is stateless** — all state lives in vault artifacts. Any session can resume any vault by reading ENTITIES.md and picking up where it left off.

## Files to Create/Modify

### Create:
- `docs/conventions/research-vault.md` — Vault structure convention
- `agents/research/Workflows/DeepInvestigation.md` — The workflow
- `~/.claude/research-vaults/.gitkeep` — Create the vaults directory

### Modify:
- `agents/research/AGENTS.md` — Add workflow routing section

## Verification

### Automated Checks
```bash
# Verify workflow file exists
test -f agents/research/Workflows/DeepInvestigation.md && echo "PASS" || echo "FAIL"

# Verify convention doc exists
test -f docs/conventions/research-vault.md && echo "PASS" || echo "FAIL"

# Verify AGENTS.md has routing
grep -l "Workflow Routing" agents/research/AGENTS.md && echo "PASS" || echo "FAIL"

# Verify vault directory exists
test -d ~/.claude/research-vaults && echo "PASS" || echo "FAIL"
```

### Manual Verification
- [ ] DeepInvestigation.md has clear iteration detection logic
- [ ] ENTITIES.md format is well-defined with scoring rubric
- [ ] Entity profile template is useful and not over-structured
- [ ] Research agent AGENTS.md routes correctly to workflow
- [ ] A manual walkthrough of the iteration logic makes sense

## Success Criteria
- [ ] Deep Investigation workflow file complete with all 3 phases (first/continuation/complete)
- [ ] Research vault convention documented
- [ ] ENTITIES.md scoring format defined (Status/Value/Effort)
- [ ] Entity profile template created
- [ ] Research agent routes to workflow on matching triggers
- [ ] Vault directory created and persistence model documented

## Scope Boundaries
**Do:** Build the workflow, define the vault format, integrate with Research agent
**Don't:** Build domain template packs. Don't create a vault management CLI. Don't modify the Research agent's existing brief workflow.

## Escape Route Closure
- "We should add domain templates for market research, threat landscape, etc." → Later. Dynamic entity discovery first. Templates are an optimization.
- "The vault should be a database, not markdown files" → No. Markdown is readable, diffable, and works across sessions without a runtime. This is the same insight that makes our memory system work.
- "We need a progress dashboard for ongoing investigations" → Nice to have but not Step 3. The ENTITIES.md table IS the progress view.
