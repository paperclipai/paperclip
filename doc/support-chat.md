# Cloud Support Chat (Plain)

This document is the contract for the Plain support chat surface on Paperclip
Cloud: what enables it, which secrets it needs, how identity attestation
works, and how to roll it out and back. The integration is **Cloud-only and
opt-in**: an ordinary open-source/self-hosted installation loads no Plain code
and makes no third-party network request — its existing flag → Share feedback
entry point is untouched.

## How it works

- `GET /api/support-chat/session` (`server/src/routes/support-chat.ts`) is the
  single server-owned switch. It answers **404 `support_chat_disabled`**
  unless this instance is enabled (see gating below), and 401 without a
  signed-in board session.
- When enabled, the response carries the Plain Chat App id plus a narrow,
  server-attested customer identity: verified email, hex HMAC-SHA256
  `emailHash`, display name, and the Paperclip user id as Plain's
  `externalId`. Nothing else — no logs, task content, prompts, URLs, or other
  product context. The only caller input is `?companyId=` (below); the
  identity block always derives from the authenticated user row, so a client
  cannot request a hash for another email.
- **Current-company context**: the browser passes the selected company as
  `?companyId=`. The server honors it only for a well-formed id the signed-in
  user is a member of (`hasCompanyAccess`); malformed, foreign, and unknown
  ids all collapse to `company: null`, so the parameter is not an existence
  oracle. When honored — and only after the tenant sync below confirmed the
  tenant exists and the customer membership is confirmed in Plain — the response includes the native tenant ID and stable externalId
  (`paperclip-company-<company uuid>`), which the widget passes as
  `threadDetails.tenantIdentifier.tenantId` so **new** support threads are
  scoped to the company the customer is working in.
- `SupportChatGate` (`ui/src/components/SupportChatGate.tsx`) asks that route
  once per signed-in account (re-asking on company switch), and only then
  injects Plain's script (`https://chat.cdn-plain.com/index.js`) and calls the
  documented `Plain.init` with the identity block. The widget is Plain's
  native bottom-right launcher and chat panel; product theme is passed through
  Plain's documented `theme` option. Identity mounts once per page lifetime;
  company and theme are context and update in place via `Plain.update` — a
  company switch never closes an open chat panel, and threads already created
  keep the tenant they started under.
- The sidebar flag (`SidebarAccountMenu`) hides only while the Plain launcher
  is actually mounted and visible; a script or config failure keeps the flag
  as the discoverable fallback.

### Company vs. tenant (Plain semantics)

Plain has two grouping concepts, and only one of them is ours to set:

