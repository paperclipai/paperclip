# Execution realism gates for seed micro experiments

Date: 2026-06-20
Issue: MIC-61
Owner: Execution Quality Pod
Company: c0af1e45-87d5-458f-93d0-996582bcf7b0
Agent: 85070e92-a33a-422d-a98b-d7d6cec24f9c
Mode: planning/read-only only

## Scope and safety boundary

This document defines the execution-quality acceptance gates that must be satisfied before any CPS, backtest, shadow, paper/demo, or promotion result for the two current seed micro experiments can be trusted.

No experiment was launched for this work. No CPS run, Vast/paid compute, paid data/API call, broker call, credential check, order simulation, paper/live order, promotion approval, or external claim was performed.

Canonical registry inputs inspected:

- Registry overview: `GET /api/companies/c0af1e45-87d5-458f-93d0-996582bcf7b0/micro-registry`
- FX experiment: `MEXP-FX-6E-EURUSD-LEADLAG-001`, experiment id `06d93b08-911a-4b90-ab8b-7b9109046477`, execution-quality dependency id `8179225b-a5aa-4a7a-b1c2-21c25f6df7bf`
- Paper reversal experiment: `MEXP-PAPER-INTRADAY-REVERSAL-001`, experiment id `8bb4c3da-e9c2-478f-bd0b-5d12b6b71b84`, execution-quality dependency id `a13216ed-f3f4-4e13-98b2-44c472835911`
- Preregistration refs:
  - `/root/cli/micro-addon/research-loop/PREREG-MEXP-FX-6E-EURUSD-LEADLAG-001-2026-06-20.md`
  - `/root/cli/micro-addon/research-loop/PREREG-MEXP-PAPER-INTRADAY-REVERSAL-001-2026-06-20.md`

Program constraints inherited from `/root/cli/micro-addon/research-loop/KILL-LIST.md`, `LEDGER.md`, and `PROTOCOL.md`:

- Hyperliquid liquid-major directional trading, conviction tails, wider-spread HL majors, maker-rebate rescue, SOL residualization, and HL wide-spread memecoin maker capture are killed and must not be reopened.
- Any GO is not permission to trade. It only triggers a mandatory fusion(opus4.8-gpt5.5) adversarial review and a new operator-approved preregistration.
- Capacity, toxicity, and execution realism are gates, not footnotes.

## Global execution-quality gate

A seed result is not verdict-grade unless the evidence pack explicitly answers all of the following with file paths, commands, timestamps, and immutable artifacts:

1. Venue and instrument: exact venue/sample, instrument identifiers, trading calendar, session mask, and timezone policy are frozen before measurement.
2. No overnight exposure: every evaluated decision has a deterministic same-session forced flat/exit time. Any position or shadow stance whose entry plus maximum horizon crosses the session close, market halt, holiday close, rollover exclusion, or weekend boundary is excluded or forces INCONCLUSIVE if not handled fail-closed.
3. Quote availability: every feature uses only quotes/trades timestamped `<= decision_time`. Forward quotes may be used only as labels/exit-price diagnostics, never as features.
4. Spread model: measured spread distribution is reported for each venue/instrument/session, including median, p90, p99, max, and missing/spurious quote counts.
5. Cost model: the named cost hurdle is frozen before evaluation and applied as a round-turn hurdle in bps. Placeholder or unverifiable costs cannot support an economic GO.
6. Slippage/fill realism: quote-only or bar-only shadow metrics must be labeled `shadow_only_not_fill_grade`. They may support a measurement/readiness GO but cannot support a paper/live trading claim without a separately preregistered execution comparator.
7. Toxicity/adverse selection: post-decision adverse move is measured at the same horizon(s) used for the signal. If adverse selection consumes the predicted edge, the result is KILL or PARTIAL even when raw direction is positive.
8. Capacity: report max theoretical turnover, average notional per decision if available, and a hard `capacity_unknown` flag when not available. `capacity_unknown` blocks promotion.
9. Stability: performance must be split by session/day and cannot be driven by a single session unless the prereg explicitly defines an event-study lane.
10. Artifact integrity: evidence pack includes exact commands, code refs/git hash or diff, raw output paths, and a statement that no forbidden action occurred.

