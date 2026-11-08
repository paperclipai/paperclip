# Turn-scoped ACPX MCP authority (design, not implemented)

Status: proposal, 2026-11-07. No code until Dotta has reviewed this design and a security review is done.
Context: [`2026-11-07-warm-follow-up-ttft.md`](2026-11-07-warm-follow-up-ttft.md) (finding 4) and [`2026-11-07-ttft-baseline.md`](2026-11-07-ttft-baseline.md).

## Summary

- **Every Claude (ACPX) follow-up relaunches the Claude provider process and reloads its session.** That is 3.2–4.2 s of each follow-up's time to first token (TTFT).
- **The relaunch is a safety boundary.** The ACPX MCP endpoint lives as long as the provider process, so it cannot tell which turn sent a tool call. Reaping the process proves that no late call from an earlier turn can execute under a later turn's authority.
- **The relaunch is also a run boundary.** Each follow-up comment is a new heartbeat run. A new run brings a new Paperclip gateway token, new instruction text and new file grants, which today reach the provider only at launch.
- **Removing the relaunch needs two things:**
  - a way to bind every MCP call to the turn and run that issued it, so late calls are rejected by authentication rather than by process death;
  - a way for a live provider to adopt a new run's authority.
- **This document compares three designs.** It recommends prototyping design C: an in-process session reload with per-generation credentials. It is the smallest change that keeps a process-independent proof.
- **Expected gain:** a Claude follow-up drops from about 6.3 s to about 3–4 s TTFT p50 locally, if the in-process reload is as fast as measured below.

## Measured cost (local, current master)

Claude follow-up TTFT p50 is 6.3 s with `per_turn` (the default) and 7.1 s with `warm` (n = 6 each, load average about 9). A new task takes 11.4 s. A per-turn runner retires the old provider generation at the end of the previous run. A warm runner does it inside `run.attach`, on the follow-up's critical path, which is why warm is slower for Claude today.

Breakdown of a warm Claude follow-up, measured with temporary timing in runnerd's ACPX backend (2 samples):

| Step | Time | On the critical path |
|---|---|---|
| `run.attach`: checkpoint and shut down the old provider generation | 1.16–1.18 s | warm only |
| Start the new generation (spawn the sidecar, `session/load` without initialization) | 0.73–0.99 s | yes |
| First prompt: deferred Claude ACP initialization and session load | 2.46–2.54 s | yes (`turn.submitted` → `turn.started`) |

A per-turn follow-up pays the second and third rows. `runner.turn.submitted_to_started` is 3.16 s p50 per-turn and 2.67 s warm. The new-generation start appears as `provider.session.load` (1.2 s p50 per-turn).

## How the boundary works today

- **Tool calls.** The runner's tool bridge (`startRunnerToolBridge`) serves a runner-owned MCP endpoint (`url` + `bearerToken`, where the token is the bridge secret). Paperclip's native MCP gateway is a second runner-owned binding with its own token. Both bindings are passed to the provider in ACP `session/new` or `session/load` (`runtime-host.ts`, `mcpServers`). ACP has no request that changes MCP servers during a session.
- **Turn epochs.** `provider_bridge.rs` keeps a tombstone for every settled call ID, so a replayed call never executes twice. `prepare_turn` keeps the tombstones across turns. `prepare_turn_after_provider_restart` releases them, and it is legal only after the owning process was reaped. Codex continues in one process across turns because its tool calls carry turn and thread identity in the app-server protocol, so it only needs the tombstones (bounded at 65,536 call IDs, then a process-boundary rollover).
- **ACPX turns.** `acpx_provider_session.rs` `start_turn` calls `restart_idle_provider` whenever the session has settled turns. The comment there states the reason: "The MCP endpoint is session-lifetime and cannot authenticate which provider turn originated a late HTTP callback." A new generation starts with no settled turns, so the first turn after a relaunch does not relaunch again.
- **ACPX runs.** `acpx_provider_backend.rs` `attach_run` checkpoints the sidecar and lets the next `session.open` start a new generation. `run_attachment_policy` allows Claude to rotate registered asset paths across runs (`AuthenticatedAssetPaths`); the new text reaches the provider at launch.

## Threat model

Assets: the authority of the current turn and run. That covers its tools, its Paperclip gateway grants, its completion contract and its workspace and file grants.

| Threat | What goes wrong | How today's design stops it |
|---|---|---|
| T1. Late call from a settled turn | The provider sends a tool call after its turn ended. Examples: an in-flight HTTP request after an interrupt, a retry, or a background subagent. If it arrives during the next turn, it executes with that turn's authority and results. | The old process is reaped before the next turn, so no such call can exist. |
| T2. Replay of a completed call | A call ID that already executed is sent again. | Call-ID tombstones, kept until the owning process is reaped. |
| T3. Credential replay | A captured bearer token is used by another process or after its owner should have lost authority. | The token is per bridge instance and dies with the process. |
| T4. Cross-turn confusion | A call is attributed to the wrong turn's completion contract or receipts. | One turn per process generation. |
| T5. Cross-run confusion | A call from run N executes under run N+1's Paperclip gateway grants, instructions or file grants. | `run.attach` relaunches the provider; the gateway token is run-scoped. |
| T6. Restart replay | After a controller or runner restart, a recovered generation accepts calls meant for the previous owner. | Generation identity, lifetime fences and the restart-recovery checks. |

