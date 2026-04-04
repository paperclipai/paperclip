# Live Strict Rollout Policy

## Decision

Live publish lane will not move to default strict immediately.

The rollout policy is:

- default live publish: `compat`
- selected live runs only: `strict`

## Selection Authority

- `Publisher` proposes a live strict canary candidate
- `Editor-in-Chief` approves whether the article is suitable for strict live rollout

This is a two-key decision:

- `Publisher` owns boundary and execution safety
- `Editor-in-Chief` owns editorial readiness

## Entry Conditions For A Strict Live Run

A live run can use strict mode only when all of the following are true:

- `publishReadyGateCanary=true`
- `publishReadyGateMode=strict`
- `publishMode=publish`
- `lane=publish`
- `Editor-in-Chief` signs off editorial readiness
- `Publisher` signs off execution readiness

Detailed candidate checklist:

- `/Users/daehan/Documents/persona/paperclip/docs/plans/2026-04-04-selected-live-strict-candidate-checklist.md`

## Why This Policy

Dry-run strict canaries are already proven.
An explicit live strict canary has also succeeded.

That is enough to expand live strict usage selectively, but not enough to flip the whole live publish lane to strict by default.

Selective rollout keeps:

- evidence quality high
- blast radius small
- operational learning fast

## Promotion Criteria

Promote from selected live strict runs to default strict only after:

1. multiple selected live strict runs succeed
2. no recurring publish-boundary or public-verify surprises appear
3. editorial false-fail volume stays low enough to avoid operator churn

## Operational Rule

If a live run is not explicitly approved as a strict canary, it stays on `compat`.
