---
navigation: {"section":"Tasks and conversations","sectionOrder":20,"order":40}
---

# Agent conversations and project handoff

A person can hold a persistent conversation with an agent, return to its history, and hand useful work into a project or task. The gated conference-room chat is a separate conversation surface.

Feature ID: `agent-chat`.

Implementation: [agent chat](../../ui/src/pages/AgentChat.tsx), [chat landing](../../ui/src/pages/AgentChats.tsx), [conference room](../../ui/src/pages/BoardChat.tsx).

Agent access: [companion](../agent-access-map/agent-chat.md).

## Sub-features

- `discovery`: `agent-chat/discovery` — find an agent and reopen an accessible recent conversation.
- `history`: `agent-chat/history` — send messages, inspect replies/files, and return to the same conversation.
- `handoff`: `agent-chat/handoff` — create or identify a project/task from chat and follow the resulting work.
- `conference-room`: `agent-chat/conference-room` — use the separately gated board chat without assuming parity with agent chat.

## How to get to it (user POV)

### `agent-conversation`

Open `/chats`, choose an agent, or use `/chats/:agentRef` and its conversation sidebar.

With Coordinator enabled, the composer exposes the shared model/thinking-level picker for supported agents. The agent stays fixed in this control; switching agents remains in the chat header. Choices save as conversation overrides on send, preserving the agent's configuration. A first message creates the conversation before saving settings and submitting through the ordered comments endpoint.

Coordinator answer receipts from this conversation jump to the answer bubble without leaving chat. Answer updates from an execution task link to that source task and its decision context. Compact document links read “Open [document title] in the sidebar”.

### `project-handoff`

Ask for project work in Agent Chat and follow its created project/task links. New tasks and accepted task suggestions default to the agent in that conversation. An explicitly requested agent or person takes precedence; no best-fit agent routing is inferred. Ordinary task creation outside chat keeps its existing assignment behavior.

### `conference-room`

Open `/board-chat` only when its conference-room gate is enabled.

## Driving it with Playwright and the Paperclip CLI

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Enable the applicable chat feature, use a configured test agent, and distinguish model replies from a mocked conversation fixture.

### `agent-conversation`

Automated: [chat landing](../../ui/src/pages/AgentChats.test.tsx) checks recent-chat routing; [conversation service](../../server/src/__tests__/agent-conversations.test.ts) covers persisted conversation behavior.

Automated: [composer picker](../../ui/src/components/task-chat/ComposerRunSettingsPicker.test.tsx) covers fixed-agent model/effort selection on desktop and mobile; [composer](../../ui/src/components/task-chat/TaskChatComposer.test.tsx) covers Coordinator gating and settings submission without reassignment. [Task detail](../../ui/src/pages/IssueDetail.test.tsx) verifies canonical first/existing-chat IDs, settings-before-comment ordering, and no comment submission when settings fail to save. These tests mock the API and do not prove provider execution with the chosen model.

Automated: [conversation delivery](../../server/src/__tests__/agent-conversation-delivery.test.ts)
checks that paused or otherwise non-invokable agents leave comments pending
without aborting startup recovery, and that a later unpause allows one delivery.
The test persists queue admissions only; it does not start agents or providers.
Automated: [historical chat](../../ui/src/pages/AgentChat.test.tsx) keeps an older
conversation reachable after a cached roster refresh ends in HTTP 429. It checks
lookup Retry and preserves permission and company boundaries. This is component
evidence with real query state, not live provider proof.

Automated: [thread and composer](../../ui/src/components/TaskChatThread.test.tsx)
keeps an in-flight attachment through first-chat creation on desktop and mobile,
while initial history for an existing conversation stays deferred. The
[first-upload browser journey](../../tests/e2e/agent-chat-projects.spec.ts)
checks the visible file chip, server attachment, no premature agent run, and
attachment count after send and reload. That journey uses a simulated agent.

Manual: In a conversation with no messages, attach a file before the first
send. Confirm the same file stays in the composer after the chat is created.
Send it once, reload, and confirm the file and message remain.

Manual: Start a conversation, send a recognizable request, and inspect its reply.
Navigate away and reopen the same history. Use `/new` for a fresh session within
the same standing conversation. Test an unavailable historical agent and an
inaccessible saved conversation; verify no cross-user or cross-company history appears.

### `project-handoff`

Automated: [chat project tools](../../server/src/__tests__/chat-project-tools.test.ts) checks tool contracts; live model choice and UI handoff require a manual run.

