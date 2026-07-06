# 016 — Approval Triage & Policy-Based Batching

## Suggestion

Human review is the governance backbone — approvals and review handoffs are first-class
(`approvals.ts`, `issue-approvals.ts`), surfaced via inbox/sidebar badges
(`sidebar-badges.ts`, `inbox-dismissals.ts`). But as a company scales, the operator becomes
the bottleneck: dozens of approval items pile up, each reviewed one at a time, indistinguishable
high-stakes-from-trivial. The human drowns, autonomy stalls waiting on them, and the natural
(bad) response is to rubber-stamp everything — which defeats the point of review.

Add an **approval triage layer**: risk-rank pending approvals, group similar ones, and let the
operator define policies to auto-handle the low-risk long tail so human attention goes where it
matters.

## How it could be achieved

1. **Risk score per approval.** Compute a lightweight score from signals already present: the
   acting agent's trust stage (idea 009), spend implied by the action, whether it crosses a
   sensitive boundary (secrets, external sends, budget changes), and diff size for work
   products. Sort the inbox by it.
2. **Grouping.** Cluster approvals by agent, issue subtree, or action type so the operator can
   review "all 8 doc edits from the marketing team" as one batch with bulk approve/reject.
3. **Auto-approve policies.** Operator-defined rules — "auto-approve work products from
   `trusted`+ agents under $0.50 that touch no secrets" — evaluated server-side, every decision
   (including auto-ones) written to `activity-log.ts` for audit.
4. **Standing review SLAs.** Flag approvals waiting beyond a threshold and optionally escalate
   to a manager agent or a second human, so nothing rots silently (complements the deadlock
   detector, idea 010, for the human-blocked case).
5. **UI.** A triage inbox: risk-sorted, grouped, keyboard-bulk-actionable, with a clear
   "auto-handled by policy" lane the operator can audit and tighten.

## Perceived complexity

**Medium.** The approval data model, inbox, and badges already exist, so this is a scoring +
grouping + policy-engine layer on top, plus inbox UX work. The sensitive part is the auto-
approve policy engine: it must be conservative, fully audited, and easy to reason about, because
a wrong rule silently removes the human safeguard. Ship triage/sorting/grouping first (pure
upside, no risk), then add auto-approve behind explicit, narrow policies.
