# Capability execution modes and identity

Capability runs the same semantic tool catalog, authorization engine, and mock
`ControlPlanePort` under two agent modes. Whichever mode is active, the
surface always names three separate actors so a reader never mistakes one for
another.

## Three actors, always separate

| Actor | What it is in Capability | What it is **not** |
| --- | --- | --- |
| **Real Codex** | A real Codex app-server session driving the turn loop. The agent has no Paperclip skill; it sees only the semantic tools the scenario exposes. | Not a scripted stand-in, and not a Paperclip-aware agent. |
| **Real runnerd** | The real package-local `paperclip-runnerd` binary. It owns the Codex child process group and proxies newline-delimited JSON-RPC over stdio. | Not an in-process fake and not the production Paperclip runtime. |
| **Mock Paperclip** | The deterministic in-process `ControlPlanePort` adapter. It holds every issue, comment, document, interaction, approval, and audit record as mock state. | Not the Paperclip control plane, database, or API. No request leaves the process for a Paperclip service. |

The live surface renders a `Real Codex`, `Real runnerd`, and `Mock Paperclip`
marker at all times. Mock records carry an `MCK-` identifier prefix so a mock
issue is never confused with a real `PAP-` issue.

## Two agent modes

### Scripted (deterministic) — fake mode

The scripted driver replays a recorded conversation over the same mock core.
It needs no provider credential, no runnerd process, and no network after
`pnpm install`. It is the mode used for:

- the 106-case conformance suite and its bounded parity report;
- the byte-stable screenshot matrix;
- replay of a recorded session.

Because it is fully deterministic, two runs of the same route produce
byte-identical output. **A scripted (`mode=fake`) artifact cannot satisfy a
live acceptance criterion** — it proves the contract, not a real provider turn.

### Codex (bounded) — live mode

Live mode starts a real `paperclip-runnerd` process and a real Codex
app-server session. The package server — never the browser — owns the Codex
process, the session, the tool loop, and provider authentication. The browser
receives no provider, runner, mock-control-plane, or real-control-plane
credential.

Live mode requires a locally authenticated Codex installation. When that relay
is not present, the UI keeps Codex disabled with a named reason and scripted
mode stays available. Live mode is the only mode eligible for the final
Revision 3/4 acceptance criteria that require a real provider turn.

## Mode-independent controls

These behave the same in either mode because they operate on the mock core and
the runner session, not on the agent:

- **Reset** restores the original clean mock seed under new run/session
  authority and rotates or clears the old session authority. It does not
  affect another browser session's state.
- **Stop** cancels only the active turn and reaps the runnerd process group;
  the session and its transcript survive. Cleanup evidence shows no abandoned
  child process and no active session afterward.
- **Replay** reproduces a recorded canonical timeline. It is always scripted
  and always labelled as fake-derived, even inside a session that also ran a
  live turn.
- **Refresh / reconnect** restores the same durable session, pending
  interaction, transcript, and mock state. Reconnect starts a fresh runnerd and
  Codex app-server and resumes the persisted provider thread; the session does
  not restart because the browser reconnected.

## Two entry points, one live mode

Live mode is reachable from both primary surfaces:

- the preset scenario explorer, with `mode=live` on a chosen scenario;
- the [clean-room chat](capability-clean-room-chat.md) at `#/chat`, which has no
  other mode. It starts blank on a freshly minted mock tenant, pins `mode=live`
  in the route, and reports a failure to start real Codex rather than falling
  back to a fixture or a recording.

## Eligibility summary

| Evidence | Eligible for |
| --- | --- |
| Scripted / `mode=fake` run | 106-case conformance, replay determinism, screenshot matrix, contract proofs |
| Live Codex run on the final build | Revision 3/4 final acceptance criteria that require a real provider turn |
| Revision 2 preview (build `da0d32d74a`, historical URL) | Historical comparison only — **not** eligible for final acceptance |

See the [live runnerd and Codex loop](capability-live-runnerd-codex.md) reference
for the session API and verification commands behind each row above.
