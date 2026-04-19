## Mission Control OpenClaw Integration Spec

Status: draft, implementation-facing  
Date: 2026-04-19  
Scope: section 6 starter slice for mission-control integration glue

### 1. Purpose

Define the minimum durable contract for mapping OpenClaw orchestration actors into existing Paperclip mission-control fields without introducing a second dashboard, second task model, or transcript-mining dependency.

This slice covers only:

- identity mapping for `Main`, `Ork`, `Stitch`, and `Personal OS`
- how those actors create or update tracked Paperclip issues
- when a message must become a structured Paperclip update versus remaining chat/comment text
- task-status sync rules for mapping OpenClaw-side progress onto existing Paperclip issue status

This slice does not yet define:

- Telegram emergence rules
- broader specialty-routing policy beyond the minimum ownership defaults below

### 2. Reuse-First Constraints

The integration must reuse existing Paperclip primitives:

- durable work object: `issue`
- durable discussion surface: `issue_comments`
- ownership fields: `ownerAgentId`, `assigneeAgentId`
- mission-control state: `missionControl.nextStep`, `missionControl.blocker`, `missionControl.needsHumanAttention`, `missionControl.workflowState`, `missionControl.handoff`
- visibility/audit surface: activity log summaries already derived from `issue.updated` and `issue.handoff_updated`

It must not introduce:

- a parallel mission-control task table
- a second orchestration status model outside issue status plus mission-control metadata
- transcript archaeology as the primary source of handoff/blocker/owner state

### 3. Identity Mapping

#### 3.1 Canonical rule

Each OpenClaw orchestration actor that can own, hand off, or escalate tracked work must correspond to exactly one Paperclip `agents` row in the same company.

For this slice, the canonical orchestration actors are:

- `Main`
- `Ork`
- `Stitch`
- `Personal OS`

#### 3.2 Mapping shape

The mapping is Paperclip-agent based, not transcript-label based.

- `ownerAgentId` points at the Paperclip agent currently accountable for coordination of the issue
- `assigneeAgentId` points at the Paperclip agent expected to execute the next active run on the issue
- `missionControl.handoff.fromAgentId` and `toAgentId` must also point at real Paperclip agent ids
- `missionControl.collaboratorAgentIds` may include any additional mapped Paperclip agents involved in the work

Agent display names may be used as bootstrap conventions in the UI and docs, but they are not the durable identity contract. The durable contract is the Paperclip `agent.id`.

#### 3.3 Resolution rules

When OpenClaw-side logic wants to publish a structured mission-control update:

1. Resolve the actor to a Paperclip agent in the same company.
2. If exactly one mapped Paperclip agent is found, use that agent id in structured fields.
3. If no mapped Paperclip agent is found, do not invent a placeholder identity and do not write structured ownership/handoff metadata.
4. In that unmapped case, the actor may leave plain chat/comment text, but the work remains unclaimed in mission-control terms until a human or mapped agent fixes the identity gap.

Identity ambiguity is a hard stop for structured ownership and handoff writes.

### 4. Ownership Defaults By Actor

These defaults constrain integration behavior without creating a new model:

| Actor | Default mission-control role | Default `ownerAgentId` behavior | Default `assigneeAgentId` behavior |
|---|---|---|---|
| `Main` | coordination and routing | owns cross-agent coordination issues | may assign execution to self or another specialist |
| `Ork` | engineering execution | owns engineering execution once Main hands it off | usually assignee for engineering build/fix/verify work |
| `Stitch` | design/product specialist execution | owns design or product-spec execution once handed off | usually assignee for design/product-specialist work |
| `Personal OS` | personal/admin/operator support | may own personal or admin follow-through, but not product/build implementation by default | may assign to self only for personal/admin tasks |

Minimum policy enforced by this spec:

- `Main` remains the default coordination surface.
- `Personal OS` must not become the durable owner for product/build implementation when `Main`, `Ork`, or `Stitch` should own it.
- When implementation work is delegated, ownership should move to the specialist who is expected to drive it, not remain vaguely attached to whoever mentioned it in chat.

### 5. Structured Update Contract

#### 5.1 What counts as a structured update

A structured mission-control update is any Paperclip write that changes tracked issue state beyond freeform commentary, including:

