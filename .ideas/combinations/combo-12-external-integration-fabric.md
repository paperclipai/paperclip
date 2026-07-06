# Combo 12 — Two-Way External Integration Fabric

**Combines:** 062 Inbound Intake Channels (Email/Webhook/Form → Issue) · 036 Outbound Webhooks &
Event Subscriptions · (completes the loop with 030 payment-webhook ingestion)

## The unified idea

A real company both *receives* work from the outside (support emails, leads, bug reports, form
submissions) and *emits* signals to the rest of its toolchain (Slack on ship, PagerDuty on
hard-stop, a deploy on approval). Paperclip today can do neither across its boundary: it has a rich
*internal* event bus and an http adapter for inbound *agent* webhooks, but no first-class **front
door** for external work and no **outbound** event delivery. Two ideas combine into one symmetric
external-integration fabric — Paperclip as a first-class node in any automation graph.

- **Inbound: the front door (062).** Per-company intake endpoints — a unique email address and/or a
  public webhook/form — that turn external messages into issues, mapped through a work template
  (combo 10 / idea 058) for the intake type, then **auto-triaged on arrival** via capability-based
  assignment (combo 07) and risk triage (combo 05) so a support email is picked up and worked within
  seconds, threaded back to the originating conversation.
- **Outbound: the event tap (036).** Operator-registered HTTPS subscriptions `{ url, eventTypes[],
  secret, active }` fed from the existing internal bus, with HMAC-signed payloads, retry-with-backoff
  + dead-lettering (the `plugin-job-scheduler.ts` retry pattern), curated per-event-type payloads (no
  sensitive leakage), and SSRF protection via the existing `private-hostname-guard`.

Together they *close the loop*: an inbound support request (062) becomes an issue, an agent works and
ships it, and an outbound webhook (036) fires the resolution to the customer's system — genuine
two-way external comms. Payment-provider webhooks (combo 04 / idea 030) are simply a special inbound
channel; the intra-instance analog is the Company Mailbox (combo 13 / idea 054).

## Why combining wins

Inbound and outbound are the two halves of the same boundary, share security concerns (SSRF guard,
rate-limiting, leak/PII scanning of crossing content per combo 08, source-trust gating), and only
deliver their full value *together* — a front door with no way to reply, or replies with no front
door, is half a feature. They also reuse the same primitives (issue threading via `issue-references.ts`,
the http plumbing, signed payloads), so building them as one fabric avoids two separate, inconsistent
"talk to the outside world" surfaces.

## Phasing

1. Outbound webhooks: subscription store + signed retrying delivery worker, a handful of high-value
   event types (036).
2. Inbound webhook/form intake → issue + auto-triage (062) — smaller first slice than email.
3. Inbound email ingestion (parser/threading/attachments, via plugin) — the fiddliest piece (062).
4. Two-way threading so external conversations map to one issue; payment-webhook channel (030).

## Ratings

- **Difficulty:** Medium — issue creation, threading, the event bus, and inbound http all exist; the
  real care is *security* (a public front door must be rate-limited, spam-filtered, trust-gated, and
  leak/PII-scanned before driving any autonomous action) and email's parsing/threading fiddliness.
- **Estimated time to complete:** ~3–5 engineer-weeks.
- **Importance:** 6/10 — essential for support/sales-style autonomous companies (no front door = no
  autonomy) and broadly useful as an automation connector, but not a prerequisite for core value.
