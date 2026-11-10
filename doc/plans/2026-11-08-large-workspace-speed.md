# Speed with a paperclip-sized workspace

Status: measured 2026-11-08. Follows [`2026-11-07-warm-follow-up-ttft.md`](2026-11-07-warm-follow-up-ttft.md).

## Summary

- **Locally, follow-ups are fast and first turns are not.** A first turn takes 31–34 s to first token in a fresh paperclip clone, mostly the repository's own `provision-worktree.sh` (about 20 s). Follow-ups take 7 s.
- **On Daytona, every follow-up turn re-uploaded the whole workspace.** With a default environment a follow-up took 30 s, because each turn got a new sandbox and synced the repository into it again (13–22 s), then started a new runner (8–9 s).
- **A reusable warm sandbox removes that wait.** The same follow-up takes 8.1 s (Codex) and 10.3 s (Claude). An agent that never chose a lifecycle, in an environment that inherits it, now runs Codex, OpenCode and Claude warm on a sandbox.
- **The wait was invisible in the run log.** It sat inside one opaque `heartbeat.prepare_after_environment` span. Named preparation phases are now run-log spans too.

## Method

- Driver: [`tests/restart-chaos/ttft-baseline.ts`](../../tests/restart-chaos/ttft-baseline.ts).
  - `--workspace-repo` gives a fresh clone of paperclipai/paperclip at origin/master (14.8k files, 484 MB, no `node_modules`) as the project's primary workspace, with git_worktree isolation. The repository's `scripts/provision-worktree.sh` runs automatically, as for a real user.
  - The `postfault` phase is the first follow-up after an idle K1 restart.
  - `--env daytona` (and `--daytona-warm` for the reusable warm fixture) uses the signed Runner image built from master c8822ffd4b.
- One sample per cell, Codex and Claude. The figures are comment-to-first-token (`task.time_to_first_token`) from the run log only.
- Every Daytona sandbox the runs created was cleaned up.

## Results (time to first token)

| | Local | Daytona, per-turn sandbox | Daytona, warm reusable sandbox |
|---|---|---|---|
| First turn | 31–34 s | 58–63 s | 45–51 s |
| Follow-up | 7 s | 30 s | 8.1 s (Codex), 10.3 s (Claude) |
| Follow-up after an idle K1 | 6.8–8.2 s | 38–46 s | 20.8 s (Claude) |

## Where a remote follow-up spent its time (Codex, per-turn sandbox)

| Step | Time |
|---|---|
| `workspace_sync.transfer`: the whole workspace into the new sandbox | 13.3 s |
| `runner.session.resume`: a new runner for the turn | 8–9 s |
| Environment acquire, workspace binding, instructions | about 4 s |
| `workspace_finalize` after the turn (copyback; not before the first token) | 8–10 s |

Run-log reuse records show `environment: fresh/created` on every follow-up.

## Largest waits, ranked

1. **A full workspace upload on every remote turn** (13–22 s). Fixed: warm keeps the sandbox, and the workspace is adopted after a stamp check.
2. **A new runner on every remote turn** (8–9 s). Fixed by the same change.
3. **First-turn provision on a large repository** (about 20 s locally). The repository's own script; next step: a pre-provisioned worktree pool keyed by base commit and lockfile hash.
4. **Copyback after each remote turn** (8–10 s). It is after the reply, not before the first token.
5. **First-turn seed build** (git clone and pack 4.5 s, seed verify and publish 3.7 s).

## The default change

- **Scope.** A sandbox environment that inherits the lifecycle (`runnerLifecycleMode` unset), and an agent with no stored lifecycle. Covers Codex and OpenCode, as locally, plus Claude: on a sandbox the upload, not the provider relaunch, dominates its follow-up.
- **Gate.** One rule (`defaultsRemoteSandboxRunToWarm`) decides it for both the lease and the runner. It applies only when the sandbox provider keeps reusable leases (Daytona does; E2B, Modal and the built-in `fake` provider do not), and with a managed AI account only when that harness supports a managed warm session (Codex). Otherwise the run is per-turn, exactly as before. The lease side asks the provider before acquisition; the runner side reads the acquired lease, so a default never produces a refused warm run.
- **Mechanics.** Warm on a sandbox turns on `reuseLease` for the run. The follow-up keeps the live sandbox and runner and adopts the workspace.
- **What does not change.** Explicit choices, environments that pin a lifecycle, plugin-task environments and admitted sessions keep their policy.
- **Cost.** An idle sandbox stays up for the warm idle window (the agent's `idleTimeoutMs`, 5 minutes by default). After that the controller suspends the runner, and the provider auto-stop follows the same window.

## Gaps

- One sample per cell on a shared host. Daytona's warm path still needs a K1, K2 and K6 chaos wave before the default ships widely.
- In the warm run, the Codex post-restart sample finished but produced no report row.
