# Capability clean-room live chat

Capability adds a second primary path beside the preset scenario explorer. A board
user opens a blank chat, sends a free-form message, and watches real Codex work
a mock Paperclip issue through real runnerd. There is no scenario to pick, no
recorded transcript, and no scripted tool tour.

Both paths ship in the same app and share one view contract. What separates them
is what the session is seeded with, and whether a fixture is allowed to stand in
for a provider.

| | Preset scenario explorer | Clean-room chat |
| --- | --- | --- |
| Route | `#/issue/<fixtureProfile>` | `#/chat` |
| Seed | A recorded eval case: transcript, scripted calls, parity verdicts | A company, an agent, and one blank issue |
| Modes | `fake` (default), `replay`, `mode=live` | Live only — no fixture, no recording |
| Tool calls | Fixed by the scenario | Chosen by the conversation |
| Evidence drawer | Collapsed by default | Collapsed by default |

## What "clean room" means

Every open mints a new mock tenant — a new company, actor, task, and `MCK-`
identifier — and seeds nothing else. `assertCapabilityCleanRoomSeedIsBlank` fails the
open if any comment, document, interaction, approval, artifact, blocker, wake,
or fault is present, so "the thread starts blank" is enforced at the seam that
creates the session rather than assumed.

The only mutation an open performs is the run checking the mock issue out, which
is why a fresh room reads `in_progress` rather than `todo`.

## Live only, and loudly so

The clean room never falls back:

- `parseCapabilityRoute` pins `mode` to `live` on `#/chat` and drops `shot` and
  `at`. No URL can talk it into rendering a fixture or a recording.
- The package server has no scripted path for this route. It projects the live
  session and refuses any view that is not `mode=live` with a `Real Codex`
  agent label.
- When runnerd or the Codex app-server cannot start, the surface says exactly
  that and offers `Try again`. It does not render a canned thread.

## Exposure profile

The profile is deterministic and inspectable even though the calls are not.
`CAPABILITY_CLEAN_ROOM_CLAIMS` grants the read, comment, document, interaction,
deliverable, delegation, dependency, wake, and approval-request operations.

Three grants stay withheld on purpose:

| Withheld grant | Effect |
| --- | --- |
| `governance:approvals:decide` | The agent may request an approval; the board decides it. |
| `workspace:control` | No service lifecycle changes from a chat. |
| `test:generic_api_request` | The escape hatch stays off. |

Withholding them keeps a denial reachable in a conversation nobody scripted: if
the model reaches for one, it gets a typed denial with a named code and the mock
state does not move. The Evidence drawer's Tools section lists all three under
`Control plane (not exposed to the agent)`.

The run itself holds the wider adapter claim set that the mock command boundary
requires (`capabilityFixtureRunCapabilities`). That union widens the port, never the
catalog the model sees: effective claims are the intersection of run claims,
scenario claims, and explicitly delegated claims.

## Session lifecycle

```text
GET  /api/capability/ui/cleanroom/session[?sessionId=…]   open or reconnect
POST /api/capability/ui/cleanroom/session {sessionId?}    New chat (retires the caller's room)
POST /api/capability/ui/message      {sessionId, message}
POST /api/capability/ui/interrupt    {sessionId}
POST /api/capability/ui/reconnect    {sessionId}
POST /api/capability/ui/reset        {sessionId}
POST /api/capability/ui/interaction  {sessionId, interactionId, outcome, result}
```

`Reset` and `New chat` both stop active work, clear the previous session's
authority, drop its workspace directory, and open a new tenant. A retired
session id answers `404` on every route afterwards — the rotation is verifiable,
not just visible. Refresh reconnects to the same durable session; a stale id
from `localStorage` opens a fresh room rather than dead-ending.

The clean room stores its session id under its own `localStorage` key, so a
scenario session can never be handed to the chat route or the reverse.

## Bounds

| Bound | Value |
| --- | --- |
| Turns per chat | 24, then a named `turn_limit` refusal that points at `New chat` |
| Message size | 8 KiB |
| Concurrent clean rooms | 4; the oldest yields to a new board user |
| Turn timeout | 120 s (`CapabilityLiveSessionService` default) |

