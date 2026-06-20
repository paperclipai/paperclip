# micro.fincli.ai agent communication and assignment map

Date: 2026-06-20
Scope: Paperclip / board.fincli.ai CEO control room and micro experiment registry.
Safety mode: read-only planning and evidence-gated assignment. No Vast launch, broker action, paid API, order simulation, live trading, or promotion is authorized by this map.

## Core loop

1. Micro Research Director
   - Owns source intake and experiment routing.
   - Converts papers/social/public information into bounded registry experiments.
   - Assigns only preregistration, data-readiness, execution-quality, CPS-plan, and evidence tasks until gates clear.
   - Talks to: research pods, Evidence Archivist, Market Data Steward, CPS Strategy Search Pod, CRO Risk Gatekeeper.

2. Research/alpha pods
   - Academic Paper Replication Pod: paper replication hypotheses and preregistration.
   - FX Lead-Lag Pod: FX / futures lead-lag hypotheses and preregistration.
   - CME Futures Intraday Pod: CME daytrading candidates.
   - Crypto Microstructure Pod: crypto intraday/scalping candidates.
   - Prediction Market Microstructure Pod: prediction-market microstructure/benchmark-health candidates.
   - Social Event Alpha Pod: X/Reddit/news/public-event candidates.
   - Talks to: Micro Research Director, Market Data Steward, Evidence Archivist, CPS Strategy Search Pod.

3. Market Data Steward
   - Confirms whether required data exists, is fresh, and is legally/operationally accessible.
   - Produces data-readiness notes before CPS Strategy Search Pod receives execution permission.
   - Talks to: research pods, CPS Compute Orchestrator, Evidence Archivist.

4. Execution Quality Pod
   - Defines spread/slippage/fill realism gates before any backtest/shadow/paper verdict can be trusted.
   - Talks to: research pods, CPS Strategy Search Pod, CRO Risk Gatekeeper.

5. CPS Strategy Search Pod
   - Converts approved preregistration + data-readiness + execution-quality gates into CPS run plans.
   - Must not execute CPS, launch Vast, or spend without explicit approval.
   - Talks to: CPS Compute Orchestrator, Market Data Steward, Execution Quality Pod, Evidence Archivist.

6. CPS Compute Orchestrator
   - Owns local/Vast compute routing and worker state.
   - Can monitor and plan. Cannot launch paid Vast without human approval.
   - Talks to: Local Worker SRE, Vast GPU Manager, CPS Strategy Search Pod, CEO Operator.

7. Evidence Archivist
   - Owns evidence pack schema, artifact traceability, and verdict package structure.
   - Receives outputs from all pods and gates.
   - Talks to: Micro Research Director, Execution Quality Pod, CRO Risk Gatekeeper, Broker Integration Manager.

8. CRO Risk Gatekeeper
   - Defines kill/revise/promote gates and blocks overfit/unsafe promotion.
   - Talks to: Evidence Archivist, Execution Quality Pod, Broker Integration Manager, CEO Operator.

9. Broker Integration Manager
   - Owns broker-paper intake contract only after CRO/CEO gate.
   - Keep automation paused. Planning-only tasks are allowed; credential/broker actions require approval.
   - Talks to: CRO Risk Gatekeeper, Evidence Archivist, MetaTrader Productization Pod, CEO Operator.

10. MetaTrader Productization Pod
    - Packages validated Forex candidates toward MT4/MT5 feasibility only after evidence and risk gates.
    - Does not create alpha or make performance claims.
    - Talks to: FX Lead-Lag Pod, Broker Integration Manager, CRO Risk Gatekeeper.

11. CEO Operator
    - Router/escalator only.
    - Should not implement code or run experiments.
    - Receives blockers, promotion candidates, budget/spend asks, and external-action asks.

## Current seed experiments

- `MEXP-FX-6E-EURUSD-LEADLAG-001`
  - Lead pod: FX Lead-Lag Pod.
  - Required next contacts: Market Data Steward, Execution Quality Pod, Evidence Archivist, CPS Strategy Search Pod.
  - Later contacts: CRO Risk Gatekeeper, Broker Integration Manager, MetaTrader Productization Pod.

- `MEXP-PAPER-INTRADAY-REVERSAL-001`
  - Lead pod: Academic Paper Replication Pod.
  - Required next contacts: Market Data Steward, Execution Quality Pod, Evidence Archivist, CPS Strategy Search Pod.
  - Later contacts: CRO Risk Gatekeeper.

## Assignment policy

- Use Paperclip issues as the communication medium.
- Link every execution-stage task to a registry experiment or dependency request when possible.
- First wave can be one-shot bounded tasks; do not enable per-pod heartbeats yet.
- Close resolved preregistration dependency requests once prereg docs/evidence packs exist.
- Create new dependency requests for data readiness, execution quality, CPS run planning, and risk gate review.

## Forbidden until explicit approval

- Vast launch/resize/paid compute.
- Broker credential checks or broker API calls.
- Paper/live orders.
- Promotion request approval.
- External publication or performance claims.
