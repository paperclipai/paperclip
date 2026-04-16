# Issue State Clarity And Next-Action Design

Date: 2026-04-15
Status: Approved design
Owner: Codex session

## Goal

Make issue state effortless to understand.

The product should answer three questions immediately:

- what is happening
- who needs to act
- where do I click

The board should never need to interpret raw issue status, read comments for state truth, or manually collapse blocker trees just to know what to do next.

## Problem

Today the system exposes internal workflow facts directly and expects the user to assemble meaning:

- `status`
- `blockedBy`
- recovery relations
- review state
- comments
- activity log

That is too much cognitive work for the operator.

It creates bad experiences such as:

- `Blocked` + `No blockers`
- an issue that is really waiting on review being shown as blocked
- an issue with “done” comments still looking stalled
- ten blockers in a flat list even though they all roll up to one real root blocker

The live example that triggered this design, `COMA-1114`, exposed exactly this failure mode: the system showed a blocked issue without giving the operator a concrete problem or a direct action.

## Product Principle

The board sees computed meaning, not raw internals.

Rules:

- `blocked` is only for real dependency blockers
- non-dependency stalls are presented as `Waiting on ...`, not as fake blockers
- the backend computes the primary blocker, next owner, and next action
- the UI presents that answer consistently across surfaces
- invalid state is labeled as system inconsistency, not left for the user to interpret

## Selected Approach

Selected approach: keep internal workflow state for the system, add a board-facing computed issue state for the operator, and make the backend the source of truth for both root-blocker navigation and next action.

This design has four parts:

1. strict dependency blockers
2. typed stall reasons for non-dependency waits
3. server-computed board-facing state
4. root-blocker-first navigation

This is intentionally stronger than “better blocked copy.” The product should compute the answer, not explain ambiguity better.

## Scope

This design covers issue-state semantics and the issue surfaces that should expose them.

In scope:

- redefining `blocked` as dependency-blocked only
- introducing a board-facing computed issue state
- defining typed stall reasons for non-dependency waits
- computing root blockers, blocker paths, and impact ranking
- defining a primary next action for stalled work
- using the same computed answer on issue detail and issue-list-like surfaces
- detecting and labeling invalid system state clearly

Out of scope:

- redesigning the full issue schema in one pass
- creating a large taxonomy of new workflow statuses visible to operators
- introducing a separate chat model
- redesigning every dashboard card in the app in this iteration

## User Experience Outcome

After this change, the normal board experience should be:

1. Open an issue or look at an issue row
2. See one clear state card or label such as:
   - `Blocked by COMA-1098`
   - `Waiting on QA`
   - `Waiting on board decision`
   - `Waiting on assignee`
   - `System error in issue state`
3. Click the single primary action:
   - `Go to blocker`
   - `Open QA review`
   - `Review decision`
   - `Open assignee`
   - `Fix issue state`

The board should feel like the product already did the triage.

## Internal State Vs Board State

The product needs two layers of truth:

### 1. Internal workflow state

This is the lower-level execution truth used by the system:

- status
- blocker relations
- review state
- recovery state
- assignee state
- comments and activity

This remains useful for orchestration and auditing.

### 2. Board-facing state

This is the interpretation layer shown to the user by default.

It is computed from the internal state and always answers:

- the headline
- the acting owner
- the next action

The board should mostly live at this layer.

## Board-Facing State Model

Each issue should expose a computed board-facing state object.

Conceptually:

```ts
boardState = {
  kind: "blocked" | "waiting" | "ready" | "done" | "system_error";
  headline: string;
  reasonCode: string | null;
  actorType: "issue" | "agent" | "board" | "system" | null;
  actorId: string | null;
  primaryAction: {
    type: "open_issue" | "open_blocker" | "open_agent";
    label: string;
    targetEntity: "issue" | "agent";
    targetId: string;
  } | null;
}
```

The exact wire shape can change, but the semantics should not.

## Strict Dependency Blockers

`blocked` must mean one thing only:

the issue cannot proceed because at least one explicit blocker issue exists.

Rules:

- an issue must not be persisted as `blocked` if there are zero blocker relations
- if blocker relations are removed and none remain, the issue must automatically normalize out of `blocked`
- recovery, review, stale work, contradictory comments, and general failure conditions are not blockers on their own

This preserves trust in the word `blocked`.

For slice 1, normalization should be conservative:

- if the caller explicitly sets a non-blocked status in the same mutation, honor it
- otherwise, when the last blocker disappears and the issue would remain `blocked`, normalize it to `todo`

The service should not guess `in_progress` or `in_review` from partial context. Routes or higher-level workflows can choose those statuses explicitly when they truly know work resumed.

## Stall Reasons For Non-Dependency Waits

Not all stalled work is dependency-blocked. The operator still needs a clear explanation.

For non-dependency stalls, the backend should compute a typed stall reason. Initial reason codes should be small and user-facing:

- `review`
- `board_decision`
- `assignee_followup`
- `recovery`
- `invalid_state`

These should render as plain language:

- `Waiting on QA`
- `Waiting on board decision`
- `Waiting on assignee`
- `Waiting on recovery follow-up`
- `System error in issue state`

The board sees the plain-language outcome, not the raw code.

## Next Action Model

Every non-done issue should expose one primary next action when possible.

Slice 1 must only emit actions that map to destinations the product already has:

- blocked by dependency:
  - type: `open_blocker`
  - target: blocker issue detail
  - label: `Go to blocker`
