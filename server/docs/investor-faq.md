# Gradata Investor FAQ — 10 Procedural-Memory Diligence Objections

Target: YC partners, seed VCs. Diligence call format.

---

**1. "Is this just RAG with extra steps?"**
RAG retrieves documents at query time and forgets after the response — no learning happens. Gradata extracts durable behavioral rules from agent corrections, stores them in a typed rule store, and injects them into future sessions. The agent actually improves over time rather than re-deriving the same answers from scratch.

**2. "Context windows are getting huge — won't that make this obsolete?"**
Larger windows make it cheaper to stuff in more documents, but they don't solve forgetting: when the session ends, learned behavior disappears. Gradata's rule store persists across sessions, tools, and model upgrades. A 1M-token window still resets when it closes.

**3. "How do you prevent garbage rules from polluting the store?"**
Three gates in series: (1) noise gate rejects low-signal observations, (2) confidence threshold (0.72) filters weak candidates, (3) any rule that fails in production three times triggers RULE_FAILURE auto-quarantine. Live: 62 rule files, 0 garbage as of last audit.

**4. "What happens when two rules conflict?"**
Fingerprint dedup collapses near-duplicates before they enter the store. Surviving conflicts surface in a pending_approvals queue where a human or reviewer arbitrates. No silent clobbering — every conflict is explicit.

**5. "This only works inside one tool — what's the moat when Claude/Cursor ships memory?"**
The moat is cross-tool identity: Gradata graduates rules observed in Claude Code, surfaces them in Cursor, re-enforces them in Codex — all from one rule store. A vendor's own memory only captures behavior inside their product. The multi-host hook adapter is already live across four CLIs.

**6. "Solo founder — how does this scale?"**
The company runs on a Paperclip multi-agent fleet: dedicated roles (boss, marketing, investor-voice) handle async work; Oliver unblocks. This FAQ was delivered by an autonomous agent — the architecture is already live, not planned.

**7. "LLMs hallucinate — how do you know extracted rules are correct?"**
Every candidate clears a pattern gate (structural validity), a 3-fire floor (observed at least three times), and the confidence threshold. Rules that fail in production are auto-quarantined. Live untestable rate: 6%, down from 67.5% before pipeline hardening.

**8. "What's the revenue model?"**
Per-session credits for indie devs; enterprise SLA tier with private rule stores and audit logs for teams. Pro tier spec in review (GRA-3263). Free tier captures corrections automatically via CLI hooks, upgrades when rule count hits the free cap.

**9. "Better models will just solve this — GPT-6 will remember everything."**
Better base models amplify forgetting rather than solving it: a smarter model that resets per-session forgets smarter answers. Gradata's value scales with model capability — better models generate higher-quality rules and apply them more precisely. We're a layer above the model race.

**10. "What's the actual traction?"**
1,206 corrections captured, 541 graduated behavioral rules, 19/19 smoke tests green, 0 garbage rules in the live store. Capture rate: 63.5 observations per session. Not a demo — live system with real data.

*~550 words. Ready for pitch deck appendix or diligence email.*