Global failure criteria:

- Any use of future data as a feature: KILL for that run and invalidate artifacts.
- Any unapproved CPS/Vast/paid API/broker/order path: INCONCLUSIVE at minimum; do not trust result for promotion.
- Any missing cost/spread diagnostics: INCONCLUSIVE for economic claims.
- Any overnight leakage or unmanaged session-close crossing: INCONCLUSIVE or KILL if it changes sign of the result.
- Any result that only clears before costs or before toxicity/adverse-selection accounting: not GO.

## Gate A — MEXP-FX-6E-EURUSD-LEADLAG-001

Purpose: cross-venue/cross-asset shadow measurement of whether fresh CME/IBKR 6E BBO features improve IC Markets EURUSD short-horizon prediction enough to clear a frozen EURUSD cost hurdle. This gate does not authorize orders or broker interaction.

### Required before any trusted shadow result

Data/session acceptance:

- At least 3 London/NY overlap sessions with `13:00 <= UTC < 16:00`.
- At least 800 OOS label events per evaluated horizon after masks; GO requires >=1,000 fired OOS shadow decisions at the 1.0 bps primary cost cell.
- At least 80% of decision-grid points in each ready session have last-quote age <=2s for IBKR 6E, IBKR EURUSD, and IC Markets EURUSD.
- Exclude weekends, holidays, known rollover/illiquid windows, and any decision whose horizon would cross the overlap window/session boundary unless a same-session forced exit is already specified.

Spread/cost acceptance:

- Primary cost model: `IC_MARKETS_RAW_EURUSD` at 1.0 bps round-turn, with frozen grid 0.8 / 1.0 / 1.5 bps.
- Evidence must report IC Markets EURUSD measured BBO spread distribution by session and horizon decision grid.
- A GO-like result must remain positive at the 1.0 bps primary cell; positivity only at 0.8 bps is PARTIAL at best.
- The 1.5 bps stress cell is not required for GO but must be reported; if it is sharply negative, the risk memo must state that cost fragility blocks any promotion claim.

Slippage/fill realism acceptance:

- Current seed is quote-only shadow. It cannot claim actual fill quality.
- Shadow stance may fire only when predicted absolute move exceeds the evaluated round-turn cost hurdle.
- Later paper/demo execution comparator, if proposed, must be separately preregistered with these minimum fill metrics: quote-at-decision, submitted side, accepted/rejected status, fill timestamp, fill price, markout at 30s/60s, effective spread paid, slippage versus decision mid, cancel/reject rate, and order-to-fill latency.
- Until such comparator exists, every result must carry `fill_grade=false` and `shadow_only_not_fill_grade=true`.

Toxicity/adverse-selection acceptance:

- Report markout/adverse selection for fired shadow decisions at 30s and 60s from decision mid to label mid.
- GO is blocked if average adverse selection exceeds the gross predicted edge or if improvement versus EURUSD quote-only baseline is < +0.3 bps/trade at the 1.0 bps cell.
- Apparent lift confined to one session is KILL under the preregistered rule.

Daytrading/no-overnight acceptance:

- `overnightAllowed=false` is binding.
- Valid decisions must be intraday only and inside the frozen London/NY overlap mask.
- Any feature/label whose timestamp crosses a weekend, holiday, session close, or maintenance gap is excluded; if exclusion is not implemented in the harness, result is INCONCLUSIVE.

Verdict trust rule:

- A shadow GO is trusted only if the preregistered FX decision rule, the global execution-quality gate, and this FX gate all pass.
- A trusted shadow GO still only authorizes mandatory fusion(opus4.8-gpt5.5) adversarial review and a new operator-approved preregistration; it does not authorize CPS/Vast/broker/order/promotion action.

## Gate B — MEXP-PAPER-INTRADAY-REVERSAL-001

