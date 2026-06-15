# Gradata Investor FAQ — 10 Procedural-Memory Diligence Objections

**Target:** YC partners, seed VCs. 30-min diligence call format.
**Last updated:** 2026-06-14 (live stats from api.gradata.ai)

---

## 1. "This is just RAG / prompt caching — how is it different?"

RAG retrieves documents; Gradata graduates *behavioral patterns* into durable rules through a confidence pipeline. Rule candidates require ≥3 real-session triggers plus a beta lower-bound ≥0.75 before graduating. A retrieved chunk is stateless; a graduated Gradata rule carries provenance, confidence score, and an auto-quarantine mechanism that fires on repeated failure. That's procedural memory, not retrieval.

---

## 2. "LLMs have long context windows now — why store memory externally?"

Context is ephemeral. When the session ends, the model restarts, or you swap providers — it's gone. Gradata's rule store survives all three, and it's agent-agnostic: the same graduated rule set works in Claude, Codex, Gemini, or a local model. Context windows also don't distinguish signal from noise; the graduation pipeline does.

---

## 3. "How do you stop garbage rules from accumulating?"

Three gates. The noise gate rejects low-signal patterns before they enter the pipeline. The confidence threshold (beta lower-bound ≥0.75, minimum 3 fires) blocks premature graduation. RULE_FAILURE auto-quarantine removes rules that repeatedly cause downstream errors. Current live brain: 62% behavioral pattern rules, 6% untestable rate (down from ~68% pre-fix).

---

## 4. "What happens when two agents produce conflicting rules?"

OriginFingerprint deduplication prevents duplicate candidates from entering the pipeline. When two rules conflict at graduation, the confidence scorer arbitrates — lower beta_lb loses. Contested rules route to pending_approvals for human or designated-agent review before being committed. No silent overwrites. Note: the pending_approvals drain mechanism (GRA-2060) is code-complete and under review — not yet merged to production.

---

## 5. "Can't OpenAI or Anthropic just build this into their models?"

This is model-orthogonal by design — it works across all providers simultaneously, which is the actual wedge. A rule learned in a Claude session is available to a Codex session 30 seconds later. If Anthropic ships memory, it's Claude-only. The network effect compounds: every agent interaction that corrects a rule improves the shared corpus for every other agent in that deployment. Cross-agent identity is not something a model provider can replicate without the vendor lock-in enterprises won't accept.

---

## 6. "Solo founder — how does this scale operationally?"

Procedural memory is itself the force multiplier. The Gradata fleet runs autonomously; new issues are filed, worked, and closed without the founder touching them daily. The graduation pipeline is self-maintaining — it auto-quarantines failures and self-audits for noise. Paperclip orchestration provides retry, recovery, and visibility into fleet health. Scaling to 10× users doesn't require 10× headcount; it requires more agent capacity, which is a cloud cost problem.

---

## 7. "How do you prevent hallucinated or low-quality rules from getting in?"

Hallucinated rules fail the behavioral-pattern gate first — they don't recur across real sessions. If one slips through, the 3-fire / beta_lb ≥0.75 threshold means it needs to be consistently *correct* across multiple independent sessions before graduating. If it graduates and later causes failures, RULE_FAILURE quarantine pulls it automatically. The system degrades gracefully, not silently.

---

## 8. "What's the revenue model?"

API credits per agent-session — each session that reads or writes the rule store is a billable unit. Enterprise tier adds SLA, private rule namespaces, and audit logs. The compounding dynamic: rules improve over time, so churn is structurally penalized (churning means losing accumulated procedural memory), and usage grows with agent deployment size, not headcount.

---

## 9. "Why now — won't better models just solve this?"

Better models amplify the problem. GPT-5-class models run longer, more complex agent workflows — the cost of re-learning from scratch every session increases with capability. The forgetting problem doesn't shrink; it scales with ambition. Every new model release is a forcing function for customers asking how to preserve what they've already taught their agents.

---

## 10. "What does traction look like at this stage?"

Live stats (api.gradata.ai, 2026-06-14):
- **13,625 corrections** ingested across 4 active brains
- **273 lessons** extracted, **106 graduated** into durable rules
- **20 meta-rules** governing the pipeline itself
- 6% untestable rate (down from ~68% pre-noise-gate fix)
- SDK ships working CLI: `gradata status`, `gradata review`, doctor command, session-ID capture smoke test (19/19 passing)
- Running in production dogfood against real agent workflows, not a demo
- YC S26 application in progress

---

*Generated for GRA-3073. Gradata — procedural memory for AI agents.*