Automated: [Coordinator handoffs](../../server/src/__tests__/coordinator-handoff.test.ts)
checks that a suggested task remains a proposal until acceptance, that its task,
initial plan and source-chat audience are saved atomically, and that retries do
not create another task. A conversation is a privacy/provenance source rather
than a structural task parent. The same tests cover compact canonical decision
receipts, exact uploaded-artifact bindings, current task access, reset-session
boundaries, and pagination of older handoffs.
Explicit live evals: [chat feature journeys](../../tests/runner-e2e/CHAT-FEATURES.md)
send natural requests to save a backlog task or delegate an announcement. They
check project/assignee, execution or non-execution, saved output, return to chat,
and click the actual same-instance task link after reload. Registration alone
does not establish a pass. Production chat guidance uses company-prefixed relative
task links unless the platform supplied a verified absolute origin.

Manual: Ask the configured agent to create bounded project work, inspect the proposed/created target, and open the resulting task. Verify the request context and intended project survived and the task produces a useful output.

Manual: With the personal Coordinator workspace enabled, discuss a vague request
until the agent suggests a task. Confirm that no execution task exists before
acceptance. Accept it, stay in chat, and open the created card on demand. An
explicit request to create a task may create it directly under normal authority.
Approve a work product or answer a question in its task or Needs You, then return
to the originating chat. Its compact update should link to the exact recorded
decision and reviewed artifact, without needing another coordinator turn.
Approval of artifact quality alone must not publish it or complete the task.

Coordinator task clarification: create a task with only a description. When material context is missing, native task guidance asks one focused canonical question inside that task. Its actionable form is also projected into Needs You and the originating standing chat; direct user-created tasks appear in the assigned agent’s standing chat. Answer on either surface and verify the pending card/count clear and a compact recorded answer replaces it in chat. This projection is event-refreshed and does not wake another agent merely to repeat the question. Current direct-task questions survive a chat reset; their answered receipts start at the current chat boundary. The task brief remains editable context, not another stored question. Model choice and actual resumed execution still require live verification.

### `conference-room`

Automated: [board chat gate](../../server/src/__tests__/board-chat-route-feature-flag.test.ts) proves route gating, not a live conversation.

Preconditions for this entry point: `local_trusted` mode and an installed,
authenticated `claude` CLI, in addition to the Conference Room flag. These are
separate from Agent Chat's configured-agent prerequisites.

Manual: Check disabled access first, enable in the disposable instance, then send and reload a conversation. Inspect the actual responding agent and persisted history; report this result separately from Agent Chat.

## Gotchas

- Coordinator Markdown references to a standing agent conversation display “Chat with [agent]” and route to that chat, preserving anchors. Labels resolve once from the existing current-person/current-company chat list and agent roster; no task status glyph or task quicklook is shown for these references. Ordinary task links retain their existing treatment.

- Idle chat is not failed execution.
- See [steering](./steering.md) for in-flight messages and [questions](./questions-and-approvals.md) for interactions.
- An API tool test does not prove that every harness will choose the same handoff tool.

### Storybook verification

#### `conference-room`

Capability ID: `agent-chat/conference-room`.

Scope: ui
Storybook: Conference-room flag disabled, empty/history/reply, busy and explicit failure states.
Production: Exercise separate BoardChat route gate, local-trusted deployment and authenticated Claude CLI; send/reload real conversation with responding agent attribution.
Sources: Source: [BoardChat.tsx](../../ui/src/pages/BoardChat.tsx), [board-chat.ts](../../server/src/routes/board-chat.ts). Tests: [BoardChat.test.tsx](../../ui/src/pages/BoardChat.test.tsx), [board-chat-route-feature-flag.test.ts](../../server/src/__tests__/board-chat-route-feature-flag.test.ts)

### Explicit output quality review (Coordinator functional slice)

Accepted suggestions and native explicit task creation may carry `requiredQualityReview` into the task's existing execution policy. The opt-in requirement names output slots and is separate from the existing reviewer eligibility policy. Each slot requires a canonical human verdict bound to an exact current output document revision or attachment identity. Plans, questions, file presence, model completion claims, rejected/deferred verdicts and stale versions do not satisfy it. Only a human may change an existing requirement. Quality approval does not publish or automatically complete the task. Tasks without this optional requirement retain existing completion behavior.

Owning service: `server/src/services/required-quality-review.ts`; enforcement: interaction creation, issue update, native completion feedback/finalization. Focused proof: `server/src/__tests__/required-quality-review.test.ts` plus native arbiter and chat completion delivery tests. Completion updates include bounded canonical output-decision identities for linking existing review, never worker-authored review prose. These tests do not establish unattended live provider reliability.

Attachment approval is for the exact immutable file identity. Removal or a mismatched hash invalidates that target; registering a replacement beside the approved file does not redefine its output slot. A replacement requires a fresh bound review. Document targets additionally track the current revision.