Purpose: paper-faithful or approved-adaptation measurement of intraday short-term reversal as execution-timing / monitoring evidence. The current preregistration explicitly says the repo lacks point-in-time NYSE cross-section data and a verified liquid-equity cost model; therefore the current authorized stage is readiness/evidence planning only.

### Required before any trusted readiness result

Data/session acceptance:

- Freeze a paper-faithful NYSE common-stock universe or a clearly labeled approved adaptation universe before measurement.
- At least 60 regular sessions.
- At least 95% of expected 13 half-hour intervals present per usable session.
- Malformed or non-monotone timestamps <=0.1%.
- Corporate-action, symbol mapping, holiday, DST, early close, and `America/New_York` session policy frozen before feature construction.
- No paid/authenticated TAQ, broker, vendor, X/Twitter, or external data may be pulled without explicit operator approval.

Spread/cost acceptance:

- Any economic execution-timing claim requires bid/ask or spread proxy coverage for >=90% of usable symbol-session-intervals.
- Placeholder cost models, including a conservative placeholder ETF model, cannot support GO for economic claims.
- If spread/cost fields are missing but raw reversal is measurable, the only possible outcome is PARTIAL monitoring-only or INCONCLUSIVE, never economic GO.

Slippage/fill realism acceptance:

- Half-hour bars, midpoint returns, or close-to-close returns are not fills.
- Any later execution-timing comparator must separately freeze order type, side, entry/exit timestamps, bid/ask choice, effective spread paid, partial-fill policy, shorting/borrow constraints where relevant, and same-day flat policy.
- Without quote/fill evidence, outputs must be labeled `monitoring_only_not_fill_grade=true`.

Toxicity/bid-ask-bounce acceptance:

- The measurement must separate raw reversal from bid-ask bounce / effective-spread contribution, because the source paper explicitly names bid-ask bounce as part of the mechanism.
- GO for monitoring/execution-timing evidence requires next-interval reversal coefficient negative with bootstrap 95% CI upper bound <0, absolute median next-interval reversal >=0.5x measured effective half-spread, and persistence after excluding open and close intervals.
- If raw reversal disappears after spread/bid-ask adjustment, verdict is PARTIAL as a bid-ask-bounce monitoring artifact, not an execution edge.

Daytrading/no-overnight acceptance:

- Only regular-session intraday intervals are valid.
- Overnight open-close moves, after-hours bars, and cross-session labels are excluded.
- Any adaptation to futures/ETF instruments must still force flat by the relevant regular-session close unless separately preregistered.

Verdict trust rule:

- The current state can at most GO to a measurement proposal after readiness clears; it cannot GO to trading or promotion.
- A future Stage C measurement result is trusted only if the preregistered paper-reversal decision rule, the global execution-quality gate, and this paper-reversal gate all pass.

## Registry follow-up recommendation

Create or update evidence-pack records to include this document as an execution-quality gate artifact for both seed experiments. Mark the two execution-quality dependency requests as resolved only after the board accepts this artifact:

- `8179225b-a5aa-4a7a-b1c2-21c25f6df7bf` — FX execution realism gate.
- `a13216ed-f3f4-4e13-98b2-44c472835911` — paper reversal execution realism gate.

Do not advance either experiment beyond draft/planning until data-readiness, CPS run-plan, CRO risk, and evidence-archival gates are also cleared.

## Verification performed for this artifact

Read-only inputs verified during this heartbeat:

- Paperclip issue `MIC-61` via `GET /api/issues/MIC-61`.
- Micro registry overview via localhost `curl`.
- Paperclip guidance: `/root/paperclip/AGENTS.md`.
- Registry plan and communication map: `/root/paperclip/doc/plans/2026-06-20-micro-pod-experiment-registry.md`, `/root/paperclip/doc/plans/2026-06-20-micro-agent-communication-map.md`.
- Micro research controls: `/root/cli/micro-addon/research-loop/KILL-LIST.md`, `LEDGER.md`, `PROTOCOL.md`.
- Seed preregistrations named above.
