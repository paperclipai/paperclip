# TSMC-18808 evidence

## Root cause (shared with TSMC-18806)

`packages/adapter-utils/src/server-utils.ts` wrote adapter-child prompts to `child.stdin` inside `spawnPersistPromise.finally()` with only a check-then-act `child.killed || stdin.destroyed` guard. `child.stdin` is a Socket; an exit between the check and the write raised unhandled `EPIPE` on the stdin stream (NOT covered by `child.on("error")`, which is the ChildProcess emitter).

## Fix commits (on live)

- `f20c93067` — server stdout/stderr EPIPE guard (necessary belt; not sufficient alone)
- `4ddcde0b7` — stdin.on("error") swallow EPIPE/ERR_STREAM_DESTROYED in server-utils + execution-target pollStdin

## Recurrence mechanism (VA1 layer: platform guard)

- Platform guard in adapter-utils + server boot (not comment-only lesson)
- Regression tests: `server/src/__tests__/run-child-process-stdin-epipe.test.ts`
- Canonical KB: `~/TSKB/KB/TSKB0354 [ALL] - Unhandled EPIPE on adapter child.stdin kills the control plane - v1.0 - 08-01.md`

## Acceptance (A) deliberate kill-child-mid-prompt-write — PASS

### Focused vitest (re-verified 2026-08-01 05:40 IST)

- Path: `server/src/__tests__/run-child-process-stdin-epipe.test.ts`
- Command: `pnpm exec vitest run --project @paperclipai/server server/src/__tests__/run-child-process-stdin-epipe.test.ts`
- Result: **2/2 passed** (29ms)
- Artifact: `work-products/TSMC-18808/vitest-stdin-epipe.20260801-0540.txt`

### Standalone 20-child SIGKILL burst (re-verified 2026-08-01 05:40 IST)

- Path: `work-products/TSMC-18808/kill-child-mid-prompt-write-repro.mjs`
- Result: `runs=20`, `epipeUncaught=0`, `stillAlive=true`, `ok=true`, elapsedMs 38
- Artifact: `work-products/TSMC-18808/kill-child-mid-prompt-write-repro.20260801-0540.txt`

## Acceptance (B) 2h zero-exit soak — PASS (2026-08-01 05:46 IST)

| Field | Value |
| --- | --- |
| Baseline exits | **218** |
| Baseline epoch | `1785552383` (board caps restore / 03:46:23 IST) |
| Check time | 2026-08-01 05:46:57 IST / epoch ~1785559617 |
| Current exits | **218** (unchanged) |
| Post-baseline exits | **0** |
| Post-baseline EPIPE lines | **0** (last EPIPE crash still `[dev-watch 02:46:17]`) |
| Elapsed | **7233s** (≥7200) |
| API health | **200** on `:3100/api/health` |
| Live server | pid **86433** `pnpm dev` up **57m+** since launchd 04:49 restart |
| Helper output | `work-products/TSMC-18808/soak-check.20260801-0547.txt` → `SOAK_PASS` |

## Board overnight note (folded)

Stability under gated watcher is consistent with the fix; RC is the child.stdin race, not the gate itself. Gate remains a useful reload-safety layer. Duplicate TSMC-18806 is cancelled/folded here.

## Close bar

Root cause identified + recurrence mechanism encoded at platform-guard layer + regression tests green + 2h soak zero unexpected exits at baseline 218.
