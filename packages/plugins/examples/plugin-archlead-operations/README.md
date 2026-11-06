# ArchLead Operations for Paperclip

This bundled first-party plugin example is an incremental migration of ArchLead
backend capabilities. It is not feature parity, a replacement execution plane,
or authorization to delete or retire the ArchLead backend.

## Implemented in this slice

- **Leads and CRM requests:** signed `lead.created` intake creates a
  company-scoped lead and linked request entity. Board users can create leads
  and requests, update supported request stages, and review source/last-touch
  attribution and operator-entered pipeline values.
- **Client onboarding lifecycle:** requests can move through `open`,
  `qualified`, `proposal`, `closed_won`, and `closed_lost`. A won request can be
  converted idempotently into a pending client entity with
  `manual_setup_required` onboarding status. This does not provision external
  customer accounts, create credentials, allocate leads, or send welcome email.
  An operator may set a client record to `active`; this is an operator-entered
  state and does not prove that an external account was provisioned.
- **Public support intake and triage:** the public `intake` webhook accepts
  `support_ticket.created` events after per-company timestamped HMAC-SHA256
  verification. Valid tickets are company-scoped, deduplicated by event ID,
  priority-classified, and visible in the company page. Board users can update
  status, priority, assignee text, and resolution. A request can be escalated
  into a native Paperclip issue through an explicit operator action.
- **Paperclip-native follow-up:** CRM requests and support tickets can create or
  relink a company-scoped Paperclip issue using the plugin SDK. Plugin entities
  remain the source of truth for customer and ticket details; issue status is
  operational follow-up, not a replacement CRM lifecycle.
- **Synthetic lead qualification:** a board-authenticated server-side route
  creates an idempotent native Paperclip issue and request-confirmation
  interaction only for `sandbox:` IDs and `@example.test` emails. The company
  page and a company-scoped read route show qualification and native human
  approval status. Accepting/rejecting does not trigger outbound execution;
  outreach remains blocked in the plugin.
- **Cashfree and Paddle payment-order contracts:** the board-only
  `POST /api/plugins/paperclipai.plugin-archlead-operations/api/payment-orders`
  endpoint persists a local pending order and returns the provider-specific
  association metadata. Cashfree receives `order_tags`; Paddle receives
  `custom_data`. This creates no provider order and makes no network call.
- **Verified payment status events:** Cashfree events use Cashfree's HMAC-SHA256
  over its timestamp concatenated with the exact raw body and Base64 signature.
  Paddle events use the `Paddle-Signature` timestamp/body HMAC-SHA256 format
  with a five-second timestamp tolerance. After signature verification, the
  signed provider metadata must match a locally persisted order for the same
  company and provider. Receipts are deduplicated by provider event identity;
  retries with the same event are idempotent and changed-body replays are
  rejected. The linked local payment-order status is updated from accepted
  provider event states.
- **Payment parity is incomplete:** no provider order API calls, invoice
  confirmation, refunds, subscriptions, provider reconciliation, customer
  fulfillment, or account provisioning are implemented. The status field is
  not proof that any local invoice or entitlement was fulfilled.
- Eight manual-only job hooks remain unscheduled and explicitly fail until their
  business logic is ported. Paperclip does not start a competing ArchLead
  scheduler.

## Intake contract and security

Send a raw JSON webhook to:

```text
POST /api/plugins/paperclipai.plugin-archlead-operations/webhooks/intake
```

The company ID and stable event ID are required. The payload shape is:

```json
{
  "companyId": "<Paperclip company UUID>",
  "eventId": "<stable producer event ID>",
  "eventType": "lead.created",
  "lead": {
    "name": "Contact name",
    "email": "contact@example.test",
    "business": "Business name",
    "message": "Submitted brief",
    "source": "website",
    "attribution": { "source": "website", "campaign": "example" }
  }
}
```

For support, set `"eventType": "support_ticket.created"` and use a `ticket`
object with required `name`, `email`, `subject`, and `message` fields. Optional
fields are `phone`, `business`, `orderId`, `category`, `bounceLogUrl`, and
`source`. Use a new stable `eventId` for a new submission; reuse the same ID
and exact event content for retries. Reusing an ID with changed content is
rejected.

Set `X-ArchLead-Timestamp` to Unix seconds and
`X-ArchLead-Signature` to `sha256=` followed by the hex HMAC-SHA256 of
`<timestamp>.<exact raw request body>`. Timestamps outside a five-minute
window are rejected. Select a Paperclip secret reference per company in plugin
settings. Secret values are resolved only at delivery time and are never logged
or persisted by this plugin. The public webhook is separate from board-only
mutation routes. A public browser form must send submissions through a trusted
server-side signer; never place the webhook secret in browser code.

The plugin, worker, and same-origin UI are trusted code; manifest capabilities
are not a sandbox boundary. Do not install untrusted plugin packages.

## Parity matrix

