# Scenario chat Tutorial: Chat With the Mock Control Plane

**Time to first success: about 3 minutes.** One command opens a chat where you
send prompts to a Capability scenario and watch exactly how the mock Paperclip
control plane was used on every turn. The tutorial runs from the repository
root. It starts no Paperclip service, contacts no Paperclip control plane, and
holds no provider credential.

Scenario chat extends the Capability browser surface; it does not integrate the runner
into Paperclip. Real integration is future upload integration and requires separate approval. See
[the future binding boundary reference](../capability-future-binding-boundary.md).

## What you need

- Node.js 20 or newer and pnpm 9 or newer. Verified with Node 22.22.2.
- No Rust toolchain and no network access after `pnpm install`.

Install the package workspace from the repository root:

```sh
pnpm install --filter @paperclipai/paperclip-runner --lockfile=false --offline --ignore-scripts --dev
```

## 1. Open the chat (about 1 minute)

```sh
pnpm --filter @paperclipai/paperclip-runner run demo:scenarios
```

Open <http://127.0.0.1:4183/scenario-explorer/#/chat/ap-mcp-gate-01>.

Before you type anything, the conversation already has content: a **session
seed** strip reading "Control plane checked out the task and opened the run — no
agent tool exists for this," and a **Session seed activity** strip counting what
it did. That is the point of turn 0. Work happened, and no agent tool was
involved.

The session status chip reads **Idle · seeded**. The right rail — **Activity**
on desktop, the **Activity** segment on a phone — shows the seed group with its
exposure decision, state diff, and verdict.

## 2. Run a turn that succeeds

Type into the composer and press Enter:

```
Where does the MCP tool approval for this task stand?
```

The turn appends: your message as a right-aligned bubble, two semantic calls
(`get_task_context`, `list_approvals`) as tool cards with their disposition
badges, the agent's reply, and a **Turn 1 activity** strip:

```
Turn 1 activity   ⚙ 2 tools   ⌘ 0 control plane   Δ 0 domains   ✓ Pass
```

Click the strip. The Activity stream opens turn 1's group with the six evidence
sections in order — exposed tools, calls and results, authorization, control
plane, state diff, parity. Nothing changed state, and the diff says so.

## 3. Run a turn that is denied

```
Raise the approval request yourself and get the tool switched on.
```

`request_approval` is denied. The denial renders in place on the danger surface
with the failing operation, the code `policy_denied`, the reason
`required_claim_missing`, and an explicit line that **no protected state was
returned**. The turn strip counts it (`✕ 1 denied`), and on mobile the Activity
segment carries a `· 1 deny` chip so you can see it without opening the segment.

The session status still reads **Scripted · deterministic** and the session
parity still passes. A denial is a correct outcome, not a broken session — this
run simply does not hold `governance:approvals:request`. Open the turn's
**Authorization** section to see the claims considered and the missing one.

## 4. See control-plane-owned work with no agent tool

Open <http://127.0.0.1:4183/scenario-explorer/#/chat/ix-checkbox-01?replay=fake>.
`replay=fake` plays the recorded three-turn conversation.

Turn 2 opens a checkbox interaction. Turn 3 is the board answering it — and
that answer is performed by the control plane, not by a tool:

```
⌘ Control plane recorded the board's answer and scheduled the continuation
  wake — no agent tool exists for this.
```

Open turn 3's **State diff** section. The `interactions` domain shows
`status: pending → answered`, the unchanged domains collapse to one line, and a
**Control plane** badged row records `wake.scheduled`. The wake is scheduled by
reconciliation; the agent never asked for it.

## 5. Reset and replay

**Reset session** asks first, because it discards mutable mock state. Accept it
and the transcript returns to the seeded turn 0 — no turns, no denials, a clean
diff. Switching scenario from the rail mid-session asks the same question, since
two scenarios never share mock state.

**Replay scripted session** plays the remaining recorded turns and needs no
confirmation: it reproduces an identical timeline.

## 6. Run the tests and record the evidence

```sh
pnpm --filter @paperclipai/paperclip-runner run test:scenarios
pnpm --filter @paperclipai/paperclip-runner run test:browser:scenarios
# Recorded evidence generation is deferred from this release.
```

The first covers the session data contract and the chat components, the second
drives the surface in a real browser at both viewports, and the third writes the
ten acceptance screenshots to `.paperclip-local/evidence/capability/` — failing if any
route scrolls horizontally.

## What this does not do

- No ACPX implementation and no real control-plane integration.
- No provider credential in the browser. **Codex (bounded)** stays disabled with
  a named reason unless the local provider relay is running; **Scripted
  (deterministic)** drives the same mock core offline.
- Nothing you type is persisted. A reload drops an unsent draft, which is the
  accepted trade against storing conversation content.

Reference: [Scenario chat scenario chat](../scenario-chat.md).
