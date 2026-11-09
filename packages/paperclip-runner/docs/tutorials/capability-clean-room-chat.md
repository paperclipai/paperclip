# Capability Tutorial: Chat With Real Codex In A Clean Room

**Time to first success: about 3 minutes**, once the package is installed. You
open a blank chat, type whatever you like, and watch a real Codex session work a
brand-new mock Paperclip issue through a real `paperclip-runnerd` process. No
scenario to pick, no recorded transcript, and no real Paperclip service anywhere
in the picture.

This is the second primary Capability path. The first — the preset scenario
explorer — is covered by the
[issue-thread tutorial](capability-issue-thread.md) and stays available and
unchanged. Read [the clean-room reference](../capability-clean-room-chat.md) for
the seed, exposure profile, bounds, and route contract behind what you see here.

## What you need

- Node.js 20 or newer and pnpm 9 or newer (verified with Node 22.22.2 and pnpm
  9.15.4).
- A Rust toolchain, because this path builds the real `paperclip-runnerd`
  binary. There is no offline fallback: the clean room is live-only by design.
- A locally authenticated Codex CLI. The package server owns that
  authentication; the browser never receives it.

Install the workspace from the repository root:

```sh
NODE_ENV=development pnpm install --filter @paperclipai/paperclip-runner --frozen-lockfile --offline --ignore-scripts
```

Setting `NODE_ENV=development` matters even if your shell already has
`NODE_ENV=production`: pnpm silently skips devDependencies otherwise, and the
build tooling lives there.

## 1. Prove the path without a browser (about 1 minute)

```sh
pnpm --filter @paperclipai/paperclip-runner smoke:capability:cleanroom -- --json
```

This builds the TypeScript output and `paperclip-runnerd`, starts the package
server on loopback, opens a clean room, and drives two real Codex turns through
the same HTTP routes the browser uses. Expected shape:

```json
{
  "schema": "paperclip.capability.clean-room-smoke.v1",
  "firstIssue": "MCK-2114",
  "newChatIssue": "MCK-9539",
  "turns": 2,
  "toolCalls": [
    { "operationId": "get_task_context", "outcome": "ok" },
    { "operationId": "report_progress", "outcome": "ok" }
  ],
  "assertions": { "...": true }
}
```

Every assertion must read `true`. The two issue identifiers differ because
`New chat` mints a new mock tenant rather than clearing the old one.

## 2. Open the chat in a browser (about 1 minute)

```sh
pnpm --filter @paperclipai/paperclip-runner console:issue-thread
```

Open `http://127.0.0.1:4184/`. The landing surface is the scenario explorer.
Above the issue header, a two-item rail offers **Scenario explorer** and
**New chat · clean room**. Click `New chat`, or go straight to
`http://127.0.0.1:4184/#/chat`.

The first load takes a few seconds: the server is starting a real runnerd and a
real Codex app-server for you. When it settles you should see:

- three identity chips — `Real Codex`, `Real runnerd`, `Mock Paperclip` — plus a
  `Clean room <token>` chip naming the tenant;
- a mock issue identifier such as `MCK-3799` with the title `Clean-room chat`;
- a blank thread with a short explanation of what the surface is;
- a composer, and an `Evidence` button that is closed.

If Codex or runnerd cannot start, the page says so and offers `Try again`. It
will not quietly show you a fixture.

## 3. Send a real message

Type anything. A useful first prompt:

```
Read this issue, then record a one-sentence status on it.
```

You should see a user message, a `Real Codex` reply, collapsed tool strips for
the semantic calls Codex chose (`get_task_context`, `report_progress`, …), and a
durable comment card tagged **Recorded to mock thread** — that card is a mock
control-plane record, not model prose.

Keep going. The conversation is free-form and multi-turn on one durable session.
Ask Codex to write a document, register a deliverable, propose child tasks, or
ask you a structured question; interaction cards render inline and resume the
same Codex thread once you answer.

## 4. Look at the evidence, when you want it

Click `DevTools`. The drawer carries the same eight evidence sections the scenario path
uses: tools exposed, calls and typed results, authorization decisions,
control-plane actions, runner events, state diffs, traceability, and parity.
Above those sections, the DevTools inspector provides six tabs:

- **Timeline** selects any retained control-plane revision.
- **State** browses the full mock company tree.
- **Diff** compares any two revisions field by field.
- **Documents** reads document bodies and switches between revisions.
- **Protocol**, **Runtime**, and **Authority** show the surrounding scaffolding
  that explains why each mutation happened.

Use **Pause** to stop following the newest revision, **Export** to download a
redacted JSON snapshot, or **Fork rN** to replace this chat with a fresh live
branch rooted at the selected mock-company revision.

Drag the bright divider at the drawer's left edge to resize it (up to 960px), or
focus that divider and use the arrow keys. As soon as you send a message, the
live activity rail reports the current Codex stage; shell commands, built-in
Codex tools, and Paperclip semantic calls also appear as individual activity
rows while the turn is still open.

Two things are worth finding on your first pass:

- **Tools exposed** lists `decide_approval`, `control_workspace_service`, and
  `generic_api_request` under `Control plane (not exposed to the agent)`. Those
  grants are withheld on purpose, so a denial stays reachable in a conversation
  nobody scripted.
- **Control plane** carries a `network-guard-…` row reading
  `Real Paperclip API requests: 0. Child PAPERCLIP_* environment keys: none.`

Close the drawer and the surface is a plain chat again.

## 5. Stop, reset, and start over

- **Stop** cancels the active turn and keeps the session and its transcript.
- **Reset** stops active work, retires this session's authority, and opens a new
  mock tenant. The confirmation dialog says so before it happens.
- **New chat** does the same without the dialog.
- **Refresh** (F5) reconnects to the same chat. It does not become a recording.

After a reset or a new chat, look at the header: the `MCK-` identifier, the run
id, and the `Clean room` token have all changed. The previous session is gone —
its id answers `404` on every route.

## 6. Confirm the scenario explorer still works

Click `Scenario explorer` in the rail. Every preset deep link still resolves,
including the deterministic capture routes:

```
http://127.0.0.1:4184/#/issue/hb-baseline?shot=denial-optional-tool&capture=1
```

## Where to go next

- [Clean-room chat reference](../capability-clean-room-chat.md) — seed, exposure
  profile, session routes, and bounds.
- [Execution modes and identity](../capability-execution-modes.md) — why a
  `mode=fake` artifact can never satisfy a live criterion.
- [Verification commands](../capability-verification-commands.md) — the full
  command set, including the browser and screenshot gates.