- waiting on review:
  - type: `open_issue`
  - target: current issue detail
  - label: `Review QA state`
- waiting on board:
  - type: `open_issue`
  - target: current issue detail
  - label: `Review decision`
- waiting on recovery:
  - type: `open_issue`
  - target: current issue detail
  - label: `Review recovery state`
- waiting on assignee:
  - type: `open_agent` when an assignee agent exists, otherwise `open_issue`
  - target: assignee agent detail or current issue detail fallback
  - label: `Open assignee` or `Inspect issue`
- invalid state:
  - type: `open_issue`
  - target: current issue detail
  - label: `Inspect issue state`

This is the key user-experience shift: the product tells the board what to do next instead of merely describing state.

## Root Blocker Computation

When an issue is dependency-blocked, the system computes the dependency graph upward until it reaches root blockers.

A root blocker is:

- an unresolved issue with no further blockers, or
- the first unresolved blocker that the board can act on directly

The backend should compute:

- `primaryBlocker`
- `rootBlockers`
- `blockerPath`

### Ranking

Root blockers are ranked by impact:

1. number of downstream blocked issues
2. then downstream priority severity
3. then staleness of the root blocker

This ranking is operational. The top result should be the issue the board most likely needs to inspect first.

### Cycle Handling

Dependency traversal must be cycle-safe.

If the graph is cyclic or inconsistent:

- stop traversal safely
- expose `system_error` / `invalid_state`
- avoid empty or misleading blocker output

## Surface Design

### 1. Issue detail

The top of the issue page becomes a board action panel.

For dependency-blocked issues:

- headline: `Blocked by COMA-1098`
- explanation: why this issue rolls up to that blocker
- primary CTA: `Go to blocker`
- secondary CTA: `View blocker chain`
- additional ranked roots when more than one root blocker exists

For non-dependency stalls:

- headline: `Waiting on QA`, `Waiting on board decision`, and so on
- explanation: why the system reached that interpretation
- primary CTA aimed at the next actor

For invalid states:

- headline: `System error in issue state`
- explanation: what is inconsistent
- primary CTA for repair or inspection

### 2. Issue lists, inbox, and similar rows

The same board-facing state should appear in list surfaces, not only on detail pages.

Each row should be able to show:

- the board-facing headline
- the next actor
- a quick action target when relevant

Example row subtitles:

- `Blocked by COMA-1098`
- `Waiting on QA`
- `Waiting on board`

This avoids forcing the user to open the detail page just to understand the problem.

### 3. Full chain is secondary

The blocker path is important, but it is not the main thing the board wants first.

Default interaction:

- show the highest-impact blocker first
- allow expanding the chain on demand
- never force the board to parse a full tree before acting

## Enforcement And Auto-Correction

This should not become a manual board chore.

The system should prevent or repair bad state wherever possible.

### 1. Write-time enforcement

Reject attempts to persist `blocked` without a blocker relation.

Implementation requirement:

- derive the final blocker set before validating status
- validate against that final set, not only the raw request payload
- keep issue-row updates and blocker-relation sync in the same transaction

This avoids rejecting valid `status=blocked` mutations that add blockers in the same request and avoids relying on transient invalid post-write state.

### 2. Automatic normalization

If blockers are removed and no blockers remain, automatically normalize the issue out of blocked.

### 3. Operations discipline

Heartbeat, recovery, review, and other automation paths must stop using `blocked` as a generic “cannot proceed” bucket.

They should either:

- create a real blocker issue and relation, or
- leave the issue in a non-blocked workflow state and compute a stall reason

### 4. Auto-heal where deterministic

If the system can clearly infer that an issue is not actually blocked, it should normalize it rather than leaving cleanup to the board.

Manual repair should exist only as a fallback for legacy or irreducibly ambiguous records.

## Data And API Direction

The strongest product version puts this logic on the server, not only in the UI.

The API should eventually expose computed fields such as:

- `boardState`
- `primaryBlocker`
- `rootBlockers`
- `blockerPath`
- `nextAction`

This keeps the interpretation logic centralized and consistent across detail views, lists, inboxes, and future surfaces.

The first implementation can reuse existing underlying issue and relation data, but the product contract should be server-owned from the start.

## Alternatives Considered

### Option A: Copy-only fix

Improve the issue detail copy but keep the current semantics.

Rejected because it preserves the core product failure: the user still has to interpret raw internals.

### Option B: Many new visible statuses

Expose separate statuses like `waiting_on_board` and `waiting_on_review`.

Rejected because it makes the workflow noisier and pushes data-model complexity directly onto the operator.

### Option C: Board-facing computed state over internal workflow truth

Keep internal state for orchestration, but compute a simpler operator-facing truth.

Selected because it gives the most user-friendly outcome and scales across surfaces.

## Verification

Verification must prove product clarity, not just model correctness.

Required coverage:

- invalid `blocked` writes are rejected
- removing the last blocker normalizes the issue out of blocked
- multi-level dependency graphs produce the correct ranked root blocker
- cycles produce safe `system_error` output
- board-facing state is computed correctly for dependency blockers and non-dependency waits
- issue detail renders the expected headline and primary CTA
- list surfaces render the same computed headline instead of raw ambiguous status
- regression case: `blocked` with no blockers never renders as a valid blocker state

## Intended Effect

After this ships, the board experience should feel like:

- less guessing
- less comment archaeology
- fewer fake blockers
- faster navigation to the real problem
- fewer clicks before action

The system should be doing the interpretation work for the user.
