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

### `project-handoff`

Ask for project work in Agent Chat and follow its created project/task links.

### `conference-room`

Open `/board-chat` only when its conference-room gate is enabled.

## Driving it with Playwright and the Paperclip CLI

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Enable the applicable chat feature, use a configured test agent, and distinguish model replies from a mocked conversation fixture.

### `agent-conversation`

Automated: [chat landing](../../ui/src/pages/AgentChats.test.tsx) checks recent-chat routing; [conversation service](../../server/src/__tests__/agent-conversations.test.ts) covers persisted conversation behavior.

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

Explicit live evals: [chat feature journeys](../../tests/runner-e2e/CHAT-FEATURES.md)
send natural requests to save a backlog task or delegate an announcement. They
check project/assignee, execution or non-execution, saved output, return to chat,
and click the actual same-instance task link after reload. Registration alone
does not establish a pass. Production chat guidance uses company-prefixed relative
task links unless the platform supplied a verified absolute origin.

Manual: Ask the configured agent to create bounded project work, inspect the proposed/created target, and open the resulting task. Verify the request context and intended project survived and the task produces a useful output.

### `conference-room`

Automated: [board chat gate](../../server/src/__tests__/board-chat-route-feature-flag.test.ts) proves route gating, not a live conversation.

Preconditions for this entry point: `local_trusted` mode and an installed,
authenticated `claude` CLI, in addition to the Conference Room flag. These are
separate from Agent Chat's configured-agent prerequisites.

Manual: Check disabled access first, enable in the disposable instance, then send and reload a conversation. Inspect the actual responding agent and persisted history; report this result separately from Agent Chat.

## Gotchas

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
