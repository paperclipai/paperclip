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

This slice does not yet define:

- task-status sync from external runtimes
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

### 9. Operational Consequences

This spec intentionally aligns with the current operator queue and summary surfaces:

- ownership-based views depend on real `ownerAgentId` values
- blocked/waiting lanes depend on `missionControl.workflowState`
- escalation lanes depend on `missionControl.needsHumanAttention`
- recent handoffs depend on `issue.handoff_updated` activity derived from structured handoff writes

If an OpenClaw actor leaves a state-changing message only in chat, the operator queue will miss it. That is considered incorrect integration behavior for any case covered by sections 5 through 8.

### 10. Acceptance Criteria For This Slice

This slice is complete when later implementation follows these rules:

- every structured mission-control write from `Main`, `Ork`, `Stitch`, or `Personal OS` resolves to a real Paperclip agent id
- ownership, blocker, waiting, escalation, and handoff changes are represented through existing issue fields rather than transcript inference
- chat-only messages are allowed only for non-durable discussion
- no additional mission-control task or dashboard model is introduced to support this integration
