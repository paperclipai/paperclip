# Combo 13 — Governed Cross-Company Fabric

**Combines:** 054 Company Mailbox (Inbox/Outbox & Tickets) · 007 Holding Company (Meta-Orchestration)
· 053 Inter-Company Shared Services (Agent Lending) · (publishes via 033 portfolio transparency page)

## The unified idea

One Paperclip instance runs many companies, but they are *hard-isolated by design* — cross-company
access is explicitly denied at multiple layers. That isolation is correct as a default, yet it blocks
three things operators clearly want: a **holding company** that oversees a portfolio, **shared
services** (one Legal/Design/Security function several companies draw on instead of duplicating), and
simply **letting two companies talk**. The crucial realization (from idea 054) is that these are not
three separate bridges — they are **three message types on one governed channel.** Build the channel
once.

- **The channel: Company Mailbox (054).** Each company gets an inbox/outbox of typed message
  envelopes `{ from, to, type, subject, body, attachments[], status, threadId }`. The mailbox **is**
  the single audited cross-company door — neither company gets standing access to the other's
  workspace, secrets, or task tree; everything flows through the envelope, leak/PII-scanned on the way
  out (combo 08), logged to the tamper-evident audit trail. Message `type` is the extension point.
- **`directive` messages → Holding Company (007).** A meta-company (`kind = 'holding'`) governs member
  companies through a narrow `portfolio_oversight` capability: a *read* roll-up (budgets, burn, goal
  status, bottlenecks — the heatmap one level up, combo 03) plus *governed writes* expressed as
  directive messages (set a subsidiary budget, pause/resume, file a top-level directive issue into its
  goal tree). Capital allocation — rebalancing budget from a stalled company to a winning one — is the
  killer action, each move an audited budget mutation. Influence by filing goal-level issues, never by
  reaching into a subsidiary's task tree.
- **`service_request` messages → Shared Services (053).** A company publishes an agent/role as a
  *service* with a defined interface and chargeback price. A requester files a stateful service ticket
  (`open → acknowledged → in_progress → responded → closed`); on acceptance the provider converts it
  into a real issue in its own goal tree (`issue-references.ts` links both sides) and the cost is
  charged back to the *requesting* company (combo 04) so shared work is economically honest. A
  shared-services directory + cross-boundary capability matching (combo 07/idea 025) handles discovery.

A Holding Company can publish a portfolio-level **stakeholder transparency page** (combo 05 / idea
033) across its subsidiaries — one link showing the whole group's trajectory.

## Why combining wins

All three deliberately pierce the *same* security boundary, so the governed cross-company seam — *no
escalation into general access, airtight audit, leak-scanned egress, chargeback honesty* — is the
hard, safety-critical core and must be designed **once**. Idea 054 makes this explicit: build the
mailbox as the transport, then holding directives (007) and service requests (053) are message types
on it, not three bespoke bridges with three independent chances to leak. The portfolio roll-up reuses
the per-company metrics and heatmap that already exist.

## Phasing

1. The governed cross-company seam + mailbox transport: intra-instance, operator-approved document
   shares + manual messages (054), with full audit + leak scanning.
2. Read-only portfolio roll-up dashboard (007) and read-only shared-services discovery (053).
3. `service_request` tickets → issue conversion + chargeback (053); governed holding *writes* —
   budget, pause/resume (007).
4. Capital allocation (007) and standing service relationships (053) — the most sensitive tier, last.

## Ratings

- **Difficulty:** High — this is the most architecturally invasive cluster in the set; it deliberately
  crosses a boundary the system was built to enforce, so the capability/authorization work is a
  reviewed *security surface*, not a feature flag (a subsidiary agent must never escalate into
  oversight, every cross-company action must be audited and reversible).
- **Estimated time to complete:** ~8–12 engineer-weeks (phased; read-only portfolio + mailbox ~4 weeks).
- **Importance:** 6/10 — powerful for multi-company operators (the "Ace Holdings"-style setups people
  already simulate manually) and a strong differentiator, but advanced; most single-company operators
  won't need it, so it sequences after the core safety/economics/adoption work.
