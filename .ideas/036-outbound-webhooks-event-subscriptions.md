# 036 — Outbound Webhooks & Event Subscriptions

## Suggestion

Paperclip has a rich internal event system — a live-events websocket (`live-events-ws.ts`,
`live-events.ts`) and a plugin event bus (`plugin-event-bus.ts`) — but events stay *inside*
Paperclip. There's no first-class way for **external systems** to subscribe to what an autonomous
company does. Operators inevitably want Paperclip to be part of a bigger picture: post to Slack
when an issue ships, alert PagerDuty on a budget hard-stop, trigger a deploy when a work product
is approved, log revenue events (idea 030) into a data warehouse. Today that requires building a
plugin or polling the API.

Add **outbound webhooks**: let operators register HTTPS endpoints that receive signed event
payloads when chosen company events occur — turning Paperclip into a producer in any automation
pipeline.

## How it could be achieved

1. **Subscriptions model.** Per company: `{ url, eventTypes[], secret, active }`. Event types map
   to events the internal bus already emits — issue status changes, approvals, budget incidents
   (`budgets.ts`), emergency stops (idea 014), revenue (idea 030), run completions.
2. **Fan out from the existing bus.** Subscribe a delivery service to `plugin-event-bus.ts` /
   `live-events.ts` and POST matching events to registered URLs — no new event source needed,
   just a new sink.
3. **Reliable delivery.** Sign payloads (HMAC with the per-subscription secret) so receivers can
   verify authenticity; retry with backoff on failure; dead-letter and surface chronic failures
   to the operator. The plugin job scheduler (`plugin-job-scheduler.ts`) is a good template for
   the retry/queue mechanics.
4. **Security.** Reuse the private-hostname guard (`middleware/private-hostname-guard.ts`) to
   prevent SSRF into internal networks, and scope each subscription to one company's events only.
5. **Symmetry with inbound.** Paperclip already *ingests* via the HTTP adapter and (proposed)
   payment webhooks (idea 030); outbound webhooks complete the loop so Paperclip both consumes and
   emits, making it a first-class node in an automation graph.

## Perceived complexity

**Low–Medium.** The internal event stream exists and a retry/queue pattern is already in the repo
to copy, so the core is a subscription store plus a signed, retrying delivery worker. The real
care is operational safety: SSRF prevention (covered by the existing guard), payload signing,
not leaking sensitive fields in event bodies (curate per event type), and backpressure so a slow
endpoint can't stall delivery. Start with a handful of high-value event types and at-least-once
delivery; expand the catalog over time.
