# Reader-Centric Org Reorg Design

## Goal

Reorganize Fluxaivory's Paperclip operating model so that:

- reader-facing quality becomes the first-class organizing principle
- agent responsibilities stop overlapping at the wrong abstraction level
- project taxonomy reflects the actual value chain:
  - reader impact
  - production system reliability
  - infrastructure stability

This is an organizational and project-taxonomy redesign, not a pipeline rewrite.

## Current Problem

The current structure is strong enough to operate, but it is still biased toward pipeline implementation rather than reader outcome.

Observed issues:

- editorial, explainer, reader, and visual ownership can blur together
- pipeline projects are named by implementation stage instead of reader outcome
- some agents risk reviewing too much instead of owning one sharp lane
- inbox and project structure can emphasize system work over article quality

## Design Choice

Use a reader-centric project taxonomy with three layers:

1. Reader-Facing Core
2. Production System
3. Company Infrastructure

Keep vertical projects separate.

Do not replace the whole project graph. Rename existing projects in place where possible and add only the missing ones.

## Project Taxonomy

### Reader-Facing Core

- `Blog OS - Editorial Quality`
- `Blog OS - Reader Experience`
- `Blog OS - Visual System`
- `Blog OS - Audience Growth`

Purpose:

- improve what the reader feels directly
- raise article clarity, scanability, visual comprehension, and growth fit

### Production System

- `Blog OS - Research Engine`
- `Blog OS - Draft Engine`
- `Blog OS - Publish Engine`
- `Blog OS - Verification & Quality Gates`

Purpose:

- produce grounded drafts
- move drafts through review and publish
- enforce fail-closed quality gates

### Company Infrastructure

- `Blog OS - Harness & Regression`
- `Blog OS - Operations`
- `Company Platform`

Purpose:

- keep the system repeatable, replayable, and operable
- prevent pipeline drift and platform regressions

### Verticals

Keep vertical projects independent:

- `Vertical - Bio / Pharma`
- `Vertical - Market / Stocks`
- future verticals such as `Vertical - AI / Tech` may be added without changing the core taxonomy

## Rename / Create Plan

### Rename In Place

- `Blog OS - Editorial` -> `Blog OS - Editorial Quality`
- `Blog OS - Research Pipeline` -> `Blog OS - Research Engine`
- `Blog OS - Draft Pipeline` -> `Blog OS - Draft Engine`
- `Blog OS - Publish Pipeline` -> `Blog OS - Publish Engine`
- `Blog OS - Growth` -> `Blog OS - Audience Growth`
- `Blog OS - Harness` -> `Blog OS - Harness & Regression`

### Create New Projects

- `Blog OS - Reader Experience`
- `Blog OS - Visual System`
- `Blog OS - Verification & Quality Gates`

### Keep As-Is

- `Blog OS - Operations`
- `Company Platform`
- all current vertical projects

## Agent Responsibility Model

### CEO

Owns:

- top priority selection
- major bottleneck visibility
- resource allocation across projects

Must not own:

- detailed editorial review
- sentence-level quality intervention
- direct visual or explainer correction

### Editor-in-Chief

Owns:

- final editorial gatekeeping
- brand tone and publish-readiness judgment
- headline, opening, and ending coherence at final review

Must not own:

- detailed visual execution
- repetitive explainer rewrites as a first pass
- deterministic validation logic
- canonical standards authorship when those standards already live in shared project docs

### Explainer Editor

Owns:

- opening hook quality
- concept simplification
- analogy and example construction
- converting technical importance into reader-relevant framing

Must not own:

- final publish approval
- factual grounding
- visual system review

### Reader Experience Editor

Owns:

- scan path quality
- drop-off risk
- paragraph weight and pacing
- summary, checklist, and quick-scan sufficiency

Must not own:

- source verification
- visual style decisions
- final editorial brand fit

### Visual Editor

Owns:

- hero image role
- supporting image role separation
- quick-scan blocks, tables, cards, TOC clarity
- visual system standards

Must not own:

- source truth
- sentence-level explainer rewrites
- final publish approval

### Research Lead

Owns:

- topic/source alignment
- source quality and source coverage
- claim boundary
- uncertainty expression
- notebook-first grounding discipline

Must not own:

- click optimization
- final editorial styling
- publish execution

### Founding Engineer

Owns:

- code implementation across draft, image, publish, and verify flows
- wiring quality rules into the pipeline
- regression prevention in implementation surfaces

Must not own:

- editorial standards definition
- reader-facing policy decisions unless delegated

### Validation Engineer

Owns:

- hard gate codification
- failure taxonomy
- fixtures and regression suites
- schema and contract enforcement

Must not own:

- post-publish reality checks
- final editorial judgment

### Verifier

Owns:

- public verify
- actual output vs expected output comparison
- publish drift detection
- live-state confirmation

Must not own:

- rule design
- validation schema ownership

### Publisher

Owns:

- safe publish execution
- payload application
- media attachment
- publish side-effect handling

Must not own:

- article quality judgment
- grounding decisions

### Growth Lead

Owns:

- title strategy
- hook framing
- CTR and shareability interpretation
- internal linking and refresh strategy
- category-level growth opportunities

Must not own:

- canonical truth or evidence quality
- final editorial approval

### Operations Lead

Owns:

- routines
- state hygiene
- operational reliability
- runbook upkeep

Must not own:

- content quality decisions

### Harness Architect

Owns:

- replayability
- regression harness design
- execution contracts
- backstop reliability

Must not own:

- front-line editorial priorities

## Ownership-to-Project Mapping

- `Editor-in-Chief` -> `Blog OS - Editorial Quality`
- `Explainer Editor` -> `Blog OS - Editorial Quality`
- `Reader Experience Editor` -> `Blog OS - Reader Experience`
- `Visual Editor` -> `Blog OS - Visual System`
- `Growth Lead` -> `Blog OS - Audience Growth`
- `Research Lead` -> `Blog OS - Research Engine`
- `Founding Engineer` -> `Blog OS - Draft Engine`, `Blog OS - Publish Engine`
- `Validation Engineer` -> `Blog OS - Verification & Quality Gates`
- `Verifier` -> `Blog OS - Verification & Quality Gates`
- `Publisher` -> `Blog OS - Publish Engine`
- `Operations Lead` -> `Blog OS - Operations`
- `Harness Architect` -> `Blog OS - Harness & Regression`
- `CEO` -> cross-project oversight only

## Decision Rules

Every new issue, routine, or follow-up should fit one of these three questions:

1. Does this make the article easier or better for the reader?
2. Does this make the article more accurate or more trustworthy?
3. Does this make the operating system more repeatable and more stable?

If work does not fit one of these questions, it should be deprioritized.

## Migration Principles

- prefer in-place rename over replacement
- create new projects only when a meaningful ownership lane is missing
- preserve existing issue history where possible
- move issues only when the new project boundary is materially clearer
- update agent instructions and project docs together

## Success Criteria

The redesign succeeds when:

- each agent has a sharply bounded primary lane
- reader-facing work is visually first-class in the project graph
- project names explain value to the reader, not just implementation stage
- issue routing becomes clearer and less redundant
- executive focus becomes easier because project categories match real bottlenecks
