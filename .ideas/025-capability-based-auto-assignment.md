# 025 — Capability-Based Auto-Assignment

## Suggestion

Every agent carries a **capabilities** description (`agents.capabilities` — "a short paragraph
on what this agent does and when they're relevant," per `doc/PRODUCT.md`, explicitly there to
help "other agents discover who can help with what"). But that text is essentially passive:
issues have a single assignee, and choosing it is manual or hard-coded by the agent that
created the work. As a company grows, this is where throughput dies — work lands on the wrong
agent, piles up on one overloaded specialist, or sits unassigned because nobody knew who fit.

Add **capability-based auto-assignment**: when an issue needs an owner, Paperclip suggests (or
auto-selects) the best-fit agent by matching the issue against agents' capabilities, weighted
by current load, trust, and cost.

## How it could be achieved

1. **Match capability to need.** Score candidate agents for an issue using the existing
   `capabilities` text plus the issue's content/labels. Start simple (keyword/embedding
   similarity); the data is already there. `agent-assignability.ts` already encodes *who is
   eligible* (org/company boundaries) — this adds *who is best* among the eligible.
2. **Weight by reality, not just fit.** Blend in signals other ideas surface: current queue
   depth (Org Bottleneck Heatmap, idea 006), trust stage (idea 009), and cost-effectiveness
   (Unit-Economics, idea 013). Best fit ≠ best choice if that agent is underwater or expensive.
3. **Suggest, then automate.** Phase 1: surface a ranked "suggested assignee" in the UI and to
   the creating agent. Phase 2: opt-in auto-assignment for issues left unowned beyond a
   threshold, so nothing rots unassigned.
4. **Respect the org.** Route within the proper team/reporting structure by default; allow
   cross-team assignment only where policy permits (reuses the boundary logic already in
   `agent-assignability.ts`).
5. **Learn from outcomes.** Feed back completion/approval/rework rates per (agent, work-type)
   so matching improves — an agent that keeps getting a category right rises for it.

## Perceived complexity

**Medium.** Eligibility and the capability data already exist, so a first useful version
(keyword/embedding match → ranked suggestions) is quick. The harder, higher-value work is the
weighting model (fit × load × trust × cost) and the outcome-feedback loop, plus careful UX so
auto-assignment is transparent and overridable. Ship as suggestions first (pure assist, no
risk), then graduate to auto-assignment for the unowned long tail.
