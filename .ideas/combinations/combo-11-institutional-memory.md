# Combo 11 — Institutional Memory & Continuous Learning

**Combines:** 060 Knowledge System (Accumulation, Curation & Retrieval) · 028 Agent Shift-Handoff
Briefings · 056 Business Experiment Framework · (folds in the learnings from 055 calibration &
057 postmortems)

## The unified idea

An autonomous company that can't remember what it learned re-solves solved problems forever. Three
ideas combine into one **institutional-memory loop**: the company *accumulates* knowledge, *passes it
along* as work moves, and *generates new validated learnings* through experiments — all flowing into
one curated, retrievable source of truth.

- **The knowledge backbone (060).** A first-class, default-on knowledge capability (contract-in-core,
  LLM-wiki as the default bundled provider) with three layers: an **engine** that accumulates and
  curates (with a real `wiki-lint` curation gate and an autoresearch librarian agent), an **authority
  model** of scoped canonical docs (org / company / team tiers, inheritance, canonical designation,
  auto-injected into agent run context — kept cache-friendly per combo 04/idea 037), and **semantic
  retrieval** (local embeddings → pgvector in the existing Postgres, hybrid with the current trigram
  search, exposed as an agent tool: "has this been done before?").
- **Warm handoffs (028).** When work changes hands (reassignment, escalation, review handoff), auto-
  generate a structured briefing — what's done, what's left, what was tried and failed, open
  decisions, gotchas — so the receiving agent starts warm instead of re-deriving everything. This is
  retrieval (060) applied to one issue's history, generated cheaply on a local model.
- **The learning engine (056).** A business-experiment object `{ hypothesis, variants, primaryMetric,
  guardrails, result }` whose variants are real tagged work, scored against actual revenue/outcome
  data (combo 04). At close it records a **validated learning** into the knowledge base — turning
  "agents doing stuff" into "a company that gets smarter run over run."

The connective insight: the knowledge base (060) is the *destination* for everything the company
learns — experiment results (056), incident postmortems (057), estimate-calibration findings (055),
and the prior-art that powers handoff briefings (028). One curated ledger, cited by id, shared by
agents and humans, portable with company exports (combo 10).

## Why combining wins

Handoff briefings (028) are a thin special case of semantic retrieval (060) over one issue; the
experiment framework (056) and postmortems/calibration are the *write* side of the same knowledge
base that retrieval (060) reads. Build the knowledge contract + retrieval once, and handoffs and the
learnings ledger become consumers rather than separate stores — avoiding the classic failure of three
parallel, drifting "where the company keeps what it knows" systems. The autoresearch curator keeps it
all from rotting.

## Phasing

1. Knowledge Layer 2 — three-tier canonical docs + context injection (060) — highest value, lowest risk.
2. Shift-handoff briefings (028) on the same retrieval/summarization substrate.
3. Knowledge Layer 3 — local embeddings + pgvector + hybrid retrieval tool (060).
4. Business experiment framework + validated-learnings ledger (056), wired to postmortems (057) and
   calibration (055); Layer 1 engine-to-core promotion + autoresearch curation.

## Ratings

- **Difficulty:** High — promoting a plugin engine into a core contract means a conscious `SPEC.md`
  "thin core" amendment and a delicate data migration of existing wiki spaces; semantic retrieval adds
  embedding freshness/cost and ranking-quality concerns; experiment scoring needs statistical rigor
  (attribution, sample size) and is gated on revenue data (combo 04).
- **Estimated time to complete:** ~7–10 engineer-weeks (phased; canonical docs alone ~3 weeks).
- **Importance:** 7/10 — compounding long-term value (a company that learns and stops repeating
  mistakes), but it pays off over time and depends on revenue/outcome data being in place first.
