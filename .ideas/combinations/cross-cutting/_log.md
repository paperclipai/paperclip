# Cross-Cutting Combinations — Loop Log

**Mode (per operator instruction):** on each loop fire, produce **one new, *different* combination** —
a synthesis that cuts *across* the 13 thematic clusters in `../` rather than repeating them. Each is a
novel unifying abstraction, persona, or flywheel that recombines ideas from multiple clusters into one
emergent feature.

**Loop procedure (read this first on each fire):**
1. Read this log. Count what's already in `done`.
2. Pick the next angle from `backlog` (or invent a fresh one if the backlog is exhausted).
3. **Use WebSearch when it would sharpen the idea** — to ground a combination in established industry
   practice, standards, terminology, pricing, or known techniques (e.g. FinOps/OTel for cost, SRE for
   reliability, kanban for flow). **Include academic sources** for technical/algorithmic grounding — run
   searches with `allowed_domains:["arxiv.org"]` and `allowed_domains:["scholar.google.com"]` alongside a
   general search, and cite the papers in `## Sources`. Skip search only for combinations that are purely
   internal-architecture plays.
4. Write `xcombo-NN-<slug>.md` with: combined idea, source ideas (cite numbers), why it's a *different*
   cut than the thematic combos, phasing, ratings (difficulty / est. time / importance 1–10), and
   sources if web research was used.
5. Move the angle from `backlog` to `done` here, with a one-line summary.

## Done

- **xcombo-01 — The Autonomy Dial** — one operator control that composes admission, breaker, trust
  ramp, auto-approve, and heartbeat into a single supervised→autonomous slider. Cuts across combos
  01/05/07.
- **xcombo-02 — Closed-Loop Self-Improving Company** — chains capture (040) → mine (055/046) →
  propose → test (011/032 offline, 056 online) → decide+record (060) → deploy into one compounding
  flywheel. The novelty is loop closure. Cuts across combos 06/04/11.
- **xcombo-03 — Cost-Attribution Spine** — one attribution key from span-open to billed dollar/token;
  views = OTel-GenAI tracing (031), showback unit-economics (013), cache metric (037), token budgets
  (019), cross-company chargeback (053). Grounded in OTel GenAI conventions + FinOps showback→chargeback.
  Cuts across combos 03/04/13. *(web-researched)*
- **xcombo-04 — Trust as Universal Currency** — one continuous, behavior-updated trust score per agent
  identity that every gate reads (egress 022, secret leases 021, auto-approve 016, assignment 025,
  per-run caps 024), driven by probation/ramp (009). Grounded in 2026 zero-trust-for-agents (continuous
  authorization). Cuts across combos 07/08/05/01. *(web-researched)*
- **xcombo-05 — The Night-Shift Operator** — an armed "unattended-hours" profile bundling spend bounds
  (005/002/024), local-first resilience (008/012), idle backoff (035), egress lock (022), human coverage
  (038/057), and a morning digest (029); surfaces a new requirement: mid-run credential renewal (021/049).
  Grounded in 2026 overnight-agent incidents. Cuts across combos 01/02/05/08/09. *(web-researched)*

- **(user-directed) Code-Knowledge Flywheel** — llm-wiki (060) stores reusable snippets, an architecture
  graph (hybrid vector + call/dependency graph), and canonical specs to power software-building (065);
  for self-hosting, every rung built enriches the system's model of itself so the bootstrap compounds.
  Grounded in 2026 hybrid code-retrieval / persistent-codebase-memory practice. File:
  `xcombo-code-knowledge-flywheel.md`. *(web-researched)*

- **xcombo-06 — Provenance & Replay** — the *auditability* layer (vs combo 03 observability): a Decision
  Provenance Record (inputs+model+prompt+policy+trace+diff+cost, hash-chained into 023) to reconstruct
  any decision, plus fork-restore (015) + deterministic `planOnly` re-run to reproduce or counterfactually
  test it. Grounded in EU AI Act Art. 12 (Aug 2 2026) + R-LAM replay. Cuts 08/03/09/05. *(web-researched)*

