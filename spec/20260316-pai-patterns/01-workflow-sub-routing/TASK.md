# Step 1: Workflow Sub-Routing

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this task.

## Quick Reference
- **Branch:** `feat/pai-patterns-01-sub-routing`
- **Complexity:** M
- **Dependencies:** None
- **Estimated files:** 10-12

## Objective
Define and implement the workflow sub-routing convention where SKILL.md acts as a router dispatching to separate Workflow .md files. Retrofit one existing skill (context-cost-management) as proof-of-concept. Update the skill builder to support creating skills with Workflows/.

## Context from Research
PAI uses this pattern in every skill: a top-level SKILL.md with a "Workflow Routing" table that maps user intent patterns to `Workflows/[Name].md` files. Each workflow is self-contained. This keeps SKILL.md scannable (under 100 lines for the router) while allowing arbitrarily deep workflows.

Our skills are flat — everything lives in one SKILL.md with references/ for supporting content. The context-cost-management skill already has a "Quick Entry" table routing symptoms to sections — this is proto-routing that maps naturally to sub-workflows.

**Key learning:** Inline code blocks in SKILL.md that duplicate reference files are dead weight (from _patterns.md). Sub-routing makes this worse if not handled — workflow files should be the single source of truth for their domain.

## Prerequisites
- [ ] Current skills build and publish correctly (verify with a dry-run read of publish-skill.ts)

## Implementation

**Read these files first** (in parallel):
- `skills/agent-building/context-cost-management/SKILL.md` — skill to retrofit
- `skills/agent-building/highimpact-skill-builder/SKILL.md` — skill builder to update
- `skills/agent-building/highimpact-skill-builder/references/create.md` — creation flow details
- `scripts/publish-skill.ts` — understand how references/ are bundled (Workflows/ needs same treatment)

### 1. Define the Convention

Create `docs/conventions/workflow-sub-routing.md` documenting:

**Directory structure:**
```
skills/[category]/[skill-name]/
├── SKILL.md              ← Router: frontmatter + routing table + dispatch rules
├── Workflows/
│   ├── [WorkflowA].md    ← Self-contained workflow
│   └── [WorkflowB].md    ← Self-contained workflow
└── references/            ← Supporting content (unchanged)
```

**SKILL.md router pattern:**
```markdown
---
name: skill-name
description: [triggers as before]
---

# Skill Name

[1-2 sentence overview]

## Workflow Routing

| Request Pattern | Route To |
|---|---|
| [trigger phrases] | `Workflows/WorkflowA.md` |
| [trigger phrases] | `Workflows/WorkflowB.md` |
| [default/fallback] | [inline quick answer OR specific workflow] |

## Dispatch Rules
- Read the matched workflow file and follow its instructions
- If no pattern matches, [default behavior]
- Workflows may reference files in `references/` for supporting content
```

**Workflow file pattern:**
```markdown
# [Workflow Name]

## When to Use
[Specific triggers and context]

## Steps
[Self-contained implementation steps]

## Verification
[How to verify this workflow completed correctly]
```

**Rules:**
- A skill with 1-2 modes doesn't need sub-routing — keep it flat
- Sub-routing is for skills with 3+ distinct modes or where SKILL.md exceeds 150 lines
- Workflow files can reference `../references/` content
- Frontmatter stays in SKILL.md only (not in workflow files)

### 2. Retrofit context-cost-management

The current skill has 7 sections (Token Audit, /compact, MCP Slimming, Model Routing, Rate Limits, Checkpointing, Diagnosing Regressions) plus an Anti-Rationalization table.

**Refactor plan:**
- SKILL.md becomes a router (~60-80 lines): frontmatter + overview + Quick Entry routing table + dispatch instructions + Anti-Rationalization table (stays in SKILL.md — it applies to all workflows)
- Create 7 workflow files in `Workflows/`:
  - `TokenAudit.md`
  - `CompactGuide.md`
  - `McpSlimming.md`
  - `ModelRouting.md`
  - `RateLimits.md`
  - `SessionCheckpointing.md`
  - `DiagnosingRegressions.md`
