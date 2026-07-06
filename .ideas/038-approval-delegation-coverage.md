# 038 — Approval Delegation & Coverage

## Suggestion

Human approval is Paperclip's governance backbone (`approvals.ts`, `issue-approvals.ts`), and
with multiple human users now supported, the operator is still a **single point of stall**: when
the person whose sign-off is required is asleep, on vacation, or simply busy, autonomous work
that needs approval freezes — a 24/7 company gated on one human's availability. Approval triage
(idea 016) helps the human go faster, and mobile push (idea 027) reaches them anywhere, but
neither helps when that human is genuinely **unavailable**. There's no way to delegate approval
authority or set coverage.

Add **approval delegation and coverage**: let an approver hand scoped, time-boxed approval
authority to another human (or a manager agent) so work keeps flowing when they're away — without
quietly removing the safeguard.

## How it could be achieved

1. **Delegation grants.** An approver creates a scoped, expiring delegation: "while I'm out
   (dates), <delegate> may approve <these scopes/risk levels> up to <limit>." Scoping reuses the
   risk score from approval triage (idea 016) so only low/medium-risk items delegate by default.
2. **Coverage routing.** When an approval sits unactioned beyond an SLA, auto-route it to the
   designated backup (another human, or escalate up the org chart to a manager agent) instead of
   rotting — complements the human-blocked case of the deadlock detector (idea 010).
3. **Agent-as-approver, bounded.** Allow a manager *agent* to hold delegated authority only
   within tight limits (e.g. approve doc edits under $X from trusted agents), with everything it
   approves double-logged for the absent human to review on return. High-risk items never
   delegate to an agent — they wait or escalate to another human.
4. **Full audit.** Every delegated/covered approval records who actually approved, under whose
   delegation, and why, in the tamper-evident audit log (idea 023). Delegation is itself a
   governance event and is logged.
5. **Out-of-office switch.** A simple "I'm away until <date>, route my approvals to <X>" control,
   with auto-revert — the human-coverage analog of quiet-hours scheduling (idea 005).

## Perceived complexity

**Medium.** The approval model, multi-user support, and org chart all exist, so this is a
delegation/scoping/expiry layer plus coverage routing — not new core machinery. The careful parts
are the **authority model**: scopes and limits must be airtight so delegation can't be used to
escalate privilege, agent-held authority must be narrowly bounded and fully audited, and
revocation/expiry must be reliable. Ship human-to-human delegation and SLA coverage routing
first; bounded agent-as-approver is a later, more sensitive tier.
