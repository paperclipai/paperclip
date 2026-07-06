# 057 — Incident Management & On-Call

## Suggestion

When something goes wrong in a company's *operations* — a production service the company runs goes
down, a customer reports a critical bug, a security alert fires, a payment integration breaks —
Paperclip has no way to handle it as an **incident**. The only "incident" concept in the codebase
is narrow and internal: budget incidents in `budgets.ts` (`createIncidentIfNeeded`). There's no
severity, no on-call routing, no runbook, no postmortem. For an autonomous company that runs real
services 24/7, the absence of incident response is glaring: urgent problems land in the normal
issue queue with no special routing or urgency, and there's no guarantee anyone (agent or human) is
designated to respond *now*.

Add **incident management with on-call routing**: a first-class incident type with severity,
fast-path routing to a designated responder, runbooks, and postmortems — generalizing the existing
budget-incident notion into real operational incident response.

## How it could be achieved

1. **Incident object.** `{ severity (SEV1–4), source, status, responder, timeline,
   relatedIssues[] }`. Incidents can be raised by agents, humans, monitors, or *automatically* by
   existing signals — budget hard-stops (idea 002), reliability-SLO burn (idea 044), security
   alerts (ideas 020/050), deadlocks (idea 010). Generalizes `budgets.ts` incidents into one model.
2. **On-call routing.** Per company/team, an on-call assignment (an agent, a human, or an
   escalation chain over the org chart) that high-severity incidents page *immediately* — bypassing
   normal heartbeat cadence (idea 035) and concurrency queues (idea 001) so response isn't gated by
   ordinary scheduling. Pairs with mobile push (idea 027) for the human case and approval coverage
   (idea 038) for after-hours.
3. **Runbooks.** Attach runbook docs/skills to incident types so a responding agent has a defined
   procedure (reuses skills + documents), rather than improvising under pressure.
4. **Severity-driven behavior.** A SEV1 can auto-trigger Drain/Emergency-Stop (idea 014) on the
   affected scope and pull in additional responders; lower severities follow normal flow with
   priority. Severity sets the urgency contract.
5. **Postmortems + learning.** On resolution, capture a structured postmortem (timeline, root
   cause, follow-ups as issues) into the company learnings ledger (shared with idea 056), so the
   company gets more reliable over time instead of repeating failures.

## Perceived complexity

**Medium.** A precedent exists to generalize (budget incidents), and the trigger signals, org
chart, notifications, and emergency controls are all already present or proposed — so this is
largely a new incident object + severity model + on-call routing wired to existing signals and
actions. The harder parts are the *fast path* (genuinely bypassing normal scheduling so urgent
response isn't throttled) and a clean on-call/escalation model that works for mixed agent+human
responders. Ship manual incident raise + severity + on-call routing first; auto-raising from
existing signals and auto-Drain on SEV1 are high-value follow-ons.
