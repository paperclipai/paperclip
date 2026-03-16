# Agent Chat UI and Issue-Backed Conversations

## Context

`PAP-475` asks two related questions:

1. What UI kit should Paperclip use if we add a chat surface with an agent?
2. How should chat fit the product without breaking the current issue-centric model?

This is not only a component-library decision. In Paperclip today:

- V1 explicitly says communication is `tasks + comments only`, with no separate chat system.
- Issues already carry assignment, audit trail, billing code, project linkage, goal linkage, and active run linkage.
- Live run streaming already exists on issue detail pages.
- Agent sessions already persist by `taskKey`, and today `taskKey` falls back to `issueId`.
- The OpenClaw gateway adapter already supports an issue-scoped session key strategy.

That means the cheapest useful path is not "add a second messaging product inside Paperclip." It is "add a better conversational UI on top of issue and run primitives we already have."

## Current Constraints From the Codebase

### Durable work object

The durable object in Paperclip is the issue, not a chat thread.

- `IssueDetail` already combines comments, linked runs, live runs, and activity into one timeline.
- `CommentThread` already renders markdown comments and supports reply/reassignment flows.
- `LiveRunWidget` already renders streaming assistant/tool/system output for active runs.

### Session behavior

Session continuity is already task-shaped.

- `heartbeat.ts` derives `taskKey` from `taskKey`, then `taskId`, then `issueId`.
- `agent_task_sessions` stores session state per company + agent + adapter + task key.
- OpenClaw gateway supports `sessionKeyStrategy=issue|fixed|run`, and `issue` already matches the Paperclip mental model well.

That means "chat with the CEO about this issue" naturally maps to one durable session per issue today without inventing a second session system.

### Billing behavior

Billing is already issue-aware.

- `cost_events` can attach to `issueId`, `projectId`, `goalId`, and `billingCode`.
- heartbeat context already propagates issue linkage into runs and cost rollups.

If chat leaves the issue model, Paperclip would need a second billing story. That is avoidable.

## UI Kit Recommendation

## Recommendation: `assistant-ui`

Use `assistant-ui` as the chat presentation layer.

Why it fits Paperclip:

- It is a real chat UI kit, not just a hook.
- It is composable and aligned with shadcn-style primitives, which matches the current UI stack well.
- It explicitly supports custom backends, which matters because Paperclip talks to agents through issue comments, heartbeats, and run streams rather than direct provider calls.
- It gives us polished chat affordances quickly: message list, composer, streaming text, attachments, thread affordances, and markdown-oriented rendering.

Why not make "the Vercel one" the primary choice:

- Vercel AI SDK is stronger today than the older "just `useChat` over `/api/chat`" framing. Its transport layer is flexible and can support custom protocols.
- But AI SDK is still better understood here as a transport/runtime protocol layer than as the best end-user chat surface for Paperclip.
- Paperclip does not need Vercel to own message state, persistence, or the backend contract. Paperclip already has its own issue, run, and session model.

So the clean split is:

- `assistant-ui` for UI primitives
- Paperclip-owned runtime/store for state, persistence, and transport
- optional AI SDK usage later only if we want its stream protocol or client transport abstraction

## Product Options

### Option A: Separate chat object

Create a new top-level chat/thread model unrelated to issues.

Pros:

- clean mental model if users want freeform conversation
- easy to hide from issue boards

Cons:

- breaks the current V1 product decision that communication is issue-centric
- needs new persistence, billing, session, permissions, activity, and wakeup rules
- creates a second "why does this exist?" object beside issues
- makes "pick up an old chat" a separate retrieval problem

Verdict: not recommended for V1.

### Option B: Every chat is an issue

Treat chat as a UI mode over an issue. The issue remains the durable record.

Pros:

- matches current product spec
- billing, runs, comments, approvals, and activity already work
- sessions already resume on issue identity
- works with all adapters, including OpenClaw, without new agent auth or a second API surface

Cons:

- some chats are not really "tasks" in a board sense
- onboarding and review conversations may clutter normal issue lists

Verdict: best V1 foundation.

### Option C: Hybrid with hidden conversation issues

Back every conversation with an issue, but allow a conversation-flavored issue mode that is hidden from default execution boards unless promoted.

Pros:

- preserves the issue-centric backend
- gives onboarding/review chat a cleaner UX
- preserves billing and session continuity

Cons:

- requires extra UI rules and possibly a small schema or filtering addition
- can become a disguised second system if not kept narrow

Verdict: likely the right product shape after a basic issue-backed MVP.

## Recommended Product Model

### Phase 1 product decision

For the first implementation, chat should be issue-backed.

More specifically:

- the board opens a chat surface for an issue
- sending a message is a comment mutation on that issue
- the assigned agent is woken through the existing issue-comment flow
- streaming output comes from the existing live run stream for that issue
- durable assistant output remains comments and run history, not an extra transcript store

This keeps Paperclip honest about what it is:

- the control plane stays issue-centric
- chat is a better way to interact with issue work, not a new collaboration product

### Onboarding and CEO conversations

For onboarding, weekly reviews, and "chat with the CEO", use a conversation issue rather than a global chat tab.

Suggested shape:

- create a board-initiated issue assigned to the CEO
- mark it as conversation-flavored in UI treatment
- optionally hide it from normal issue boards by default later
- keep all cost/run/session linkage on that issue

