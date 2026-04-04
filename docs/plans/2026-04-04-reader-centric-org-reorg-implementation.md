# Reader-Centric Org Reorg Implementation

## Scope

Implement the reader-centric reorganization through project rename, targeted project creation, agent ownership updates, and issue/routine realignment.

This plan assumes:

- existing project history should be preserved
- rename in place is preferred
- new projects are allowed where ownership lanes are currently missing

## Phase 1: Freeze The Spec

1. Save the approved design in:
   - `docs/plans/2026-04-04-reader-centric-org-reorg-design.md`
2. Treat that design as the source of truth for rename/create decisions.
3. Do not move issues before the target project list and agent ownership map are confirmed in writing.

## Phase 2: Project Taxonomy Changes

### Rename Existing Projects

Apply these renames in place:

- `Blog OS - Editorial` -> `Blog OS - Editorial Quality`
- `Blog OS - Research Pipeline` -> `Blog OS - Research Engine`
- `Blog OS - Draft Pipeline` -> `Blog OS - Draft Engine`
- `Blog OS - Publish Pipeline` -> `Blog OS - Publish Engine`
- `Blog OS - Growth` -> `Blog OS - Audience Growth`
- `Blog OS - Harness` -> `Blog OS - Harness & Regression`

### Create New Projects

Create:

- `Blog OS - Reader Experience`
- `Blog OS - Visual System`
- `Blog OS - Verification & Quality Gates`

### Keep Existing Projects

- `Blog OS - Operations`
- `Company Platform`
- all vertical projects

## Phase 3: Agent Ownership Updates

Update primary project ownership for the main agents:

- `Editor-in-Chief` -> `Editorial Quality`
- `Explainer Editor` -> `Editorial Quality`
- `Reader Experience Editor` -> `Reader Experience`
- `Visual Editor` -> `Visual System`
- `Growth Lead` -> `Audience Growth`
- `Research Lead` -> `Research Engine`
- `Founding Engineer` -> `Draft Engine`, `Publish Engine`
- `Validation Engineer` -> `Verification & Quality Gates`
- `Verifier` -> `Verification & Quality Gates`
- `Publisher` -> `Publish Engine`
- `Operations Lead` -> `Operations`
- `Harness Architect` -> `Harness & Regression`

CEO remains cross-project and should not become the detailed owner of any reader-quality lane.

## Phase 4: Documentation Updates

For each renamed or created project:

1. update project summary / starter docs
2. update relevant agent instructions
3. update any project-level playbooks that still use old project names

Priority documentation updates:

- editorial quality docs
- reader experience docs
- visual system docs
- verification and quality-gate docs

## Phase 5: Issue Realignment

### Move Only The Issues That Clearly Belong Elsewhere

Target relocations:

- reader-scan, readability, drop-off, ending payoff -> `Reader Experience`
- hero/supporting image, quick-scan, TOC, comparison tables -> `Visual System`
- topic alignment, publish-ready hard gates, validation rules, public verify contract -> `Verification & Quality Gates`
- grounding, source quality, NotebookLM-first rules -> `Research Engine`
- title growth, CTR framing, internal linking, refresh strategy -> `Audience Growth`

### Leave Stable Issues In Place

Do not move issues when the current project still communicates the work clearly enough and the move would add noise.

## Phase 6: Routine Realignment

Review routines and align them with the new taxonomy:

- research bundle routines -> `Research Engine`
- editorial or reader-quality routines -> `Editorial Quality` or `Reader Experience`
- visual review routines -> `Visual System`
- strict gate / verify routines -> `Verification & Quality Gates`
- ops hygiene routines -> `Operations`

## Phase 7: Executive Focus Update

Update the executive focus surface so that it shows bottlenecks by the new layers:

- Reader-Facing Core
- Production System
- Company Infrastructure

Top-level review should highlight:

- the biggest current reader-quality bottleneck
- the biggest current accuracy bottleneck
- the biggest current stability bottleneck

## Suggested Execution Order

1. rename existing projects
2. create new projects
3. update agent ownership mapping
4. update project and agent docs
5. move clearly misfiled issues
6. update routines
7. refresh executive focus

## Validation Checklist

The migration is considered successful when:

- every target project exists with the correct final name
- every key agent has an updated primary ownership lane
- newly created projects contain the right starter issues or migrated issues
- verification and quality-gate work is no longer mixed ambiguously into unrelated projects
- reader experience and visual work are visible as first-class lanes in Paperclip

## Immediate Next Step

Start with taxonomy changes:

1. rename the six existing projects
2. create the three missing projects
3. then review project ids and move issues deliberately instead of in bulk
