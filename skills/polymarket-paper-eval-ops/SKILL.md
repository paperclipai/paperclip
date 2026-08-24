---
name: polymarket-paper-evaluation-ops
description: 'ThinkStack Capital routine operation of the Polymarket live paper-trading harness and crypto paper loops. Use for "Polymarket live paper evaluation pass (THIA-31)", "Daily Polymarket --resolve calibration dataset update", "Polymarket weekly P&L report", "THIA-15/THIA-17 daily paper-trade health check", or any paper-loop crash/stall recovery. Encodes the evaluation-script exit-code contract, the THIA-31 re-anchor guard, calibration thresholds, the sample-size gate on P&L claims, and the known supervisor/CancelledError crash modes.'
---

# Polymarket Paper-Evaluation Ops

> **Standing rule (operator, 2026-08-23): paper instances are never halted/killed/unloaded by agents — no kill checks, no `enabled:false`, no bootout. Propose changes as a `rocky-paper-change` board card for Wednesday/Sunday; you may START paper cells and CORRECT crashed cells/reporting errors. Registry TSKB0441. Analysis truth = official Gamma; `n` = era n.**

ThinkStack Capital's revenue path is evidence: paper-trading evals that prove (or kill) strategies before any live USDC. The recurring work is highly scripted — the value an agent adds is running the contract exactly, reporting the right numbers, and recognizing the known failure modes fast. Domain principles (look-ahead bias, sample size, liquidity asymmetry) are in PolymarketEngineer's AGENTS.md; this skill is the operational layer.

## Hourly evaluation pass — "Polymarket live paper evaluation pass (THIA-31)"

From the project root, run `uv run python scripts/poly_paper_eval.py` and capture stdout/stderr + exit code. State DB: `data/polymarket/live_paper_state.db`; logs in `data/polymarket/`.

Exit-code contract (do not improvise):
- **0** — normal. The script re-anchors THIA-31 itself (PATCH to `in_progress`, assignee = PolymarketEngineer). Mark the execution issue done with: settled / entered counts, open positions, equity + cash, kill-switch state. One short comment — the good closes are 5 lines (see references for the canonical shape).
- **1** — kill switch fired. The script already escalated on THIA-31 and reassigned to CEO. Mark this issue done noting the kill switch; do NOT re-escalate.
- **2** — fatal error. Post the error to THIA-31, mark this issue done.

The **re-anchor guard** exists to stop recovery-scanner loops — never remove it. If THIA-31 is `in_review`/owned by board or user, the script correctly **skips** the re-anchor; say so in the close ("re-anchor skipped — board owns THIA-31") rather than forcing it.

## Daily resolve — "Daily Polymarket --resolve: calibration dataset update"

Runs `polymarket_daily_resolve.sh`. **Exit 1 with 0 resolved markets is the normal early state**, not a failure: expired markets often return `None` from Gamma until settled on-chain. Calibration only triggers at **N ≥ 30 resolved per bin**. Close with: markets checked, newly resolved, dataset totals (total / resolved / expired+pending), calibration triggered or skipped, and post full output to THIA-30.

## Weekly P&L — "Polymarket weekly P&L report (THIA-31)"

Post to THIA-31: trades opened all-time, open/closed, realized P&L vs initial capital ($150 virtual), mark-to-market on open positions, win rate **with the caveat that CI crosses zero under ~30 samples**, kill-switch state, max 7-day drawdown, backtest dataset progress. **Phase-2 (scale-up) discussion is gated on sample ≥ 30** per THIA-31 acceptance criteria — flag it explicitly while under. Known papercut: Paperclip API POSTs from report scripts need a 30s timeout (15s hit `httpx.ReadTimeout`).

## Paper-loop health checks (THIA-15 SMA / THIA-17 ETH MeanRev)

Daily check = supervisor PID alive, lock file sane, fills/bars progressing, daily report written once (not repeatedly). Known crash modes — check these before debugging fresh:

1. **CancelledError / SIGTERM interplay** (THIA-253, then THIA-1360): SIGTERM → `task.cancel()` → `CancelledError` is a `BaseException`; catching it as exit 0 made the supervisor treat a kill as a clean exit and stop. Symptom: loop down + stale lock after a tmux/session kill. Fix lineage in commits 7a5a464 → 8c40ad6. Note: `str(TimeoutError())` is empty in Python 3.12 — "REST poll failed (will retry): " with no text is a timeout.
2. **Duplicate supervisor race** (THIA-253 bug 2): a health-check heartbeat spawned a second supervisor that fought the first. Never start a supervisor without checking for the existing PID/lock.
3. **Crash-loop signature**: repeated daily-report writes + restart every ~10s = the supervisor restarting on nonzero exit; read `logs/paper-meanrev-eth/paper-trade.stderr` first.

## Watchdog friction on long-running observation issues

THIA-17 (30-day observation) repeatedly tripped `long_active_duration`. Resolution of record: set `executionPolicy.monitor.monitorNextCheckAt` on the issue (the corrected approach — THIA-247), and/or suppress the trigger for the observation window. If a watchdog blocks the loop issue despite that, restore it to `in_progress` and note the standing suppression; don't re-litigate each time.

## Hard rails (non-negotiable, from AGENTS.md + board gates)

- Paper only. No real orders, no live USDC, no wallet keys without a board approval logged on an issue.
- Numbers over narrative in every close: P&L, drawdown, hit rate, trade count, sample size.
- Secrets via `src/trading/config/secrets.py` env-var pattern only.

## References

- The bundled evidence reference file — canonical comment shapes, the THIA-17 crash-fix history, and the routine issue descriptions of record.


<!-- TOOLS-2026-06 -->
## Local tools
- Crunch price/market history fast with `duckdb` (SQL over CSV/JSON/parquet). Crypto/exchange data via `ccxt` from a workspace dependency or pre-provisioned local environment. See [[crypto-trading-ops]].
