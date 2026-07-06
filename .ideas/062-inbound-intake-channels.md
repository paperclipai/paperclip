# 062 — Inbound Intake Channels (Email / Webhook → Issue)

## Suggestion

A real company receives work from the **outside**: customer support emails, sales leads, bug
reports, form submissions, partner requests. Paperclip can *emit* events (outbound webhooks, idea
036) and agents can *call out*, but there's no first-class way for the outside world to **create
work inside a company**. A code scan finds no inbound intake — no email-to-issue, no public intake
webhook, no support-request channel. So an autonomous customer-support or sales company has no
front door: a human has to manually transcribe every external request into an issue, which defeats
the point of autonomy.

Add **inbound intake channels**: addresses/endpoints that turn external messages — email, webhook,
form — into issues in a company's queue, routed and triaged automatically.

## How it could be achieved

1. **Intake endpoints per company.** A unique intake email address and/or a public webhook/form
   endpoint per company (or per team). Inbound messages become issues in that company's queue. The
   HTTP plumbing for inbound requests already exists (the http adapter handles inbound agent
   webhooks); this is a new inbound *intake* surface.
2. **Map message → issue.** Parse subject/body/attachments into a structured issue, applying a work
   template (idea 058) for the intake type (support, lead, bug) so intake is consistent and complete.
3. **Auto-triage on arrival.** Run capability-based assignment (idea 025) and approval/risk triage
   (idea 016) so an inbound request is routed to the right agent and prioritized — not just dumped
   in a backlog. A support email can be picked up and worked autonomously within seconds.
4. **Threading & two-way.** Link replies to the originating thread (reuse `issue-references.ts` /
   issue threads) so an external conversation maps to one issue, and pair with outbound (idea 036)
   for responses — closing the loop into genuine two-way external comms (and feeding the mailbox
   model, idea 054, for the intra-instance case).
5. **Abuse protection.** Rate-limit and spam-filter intake (the company-search rate-limit pattern
   and `private-hostname-guard` are precedents), and gate auto-actions on untrusted inbound through
   source trust (`source-trust.ts`) so a public endpoint can't be weaponized.

## Perceived complexity

**Medium.** Issue creation, threading, routing, and inbound HTTP handling all already exist, so the
core is the intake surface (email ingestion and/or a public webhook/form endpoint) plus
message→issue mapping. Email ingestion is the fiddliest piece (an inbound mail provider/parser,
threading, attachments) and is best delivered via the plugin system; a webhook/form intake is a
smaller first slice. The real care is **security**: a public front door must be rate-limited, spam-
filtered, and trust-gated, and inbound content must be leak/PII-scanned (ideas 020/034) before it
drives any autonomous action. Ship webhook/form intake first, then email.
