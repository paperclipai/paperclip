# COO Heartbeat And Issue Surface Design

Date: 2026-04-15
Status: Approved design
Owner: Codex session

## Goal

Let the COO wake agents directly from an issue without posting a comment, and reshape the default issue view so users see clarity and outcomes instead of internal coordination chatter.

## Problem

The current issue experience couples board comments to agent wakeups. In practice that means the COO must often post a low-value comment just to wake an agent, and the issue thread accumulates operational noise that does not help the user understand:

- what changed
- who is working
- what is blocked
- what result came out

This is a control-plane concern being expressed as conversation content. From the user's perspective, internal wakeups are implementation detail.

## Product Principle

The default issue surface should optimize for clarity and results, not internal chit-chat.

Rules:

- Comments are for substantive coordination or durable decisions
- COO wakeups are direct control actions, not conversation
- Internal agent/COO chatter is secondary evidence, not the main narrative
- Operational traces should be quiet by default and only expand when the user asks

## Scope

This design covers issue-level wake behavior and issue detail presentation.

In scope:

- Direct COO-triggered agent heartbeat from the issue page
- Smart target selection for wake actions, with conservative defaults
- Required reason when the COO wakes a non-assignee
- Removing comment-driven COO wake behavior
- Default issue detail emphasis on status, blockers, ownership, and latest meaningful result
- Hiding internal thread content by default while keeping it available
- Small visual wake traces instead of thread noise

Out of scope:

- Full redesign of all activity surfaces across the app
- Changing agent-to-agent comment behavior outside the COO path
- Replacing all issue comments with a new communication model
- Major schema redesign for heartbeat storage
- New multi-user governance or permissions work

## User Experience Outcome

After this change, the normal COO/operator experience should be:

1. Open an issue
2. See current status, assignee, blockers, and latest meaningful result first
3. If an agent needs to be nudged, click a heartbeat control or rely on automatic structural wakes
4. Avoid posting a comment unless there is real content worth preserving
5. Open internal thread/activity only when deeper inspection is needed

## Current Baseline

Today:

- the app already has a direct wake route for agents in `server/src/routes/agents.ts`
- the UI already has an `agentsApi.wakeup()` client in `ui/src/api/agents.ts`
- issue comments enqueue wakeups for the assignee and mentions in `server/src/routes/issues.ts`
- the issue detail page is chat-first, with comments and run output dominating the primary surface

This means the platform already has the technical primitive needed for direct wakeup. The missing piece is product behavior and issue-surface structure.

## Selected Approach

Selected approach: make wakeups first-class issue actions, keep commenting and waking decoupled, and move issue detail toward a result-first control-plane view.

This combines:

- direct issue-scoped heartbeat actions
- conservative smart targeting
- no thread event for wake actions
- hidden-by-default internal thread

## Alternatives Considered

### Option A: Keep comment-driven wakeups, but add a better UI wrapper

Pros:

- small implementation delta
- keeps the existing behavior model intact

Cons:

- preserves the core product problem
- still turns control-plane actions into thread noise
- does not improve the default issue narrative

### Option B: Hybrid comment plus direct wake model

Comments still auto-wake in normal cases, while a separate manual heartbeat action exists.

Pros:

- lower behavior change risk
- fewer user-facing surprises during transition

Cons:

- still treats comments as an operational trigger
- keeps wake logic split across two user actions
- still nudges the product toward chat-first behavior

### Option C: Direct wake as the primary COO action, comments decoupled from wake

Pros:

- aligns with the control-plane model
- keeps the thread reserved for meaningful content
- produces the clearest default issue surface

Cons:

- requires more explicit issue-detail UX changes
- may require a short adjustment for operators used to “comment to wake”

Selected approach: Option C.

## Wake Interaction Design

### 1. Direct heartbeat action

Add a dedicated heartbeat control to the issue detail view using the “Design A” placement validated during brainstorming:

- a compact `Heartbeat` control near the issue composer / issue action row
- it sends a wake without creating a comment
- it is available even when the COO does not want to leave a message

This makes wakeup a first-class operational action, not a byproduct of chat.

### 2. Automatic wakes

Automatic wakes remain useful, but only for structural issue mutations that materially change work context.

Automatic wake triggers should include:

- issue assignment / reassignment
- reopen
- significant status changes that imply resumed work
- blocker resolution paths that already wake dependent work

Automatic wakes should not include:

- ordinary COO comments
- passive observation
- low-signal UI inspection or page views

### 3. Comments

COO comments stop auto-waking agents.

Comments remain available for:

- decisions
- clarifications that should be durable
- real coordination that should be visible later

Comments no longer serve as the default “poke the agent” mechanism.

## Smart Target Selection

Target selection should be conservative.

Default behavior:

- if the issue has an assignee, preselect the assignee
- if the issue has no assignee, require explicit target selection

Explicit override behavior:

- the COO can pick another agent
- when the chosen target is not the assignee, the UI must make that explicit
- non-assignee wake requires a short reason

Reason for conservatism:

- waking the wrong agent is more damaging than asking for one extra confirmation
- cross-agent pings should be infrequent and deliberate

## Inference Rules

Inference in V1 should be intentionally narrow.

Rules:

- default to the assignee
- for structural automatic wakes, target the agent implied by the mutation itself (for example the new assignee after reassignment)
- do not infer a non-assignee target from freeform COO comment text
- do not redirect based on passive mentions alone
- if a non-assignee should be woken from the issue surface, require explicit selection
- any non-assignee wake still requires confirmation and reason before completion