- **xcombo-07 — The Self-Healing Org** — applies the SRE self-healing loop (detect→diagnose→remediate→
  verify) to *staffing & structure*: reliability SLOs (044) detect, diagnose agent/role/structure fault,
  remediate via constrain/reassign (009/025), auto-backfill posting (048), reorg (052), or incident (057),
  then verify recovery. Human = reliability architect. Grounded in 2026 agentic-SRE (80% MTTR). Cuts
  07/09/03. *(web-researched)*

- **xcombo-08 — Capital Allocator** — the portfolio as a multi-armed bandit: arms = agents/issues/
  companies, reward = ROI (030/013/cross-cut 03), forecast prior (063), UCB/Thompson explore-vs-exploit
  with knapsack + fairness-floor constraints, budget pooling, executed via holding capital moves (007).
  Grounded in arXiv bandit/portfolio literature. Cuts 04/13. *(web-researched, arXiv)*

- **xcombo-09 — The Front Desk** — autonomous intake→resolution pipeline: intake (062) → triage/score
  (016) → retrieve context (combo 11) → capability/UCB-skill assign + template/DoD (025/058) → respond
  (036); three modes (resolve/triage/assist) on a confidence dial. Grounded in arXiv ticket-routing +
  2026 support metrics (≈$1/resolution, 50–70% deflection). Cuts 12/07/10/05. *(web-researched, arXiv+Scholar)*

- **xcombo-10 — Pre-Flight Everything** — generalize idea 004's `planOnly`/dry-run into ONE
  `simulate(change)→ImpactReport` seam every consequential action implements (launch 004, reorg 052,
  policy 043, import 064, restore 015, config 011, capital xcombo-08, cross-company 13), with a
  shadow→dry-run→auto-commit graduation ladder (cross-cut 01). Grounded in arXiv digital-twin/CIA +
  2026 shadow-mode rollout. Cuts 10/07/08/09. *(web-researched, arXiv+Scholar)*

## Backlog (candidate different cuts — each loop takes one)

> Original 10-item backlog is exhausted. Fresh angles below draw on newer material: idea 065
> (software-building/self-hosting), the Aisha multi-agent direction, the skeleton reference, and
> still-uncombined source ideas. Each loop takes the next; invent more when these run out.

## (done, continued)
- **xcombo-11 — Bootstrap Ladder (Kernel→Org)** — a governed capability *curriculum* climbing from the
  5-table skeleton: each rung is build→verify (011/xcombo-10/human gate)→ratchet, raising capability
  (Flywheel self-model) AND earned autonomy (cross-cut 01) *together* so autonomy never outruns proven
  verification. Grounded in arXiv Darwin/Huxley-Gödel + automatic-curriculum-learning + earned-autonomy
  (with statistical-limits caveat). Cuts 065/combo11/cross-cut01/combo06. *(web-researched, arXiv+Scholar)*
- **xcombo-12 — Conversational Operator (Aisha bridge)**: board-chat + mobile push (027) + digest (029)
  + voice approvals (016/017) as ONE conversational control surface; the Aisha-as-chief front end over
  Paperclip via MCP. Scenario cut tying PAPERCLIP_INTEGRATION.md. (cuts 05/12)
- **xcombo-13 — The Reproducible Run**: session continuity (028 handoff, continuation summaries) +
  cache-stable context (037) + deterministic replay (xcombo-06) + captured dataset (040) → runs that
  resume, reproduce, and resist drift. (cuts 03/06/11)
- **xcombo-14 — The Marketplace/Ecosystem**: blueprint library (018) + signed community sharing +
  shared services (053) + skills/teams catalogs + skill-effectiveness (046) → a trust-gated exchange of
  orgs, agents, skills, and services. (cuts 10/13/06)
- **xcombo-15 — Closed-Loop Run Efficiency**: tracing (031) + adaptive heartbeat (035) + diminishing-
  returns (003) + per-run caps (024) → a real-time control loop that tunes *how* runs execute for
  cost/throughput, not just whether they start. (cuts 03/01)
