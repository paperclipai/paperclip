# Scenario chat Scenario Chat

The scenario chat is an interactive surface over the same package-local Capability
runner and [mock control plane](capability-mock-control-plane-port.md) that the
[scenario explorer](capability-scenario-explorer.md) reads. You pick a scenario,
send prompts, and watch the mock Paperclip activity for every turn instead of
having it hidden behind the conversation. It contacts no Paperclip service,
holds no credential, and introduces no ACPX implementation.

Sources: `src/scenarios/chat-session.ts`, `src/scenarios/chat-script.ts`,
`src/scenarios/scenario-execution.ts`, and `examples/scenario-explorer/`.
Interaction contract:
[Scenario chat mobile chat UX](design/scenario-chat-ux.md).

## The turn model

A **session** is one long-lived mock control plane. Unlike a 7F single-shot
run, the state a turn changes is still there for the next turn — which is what
makes a per-turn diff mean anything.

- **Turn 0 is the session seed**: checkout, wake routing, and the first tool
  exposure decision, all performed by the control plane before anyone can type.
  It renders with control-plane styling because no agent tool was involved.
- **Turns 1..N** are one user message each, plus everything the runtime
  recorded until the agent settled.

Every timeline entry carries the `turn` it belongs to, and the artifact carries
a `turns[]` array. The UI groups on those records; it never derives a turn
boundary, a per-turn diff, or a per-turn verdict itself.

## What each turn records

| Record | Produced by |
| --- | --- |
| Exposed tools (always / optional with unlocking grant / control-plane — no tool) | the 7D authorization engine |
| Semantic calls and typed results | the 7D tool runtime |
| Authorization decisions, missing claims, redactions | the 7D authorization engine |
| Control-plane actions with audit and decision references | the 7C mock core |
| State diff over the ten entity domains | immutable fixture snapshots |
| Wake / reconciliation events | the 7C mock core's own scheduled wakes |
| Turn parity verdict | `capabilityTurnParity` |

A turn is judged on what that turn did. A session-level expectation about work
the board has not asked for yet would read as a failure of turn 1 rather than
as work still to come, so the session verdict stays separate and is judged over
the whole transcript.

## Scripts and drivers

Every one of the 106 corpus scenarios opens in chat. Two carry authored
multi-turn conversations because the acceptance matrix names them:

- `ix-checkbox-01` — read the options, open a checkbox interaction, then the
  board answers it. That answer is a **control-plane-owned action with no agent
  tool**, and it is what makes the control plane schedule the continuation wake.
- `ap-mcp-gate-01` — read the approval queue (allowed), then attempt the gated
  request without the decide claim (**denied**). The denial is a turn outcome
  with its own authorization slice, not a broken session.

Every other scenario falls back to its 7F plan as a single scripted turn, which
keeps the whole corpus openable without inventing dialogue the traceability rows
do not support. Past the end of a script the session stays usable: the agent
re-reads the task context so the turn still shows real mock activity.

**Scripted (deterministic)** is the working driver: your prompt drives the next
recorded turn against the in-page mock core. **Codex (bounded)** is disabled
with a named reason unless the local provider relay is running — the same rule
the explorer applies. No provider credential ever reaches the page in either
mode.

## Routes

```
#/chat                                       chat home (picker + intro)
#/chat/<case-id>                             live session, seeded at turn 0
#/chat/<case-id>?replay=fake                 scripted session, auto-played once
#/chat/<case-id>?replay=fake&view=activity&turn=<n>
#/chat/<case-id>?replay=fake&filter=<tools|authorization|control|diff|parity>
#/chat/<case-id>?replay=fake&stage=streaming holds the last turn mid-stream
```

The shell reports `data-chat-state` (`seeding` / `pending` / `streaming` /
`settled` / `failed`) so captures and tests wait on a state rather than a
timeout. `replay=fake` plays the script once per session: an explicit **Reset
session** returns to the seeded turn 0 and stays there.

## Boundary

- No network request leaves the page's own origin, and nothing the board types
  is written to `localStorage`.
- The chat renders records the runtime produced. It computes no exposure,
  evaluates no claim, applies no redaction, and re-times nothing.
- Redaction happens at the artifact boundary, so a raw secret cannot reach a
  rendered record even if an upstream layer returned one.

## Commands

```sh
pnpm --filter @paperclipai/paperclip-runner run demo:scenarios       # open the surface
pnpm --filter @paperclipai/paperclip-runner run test:scenarios       # runtime + component tests
pnpm --filter @paperclipai/paperclip-runner run test:browser:scenarios
# Recorded evidence generation is deferred from this release.
```

Walkthrough: [Scenario chat scenario chat tutorial](tutorials/scenario-chat.md).