Manual heartbeat:

- always opens explicit target mode
- assignee is preselected when present

This preserves operator speed without making hidden assumptions, and keeps v1 behavior understandable.

## Issue-Scoped API Design

Although an agent wake route already exists, issue-driven COO wake behavior should be mediated by an issue-scoped server action rather than assembled entirely in the UI.

Recommended route shape:

- `POST /api/issues/:id/heartbeat`

Request fields:

- `targetAgentId`
- `reason` nullable, but required when `targetAgentId` is not the assignee
- optional metadata such as `source: "issue_detail"` and small UI context flags

Server responsibilities:

- load the issue and enforce company access
- validate the target against company scope
- validate the non-assignee reason rule
- build heartbeat context from issue data
- call the existing heartbeat wake service
- record activity/log metadata
- return wake outcome without creating issue comments

Why issue-scoped route instead of only reusing `/agents/:id/wakeup` from the browser:

- keeps policy enforcement on the server
- centralizes issue-context construction
- avoids duplicating business rules across clients
- makes future issue-specific wake logic easier to evolve

## Heartbeat Context Payload

The wake action should carry issue context directly, without relying on a comment id.

Required context:

- `issueId`
- `taskId`
- derived issue/task key where needed
- wake source and trigger detail
- wake reason
- optional operator-supplied non-assignee reason

The heartbeat service already supports context snapshots and issue/task metadata, so this design should reuse that path rather than invent a new transport.

## UI Surface Design

### Default issue surface

The primary issue view should emphasize:

- current status
- assignee / owner
- priority
- blocker state
- latest meaningful result or summary
- active run / who is working

The primary issue view should de-emphasize:

- raw internal conversation
- low-level operational chatter
- repeated wake traces

### Internal thread visibility

Internal thread content should be hidden by default.

Recommended structure:

- primary summary/result area
- secondary activity strip or compact indicators
- explicit `Internal thread` or `Activity` panel/tab for deep inspection

This preserves inspectability without forcing the user through chatter to understand state.

### Wake trace

Wake actions should leave only a small visual trace.

Examples:

- a subtle pulse icon near assignee/live-run status
- compact recent ping indicator in the issue status area
- non-intrusive timestamp on hover or in secondary metadata

Wake traces should not:

- create issue comments
- dominate the timeline
- emit noisy toast history into the issue narrative

## Send Flow Behavior

There are now two separate COO actions:

### A. Send comment

- posts the comment only
- does not implicitly wake an agent
- remains available for durable coordination

### B. Send heartbeat

- wakes the selected agent only
- does not post a comment
- defaults to the assignee
- requires reason when targeting a non-assignee

This clear separation keeps user intent unambiguous.

## Error Handling

Wake failures should be surfaced clearly, but locally.

Behavior:

- show the failure near the heartbeat control or relevant issue action area
- do not create a thread comment about the failure
- do not silently swallow the error
- leave the issue thread unchanged

Common error classes:

- target agent not invokable
- cross-company / invalid target
- cooldown / wake skipped behavior
- heartbeat service failure

If a wake is skipped because the system decides it is unnecessary, the UI should communicate that as a quiet informational outcome rather than an error.

## Activity Logging

Wake actions should still be auditable.

Record:

- actor
- issue id
- target agent id
- whether target matched assignee
- reason when a non-assignee was chosen
- wake outcome / skipped state / run id when available

This belongs in activity/logging and diagnostics, not in the default user narrative.

## Documentation And Contract Updates

If implemented, the following should be updated together:

- issue API docs for the new issue heartbeat route
- issue detail frontend behavior docs if present
- onboarding/instructions that currently imply “comment to wake”
- any shared issue types or route contracts exposed to the UI

## Verification Strategy

### Backend

- route tests for `POST /issues/:id/heartbeat`
- tests for assignee default behavior
- tests for non-assignee reason requirement
- tests for invalid cross-company target rejection
- regression tests proving COO comments no longer auto-wake agents

### Frontend

- issue detail tests for manual heartbeat control
- tests that the default issue surface no longer foregrounds internal thread chatter
- tests for hidden-by-default internal thread / activity panel
- tests for non-assignee confirmation and reason capture
- tests for small wake trace rendering without timeline comment creation

### End-to-end behavior

- issue assignment/reopen still wakes agents through structural mutation paths
- ordinary COO comments no longer generate wakeups
- manual heartbeat wakes the right agent with issue context
- issue default view remains outcome-first

## Risks

- If the issue detail summary layer is too thin, hiding thread content by default could obscure useful context
- If inference is too aggressive, non-assignee wakes could feel arbitrary or unsafe
- If inference is too weak, the feature may feel slower than necessary
- Legacy operator habits around “comment to wake” may create short-term confusion during transition
- If wake traces are too subtle, debugging may become harder unless the secondary activity view remains strong

## Acceptance Criteria

- The COO can wake an agent directly from an issue without posting a comment
- COO comments no longer auto-wake agents
- Non-assignee wake requires explicit selection and a short reason
- Structural issue mutations can still auto-wake where operationally appropriate
- The default issue surface emphasizes status, blockers, ownership, and latest meaningful result
- Internal thread content is hidden by default but still available
- Wake actions leave only a small visual trace on the default issue surface
- Wake activity remains auditable without polluting the issue thread