Any replacement must stop T1, T2, T4 and T5 without relying on process death, and must not weaken T3 or T6.

## Candidate designs

### A. Turn-scoped credentials in a live session

Mint a new bearer token per turn and revoke the previous one at the bridge.

- **Safety argument:** a late call from turn N carries turn N's revoked token and is rejected by authentication (T1, T4). Tombstones still stop T2.
- **Blocker:** ACP passes MCP servers only at `session/new` or `session/load`. A provider cannot learn a new token mid-session, so A reduces to design C.

### B. Proof that no calls are in flight

Keep the process when a turn settles cleanly, and relaunch only when the proof fails.

- **Proof conditions:** the turn ended with ACP `end_turn` (not cancel, interrupt or failure); the bridge has no pending or completed receipts; there are no runtime requests; the goal is dormant. Between turns, the bridge also rejects every call.
- **Safety argument:** stops late calls that arrive between turns. It also relies on a provider guarantee: once Claude ACP reports `end_turn`, the provider issues no further MCP calls for that turn.
- **Gap:** that guarantee is a property of the upstream provider, not something Paperclip can verify. It would have to be qualified per provider release, and every background subagent or hook feature is a regression risk. A call that arrives during the next turn is still indistinguishable (T1, T4).
- **Cross-run:** B does not address T5. Run-scoped authority still needs a relaunch, so B helps only same-run turns, which are rare: each comment is a new run.

### C. In-process session reload with per-generation credentials (recommended prototype)

Keep the Claude ACP process. At each turn or run boundary, revoke the bridge credential and reload the same provider session (`session/load` with the same session ID) in the same process. The reload carries a freshly minted bridge token, the new run's Paperclip gateway token, and the new instruction and grant text.

- **Safety argument:** every MCP binding is authenticated by a token minted for exactly one session generation (turn, plus run where it changed). The bridge revokes the previous token before the reload is acknowledged.
  - T1 and T4: a late call from an earlier generation is rejected by authentication, whatever its call ID or arrival time.
  - T2: call-ID tombstones still apply, and they can be released when the token epoch rotates, because no old-epoch call can authenticate.
  - T3: tokens remain unguessable, per-generation and runner-owned.
  - T5: the run-scoped gateway token rotates with the run.
  - T6: generation identity is persisted with the token epoch, and a recovered runner mints new tokens.
- **Required: bind the epoch at authentication and recheck it before dispatch.** The bridge authenticates the bearer before it reads the request body, and the sidecar binds a call to the active turn only after that. A request that authenticated under epoch N can therefore finish arriving after rotation to N+1. It holds no pending tool receipt while its body is in transit, so the pending-call guard cannot block the next turn. The bridge must record the epoch a request authenticated with, and reject the request if the current epoch differs after the body is read and before dispatch. It must make the same check before it binds the call to a turn. Rotation must not be acknowledged while any request authenticated under the old epoch is still being read.
- **Cost:** removes the process spawn and the old process's checkpoint and shutdown. It keeps one `session/load`. The expected saving is the generation start plus the part of the deferred initialization that is process start-up rather than session load, measured below.
- **Unknowns to settle before code:**
  1. Whether Claude ACP supports a second `session/load` on a live process with different MCP servers and instructions, and tears down the first query's MCP clients, which is required so old-epoch connections cannot persist.
  2. The latency of an in-process reload compared with a relaunch.
  3. Whether the instruction and grant text can change on reload, or only the MCP servers.

## Restart and chaos implications

- A kept-alive Claude process becomes part of warm runner state. It follows the same reattach, fence and reconnect-grace rules as Codex and OpenCode warm runners (#19879).
- Persisted state gains the token epoch and generation ID. Previous-release story (`rules/upgrade-safe-run-state.mdc`): a session saved by the current release has no token epoch. It resumes by relaunching, as today, and the first relaunch establishes epoch 1. No refusal is needed.
- Restart recovery must never reuse a revoked token. A recovered runner rotates tokens before admitting any call.
- Chaos qualification: K1, K2 and K6 waves with Claude on warm, plus a new fault, "interrupt a turn with a tool call in flight, then send a follow-up", which must show the late call rejected with an authentication error. All existing R1–R6 checks must stay green.
- Red/green test for the authentication-to-dispatch gap: start a tool request under epoch N and hold its body; rotate to N+1 and start the next turn; then release the body. The request must be rejected and must never reach a turn.

## Expected TTFT gain

If an in-process reload costs about one `session/load` (an estimated 1–1.5 s, not yet measured) instead of a relaunch (3.2–4.2 s), a warm Claude follow-up drops from about 6.3 s to about 3–4 s TTFT p50 locally. Claude would then default to warm, like Codex and OpenCode. Design B, even where its proof holds, does not help cross-run follow-ups, which are the common case.

## Next steps

1. Dotta reviews this design.
2. Security review of the threat model and of design C.
3. Spike, no product code: measure an in-process `session/load` with rotated MCP servers against Claude ACP, and confirm the first query's MCP clients are torn down.
4. Only then, an implementation plan with red/green tests for T1–T6 and the chaos wave above.