## Real-API block

`CapabilityLiveSession` routes every Paperclip operation through the in-process mock
`ControlPlanePort`; no code path reaches a Paperclip URL. The projection turns
that into a record rather than a claim: the Control plane section of the
Evidence drawer carries a `network-guard-<sessionId>` row reading
`Real Paperclip API requests: 0. Child PAPERCLIP_* environment keys: none.`

The child environment is allowlisted by `createSanitizedCodexEnvironment`, so no
`PAPERCLIP_*` value reaches runnerd or Codex, and the browser receives no
provider, runner, or control-plane credential.

## DevTools state inspector

Opening **DevTools** opens a Redux-DevTools-style inspector over the live
mock company. Its timeline starts at the pristine fixture, adds a revision for
each successful semantic mutation, and lets the operator inspect or diff the
complete browser-safe company scaffolding: company, actors, tasks, comments,
documents, interactions, approvals, artifacts, work products, blockers,
workspace services, budgets, runs, wakes, audit records, decisions,
idempotency records, and configured faults. Separate tabs expose the protocol
boundary records, runner/runtime facts, and effective authority. A dedicated
**Documents** tab renders every mock document and lets the operator switch
between its retained revisions without digging through raw JSON.

The Evidence log consolidates repeated tool-exposure snapshots into one
deduplicated catalog. Its Always, Granted, and Control-plane groups fold
independently; selecting a tool opens its catalog title, description, placement,
required claims, allowed task modes and roles, and full input schema.

**Pause** pins a revision while work continues, **Export** downloads the
redacted DevTools snapshot, and **Fork rN** retires the current mock session and
starts a new executable branch from that retained state. Provider payloads,
session checkpoints, artifact content references, working directories, and
secret-shaped strings remain server-side or are withheld by the explicit
browser projection.

While a turn runs, a live status rail appears immediately after send and tracks
the newest safe Codex activity. Reasoning, planning, shell-command, file-change,
MCP/dynamic-tool, assistant-stream, and Paperclip semantic-tool lifecycle events
each trigger an interim frame. Discrete tools remain separate rows; only noisy
text deltas are grouped. Structured shell items show a bounded,
credential-redacted command preview; raw command output, other provider
payloads, and chain of thought stay withheld.

## Remote preview gateway

The tailnet preview keeps the package server on loopback and exposes it through
`dist/capability/tailnet-gateway.js`. Every API call requires the gateway's
high-entropy HttpOnly capability cookie. Mutations additionally require the
exact configured `Origin` and `application/json`.

Fetch Metadata is checked as defense in depth: any supplied `Sec-Fetch-Site`,
`Sec-Fetch-Mode`, or `Sec-Fetch-Dest` value must describe the expected
same-origin `fetch()` request. Browsers that omit one or all of those optional
headers are still accepted after the capability, Origin, and content-type
checks pass. This keeps Safari and embedded/private browser clients working
without weakening the explicit cross-site denial.

## Verification

| Surface | Command |
| --- | --- |
| Seed, exposure profile, and identity rotation | `pnpm --filter @paperclipai/paperclip-runner test:scenarios` |
| Clean-room HTTP routes end to end (stub provider) | included in `test:scenarios` |
| Browser entry, blank state, evidence-on-demand, narrow layout, axe | `pnpm --filter @paperclipai/paperclip-runner test:browser:issue-thread` |
| Real Codex through real runnerd | `pnpm --filter @paperclipai/paperclip-runner smoke:capability:cleanroom` |
| Live screenshots | `pnpm --filter @paperclipai/paperclip-runner recorded-evidence campaign (deferred)` |

See the [clean-room chat tutorial](tutorials/capability-clean-room-chat.md) for the
clean-start walkthrough, [execution modes and identity](capability-execution-modes.md)
for the fake/live eligibility rules, and the
[issue-thread UI reference](capability-issue-thread-ui.md) for the thread,
composer, and Evidence panel this surface reuses.
