# 054 — Company Mailbox (Inter-Company Inbox / Outbox & Tickets)

## Suggestion

Companies in one Paperclip instance are hard-isolated (`authorization.ts` denies cross-company
access; `agent-assignability.ts` / `trust-preset-resolver.ts` enforce the boundary), and a code
scan confirms there is **no inter-company communication primitive** at all — the existing
`inbox-dismissals` is *operator* notifications, not company-to-company. So today, two companies in
the same instance literally cannot talk: they can't share a document, hand off a deliverable, or
ask each other for help, even when the operator wants exactly that.

Add a **company mailbox**: a per-company **inbox** and **outbox** that lets companies exchange
structured messages across the boundary — share documents, send **tickets** (trackable service
requests), and pass directives — through one governed, audited channel that preserves isolation by
making the mailbox the *only* cross-company door.

This is the transport layer the earlier cross-company ideas implicitly need: holding-company
directives (idea 007) and shared-services requests (idea 053) become **message types on the
mailbox** rather than separate bespoke bridges.

## How it could be achieved

1. **Mailbox model.** Each company gets an inbox and outbox of **message envelopes**:
   `{ from, to, type, subject, body, attachments[], status, threadId, createdAt }`. Message
   `type` covers `document_share`, `service_request` (ticket), `directive`, `status_update`, and
   `general_message` — one extensible envelope instead of many one-off integrations.
2. **The mailbox *is* the governed bridge.** Reuse the controlled cross-company seam proposed for
   ideas 007/053 so the mailbox is the single audited crossing point. A sender sees only what the
   recipient's mailbox accepts; neither company gets standing access to the other's workspace,
   secrets, or task tree. Every message is logged to the tamper-evident audit trail (idea 023).
3. **Tickets that become work.** A `service_request` is a stateful ticket
   (`open → acknowledged → in_progress → responded → closed`). On acceptance, the receiving company
   can convert it into a real issue in its own goal tree — reuse `issue-references.ts` to link the
   ticket to the resulting issue so both sides track the same work, and chargeback its cost to the
   *requesting* company (ideas 030/049) so shared work is economically honest.
4. **Document sharing.** A `document_share` transfers a document (a snapshot copy by default, or a
   read-only shared reference) via the storage layer. Outbound messages and attachments are
   run through the secret/PII leak scanners (ideas 020/034) before they leave — sending across the
   boundary is a publish event and treated as one.
5. **Human governance + visibility.** Operators see each company's in/outbox, can require approval
   for outbound messages (idea 016 triage applies), and set per-company policy for who may message
   whom (expressible in the policy engine, idea 043). A delivery receipt / read state closes the
   loop, and unanswered tickets escalate via SLA like other stuck work (idea 010/038).
6. **Addressing & discovery.** Companies address each other by id/handle; pair with the shared-
   services directory (idea 053) so a company can discover *who* to message for a given need, and
   with capability matching (idea 025) applied across the boundary.

## Perceived complexity

**Medium–High.** The mailbox introduces a **new domain object** plus a ticket state machine, and
it rides the same security-critical cross-company bridge as ideas 007/053 — that governed seam
(no escalation into general access, airtight audit, leak-scanned egress) is the hard part and
should be designed once and shared across all three. The envelope/threading model, inbox/outbox UI,
and ticket→issue conversion (via existing `issue-references`) are moderate. Strong sequencing
value: build the mailbox first as the *transport*, then express holding directives (007) and
service requests (053) as message types on it, rather than building three bridges. Ship intra-
instance, operator-approved document shares and manual tickets first; automated ticket→issue
conversion, chargeback, and SLA escalation are natural follow-ons.