- creating a new issue
- changing `ownerAgentId`
- changing `assigneeAgentId`
- setting or clearing `missionControl.workflowState`
- setting or clearing `missionControl.needsHumanAttention`
- setting or clearing `missionControl.blocker`
- changing `missionControl.nextStep`
- creating, updating, or clearing `missionControl.handoff`

Plain `issue_comments` without one of those changes are chat/comments, not structured mission-control updates.

#### 5.2 Comment versus structured patch

Use the smallest write that preserves operator-visible state:

- comment only: narrative, reasoning, local progress, or questions that do not change durable task state
- structured patch only: pure state changes where no extra narrative is needed
- comment plus structured patch: state changes that also need human-readable context

If a chat message changes who owns the work, who should act next, whether the work is blocked, whether a human is needed, or what the current next step is, it must not remain chat-only.

### 6. When Work Stays In Chat Versus Becomes A Tracked Issue

#### 6.1 Leave work in chat/comment form when all of these are true

- no durable owner change is needed
- no specialist handoff is being requested
- no operator inbox visibility is needed
- no blocker/waiting/escalation state is being asserted
- the conversation is exploratory, clarifying, or ephemeral
- losing the message from the mission-control queue would not harm later coordination

Examples:

- brainstorming whether to pursue an idea
- asking a specialist a one-off question before deciding to delegate
- progress narration that does not change the current owner or next step
- low-value back-and-forth already captured by an existing structured next step

#### 6.2 Create a new tracked Paperclip issue when any of these are true

- the work needs a durable owner
- the work should appear in Paperclip operational views or later Telegram summaries
- the work requires follow-up beyond the current chat turn
- the work is being delegated across `Main` / `Ork` / `Stitch` / `Personal OS`
- the work needs a tracked blocker, next step, or human-attention flag
- the work produces or requests a real deliverable, implementation slice, or reviewable output

Rule: if the operator should be able to answer "who owns this and what state is it in?" without rereading chat, it belongs in a tracked issue.

#### 6.3 Update an existing tracked issue instead of creating a new one when

- the conversation refers to work already represented by an open issue
- the message changes ownership, handoff, blocker, waiting state, escalation, or next step for that issue
- the new work is a continuation of the same execution slice rather than a distinct deliverable

Rule: prefer updating the existing issue over opening sibling issues for the same execution lane.

### 7. Actor-Specific Rules

#### 7.1 Main

`Main` is responsible for turning cross-agent coordination into durable Paperclip state.

`Main` must create a new issue or update an existing one when it:

- delegates work to `Ork`, `Stitch`, or `Personal OS`
- changes the coordination owner
- asks for a specialist handoff
- marks the work blocked, waiting, or needing human attention
- replaces the current next step with a new durable instruction

`Main` may leave discussion in chat/comments when it is only exploring, clarifying, or acknowledging progress.

#### 7.2 Ork, Stitch, and Personal OS

These specialists should publish structured updates when they change control-plane state, not for every internal thought.

They must publish a structured update when they:

- accept or redirect ownership
- hand work back or across to another specialist
- assert a blocker or waiting condition
- request human attention
- materially replace the durable next step

They may leave work in chat/comments for:

- local reasoning
- execution narration
- tool chatter
- tentative ideas that do not yet change durable issue state

### 8. Handoff Minimums

When a structured handoff is published, it must use the existing `missionControl.handoff` shape and include:

- `fromAgentId`
- `toAgentId`
- `timestamp`
- `context`

The following should be set whenever known and are expected for normal cross-agent delegation:

- `reason`
- `requestedNextStep`
- `unblockCondition`

Cross-agent delegation must not rely on a freeform comment alone when a valid structured handoff can be written.

### 9. Task Status Sync

#### 9.1 Canonical rule

`issues.status` remains the single durable task-status model.

OpenClaw-side progress may update Paperclip issue status, but only by mapping into the existing Paperclip statuses:

- `backlog`
- `todo`
- `in_progress`
- `in_review`
- `blocked`
- `done`
- `cancelled`

`missionControl.workflowState` is supporting context, not a second status lane. It explains why work is blocked, handed off, or resumed; it does not replace `issues.status`.

#### 9.2 Reuse-first sync rule

Status sync must collapse OpenClaw-side progress into the existing Paperclip execution semantics from `doc/execution-semantics.md`.

