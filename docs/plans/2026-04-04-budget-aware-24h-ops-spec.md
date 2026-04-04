# Budget-Aware 24h Operations Spec

## Goal

Run Fluxaivory on a lower budget without sacrificing article quality.

The governing rule is:

- do not try to generate more articles
- only let strong articles consume expensive review and publish capacity

Quality stays first. Cost reduction comes from reducing expensive reasoning passes, not from weakening gates.

## Core Model

Use a two-lane operating model:

- `cheap lane`
- `deep lane`

## Cheap Lane

Run every 2 hours.

Scope:

1. topic scout
2. grounding
3. draft
4. precheck

This lane is always-on and exists to cheaply eliminate weak candidates before they reach expensive specialist review.

## Deep Lane

Only candidates that satisfy both conditions may enter:

- `precheck pass`
- `high-value topic`

High-value topic ranking order:

1. `CEO / Strategy shortlist`
2. `RSS scout score`
3. `vertical priority weight`

Deep lane scope:

1. specialist review
2. `Editor-in-Chief` final editorial gate
3. image generation
4. publish candidate package ready

Deep lane should not publish automatically.

## Publish Rule

Actual publish requires all three:

- `selected candidate`
- `strict gate pass`
- `publish window`

## Publish Window

Publish window is fixed at:

- 2 times per day

Recommended initial schedule:

- 10:00 Asia/Seoul
- 18:00 Asia/Seoul

## Deep Lane Capacity

Per 2-hour loop:

- maximum `1` candidate enters deep lane

This prevents specialist review from spreading too thin and keeps the expensive lane quality-focused.

## Why This Model

This model preserves quality because:

- weak candidates are blocked early
- expensive editorial attention is reserved for high-value candidates
- publish remains gated and time-bounded

This model reduces cost because:

- most cycles stay in cheap lane only
- specialist and final review are conditional
- image and publish work happen later and less often

## Agent Activation Model

### Always-On / Cheap Lane

- `Research Lead`
- draft generation system
- deterministic prechecks
- Grok sidecars
- NotebookLM grounding

### Conditional / Deep Lane

- `Explainer Editor`
- `Reader Experience Editor`
- `Visual Editor`
- `Editor-in-Chief`

### Publish Window Only

- `Publisher`
- `Verifier`

### Executive / Escalation Only

- `CEO`
- `Operations Lead`
- `Harness Architect`
- `Founding Engineer`
- `Validation Engineer`

## Hard Rules

- no deep lane without precheck pass
- no publish without strict gate pass
- no automatic publish just because a candidate exists
- no more than one deep-lane candidate per loop
- no weakening quality gates to save cost

## Success Criteria

The spec succeeds when:

- 2-hour loops run predictably
- most cycles terminate in cheap lane
- expensive lane is used only on strong candidates
- published articles keep the same or better quality floor
- total token spend drops because specialist review is conditional