This solves several concerns at once:

- no separate API key or direct provider wiring is needed
- the same CEO adapter is used
- old conversations are recovered through normal issue history
- the CEO can still create or update real child issues from the conversation

## Session Model

### V1

Use one durable conversation session per issue.

That already matches current behavior:

- adapter task sessions persist against `taskKey`
- `taskKey` already falls back to `issueId`
- OpenClaw already supports an issue-scoped session key

This means "resume the CEO conversation later" works by reopening the same issue and waking the same agent on the same issue.

### What not to add yet

Do not add multi-thread-per-issue chat in the first pass.

If Paperclip later needs several parallel threads on one issue, then add an explicit conversation identity and derive:

- `taskKey = issue:<issueId>:conversation:<conversationId>`
- OpenClaw `sessionKey = paperclip:conversation:<conversationId>`

Until that requirement becomes real, one issue == one durable conversation is the simpler and better rule.

## Billing Model

Chat should not invent a separate billing pipeline.

All chat cost should continue to roll up through the issue:

- `cost_events.issueId`
- project and goal rollups through existing relationships
- issue `billingCode` when present

If a conversation is important enough to exist, it is important enough to have a durable issue-backed audit and cost trail.

This is another reason ephemeral freeform chat should not be the default.

## UI Architecture

### Recommended stack

1. Keep Paperclip as the source of truth for message history and run state.
2. Add `assistant-ui` as the rendering/composer layer.
3. Build a Paperclip runtime adapter that maps:
   - issue comments -> user/assistant messages
   - live run deltas -> streaming assistant messages
   - issue attachments -> chat attachments
4. Keep current markdown rendering and code-block support where possible.

### Interaction flow

1. Board opens issue detail in "Chat" mode.
2. Existing comment history is mapped into chat messages.
3. When the board sends a message:
   - `POST /api/issues/{id}/comments`
   - optionally interrupt the active run if the UX wants "send and replace current response"
4. Existing issue comment wakeup logic wakes the assignee.
5. Existing `/issues/{id}/live-runs` and `/issues/{id}/active-run` data feeds drive streaming.
6. When the run completes, durable state remains in comments/runs/activity as it does now.

### Why this fits the current code

Paperclip already has most of the backend pieces:

- issue comments
- run timeline
- run log and event streaming
- markdown rendering
- attachment support
- assignee wakeups on comments

The missing piece is mostly the presentation and the mapping layer, not a new backend domain.

## Agent Scope

Do not launch this as "chat with every agent."

Start narrower:

- onboarding chat with CEO
- workflow/review chat with CEO
- maybe selected exec roles later

Reasons:

- it keeps the feature from becoming a second inbox/chat product
- it limits permission and UX questions early
- it matches the stated product demand

If direct chat with other agents becomes useful later, the same issue-backed pattern can expand cleanly.

## Recommended Delivery Phases

### Phase 1: Chat UI on existing issues

- add a chat presentation mode to issue detail
- use `assistant-ui`
- map comments + live runs into the chat surface
- no schema change
- no new API surface

This is the highest-leverage step because it tests whether the UX is actually useful before product model expansion.

### Phase 2: Conversation-flavored issues for CEO chat

- add a lightweight conversation classification
- support creation of CEO conversation issues from onboarding and workflow entry points
- optionally hide these from normal backlog/board views by default

The smallest implementation could be a label or issue metadata flag. If it becomes important enough, then promote it to a first-class issue subtype later.

### Phase 3: Promotion and thread splitting only if needed

Only if we later see a real need:

- allow promoting a conversation to a formal task issue
- allow several threads per issue with explicit conversation identity

This should be demand-driven, not designed up front.

## Clear Recommendation

If the question is "what should we use?", the answer is:

- use `assistant-ui` for the chat UI
- do not treat raw Vercel AI SDK UI hooks as the main product answer
- keep chat issue-backed in V1
- use the current issue comment + run + session + billing model rather than inventing a parallel chat subsystem

If the question is "how should we think about chat in Paperclip?", the answer is:

- chat is a mode of interacting with issue-backed agent work
- not a separate product silo
- not an excuse to stop tracing work, cost, and session history back to the issue

## Implementation Notes

### Immediate implementation target

The most defensible first build is:

- add a chat tab or chat-focused layout on issue detail
- back it with the currently assigned agent on that issue
- use `assistant-ui` primitives over existing comments and live run events

### Defer these until proven necessary

- standalone global chat objects
- multi-thread chat inside one issue
- chat with every agent in the org
- a second persistence layer for message history
- separate cost tracking for chats

## References

- V1 communication model: `doc/SPEC-implementation.md`
- Current issue/comment/run UI: `ui/src/pages/IssueDetail.tsx`, `ui/src/components/CommentThread.tsx`, `ui/src/components/LiveRunWidget.tsx`
- Session persistence and task key derivation: `server/src/services/heartbeat.ts`, `packages/db/src/schema/agent_task_sessions.ts`
- OpenClaw session routing: `packages/adapters/openclaw-gateway/README.md`
- assistant-ui docs: <https://www.assistant-ui.com/docs>
- assistant-ui repo: <https://github.com/assistant-ui/assistant-ui>
- AI SDK transport docs: <https://ai-sdk.dev/docs/ai-sdk-ui/transport>