- Each workflow file contains its current SKILL.md section content + pointer to its reference file
- Reference files stay where they are (no changes to references/)

### 3. Update publish-skill.ts

Currently `publish-skill.ts` reads `references/` and appends content. Add same treatment for `Workflows/`:

```typescript
// After reference file bundling, add workflow bundling
const workflowsDir = join(skillDir, "Workflows");
if (existsSync(workflowsDir)) {
  const wfFiles = readdirSync(workflowsDir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  for (const wfFile of wfFiles) {
    const wfContent = readFileSync(join(workflowsDir, wfFile), "utf-8");
    fullContent += `\n\n---\n\n<!-- workflow: ${wfFile} -->\n\n${wfContent}`;
  }
}
```

### 4. Update highimpact-skill-builder

Add awareness of Workflows/ to the skill creation flow:

- In Phase 1 (Create), after the interview: if the skill has 3+ distinct modes, recommend sub-routing and create Workflows/ directory
- In the Skill Writing Guide section, add a "When to Use Sub-Routing" decision table
- In Phase Detection, add: if an existing skill has Workflows/, route to the correct workflow file first

Update `references/create.md` with the sub-routing template and decision criteria.

## Files to Create/Modify

### Create:
- `docs/conventions/workflow-sub-routing.md` — Convention documentation
- `skills/agent-building/context-cost-management/Workflows/TokenAudit.md`
- `skills/agent-building/context-cost-management/Workflows/CompactGuide.md`
- `skills/agent-building/context-cost-management/Workflows/McpSlimming.md`
- `skills/agent-building/context-cost-management/Workflows/ModelRouting.md`
- `skills/agent-building/context-cost-management/Workflows/RateLimits.md`
- `skills/agent-building/context-cost-management/Workflows/SessionCheckpointing.md`
- `skills/agent-building/context-cost-management/Workflows/DiagnosingRegressions.md`

### Modify:
- `skills/agent-building/context-cost-management/SKILL.md` — Refactor to router
- `skills/agent-building/highimpact-skill-builder/SKILL.md` — Add sub-routing support
- `skills/agent-building/highimpact-skill-builder/references/create.md` — Add sub-routing template
- `scripts/publish-skill.ts` — Bundle Workflows/ alongside references/

## Verification

### Automated Checks
```bash
# Verify workflow files exist
ls skills/agent-building/context-cost-management/Workflows/*.md

# Verify SKILL.md is under 100 lines (router should be compact)
wc -l skills/agent-building/context-cost-management/SKILL.md

# Verify publish script still works
bun run scripts/publish-skill.ts skills/agent-building/context-cost-management/SKILL.md --dry-run 2>&1 || echo "Add --dry-run support or test manually"

# TypeScript check on publish script
bun run --bun tsc --noEmit scripts/publish-skill.ts 2>&1 || true
```

### Manual Verification
- [ ] context-cost-management SKILL.md is a clean router with routing table
- [ ] Each of 7 workflow files is self-contained and readable
- [ ] No content was lost in the refactor (diff original vs router + workflows)
- [ ] highimpact-skill-builder references sub-routing in creation flow
- [ ] publish-skill.ts bundles Workflows/ content into published output

## Success Criteria
- [ ] Convention documented in docs/conventions/
- [ ] context-cost-management skill refactored to router + 7 workflow files
- [ ] SKILL.md router is under 100 lines
- [ ] No duplicate content between SKILL.md, Workflows/, and references/
- [ ] publish-skill.ts handles Workflows/ directory
- [ ] Skill builder knows about sub-routing pattern

## Scope Boundaries
**Do:** Define convention, retrofit ONE skill, update builder and publish script
**Don't:** Retrofit all 14 skills. Don't create a Workflows/ runtime or framework. Don't change the frontmatter schema.

## Escape Route Closure
- "I should retrofit more skills while I'm at it" → No. One proof-of-concept. Others adopt organically or get retrofitted in dedicated tasks.
- "The routing table needs programmatic matching" → No. The LLM reads markdown. Pattern matching is natural language, not regex.
- "Workflow files should have their own frontmatter" → No. Frontmatter is for SKILL.md (the routing target). Workflow files are instructions, not skills.
