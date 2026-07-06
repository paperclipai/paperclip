# Cross-Cut 03 — The Cost-Attribution Spine

**A different cut:** the thematic combos treat tracing (combo 03) and economics (combo 04) as separate
stacks. This one threads a single **attribution key** through *every* run from the moment a span opens
to the moment a dollar (or token) is billed to an owner — so cost is a first-class dimension of every
record, not a report assembled after the fact. It deliberately aligns Paperclip with the emerging
industry standards for AI cost observability rather than inventing a private model.

**Synthesizes:** 031 Agent-Run Distributed Tracing · 013 Unit-Economics Dashboard ·
037 Prompt-Cache Optimization · 019 Token-Denominated Budgets · 053 Inter-Company Chargeback
*(pulls from thematic combos 03, 04, 13)*

## Industry grounding (from web research, June 2026)

- **There is now a standard to align to.** The OpenTelemetry **GenAI semantic conventions** define a
  `gen_ai` span namespace with `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` and
  model/provider attributes — explicitly created to end fragmentation and make AI cost/quality
  "measurable, comparable, and interoperable across frameworks and vendors." Paperclip's run spans
  (idea 031) should *emit these names*, so spend flows into any standard backend (Datadog, Uptrace,
  Honeycomb) for free instead of a proprietary schema.
- **FinOps has a maturity ladder: showback → chargeback.** *Showback* = teams see what they'd be
  charged (visibility, no money moves); *chargeback* = the cost actually transfers to the owner's
  budget. Showback is the documented starting point; chargeback needs internal billing agreements —
  exactly the phasing for Paperclip's cross-company chargeback (idea 053).
- **Five dimensions cover ~95% of attribution:** team · project · environment · model-name ·
  cost-center. Mapped to Paperclip: **agent/role/team · goal-subtree · adapter+model · company
  (cost-center)**.
- **The decision-useful metrics are standardized** ("TokenOps"/unit economics): cost per request, **cost
  per successful outcome**, tokens per active user, and **token cost as % of feature revenue** — which
  is precisely idea 013's "cost per shipped outcome," now with an industry name and peer set.
- **GPU spend is the #1 FinOps concern of 2026**, surpassing general cloud cost — validating idea 041's
  host-resource focus and the local-model economics of combo 02.

## The unified idea

Define one **attribution key** `{ company, goal-subtree, agent/role, adapter+model, runId }` stamped on
every span the moment a run starts, and carried through to every `cost_event`. Then the five ideas
become *views over one spine* instead of five disconnected features:

- **Emit OTel-GenAI spans (031)** with token usage + the attribution key as span attributes → standard,
  exportable, vendor-neutral.
- **Showback dashboard (013)** rolls those spans up into cost-per-outcome, rework ratio, and idle spend
  along every attribution axis — the FinOps unit-economics view, by construction.
- **Token budgets (019)** enforce on the *token* attributes of the same spans (the real constraint for
  subscription/GPU users), aligned to provider rate-limit windows.
- **Cache efficiency (037)** is just a derived attribute of the spine (`cached/total input tokens`),
  surfaced as savings — the clearest cost lever, made visible because it's on the same record.
- **Chargeback (053)** is the spine extended across the company boundary: a shared-service run carries
  the *requesting* company's attribution key, so cost transfers to the right cost-center — the
  chargeback rung above showback.

## Why this is a *better* idea than the parts

Attribution-after-the-fact is the thing every FinOps-for-AI write-up warns breaks down with agents:
you can't allocate what you didn't tag at the source. Stamping one key at span-open and never losing it
makes *every* downstream economic feature trivially correct and consistent — and aligning to the OTel
GenAI + FinOps standards means Paperclip's cost story is interoperable and credible to finance teams
out of the box, not a bespoke island. The spine is the asset; the five features are projections of it.

## Phasing

1. Define the attribution key + emit OTel-GenAI-conventioned spans carrying it (031).
2. Showback: unit-economics dashboard over the spine (013) + cache-efficiency derived metric (037).
3. Token-denominated budgets enforced on span token attributes (019).
4. Chargeback: extend the key across the cross-company seam (053, after combo 13's bridge exists).

## Ratings

- **Difficulty:** Medium — mostly disciplined instrumentation + read-models over existing data; the care
  is in *never dropping the key* across handoffs/sub-runs/adapter boundaries and matching OTel attribute
  names exactly. Chargeback (step 4) inherits combo 13's cross-company complexity.
- **Estimated time to complete:** ~3–5 engineer-weeks for showback (steps 1–3); chargeback adds ~2 atop combo 13.
- **Importance:** 8/10 — cost attribution is the backbone the entire CFO suite, token-safety, and
  capital-allocation stories stand on, and standards-alignment makes it credible to real finance owners.

## Sources

- [OpenTelemetry GenAI Semantic Conventions (DEV)](https://dev.to/x4nent/opentelemetry-genai-semantic-conventions-the-standard-for-llm-observability-1o2a)
- [Semantic conventions for generative AI spans — OpenTelemetry](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/)
- [LLM Cost Monitoring with OpenTelemetry — Uptrace](https://uptrace.dev/blog/llm-cost-monitoring)
- [FinOps for AI Overview — FinOps Foundation](https://www.finops.org/wg/finops-for-ai-overview/)
- [13 Best LLM Cost Allocation Tools for 2026 — Amnic](https://amnic.com/blogs/llm-cost-allocation-tools)
- [Token Economics and TokenOps — Finout](https://www.finout.io/blog/token-economics-and-tokenops-the-definitive-guide-to-finops-for-tokens)
- [GPU Cloud FinOps for AI Teams — Spheron](https://www.spheron.network/blog/gpu-cloud-finops-ai-teams-cost-allocation-chargeback-budgeting/)