| ArchLead capability | Paperclip plugin state |
|---|---|
| Leads, requests, CRM status, and basic attribution | Implemented as company-scoped entities with board create/read and stage updates plus a last-touch count. Advanced attribution events, analytics, lead suppression checks, and exact dashboard parity remain to port. |
| Synthetic lead qualification and approval lifecycle | Implemented through a server-side, synthetic-only route, idempotent Paperclip issue/interaction, and live status read. Production qualification scoring and all outbound execution are not implemented; a local fake provider is exercised only after human approval in a sandbox test. |
| Client list and onboarding request lifecycle | Implemented through a won-request-to-pending-client transition. External provisioning, activation tokens, lead allocation, customer portal, and welcome email are not implemented. |
| Public support ticket intake, admin triage | Signed event intake, event-ID replay handling, company page list, and status/priority/assignee/resolution edits implemented. Production form integration, escalation retries, alerts, chat-channel forwarding, and operator notifications remain to port. |
| Cashfree/Paddle order metadata and signed status events | Local order references plus provider-specific Cashfree `order_tags` and Paddle `custom_data`; raw-body signature verification, replay detection, company/provider/order association, receipt persistence, and local status updates implemented. No provider API calls or payment actions occur. |
| Invoice/payment confirmation and fulfillment | Not implemented. No provider order creation, invoice transition, refunds, subscription lifecycle, customer provisioning, or fulfillment. |
| Gumroad/Easebuzz payment handling | Not ported. |
| Unsubscribe/suppression, bounces, deliverability and replacement metrics | Not ported. |
| HERE lead sourcing, categories and email verification | Not ported. |
| Gmail sync, conversations/replies, outbound sequences | Not ported. |
| Inbound triage, onboarding sweep, watchdog, weekday outbound, SEO/PR/brief workflows | Manual-only hooks; no business logic or schedule. |
| Protected operations dashboard / Paperclip dashboard tab | A company page with scoped CRM/support workflows exists; the legacy dashboard's other tabs and access policy are not reproduced. |

Do not configure schedules until each operation has a real implementation and
its execution ownership is coordinated with the existing ArchLead scheduler.
Do not delete the original backend or its records based on this partial port.

### Non-live payment contract details

The board-authenticated `create-payment-order` route accepts a local external
ID, provider (`cashfree` or `paddle`), amount, three-letter currency, and plan
ID. It persists a pending company-scoped order, rejects reuse of an ID with
changed details, and returns metadata to be included in the future provider
request:

- Cashfree: add the returned `providerMetadata.order_tags` to the order request.
- Paddle: add the returned `providerMetadata.custom_data` to the transaction
  request.

The plugin does not create that provider order. A future trusted server-side
provider integration must use the returned metadata and keep provider API
credentials outside the browser. At webhook delivery, Cashfree association is
read from the signed `data.order.order_tags`; the plugin derives the event ID
from the signed event type and `cf_payment_id` (not an unsigned header).
Paddle association is read from signed `data.custom_data`, and the event ID is
Paddle's signed `event_id`. In both cases the corresponding local order must
exist under the signed company and match the provider before a receipt or
status update is written.

Configure per-company `cashfreeWebhookSecretRef` and
`paddleWebhookSecretRef` using Paperclip secret references. Cashfree signature
verification follows the provider's [raw-body signature
requirements](https://www.cashfree.com/docs/payments/online/webhooks/signature-verification);
Paddle verification follows its [signature and timestamp
requirements](https://developer.paddle.com/webhooks/about/signature-verification).
These handlers are not live-qualified payment integrations.

### Synthetic lead qualification

The board-authenticated, company-scoped route
`POST /api/plugins/paperclipai.plugin-archlead-operations/api/qualification-tasks`
accepts only synthetic leads:

```json
{
  "companyId": "<company UUID>",
  "externalLeadId": "sandbox:<stable lead ID>",
  "sandbox": true,
  "lead": {
    "name": "Synthetic Contact",
    "email": "lead@example.test",
    "business": "Synthetic Example Co",
    "message": "Synthetic qualification request."
  }
}
```

The route rejects IDs without the `sandbox:` prefix, non-`example.test` email
addresses, and requests without the explicit `sandbox: true` marker. The
external lead ID is company-scoped and idempotent: identical retries return the
same Paperclip issue and confirmation interaction; reusing the ID with changed
lead data returns `409`.

Each task is a native Paperclip issue titled `[SANDBOX] Review lead: <name>`
with a native `request_confirmation` card. The confirmation has no continuation
or agent wake. Paperclip's issue-thread UI is the authority for the human
decision; the plugin dashboard reads that interaction and displays
`qualificationStatus` (`pending_review`, `qualified`, or `disqualified`),
`approvalStatus` (`required`, `approved`, or `rejected`), and
`outreachStatus` (`blocked`). Accepting/rejecting updates qualification state
only; the worker has no email, payment, or outbound-provider implementation.

ArchLead can submit the task server-to-server with its existing Paperclip board
credential. Never send that credential from a browser. To refresh status after
the Paperclip decision, use the same company-scoped board credential:
`GET /api/plugins/paperclipai.plugin-archlead-operations/api/qualification-tasks/{externalLeadId}?companyId={companyId}`.
The response contains the external lead ID, native issue and interaction IDs,
the three lifecycle statuses, `synthetic: true`, and native issue title/status.
It also includes the raw Paperclip `interactionStatus` (for example
`pending`, `accepted`, `rejected`, or `cancelled`) so unresolved or unavailable
cards are distinguishable from a human rejection. URL-encode the external lead
ID.

The focused test drives a human decision through Paperclip's issue interaction
API, verifies the status read, and only then invokes a local fake provider in the
test. That fake cannot send email or initiate payment and is not wired into the
plugin worker or API. This proves a sandbox control flow, not production
outreach or payment behavior.

## Development

From the Paperclip monorepo root:

```bash
pnpm --filter @paperclipai/plugin-archlead-operations typecheck
pnpm --filter @paperclipai/plugin-archlead-operations test
pnpm --filter @paperclipai/plugin-archlead-operations build
```

Install the local example into a running Paperclip instance with the local plugin
development workflow. Plugin workers and UI are trusted code; this package must
only be installed from a trusted source. The UI is same-origin and is not
sandboxed by manifest capabilities.
