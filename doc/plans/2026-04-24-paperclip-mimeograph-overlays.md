# Paperclip mimeograph overlays

Goal: use mimeographs to improve Paperclip's judgment without turning the control plane into persona soup.

## Core position

Mimeographs should not replace roles, routing, blockers, or deterministic checks.
They should act as auditable thinking overlays that can be attached to:
- a company
- a project/repo
- an issue type
- a review step

Paperclip's deterministic control plane should still decide:
- whether work is ready
- whether blockers are resolved
- whether artifacts exist
- whether a run should wake
- whether a run should no-op

Mimeographs should only shape how an agent thinks once a real task is ready.

## What to import from mimeo / mimeographs

The useful idea is not "pretend to be Buffett".
The useful idea is:
- take a specific expert's frameworks, anti-patterns, and default questions
- package them as a small auditable text artifact
- load them only when they help a concrete task
- log which overlay fired and why

That maps well to Paperclip because Paperclip already has:
- role-specific instructions on disk
- repo-scoped execution
- issue-scoped heartbeats
- explicit review stages

## Immediate design for Nathan's setup

### 1. Add overlay classes, not new fake executives

Paperclip should expose overlays such as:
- `domain-science/genomics-atlas`
- `research-design/causal-inference`
- `engineering/release-hardening`
- `clarity/ambiguity-disambiguation`
- `nathan-lab/repo-first-contract-first`

These overlays should be attachable independently of role.
Example:
- Founding Engineer + `nathan-lab/repo-first-contract-first`
- Bioinformatics Scientist + `domain-science/genomics-atlas`
- Code Reviewer + `engineering/release-hardening`
- Scientific Planner + `clarity/ambiguity-disambiguation`

This avoids multiplying agents just to get a way of thinking.

### 2. Attach overlays by issue contract

Overlay activation should be deterministic.
Use issue metadata / tags / deliverable class / repo path to decide which overlay loads.

Examples:
- atlas bundle build issues -> `domain-science/genomics-atlas`
- release artifact verification -> `engineering/release-hardening`
- charter/acceptance-criteria ambiguity -> `clarity/ambiguity-disambiguation`
- canonical repo work for Nathan -> `nathan-lab/repo-first-contract-first`

Do not let the model decide ad hoc whether to cosplay a person.

### 3. Keep overlays review-facing and evidence-facing

Each overlay should contribute:
- what to notice first
- what tradeoffs to weigh
- anti-patterns to push back on
- required evidence patterns

For Paperclip this matters most in:
- charter review
- implementation review
- scientific sanity review
- release sign-off

It matters much less for pure mechanical execution.

### 4. Log overlay provenance on every run

Every heartbeat run that loads an overlay should record:
- overlay id
- activation reason
- issue id
- repo/workspace path

And every completion summary should say:
- which overlay(s) were active
- which judgment they materially changed

That keeps the system auditable.

## What we should build first

### A. Nathan-specific overlay

Highest-value first overlay: a Nathan/VKS/Paperclip operating overlay distilled from:
- repo-first behavior
- contract-first / deterministic-first behavior
- grant-workflow-safe repo discipline
- honest gap reporting
- verification-before-claim

This is more important than importing celebrity founder overlays.
It should become the default local overlay for Nathan-owned Paperclip companies.

### B. Genomics-atlas overlay

For the NEU / CellxGene-Census run, the most useful domain overlay is a genomics atlas / specificity overlay.
It should bias agents toward:
- artifact-contract thinking
- row/column metadata integrity
- ontology alignment
- assay/tissue confounding awareness
- release-surface verification over narrative completion

Candidate upstream figures to distill later:
- Aviv Regev
- Stacey Gabriel
- Walter Willett only where confounding / study-design reasoning is relevant

### C. Review overlays before implementation overlays

The first runtime use should be in review and planning, not in always-on implementation.
That is lower risk and easier to validate.

Suggested first sequence:
1. planner overlay for charter and unblock reasoning
2. reviewer overlay for release / artifact checks
3. scientist overlay for atlas sanity checks
4. only then optional implementation overlays

## How this improves the current Paperclip system

### Better than adding more prose to AGENTS.md

Today, we keep stuffing behavior into AGENTS.md / HEARTBEAT.md.
That works, but it mixes:
- hard runtime policy
- project-specific contracts
- cognitive style

Mimeograph overlays let us separate these layers.

### Better than adding more roles

Right now, if we want different judgment we tend to add another agent.
That increases:
- board complexity
- routing complexity
- wake complexity
- review complexity

Overlays let one role keep its permissions while swapping the reasoning lens.

### Better than generic frontier-model mush

The current failure mode is not just crashes.
It is also generic plausible reasoning that sounds fine but misses the real contract boundary.
The NEU run already showed that:
- the system could talk coherently about completion
- while the actual atlas prerequisite stage did not yet exist

A good overlay should make that kind of contract miss less likely.

## Guardrails

1. Overlays must never override deterministic wake/block rules.
2. Overlays must be versioned, named, and auditable.
3. Overlays should be small and composable.
4. Overlays should declare anti-patterns explicitly.
5. The default should be local/domain overlays, not generic celebrity imports.
6. For Nathan, repo-first and contract-first behavior remains the top-level authority.

## Immediate recommendations for the first NEU run

1. Do not change the NEU control plane into a mimeograph experiment mid-run.
2. Finish the run with the deterministic frontier now in place:
   - `atlas/assay_specific`
   - `atlas/combined`
   - downstream `final/*`
3. Use mimeographs first for review overlays around:
   - release artifact validation
   - biological sanity review
   - acceptance-criteria ambiguity cleanup
4. Build the Nathan-specific overlay next, then a genomics-atlas overlay.

## Concrete next build after the first successful run

1. Add first-class overlay metadata to agent/project config.
2. Add deterministic overlay routing by issue/repo class.
3. Emit overlay provenance into heartbeat-run summaries.
4. Distill and install:
   - `nathan-lab/repo-first-contract-first`
   - `domain-science/genomics-atlas`
5. Use those overlays first in planner/reviewer paths before implementation paths.
