# Budget-Aware 24h Operations Implementation

## Scope

Implement the 2-hour batch operating model with a cheap lane, a conditional deep lane, and fixed publish windows.

## Phase 1: Lock The Operating Rules

- [x] define `cheap lane`
- [x] define `deep lane`
- [x] define publish conditions
- [x] define publish windows
- [x] define deep-lane capacity

Source of truth:

- `docs/plans/2026-04-04-budget-aware-24h-ops-spec.md`

## Phase 2: Cheap Lane Enforcement

- [ ] ensure the 2-hour loop only runs:
  - topic scout
  - grounding
  - draft
  - precheck
- [ ] ensure cheap lane can stop cleanly without escalating to specialist review
- [ ] ensure weak candidates fail fast and open readable issue artifacts

## Phase 3: High-Value Candidate Selection

- [ ] define shortlist-first ranking implementation
- [ ] define score fallback when shortlist is empty
- [ ] define vertical weight tiebreaker
- [ ] enforce `max 1 candidate per loop` for deep lane promotion

## Phase 4: Deep Lane Control

- [ ] gate deep lane on `precheck pass + high-value topic`
- [ ] run only the required specialists for the winning candidate
- [ ] keep `Editor-in-Chief` as the final editorial gate
- [ ] stop at `publish candidate ready`

## Phase 5: Publish Window Control

- [ ] add fixed publish windows
- [ ] require `selected candidate + strict gate pass + publish window`
- [ ] prevent auto-publish outside the publish window

## Phase 6: Visibility And Reporting

- [ ] make cheap-lane exits visible
- [ ] make deep-lane promotion visible
- [ ] show why a candidate did or did not enter deep lane
- [ ] show what is queued for the next publish window

## Phase 7: Verification

- [ ] verify loop cadence
- [ ] verify only one deep candidate is promoted per cycle
- [ ] verify publish does not occur outside window
- [ ] verify quality gates are unchanged in strict mode

## Immediate Execution Checklist

1. identify the current 2-hour routine or create the replacement schedule
2. wire cheap lane steps only into that routine
3. add candidate-ranking logic
4. add deep-lane cap of one
5. add publish-window gating
6. verify with dry-run first
