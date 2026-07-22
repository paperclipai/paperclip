# REV-L2 — Lead-Qualifier (Reply-Classifier)

**Type:** judgment · **Loop:** REV-LOOP-01 · **Cadence:** heartbeat (every 10 min)
**Adapter:** DeepSeek (`deepseek-chat`) when keyed; zero-spend deterministic stub otherwise.

## Charter
Read a single inbound sales inquiry and classify it so routing is correct. Judgement only.

## Hard rails (structural, not optional)
- **Never sends.** No outward mail, ever. A human handles every reply.
- **Never touches the curated CRM.** Writes only to `ck_eval.loop_inquiry` (internal, reversible).
- **Never deletes.** Budget-capped per run — cannot run away.

## Context
Real revenue is **B2B hospitality** (hotels, lounges, bars, restaurants) ordering/【re】ordering
hand-made cigars + accessories. B2C web orders are secondary.

## Output contract (strict JSON)
- `intent` ∈ {price, availability, order, reorder, partnership, support, other}
- `icp_fit` 0..1 — how well the sender matches the B2B hospitality buyer
- `believability` 0..1 — how concrete/serious vs vague/spam
- `reason` ≤120 chars — the single strongest cue

## Evaluation (pending)
No hire without a scorecard. A labeled golden subset of real inquiries + a grader must exist before
this agent is "certified". Until then it runs in shadow (stub) and its labels are advisory.