- A Plain **company** is derived by Plain from the customer's email domain
  (`user@example.com` → the `example.com` company). We never send it;
  it appears automatically once the customer identity is attested (or the
  customer verifies via Plain's own email OTP). "No company" in the Plain
  inbox is therefore a symptom of an anonymous customer, not a missing field.
- A Plain **tenant** mirrors how our product groups users — a Paperclip
  company. `server/src/services/plain-tenant-sync.ts` upserts the tenant
  (externalId `paperclip-company-<uuid>`, name = company name) through
  Plain's documented `upsertTenant` GraphQL mutation before the session
  response ever references it; every failure path withholds the tenant id so
  the widget never points Plain at a tenant that may not exist. Successful
  upserts are cached per process; a company rename re-upserts. The server then
  upserts the verified customer and calls `addCustomerToTenants` for the selected
  tenant. Membership is not cached. No other memberships are removed, no
  existing threads are reassigned, and the email-domain company is untouched.
  Unverified customers receive no tenant context. These memberships are support
  metadata, not Paperclip authorization; this integration does not synchronize
  membership removals or grant access to Paperclip resources.

## Environment / secret bindings

| Variable | Sensitivity | Meaning |
| --- | --- | --- |
| `PLAIN_CHAT_APP_ID` | Public identifier | The Plain Chat App id (e.g. `liveChatApp_…`). Absent → support chat off everywhere. |
| `PLAIN_CHAT_EMAIL_HMAC_SECRET` | **Secret, bearer-grade** | Plain's chat authentication secret (Plain → Settings → Chat → the Chat App → Authentication). Holder can mint a chat identity for any email. Server-side env only: never in client bundles, issue comments, documents, or logs. Absent → the widget still mounts, but unauthenticated; Plain's own email OTP flow covers identity. |
| `PLAIN_API_KEY` | **Secret** | A Plain Core API key scoped to exactly `tenant:read`, `tenant:create`, `tenant:edit`, `customer:create`, `customer:edit`, and `customerTenantMembership:create` (Plain → Settings → Machine users / API keys), used server-side to upsert the tenant and verified customer, then add the customer to that tenant. Same handling rules as the HMAC secret. Absent → sessions carry the company name but no tenant id, and support threads lack the current-company association; chat itself is unaffected. |
| `PAPERCLIP_SUPPORT_CHAT_DEV_PREVIEW` | Dev-only switch | `1`/`true` enables the surface on a local development instance for product review. Ignored (fails closed) when `NODE_ENV=production` or when the instance is Cloud-managed. |

Gating (`server/src/services/support-chat.ts`): the surface is enabled when a
Chat App id is set **and** the instance is Cloud-managed per
`isCloudManagedInstance` (`PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN` or
`PAPERCLIP_MANAGED_CONFIG`), or the dev-preview opt-in applies. A production
build cannot enable the dev opt-in; tests pin this.

`emailHash` is issued only for a **verified** email (`authUsers.emailVerified`).
Cloud tenant identities arrive through trusted harness headers and are
upserted verified; self-hosted better-auth accounts must verify email before
the hash is attested.

### Where the secret should live on Cloud

The signing secret belongs in the Cloud provisioner's per-stack server env
(same trust boundary as `PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN`), sourced from
the Cloud secret store — not committed to any repo and not distributed
outside tenant server processes. All tenant stacks of one Plain workspace
share one Chat App and therefore one secret; rotation is: generate a new
secret in Plain → roll the env var across stacks → old hashes stop
authenticating on next widget init.

## Cloud rollout contract

Provisioning a new stack: inject `PLAIN_CHAT_APP_ID` (+
`PLAIN_CHAT_EMAIL_HMAC_SECRET` and `PLAIN_API_KEY` once generated) into the
tenant server env.

Existing stacks: provisioning-code changes do not reconcile already-provisioned
tenants — rollout to existing stacks is an explicit env update + process
restart per stack, and should be staged (one canary stack → cohort → fleet).

Disable/rollback: remove `PLAIN_CHAT_APP_ID` (or just stop injecting it) and
restart — the route returns 404 again, browsers stop loading Plain code on
next page load, and the flag entry point returns automatically. No schema or
data migration is involved in either direction.

Separate test app: local/dev rehearsals use the dedicated
"Plain Chat App Paperclip Cloud — Local Test" Chat App and synthetic
identities, never the production Chat App or real customer emails.

## Vendor-side settings (Plain workspace, not this repo)

- Support identity: shared "Paperclip Support" queue; individual human
  responders; no AI persona, no auto-replies, no business hours or SLA
  display.
- Welcome copy (set in the Chat App settings): "Have a question or feedback
  about the Cloud beta? Leave the Paperclip team a message. Replies may not
  be immediate."
- When enabling verified chat, pair **Require authentication** with
  **Require email verification** in the Chat App settings; enabling only one
  weakens the identity story.
- Notifications: new thread / customer reply → the `#support-cloud` Slack
  channel. Email reply continuity requires a configured support email in
  Plain; until that exists, do not promise email follow-up.

## Known limits / open vendor questions

- Plain documents no widget teardown or identity-reset API (`Plain.close()`
  hides the panel; it is not a reset). The client therefore binds one chat
  identity per page lifetime: a second account signing in on the same
  document keeps the widget hidden (flag returns) until a full page load. On
  Cloud this is unreachable — tenant sign-out is a top-level navigation — so
  it only shows up in local dev previews.
- Open question for Plain support: what browser storage does the chat widget
  persist across page loads, and what is the supported way to clear it on
  sign-out from a shared machine?
- Widget initialization and updates are asynchronous and serialized. Updates
  omit the init-only `appId`. Clearing company context sends `threadDetails: {}`
  because omitting the key leaves the previous tenant in Plain's current SDK.
- The server upserts a tenant using the stable Paperclip company ID as its
  external ID, then returns Plain's tenant ID for the widget's thread context.
  A rename updates the tenant name without creating a different organization.
- The tenant upsert and identity have been verified against the local test
  workspace. A fresh live thread must still verify the tenant-ID handoff.

## Email domain and organization are separate

- Plain customer: signed-in user's name, email, and stable Paperclip user ID.
- Plain company: email-domain grouping managed by Plain, not overwritten with
  the Paperclip organization name.
- Plain tenant: the selected Paperclip organization, using its user-chosen name.
- New conversations receive the selected tenant. Existing conversations keep
  their original association. No logs or other product content are attached.

## Validation status

Local live testing confirmed message delivery and verified customer identity.
The initial tenant-ID handoff failed because the customer had no tenant
membership. After adding that prerequisite, a new chat saved the selected
Plain tenant while preserving the separate email-domain company. The server
now performs the customer upsert and membership step before returning tenant
context; a failed step withholds the tenant ID. Cloud staging still needs its
own end-to-end verification with Cloud authentication and organization switches.
Local browser testing also verified an organization switch through the automatic
server path: the new thread saved the second tenant, the earlier thread retained
the first tenant, and the email-domain company remained unchanged.

If a widget update rejects, the controller removes the default Plain shadow
host, restores the feedback fallback, and refuses further mounts until a full
page reload. This prevents a failed organization transition from leaving the
previous tenant active. The host ID is a vendor DOM dependency, covered by the
local failure-path test and should be checked when the vendor widget changes.

Plain server credentials are removed from inherited adapter environments.

## Staging deployment

Use a dedicated Plain staging chat app. Deliver its public app ID and the
server-only HMAC and tenant API credentials through the Cloud managed-env
secret-reference path. Deploy an immutable preview release to one explicit
staging stack through the fleet app-deploy campaign. Keep the fleet default
unchanged. Record the prior release and configuration for rollback.

Verify the deployed revision, Cloud enablement, server-attested identity,
message delivery, replies, and stored tenant context. Exercise organization
switching and sign-out with distinct test accounts. Self-hosted instances must
still show their existing feedback link and make no Plain CDN request.