- Do not mirror every OpenClaw internal step or transcript event into a Paperclip status change.
- Do not invent adapter-specific task states in Paperclip.
- Do not treat chat narration as status truth.
- Only publish a status change when operator-visible execution expectations changed in a durable way.

Rule: if the answer to "what should the operator believe happens next?" did not change, the status probably should not change either.

#### 9.3 Mapping rules

| OpenClaw-side reality | Paperclip write |
|---|---|
| work exists but is not ready to start | `status=backlog` |
| work is actionable, but no mapped actor has actively claimed execution yet | `status=todo` |
| the mapped assignee has actively taken the work and is the current executor | `status=in_progress` |
| execution is paused because the next move belongs to a reviewer or approver | `status=in_review` |
| the work cannot continue until an external dependency, upstream issue, or human input changes | `status=blocked` plus matching mission-control context |
| the requested deliverable for this issue is complete | `status=done` |
| the work will not continue by explicit decision | `status=cancelled` |

This is a lossy normalization by design. OpenClaw may have richer internal progress, but Paperclip stores only the operator-facing task state it already understands.

#### 9.4 Required pairing with mission-control fields

When status sync sets `status=blocked`, the integration should also set the existing mission-control context that explains the block:

- waiting on human input: `missionControl.workflowState.kind=waiting_on_human`
- blocked on another issue or external upstream: `missionControl.workflowState.kind=blocked_on_upstream`

When status sync reflects a handoff without a true execution pause, use `missionControl.handoff` and, when helpful, `missionControl.workflowState.kind=handed_off`, but do not force a status change just because ownership moved.

When work resumes after a prior handoff or waiting state, clear or replace stale blocking/handoff metadata as needed and use `missionControl.workflowState.kind=resumed` if the resumed context is operationally useful. Resume context does not require inventing a new issue status; the issue returns to the appropriate normal status such as `todo` or `in_progress`.

#### 9.5 Ownership and status must stay coherent

Status sync must preserve existing Paperclip invariants:

- `in_progress` requires an assignee
- status must reflect the current execution expectation, not just who spoke last
- ownership changes and status changes should be published together when they describe the same handoff of active work

Examples:

- If `Main` hands implementation to `Ork` and `Ork` has not started yet, set ownership/handoff fields and leave the issue in `todo`.
- If `Ork` has started driving the implementation slice, set ownership as needed and move the issue to `in_progress`.
- If `Stitch` finishes design work and is waiting on human review, move the issue to `in_review` or `blocked` based on who must act next; do not leave it in `in_progress`.

#### 9.6 What must not change status

The following do not justify a Paperclip status transition by themselves:

- local reasoning inside OpenClaw
- transcript chatter
- tool-call progress
- partial substeps within the same active execution slice
- a handoff proposal that has not yet changed durable ownership or next-step expectations
- a summary/comment that restates the current plan

Status churn is a failure mode. Paperclip should show durable workflow state, not every heartbeat mood swing.

#### 9.7 No automatic hook requirement in this slice

This slice defines sync semantics only.

It does not require a specific automation path, webhook, or heartbeat hook in this pass. Later implementation may apply these rules through explicit issue updates, adapter callbacks, or other existing integration surfaces, but any implementation must preserve the contract in sections 9.1 through 9.6.

### 10. Operational Consequences

This spec intentionally aligns with the current operator queue and summary surfaces:

- ownership-based views depend on real `ownerAgentId` values
- blocked/waiting lanes depend on `missionControl.workflowState`
- escalation lanes depend on `missionControl.needsHumanAttention`
- recent handoffs depend on `issue.handoff_updated` activity derived from structured handoff writes

If an OpenClaw actor leaves a state-changing message only in chat, the operator queue will miss it. That is considered incorrect integration behavior for any case covered by sections 5 through 9.

### 11. Acceptance Criteria For This Slice

This slice is complete when later implementation follows these rules:

- every structured mission-control write from `Main`, `Ork`, `Stitch`, or `Personal OS` resolves to a real Paperclip agent id
- ownership, blocker, waiting, escalation, and handoff changes are represented through existing issue fields rather than transcript inference
- OpenClaw-side progress maps into existing Paperclip issue statuses rather than introducing adapter-specific task states
- blocked, waiting, handoff, and resume context is expressed through existing mission-control metadata without replacing `issues.status`
- chat-only messages are allowed only for non-durable discussion
- no additional mission-control task or dashboard model is introduced to support this integration
